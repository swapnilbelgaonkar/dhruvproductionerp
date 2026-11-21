-- Stage 5 part 3 — controlled documents, training, audits, risk register, line clearance
-- (BRD p.4, p.16; MP §14.3; QA-006, QA-010, QA-011, QA-012, QA-017, QA-018)

create table qa.controlled_documents (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^[A-Z0-9-]{3,30}$'),
  title          text not null,
  doc_type       text not null check (doc_type in ('SOP','STP','POLICY','WORK_INSTRUCTION','FORM','MANUAL')),
  department     text not null,
  owner_id       uuid not null references iam.users (id),
  review_months  int not null default 24 check (review_months between 1 and 60),    -- QA-018: biennial review by default
  status         text not null default 'Active' check (status in ('Active','Obsolete')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create table qa.document_versions (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references qa.controlled_documents (id),
  version_no       int not null,
  effective_from   date not null,
  review_due       date not null,
  change_summary   text not null,
  file_id          uuid references sys.documents (id),
  training_required boolean not null default true,
  status           text not null default 'Draft' check (status in ('Draft','Submitted','Effective','Superseded','Rejected')),
  status_reason    text,
  author_id        uuid not null references iam.users (id),
  approved_at      timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  unique (document_id, version_no)
);
-- which roles must be trained on a document (QA-011)
create table qa.training_requirements (
  document_id  uuid not null references qa.controlled_documents (id) on delete cascade,
  role_code    text not null references iam.roles (code),
  primary key (document_id, role_code)
);
create table qa.training_records (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references iam.users (id),
  document_version_id  uuid not null references qa.document_versions (id),
  trained_on           date not null,
  trainer              text not null,
  assessment           text not null check (assessment in ('Pass','Fail')),
  score                numeric(5,2),
  recorded_by          uuid not null references iam.users (id),
  recorded_at          timestamptz not null default now()
);
create index training_user_idx on qa.training_records (user_id, document_version_id);

create table qa.audits (
  id             uuid primary key default gen_random_uuid(),
  doc_no         text not null unique,
  audit_type     text not null check (audit_type in ('INTERNAL','SUPPLIER','CUSTOMER','REGULATORY')),
  title          text not null,
  scope          text not null,
  party_id       uuid references mdm.parties (id),
  auditor        text not null,
  planned_date   date not null,
  status         text not null default 'Planned' check (status in ('Planned','InProgress','Closed')),
  summary        text,
  closed_by      uuid references iam.users (id),
  closed_at      timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create table qa.audit_findings (
  id              uuid primary key default gen_random_uuid(),
  audit_id        uuid not null references qa.audits (id) on delete cascade,
  seq             int not null,
  classification  text not null check (classification in ('OBSERVATION','MINOR','MAJOR','CRITICAL')),
  clause          text,
  description     text not null,
  capa_id         uuid references qa.capas (id),
  unique (audit_id, seq)
);

-- FMEA-style quality risk register (QA-012): RPN = severity × occurrence × detection
create table qa.risks (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,
  title         text not null,
  process_area  text not null,
  failure_mode  text not null,
  effect        text not null,
  severity      int not null check (severity between 1 and 10),
  occurrence    int not null check (occurrence between 1 and 10),
  detection     int not null check (detection between 1 and 10),
  rpn           int generated always as (severity * occurrence * detection) stored,
  controls      text,
  owner_id      uuid not null references iam.users (id),
  review_date   date not null,
  status        text not null default 'Open' check (status in ('Open','Mitigated','Accepted')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

-- line clearance before a batch or packing run (QA-017, BRD p.4)
create table mfg.line_clearances (
  id            uuid primary key default gen_random_uuid(),
  line_id       uuid not null references mfg.lines (id),
  purpose       text not null check (purpose in ('BATCH','PACKING')),
  checklist     jsonb not null,
  outcome       text not null check (outcome in ('Cleared','NotCleared')),
  remarks       text,
  cleared_by    uuid not null references iam.users (id),
  cleared_at    timestamptz not null default now(),
  used_by_batch uuid references mfg.batches (id),
  used_by_packing uuid references mfg.packing_runs (id)
);
create index line_clearances_line_idx on mfg.line_clearances (line_id, cleared_at desc);
alter table mfg.batches add column line_clearance_id uuid references mfg.line_clearances (id);

do $$
declare t text;
begin
  foreach t in array array['qa.controlled_documents','qa.document_versions','qa.audits','qa.risks'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
  end loop;
  execute 'create trigger guard_status before update on qa.document_versions for each row execute function sys.guard_status_change()';
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('AUDIT', 'AUD', 6, 'Quality audit AUD/2026-27/000001'),
  ('RISK', 'RSK', 6, 'Quality risk RSK/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('CONTROLLED_DOCUMENT', 'Controlled document (SOP, STP, policy)', '{qa.controlled_document}', false, false, 10)
on conflict (code) do nothing;

insert into sys.settings (key, value, description) values
  ('mfg.lineClearance.required', 'true', 'QA-017: a batch or a packing run on a line needs a QA line clearance recorded after the line was last used')
on conflict (key) do nothing;
