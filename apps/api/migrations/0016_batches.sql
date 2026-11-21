-- Stage 4 part 3 — batch execution: dosing with tolerance, process readings, IPQC, completion with yield and mass balance
-- (BRD p.18 sub-modules 6, 7, 8, 13; MP §12.5–12.6; MFG-007, MFG-008, MFG-010; TC-11)

create table mfg.batches (
  id                  uuid primary key default gen_random_uuid(),
  batch_no            text not null unique,
  production_order_id uuid not null references mfg.production_orders (id),
  seq                 int not null check (seq > 0),
  planned_qty         numeric(18,3) not null check (planned_qty > 0),
  uom                 text not null references mdm.uom (code),
  line_id             uuid not null references mfg.lines (id),
  shift_id            uuid references mfg.shifts (id),
  operators           text[] not null default '{}',
  status              text not null default 'InProgress' check (status in ('InProgress','Completed','OnHold','Scrapped')),
  status_reason       text,
  started_at          timestamptz not null default now(),
  started_by          uuid not null references iam.users (id),
  completed_at        timestamptz,
  completed_by        uuid references iam.users (id),
  -- completion and mass balance (MFG-010): input = output + process loss + recovered + waste (+ unaccounted)
  output_qty          numeric(18,3),
  process_loss_qty    numeric(18,3),
  recovered_qty       numeric(18,3),
  waste_qty           numeric(18,3),
  balance_basis       text,                                  -- unit the balance was computed in (KG when every quantity converts to it)
  input_basis_qty     numeric(18,3),
  unaccounted_qty     numeric(18,3),
  yield_pct           numeric(7,3),
  material_cost       numeric(18,2),
  fg_lot_id           uuid references inv.lots (id),
  completion_remarks  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  unique (production_order_id, seq)
);
create index batches_order_idx on mfg.batches (production_order_id);

-- dosing (MFG-008): actual lot and quantity against the batch share of each requirement
create table mfg.batch_consumptions (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references mfg.batches (id),
  order_material_id  uuid not null references mfg.order_materials (id),
  lot_id             uuid not null references inv.lots (id),
  item_id            uuid not null references mdm.items (id),
  qty                numeric(18,4) not null check (qty > 0),
  factor             numeric(12,6) not null default 1,       -- substitute factor: requirement-equivalent = qty / factor
  unit_cost          numeric(18,4) not null default 0,
  status             text not null default 'Accepted' check (status in ('Accepted','PendingApproval','Approved','Rejected')),
  deviation_id       uuid references qa.deviations (id),
  dosed_at           timestamptz not null default now(),
  dosed_by           uuid not null references iam.users (id)
);
create index batch_consumptions_batch_idx on mfg.batch_consumptions (batch_id);
create index batch_consumptions_lot_idx on mfg.batch_consumptions (lot_id);

create table mfg.process_readings (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references mfg.batches (id),
  parameter   text not null,
  value       text not null,
  unit        text,
  in_limits   boolean,
  remarks     text,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null references iam.users (id)
);
create index process_readings_batch_idx on mfg.process_readings (batch_id);

-- in-process QC (BRD p.18 sub-module 13): viscosity, reaction completion, pH, bulk density …
create table qc.ipqc_tests (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,
  batch_id      uuid not null references mfg.batches (id),
  stage         text not null,
  status        text not null default 'Pending' check (status in ('Pending','Passed','Failed','Cancelled')),
  requested_at  timestamptz not null default now(),
  requested_by  uuid not null references iam.users (id),
  tested_at     timestamptz,
  tested_by     uuid references iam.users (id),
  remarks       text,
  deviation_id  uuid references qa.deviations (id),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create table qc.ipqc_results (
  id            uuid primary key default gen_random_uuid(),
  ipqc_test_id  uuid not null references qc.ipqc_tests (id) on delete cascade,
  seq           int not null,
  parameter     text not null,
  specification text not null,
  result        text not null,
  pass          boolean not null,
  unique (ipqc_test_id, seq)
);

do $$
declare t text;
begin
  foreach t in array array['mfg.batches','qc.ipqc_tests'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;

-- the finished-goods lot of a batch is inspected by QC like a received lot (source PRODUCTION)
alter table qc.inspections drop constraint if exists inspections_source_type_check;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('BATCH', 'B', 6, 'Production batch (also the finished-goods lot number) B/2026-27/000001'),
  ('IPQC', 'IPQC', 6, 'In-process QC test IPQC/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.settings (key, value, description) values
  ('mfg.massBalance.tolerancePct', '2', 'Mass balance (MFG-010): unaccounted quantity allowed, as % of the input, before completion needs a reason and raises a deviation')
on conflict (key) do nothing;
