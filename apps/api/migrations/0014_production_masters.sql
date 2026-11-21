-- Stage 4 part 1 — plant & line settings and the BOM / formulation master (BRD p.18; MP §12.4; MFG-006, MFG-009, MFG-019)
create schema if not exists mfg;

-- ---------------------------------------------------------------- plant & line settings (MFG-019)
create table mfg.lines (
  id               uuid primary key default gen_random_uuid(),
  plant_id         uuid not null references org.plants (id),
  code             text not null unique check (code ~ '^[A-Z0-9-]{2,20}$'),
  name             text not null,
  line_type        text not null check (line_type in ('REACTOR','BLENDER','GRANULATOR','FERMENTER','FILLING','PACKING','OTHER')),
  capacity_per_shift numeric(18,3) check (capacity_per_shift > 0),
  capacity_uom     text references mdm.uom (code),
  parameters       jsonb not null default '[]'::jsonb,        -- machine parameters: [{name, value, unit}]
  status           text not null default 'Active' check (status in ('Active','Inactive')),
  status_reason    text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check ((capacity_per_shift is null) = (capacity_uom is null))
);

create table mfg.shifts (
  id          uuid primary key default gen_random_uuid(),
  plant_id    uuid not null references org.plants (id),
  code        text not null check (code ~ '^[A-Z0-9]{1,6}$'),
  name        text not null,
  start_time  time not null,
  end_time    time not null,                                   -- may be earlier than start (night shift crosses midnight)
  status      text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  unique (plant_id, code),
  check (start_time <> end_time)
);

-- ---------------------------------------------------------------- formulations (MFG-006)
-- One formulation per output item; its versions carry the recipe and are effective-dated.
create table mfg.boms (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null unique references mdm.items (id),     -- the FG or semi-finished item produced
  code        text not null unique,
  name        text not null,
  status      text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table mfg.bom_versions (
  id                 uuid primary key default gen_random_uuid(),
  bom_id             uuid not null references mfg.boms (id),
  version_no         int not null check (version_no > 0),
  batch_size         numeric(18,3) not null check (batch_size > 0),   -- planned output per batch, in the output item's base unit
  batch_uom          text not null references mdm.uom (code),
  standard_yield_pct numeric(6,3) not null check (standard_yield_pct > 0 and standard_yield_pct <= 100),
  reaction_temp_c    numeric(6,2),
  reaction_time_min  int check (reaction_time_min > 0),
  process_notes      text,
  effective_from     date not null,
  effective_to       date,
  change_note        text not null,
  status             text not null default 'Draft' check (status in ('Draft','Submitted','Approved','Rejected','Withdrawn')),
  status_reason      text,
  approved_at        timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  unique (bom_id, version_no),
  check (effective_to is null or effective_to >= effective_from),
  -- BR-07: approved versions of one formulation never overlap in time
  exclude using gist (bom_id with =, daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&) where (status = 'Approved')
);
create index bom_versions_status_idx on mfg.bom_versions (bom_id, status);

create table mfg.bom_lines (
  id              uuid primary key default gen_random_uuid(),
  bom_version_id  uuid not null references mfg.bom_versions (id) on delete cascade,
  line_no         int not null,
  step_no         int not null default 1 check (step_no > 0),           -- dosing sequence
  item_id         uuid not null references mdm.items (id),
  qty             numeric(18,4) not null check (qty > 0),                -- per batch
  uom             text not null references mdm.uom (code),
  tolerance_pct   numeric(6,3) not null check (tolerance_pct >= 0 and tolerance_pct <= 100),  -- MFG-008 dosing tolerance
  notes           text,
  unique (bom_version_id, line_no)
);

-- MFG-009: approved substitutes for a line, with the quantity factor (1 kg of the line item = factor × substitute)
create table mfg.bom_alternates (
  id           uuid primary key default gen_random_uuid(),
  bom_line_id  uuid not null references mfg.bom_lines (id) on delete cascade,
  item_id      uuid not null references mdm.items (id),
  factor       numeric(12,6) not null default 1 check (factor > 0),
  notes        text,
  unique (bom_line_id, item_id)
);

do $$
declare t text;
begin
  foreach t in array array['mfg.lines','mfg.shifts','mfg.boms','mfg.bom_versions'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
  end loop;
  execute 'create trigger guard_status before update on mfg.bom_versions for each row execute function sys.guard_status_change()';
end $$;
