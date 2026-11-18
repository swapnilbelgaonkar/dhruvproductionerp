-- Dhruv Agro ERP 2.0 — Stage 1 Foundation schema
-- Schemas: sys (platform), iam (identity/access), org (organisation masters), wf (workflow/approvals)
create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists ltree;
create extension if not exists btree_gist;

create schema if not exists sys;
create schema if not exists iam;
create schema if not exists org;
create schema if not exists wf;

-- ---------------------------------------------------------------- shared trigger functions
-- Status may only change inside the workflow/lifecycle service, which sets app.transition = 'on' (MP Rule 4).
create or replace function sys.guard_status_change() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status and coalesce(current_setting('app.transition', true), '') <> 'on' then
    raise exception 'STATUS_CHANGE_FORBIDDEN: status of %.% changes only through the workflow service', tg_table_schema, tg_table_name
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function sys.touch_row() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

create or replace function sys.deny_modify() returns trigger language plpgsql as $$
begin
  raise exception 'APPEND_ONLY: % is append-only', tg_table_name using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------- audit (append-only, hash-chained)
create table sys.audit_events (
  id          bigserial primary key,
  seq         bigint unique,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,
  actor_label text,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  reason      text,
  ip          text,
  user_agent  text,
  request_id  text,
  prev_hash   text,
  hash        text not null default ''
);
create index audit_entity_idx on sys.audit_events (entity_type, entity_id);
create index audit_actor_idx on sys.audit_events (actor_id, occurred_at desc);
create index audit_time_brin on sys.audit_events using brin (occurred_at);

create or replace function sys.audit_hash(prev text, e sys.audit_events) returns text language sql stable as $$
  select encode(digest(
    coalesce(prev, '') || '|' || e.seq::text || '|' || extract(epoch from e.occurred_at)::text || '|' ||
    coalesce(e.actor_id::text, '') || '|' || e.action || '|' || e.entity_type || '|' || coalesce(e.entity_id, '') || '|' ||
    coalesce(e.before::text, '') || '|' || coalesce(e.after::text, '') || '|' || coalesce(e.reason, ''), 'sha256'), 'hex')
$$;

create or replace function sys.audit_chain() returns trigger language plpgsql as $$
declare last_row sys.audit_events;
begin
  -- serialise writers so the chain order equals commit order
  perform pg_advisory_xact_lock(726200101);
  select * into last_row from sys.audit_events order by seq desc limit 1;
  new.seq := coalesce(last_row.seq, 0) + 1;
  new.prev_hash := last_row.hash;
  new.hash := sys.audit_hash(new.prev_hash, new);
  return new;
end $$;

create trigger audit_chain before insert on sys.audit_events for each row execute function sys.audit_chain();
create trigger audit_no_update before update or delete on sys.audit_events for each row execute function sys.deny_modify();
create trigger audit_no_truncate before truncate on sys.audit_events for each statement execute function sys.deny_modify();

create or replace function sys.verify_audit_chain() returns table (checked bigint, first_broken_seq bigint) language plpgsql stable as $$
declare r sys.audit_events; prev text := null; n bigint := 0;
begin
  for r in select * from sys.audit_events order by seq loop
    n := n + 1;
    if r.prev_hash is distinct from prev or r.hash <> sys.audit_hash(prev, r) then
      checked := n; first_broken_seq := r.seq; return next; return;
    end if;
    prev := r.hash;
  end loop;
  checked := n; first_broken_seq := null; return next;
end $$;

-- ---------------------------------------------------------------- platform tables
create table sys.settings (
  key         text primary key,
  value       jsonb not null,
  description text not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table sys.number_series_formats (
  doc_type    text primary key,
  prefix      text not null check (prefix ~ '^[A-Z0-9-]{1,10}$'),
  padding     int not null default 6 check (padding between 3 and 10),
  description text not null
);

create table sys.number_series (
  doc_type    text not null references sys.number_series_formats (doc_type),
  scope_key   text not null default 'GLOBAL',
  fy          text not null,
  next_value  bigint not null default 1 check (next_value > 0),
  primary key (doc_type, scope_key, fy)
);

create table sys.outbox_events (
  id             uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id   text not null,
  event_type     text not null,
  payload        jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  published_at   timestamptz,
  attempts       int not null default 0,
  last_error     text
);
create index outbox_unpublished_idx on sys.outbox_events (created_at) where published_at is null;

create table sys.idempotency_keys (
  user_id      uuid not null,
  key          text not null,
  method       text not null,
  path         text not null,
  request_hash text not null,
  status_code  int not null,
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------- organisation
create table org.legal_entities (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  name               text not null,
  pan                text check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  cin                text,
  registered_address text,
  state_code         char(2),
  status             text not null default 'Draft' check (status in ('Draft','Submitted','Active','Rejected','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table org.gst_registrations (
  id              uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references org.legal_entities (id),
  state_code      char(2) not null,
  gstin           text not null unique check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  address         text,
  status          text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  check (substr(gstin, 1, 2) = state_code)
);

create table org.plants (
  id              uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references org.legal_entities (id),
  code            text not null unique,
  name            text not null,
  address         text,
  state_code      char(2),
  status          text not null default 'Draft' check (status in ('Draft','Submitted','Active','Rejected','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table org.warehouses (
  id                  uuid primary key default gen_random_uuid(),
  legal_entity_id     uuid not null references org.legal_entities (id),
  plant_id            uuid references org.plants (id),
  code                text not null unique,
  name                text not null,
  type                text not null check (type in ('FG','RM','PM','LAB','QUARANTINE','REJECTED','TRANSIT','SAMPLE','GENERAL')),
  address             text,
  state_code          char(2),
  gst_registration_id uuid references org.gst_registrations (id),
  status              text not null default 'Draft' check (status in ('Draft','Submitted','Active','Rejected','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table org.departments (
  id     uuid primary key default gen_random_uuid(),
  code   text not null unique,
  name   text not null,
  status text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

-- Territory levels are configurable (D37 pending: BRD levels seeded)
create table org.territory_levels (
  level int primary key check (level between 1 and 12),
  name  text not null,
  tier_hint text
);

create table org.territories (
  id        uuid primary key default gen_random_uuid(),
  parent_id uuid references org.territories (id),
  code      text not null unique,
  name      text not null,
  level     int not null references org.territory_levels (level),
  path      ltree not null unique,
  status    text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create index territories_path_gist on org.territories using gist (path);

create table org.employees (
  id              uuid primary key default gen_random_uuid(),
  emp_code        text not null unique,
  full_name       text not null,
  email           citext,
  mobile          text check (mobile ~ '^[6-9][0-9]{9}$'),
  department_id   uuid references org.departments (id),
  designation     text,
  sales_tier      text check (sales_tier in ('BH','NSM','DSM','ZSM','RSM','SASM','ASM','TSM','SE')),
  manager_id      uuid references org.employees (id),
  territory_id    uuid references org.territories (id),
  legal_entity_id uuid references org.legal_entities (id),
  status          text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (manager_id is null or manager_id <> id)
);
create index employees_manager_idx on org.employees (manager_id);

-- ---------------------------------------------------------------- identity & access
create table iam.users (
  id                   uuid primary key default gen_random_uuid(),
  email                citext not null unique,
  full_name            text not null,
  password_hash        text not null,
  status               text not null default 'Active' check (status in ('Active','Suspended','Deactivated')),
  must_change_password boolean not null default true,
  mfa_enabled          boolean not null default false,
  mfa_secret_enc       text,
  failed_login_count   int not null default 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  employee_id          uuid unique references org.employees (id),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table iam.sessions (
  id                  text primary key,           -- sha256 of the opaque token; the token itself is never stored
  user_id             uuid not null references iam.users (id),
  csrf_token          text not null,
  mfa_satisfied       boolean not null default false,
  mfa_pending_secret_enc text,                    -- TOTP secret during enrolment, encrypted
  mfa_pending_expires_at timestamptz,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  idle_expires_at     timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at          timestamptz,
  ip                  text,
  user_agent          text
);
create index sessions_user_idx on iam.sessions (user_id) where revoked_at is null;

create table iam.permissions (
  code        text primary key,
  module      text not null,
  resource    text not null,
  action      text not null,
  description text not null
);

create table iam.roles (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  description  text not null default '',
  department   text not null default 'General',
  privileged   boolean not null default false,
  requires_mfa boolean not null default false,
  is_system    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table iam.role_permissions (
  role_id         uuid not null references iam.roles (id) on delete cascade,
  permission_code text not null references iam.permissions (code),
  primary key (role_id, permission_code)
);

create table iam.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references iam.users (id),
  role_id    uuid not null references iam.roles (id),
  scope      jsonb not null default '{"all": true}',
  status     text not null default 'PendingApproval' check (status in ('PendingApproval','Active','Revoked','Rejected')),
  reason     text,
  granted_by uuid references iam.users (id),
  granted_at timestamptz,
  revoked_by uuid references iam.users (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index user_roles_live_uq on iam.user_roles (user_id, role_id) where status in ('PendingApproval','Active');

-- Sales authority limits (BRD p.3–4 / MP §4.4). Seeded INACTIVE until business approval (D15).
create table iam.authority_limits (
  tier             text primary key check (tier in ('BH','NSM','DSM','ZSM','RSM','SASM','ASM','TSM','SE')),
  rank             int not null unique,
  title            text not null,
  max_discount_pct numeric(5,2) check (max_discount_pct between 0 and 100),   -- null = exceptional / unlimited
  max_order_value  numeric(18,2) check (max_order_value >= 0),               -- null = exceptional / unlimited
  can_approve      boolean not null default true,
  active           boolean not null default false,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

-- ---------------------------------------------------------------- workflow & approvals
create table wf.policies (
  id          uuid primary key default gen_random_uuid(),
  doc_type    text not null unique,
  name        text not null,
  description text not null default ''
);

create table wf.policy_versions (
  id           uuid primary key default gen_random_uuid(),
  policy_id    uuid not null references wf.policies (id),
  version      int not null,
  definition   jsonb not null,
  status       text not null default 'Draft' check (status in ('Draft','Published','Retired')),
  created_at   timestamptz not null default now(), created_by uuid,
  published_at timestamptz, published_by uuid,
  unique (policy_id, version)
);
create unique index policy_one_published on wf.policy_versions (policy_id) where status = 'Published';

create table wf.approval_requests (
  id                uuid primary key default gen_random_uuid(),
  doc_no            text not null unique,
  subject_type      text not null,
  subject_id        uuid not null,
  subject_label     text not null,
  subject_revision  int not null default 1,
  policy_version_id uuid not null references wf.policy_versions (id),
  rule_name         text not null,
  facts             jsonb not null default '{}',
  status            text not null default 'Pending' check (status in ('Pending','OnHold','Approved','Rejected','Returned','Cancelled')),
  initiated_by      uuid not null references iam.users (id),
  submitted_at      timestamptz not null default now(),
  completed_at      timestamptz,
  legal_entity_id   uuid references org.legal_entities (id)
);
create unique index approval_live_uq on wf.approval_requests (subject_type, subject_id, subject_revision) where status in ('Pending','OnHold');
create index approval_subject_idx on wf.approval_requests (subject_type, subject_id);

create table wf.approval_steps (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references wf.approval_requests (id),
  seq           int not null,
  label         text not null,
  step_kind     text not null check (step_kind in ('approve','notify')),
  approver_rule jsonb not null,
  approver_ids  uuid[] not null,
  status        text not null check (status in ('Waiting','Pending','OnHold','Approved','Rejected','Returned','Cancelled','Notified')),
  activated_at  timestamptz,
  due_at        timestamptz,
  decided_at    timestamptz,
  decided_by    uuid references iam.users (id),
  unique (request_id, seq)
);
create index approval_steps_approvers_gin on wf.approval_steps using gin (approver_ids) where status in ('Pending','OnHold');

create table wf.approval_decisions (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references wf.approval_requests (id),
  step_id    uuid references wf.approval_steps (id),
  actor_id   uuid not null references iam.users (id),
  decision   text not null check (decision in ('Approve','Reject','Hold','Resume','Return','Cancel')),
  remarks    text not null default '',
  created_at timestamptz not null default now()
);
create trigger approval_decisions_append_only before update or delete on wf.approval_decisions for each row execute function sys.deny_modify();

-- ---------------------------------------------------------------- triggers on mutable tables
do $$
declare t text;
begin
  foreach t in array array['org.legal_entities','org.plants','org.warehouses','org.departments','org.territories','org.employees','iam.users','iam.authority_limits']
  loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
  end loop;
  foreach t in array array['org.legal_entities','org.plants','org.warehouses','iam.user_roles','wf.approval_requests']
  loop
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;
