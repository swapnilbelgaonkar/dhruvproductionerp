-- Stage 5 part 2 — QA core: CAPA, non-conformance, change control, complaints, recall (BRD p.16; MP §14.4–14.5; QA-007…QA-009, QA-013, QA-016; UAT-15)

alter table inv.stock_ledger drop constraint stock_ledger_txn_type_check;
alter table inv.stock_ledger add constraint stock_ledger_txn_type_check
  check (txn_type in ('GRN','GRN_REVERSAL','QC_RELEASE','QC_REJECT','QC_HOLD','SAMPLE','SUPPLIER_RETURN',
                      'ISSUE_TO_PROD','RETURN_FROM_PROD','PRODUCTION_OUTPUT','OPENING','QA_RELEASE','QA_REJECT','QA_HOLD','PACKING_LOSS','PACKING_ISSUE','RECALL_HOLD'));

create table qa.capas (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,
  title         text not null,
  source_type   text not null check (source_type in ('DEVIATION','NON_CONFORMANCE','COMPLAINT','AUDIT','OOS','CHANGE','RECALL','OTHER')),
  source_id     uuid,
  source_ref    text,
  problem       text not null,
  root_cause    text,
  owner_id      uuid not null references iam.users (id),
  due_date      date not null,
  status        text not null default 'Open' check (status in ('Open','EffectivenessCheck','Closed','Cancelled')),
  effective     boolean,
  verification_note text,
  verified_by   uuid references iam.users (id),
  verified_at   timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create table qa.capa_actions (
  id          uuid primary key default gen_random_uuid(),
  capa_id     uuid not null references qa.capas (id) on delete cascade,
  kind        text not null check (kind in ('CORRECTION','CORRECTIVE','PREVENTIVE')),
  description text not null,
  owner_id    uuid not null references iam.users (id),
  due_date    date not null,
  status      text not null default 'Open' check (status in ('Open','Done')),
  evidence    text,
  done_at     timestamptz,
  done_by     uuid references iam.users (id)
);

create table qa.non_conformances (
  id           uuid primary key default gen_random_uuid(),
  doc_no       text not null unique,
  kind         text not null check (kind in ('MATERIAL','PROCESS','SUPPLIER','PRODUCT','OTHER')),
  title        text not null,
  description  text not null,
  severity     text not null check (severity in ('MINOR','MAJOR','CRITICAL')),
  lot_id       uuid references inv.lots (id),
  party_id     uuid references mdm.parties (id),
  disposition  text check (disposition in ('USE_AS_IS','REWORK','RETURN','SCRAP')),
  disposition_note text,
  capa_id      uuid references qa.capas (id),
  status       text not null default 'Open' check (status in ('Open','Closed')),
  raised_by    uuid not null references iam.users (id),
  closed_by    uuid references iam.users (id),
  closed_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table qa.change_requests (
  id             uuid primary key default gen_random_uuid(),
  doc_no         text not null unique,
  title          text not null,
  change_type    text not null check (change_type in ('FORMULATION','SPECIFICATION','PROCESS','EQUIPMENT','SOP','SUPPLIER','OTHER')),
  description    text not null,
  justification  text not null,
  impact         text not null,                          -- on quality, regulatory status, stock, documents
  risk           text not null check (risk in ('LOW','MEDIUM','HIGH')),
  target_date    date,
  status         text not null default 'Draft' check (status in ('Draft','Submitted','Approved','Rejected','Implemented','Closed','Cancelled')),
  status_reason  text,
  implementation_note text,
  requested_by   uuid not null references iam.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table qa.complaints (
  id             uuid primary key default gen_random_uuid(),
  doc_no         text not null unique,
  party_id       uuid references mdm.parties (id),            -- the dealer
  received_on    date not null,
  channel        text not null check (channel in ('PHONE','EMAIL','FIELD_VISIT','WHATSAPP','LETTER','OTHER')),
  item_id        uuid references mdm.items (id),
  lot_id         uuid references inv.lots (id),
  box_serial     text,
  category       text not null check (category in ('QUALITY','EFFICACY','PACKAGING','LABELLING','QUANTITY','DAMAGE','OTHER')),
  description    text not null,
  severity       text not null check (severity in ('MINOR','MAJOR','CRITICAL')),
  status         text not null default 'Open' check (status in ('Open','Investigating','Closed')),
  findings       text,
  conclusion     text check (conclusion in ('Justified','NotJustified')),
  response       text,
  capa_id        uuid references qa.capas (id),
  logged_by      uuid not null references iam.users (id),
  closed_by      uuid references iam.users (id),
  closed_at      timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table qa.recalls (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  mode            text not null check (mode in ('DRILL','ACTUAL')),
  reason          text not null,
  source_lot_id   uuid not null references inv.lots (id),
  complaint_id    uuid references qa.complaints (id),
  status          text not null default 'Open' check (status in ('Open','Closed')),
  initiated_by    uuid not null references iam.users (id),
  initiated_at    timestamptz not null default now(),
  traced_at       timestamptz,
  locked_at       timestamptz,
  trace_seconds   int,
  closure_note    text,
  closed_by       uuid references iam.users (id),
  closed_at       timestamptz,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create table qa.recall_lots (
  id            uuid primary key default gen_random_uuid(),
  recall_id     uuid not null references qa.recalls (id) on delete cascade,
  lot_id        uuid not null references inv.lots (id),
  depth         int not null,
  relation      text not null check (relation in ('SOURCE','MADE_FROM','INPUT_OF')),
  produced_qty  numeric(18,3),
  on_hand_qty   numeric(18,3) not null,
  boxes         int not null default 0,
  locked_qty    numeric(18,3) not null default 0,
  unique (recall_id, lot_id)
);

do $$
declare t text;
begin
  foreach t in array array['qa.capas','qa.non_conformances','qa.change_requests','qa.complaints','qa.recalls'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
  end loop;
  execute 'create trigger guard_status before update on qa.change_requests for each row execute function sys.guard_status_change()';
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('CAPA', 'CAPA', 6, 'Corrective and preventive action CAPA/2026-27/000001'),
  ('NON_CONFORMANCE', 'NC', 6, 'Non-conformance NC/2026-27/000001'),
  ('CHANGE_REQUEST', 'CC', 6, 'Change control CC/2026-27/000001'),
  ('COMPLAINT', 'CMP', 6, 'Complaint CMP/2026-27/000001'),
  ('RECALL', 'RCL', 6, 'Recall RCL/2026-27/000001')
on conflict (doc_type) do nothing;
