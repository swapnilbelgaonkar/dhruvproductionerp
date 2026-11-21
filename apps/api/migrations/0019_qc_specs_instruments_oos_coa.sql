-- Stage 5 part 1 — specification & method master, instruments & calibration, OOS investigation, controlled CoA
-- (BRD p.15 sub-modules 1, 3, 4, 5, 6; MP §13.3–13.7; QC-004…QC-008, QC-011, QC-013; TC-12)

create table qc.test_methods (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9-]{2,20}$'),
  name        text not null,
  technique   text not null check (technique in ('HPLC','AAS','TITRATION','PH_METER','GRAVIMETRIC','SPECTROPHOTOMETRY','DENSITY','VISUAL','OTHER')),
  reference   text,                                            -- e.g. FCO 1985 Schedule II, IS 7179
  status      text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table qc.instruments (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique check (code ~ '^[A-Z0-9-]{2,20}$'),
  name             text not null,
  technique        text not null,
  make_model       text,
  serial_no        text,
  location         text,
  interval_days    int not null check (interval_days between 1 and 1095),
  last_calibrated  date,
  calibration_due  date,
  status           text not null default 'Active' check (status in ('Active','OutOfService','Retired')),
  status_reason    text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table qc.calibrations (
  id             uuid primary key default gen_random_uuid(),
  instrument_id  uuid not null references qc.instruments (id),
  calibrated_on  date not null,
  due_on         date not null,
  result         text not null check (result in ('Pass','Fail')),
  agency         text,
  certificate_no text,
  document_id    uuid references sys.documents (id),
  remarks        text,
  recorded_by    uuid not null references iam.users (id),
  recorded_at    timestamptz not null default now(),
  check (due_on > calibrated_on)
);
create index calibrations_instrument_idx on qc.calibrations (instrument_id, calibrated_on desc);

-- specifications: one per item, numbered versions approved by QC then QA, effective-dated like formulations
create table qc.specifications (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null unique references mdm.items (id),
  code        text not null unique,
  title       text not null,
  status      text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create table qc.spec_versions (
  id              uuid primary key default gen_random_uuid(),
  spec_id         uuid not null references qc.specifications (id),
  version_no      int not null,
  effective_from  date not null,
  effective_to    date,
  change_note     text not null,
  status          text not null default 'Draft' check (status in ('Draft','Submitted','Approved','Rejected','Withdrawn')),
  status_reason   text,
  approved_at     timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  unique (spec_id, version_no),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (spec_id with =, daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&) where (status = 'Approved')
);
create table qc.spec_parameters (
  id               uuid primary key default gen_random_uuid(),
  spec_version_id  uuid not null references qc.spec_versions (id) on delete cascade,
  seq              int not null,
  parameter        text not null,
  category         text not null check (category in ('PHYSICAL','CHEMICAL','HEAVY_METAL','MICROBIAL','OTHER')),
  unit             text,
  limit_type       text not null check (limit_type in ('RANGE','MIN','MAX','TEXT')),
  min_value        numeric(18,6),
  max_value        numeric(18,6),
  expected_text    text,
  method_id        uuid references qc.test_methods (id),
  unique (spec_version_id, seq),
  check ((limit_type = 'RANGE' and min_value is not null and max_value is not null and max_value >= min_value)
      or (limit_type = 'MIN' and min_value is not null) or (limit_type = 'MAX' and max_value is not null)
      or (limit_type = 'TEXT' and expected_text is not null))
);

-- results against the specification; a retest adds rows, the original is never overwritten (QC-007)
alter table qc.inspections add column spec_version_id uuid references qc.spec_versions (id);
alter table qc.inspection_results drop constraint inspection_results_inspection_id_seq_key;
alter table qc.inspection_results
  add column spec_parameter_id uuid references qc.spec_parameters (id),
  add column numeric_value numeric(18,6),
  add column method_id uuid references qc.test_methods (id),
  add column instrument_id uuid references qc.instruments (id),
  add column attempt int not null default 1,
  add column analyst_id uuid references iam.users (id),
  add column recorded_at timestamptz not null default now();
create unique index inspection_results_attempt_uq on qc.inspection_results (inspection_id, seq, attempt);

create table qc.oos_cases (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique,
  inspection_id    uuid not null references qc.inspections (id),
  parameters       text not null,                               -- the parameters out of specification, as found
  status           text not null default 'Open' check (status in ('Open','RetestAuthorised','Closed')),
  phase1_findings  text,                                        -- laboratory investigation
  root_cause       text,
  conclusion       text check (conclusion in ('Confirmed','Invalidated')),
  retest_authorised_by uuid references iam.users (id),
  retest_authorised_at timestamptz,
  closed_by        uuid references iam.users (id),
  closed_at        timestamptz,
  opened_at        timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create index oos_inspection_idx on qc.oos_cases (inspection_id);

-- controlled certificate of analysis (QC-006, QC-013): versioned, analyst and approver, QR-verifiable
create table qc.coas (
  id             uuid primary key default gen_random_uuid(),
  doc_no         text not null,
  inspection_id  uuid not null references qc.inspections (id),
  version_no     int not null,
  analyst_id     uuid not null references iam.users (id),
  approver_id    uuid not null references iam.users (id),
  issued_at      timestamptz not null default now(),
  content        jsonb not null,                                -- the certificate as issued
  signature      text not null,
  status         text not null default 'Current' check (status in ('Current','Superseded')),
  unique (doc_no, version_no)
);

do $$
declare t text;
begin
  foreach t in array array['qc.test_methods','qc.instruments','qc.specifications','qc.spec_versions','qc.oos_cases'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
  end loop;
  execute 'create trigger guard_status before update on qc.spec_versions for each row execute function sys.guard_status_change()';
  execute 'create trigger guard_status before update on qc.oos_cases for each row execute function sys.guard_status_change()';
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('OOS_CASE', 'OOS', 6, 'Out-of-specification investigation OOS/2026-27/000001'),
  ('COA', 'COA', 6, 'Certificate of analysis COA/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('CALIBRATION_CERTIFICATE', 'Calibration certificate', '{qc.instrument}', false, false, 8)
on conflict (code) do nothing;
