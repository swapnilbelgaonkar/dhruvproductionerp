-- Stage 1 increment 2 — document vault (DMS-001…005) and in-app notifications (NTF-001/004)

create table sys.document_types (
  code            text primary key check (code ~ '^[A-Z0-9_]{2,40}$'),
  name            text not null,
  entity_types    text[] not null,
  requires_expiry boolean not null default false,
  sensitive       boolean not null default false,       -- e.g. cheques, KYC identity documents (X26)
  max_size_mb     int not null default 10 check (max_size_mb between 1 and 50),
  retention_years int,
  status          text not null default 'Active' check (status in ('Active','Inactive'))
);

create table sys.files (
  id            uuid primary key default gen_random_uuid(),
  storage_key   text not null unique,
  original_name text not null,
  mime          text not null,
  size_bytes    bigint not null check (size_bytes > 0),
  sha256        text not null,
  av_status     text not null default 'NotScanned' check (av_status in ('NotScanned','Clean','Infected')),
  uploaded_by   uuid references iam.users (id),
  uploaded_at   timestamptz not null default now()
);

create table sys.documents (
  id              uuid primary key default gen_random_uuid(),
  document_type   text not null references sys.document_types (code),
  entity_type     text not null,
  entity_id       uuid not null,
  title           text not null,
  current_version int not null default 1,
  valid_until     date,
  status          text not null default 'Active' check (status in ('Active','Archived')),
  created_at timestamptz not null default now(), created_by uuid references iam.users (id),
  updated_at timestamptz not null default now()
);
create index documents_entity_idx on sys.documents (entity_type, entity_id);
create index documents_expiry_idx on sys.documents (valid_until) where status = 'Active' and valid_until is not null;

create table sys.document_versions (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references sys.documents (id),
  version     int not null,
  file_id     uuid not null references sys.files (id),
  valid_until date,
  note        text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  unique (document_id, version)
);
create trigger document_versions_append_only before update or delete on sys.document_versions for each row execute function sys.deny_modify();
create trigger files_no_delete before delete on sys.files for each row execute function sys.deny_modify();

create table sys.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references iam.users (id),
  kind       text not null check (kind in ('action','info','success','warning')),
  title      text not null,
  body       text not null default '',
  link       text,
  dedupe_key text not null,
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index notifications_unread_idx on sys.notifications (user_id, created_at desc) where read_at is null;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('GST_CERTIFICATE', 'GST registration certificate', '{org.legal_entity,mdm.party}', false, false, 8),
  ('PAN_CARD', 'PAN card', '{org.legal_entity,mdm.party}', false, true, 8),
  ('INCORPORATION', 'Certificate of incorporation / registration', '{org.legal_entity,mdm.party}', false, false, 8),
  ('FACTORY_LICENCE', 'Factory / manufacturing licence', '{org.legal_entity,org.plant}', true, false, 8),
  ('FERTILIZER_LICENCE', 'Fertilizer licence (FCO 1985)', '{org.legal_entity,mdm.party}', true, false, 8),
  ('PESTICIDE_LICENCE', 'Pesticide / insecticide licence (Insecticides Act 1968)', '{org.legal_entity,mdm.party}', true, false, 8),
  ('CIB_REGISTRATION', 'CIB&RC registration', '{org.legal_entity,mdm.party,mdm.item}', true, false, 8),
  ('PRODUCT_SPEC', 'Product specification / label', '{mdm.item}', false, false, 8),
  ('MSDS', 'Material safety data sheet', '{mdm.item}', false, false, 8),
  ('LEASE_AGREEMENT', 'Lease / premises agreement', '{org.legal_entity,org.plant,org.warehouse}', true, false, 8),
  ('OTHER', 'Other supporting document', '{org.legal_entity,org.plant,org.warehouse,mdm.item,mdm.party}', false, false, 8);
