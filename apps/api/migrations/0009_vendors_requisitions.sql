-- Stage 3 part 1 — vendor onboarding and purchase requisitions (BRD §3.2 p.8; MP §10.1; MDM-011, MDM-016, PUR-001/002)

-- Vendors share the party record (identity, addresses, licences, signatories, documents) with dealers.
alter table mdm.party_licences drop constraint party_licences_licence_type_check;
alter table mdm.party_licences add constraint party_licences_licence_type_check
  check (licence_type in ('FERTILIZER','PESTICIDE','BIOSTIMULANT','CIB_REGISTRATION','MANUFACTURING'));
update sys.document_types set entity_types = array_append(entity_types, 'mdm.party') where code = 'FACTORY_LICENCE' and not ('mdm.party' = any(entity_types));
insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('MSME_CERTIFICATE', 'Udyam (MSME) registration certificate', '{mdm.party}', false, false, 8)
on conflict (code) do nothing;

create table mdm.vendor_profiles (
  party_id           uuid primary key references mdm.parties (id),
  vendor_category    text not null check (vendor_category in ('RAW_MATERIAL','PACKAGING','LAB_CONSUMABLE','SERVICES','CAPITAL','OTHER')),
  licence_types      text[] not null default '{}',
  msme_registered    boolean not null default false,
  udyam_number       text check (udyam_number ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$'),
  payment_terms_days int not null default 30 check (payment_terms_days between 0 and 180),
  rating             numeric(3,1) check (rating between 0 and 5),      -- from receipts and QC results (Stage 3 part 3)
  status             text not null default 'Draft' check (status in ('Draft','Submitted','Active','Rejected','Suspended','Inactive')),
  status_reason      text,
  activated_at       timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (licence_types <@ array['FERTILIZER','PESTICIDE','BIOSTIMULANT','CIB_REGISTRATION','MANUFACTURING']::text[]),
  check (not msme_registered or udyam_number is not null)
);
create trigger touch_row before update on mdm.vendor_profiles for each row execute function sys.touch_row();
create trigger guard_status before update on mdm.vendor_profiles for each row execute function sys.guard_status_change();

-- Bank account for payments (MDM-011 "bank account (verified)"). The number is stored encrypted; only the last 4 digits are shown.
create table mdm.party_bank_accounts (
  id              uuid primary key default gen_random_uuid(),
  party_id        uuid not null references mdm.parties (id),
  account_holder  text not null,
  bank_name       text not null,
  branch          text,
  ifsc            text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_no_enc  text not null,
  account_last4   char(4) not null,
  document_id     uuid not null references sys.documents (id),     -- cancelled cheque / bank letter
  verification    text not null default 'Pending' check (verification in ('Pending','Verified','Rejected')),
  verified_by     uuid references iam.users (id),
  verified_at     timestamptz,
  remarks         text,
  status          text not null default 'Active' check (status in ('Active','Superseded')),
  created_at timestamptz not null default now(), created_by uuid
);
create unique index party_bank_live_uq on mdm.party_bank_accounts (party_id) where status = 'Active';

-- Items a vendor is approved to supply (MDM-011), with lead time; the basis of vendor choice on POs.
create table mdm.vendor_items (
  id               uuid primary key default gen_random_uuid(),
  party_id         uuid not null references mdm.parties (id),
  item_id          uuid not null references mdm.items (id),
  vendor_item_code text,
  lead_time_days   int not null default 0 check (lead_time_days between 0 and 365),
  min_order_qty    numeric(18,4) check (min_order_qty > 0),
  status           text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  unique (party_id, item_id)
);

-- Vendor KYC uses the same configurable rule table as dealers (D07), selected by party role.
alter table mdm.kyc_requirements add column party_role text not null default 'DEALER' check (party_role in ('DEALER','VENDOR'));
insert into mdm.kyc_requirements (party_role, policy, constitution, requirement, min_count, condition, threshold, note) values
  ('VENDOR', 'BOTH', '*', 'PAN_CARD', 1, 'ALWAYS', null, 'PAN of the business / proprietor'),
  ('VENDOR', 'BOTH', '*', 'GST_CERTIFICATE', 1, 'GST_REGISTERED', null, 'GST certificate (same line as GSTIN, BRD p.8)'),
  ('VENDOR', 'BOTH', '*', 'LETTERHEAD', 1, 'ALWAYS', null, 'Letterhead with stamp and signature (BRD p.8)'),
  ('VENDOR', 'BOTH', '*', 'SIGNATORY', 1, 'ALWAYS', null, 'At least one authorised signatory with ID proof'),
  ('VENDOR', 'BOTH', 'PARTNERSHIP', 'PARTNERSHIP_DEED', 1, 'ALWAYS', null, 'Partnership deed'),
  ('VENDOR', 'BOTH', 'LLP', 'INCORPORATION', 1, 'ALWAYS', null, 'LLP incorporation certificate'),
  ('VENDOR', 'BOTH', 'PVT_LTD', 'INCORPORATION', 1, 'ALWAYS', null, 'Certificate of incorporation'),
  ('VENDOR', 'BOTH', 'PUBLIC_LTD', 'INCORPORATION', 1, 'ALWAYS', null, 'Certificate of incorporation'),
  ('VENDOR', 'BOTH', 'FPO', 'INCORPORATION', 1, 'ALWAYS', null, 'FPO registration certificate'),
  ('VENDOR', 'BOTH', 'PVT_LTD', 'BOARD_RESOLUTION', 1, 'ALWAYS', null, 'Board resolution naming the signatory'),
  ('VENDOR', 'BOTH', 'PUBLIC_LTD', 'BOARD_RESOLUTION', 1, 'ALWAYS', null, 'Board resolution naming the signatory'),
  ('VENDOR', 'BRD_STRICT', '*', 'SECURITY_CHEQUE', 3, 'ALWAYS', null, '3 security cheques (BRD p.8, all vendors)'),
  ('VENDOR', 'BRD_STRICT', '*', 'SIGNATORY', 5, 'ALWAYS', null, '5 directors / partners with ID proof (BRD p.8, all vendors)');

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('VENDOR_CODE', 'VEN', 4, 'Vendor VEN-2026-0001'),
  ('PURCHASE_REQUISITION', 'PR', 6, 'Purchase requisition PR/2026-27/000001')
on conflict (doc_type) do nothing;
insert into sys.settings (key, value, description) values
  ('vendor.kyc.policy', '"CONDITIONAL"', 'Vendor KYC rule set: CONDITIONAL (recommended, D07) or BRD_STRICT (3 cheques + 5 directors for every vendor, BRD p.8)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- purchase requisitions
create schema if not exists purchase;

create table purchase.requisitions (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  legal_entity_id uuid not null references org.legal_entities (id),
  warehouse_id    uuid not null references org.warehouses (id),        -- deliver to
  department_id   uuid references org.departments (id),
  requested_by    uuid not null references iam.users (id),
  required_by     date not null,
  priority        text not null default 'NORMAL' check (priority in ('NORMAL','URGENT','EMERGENCY')),
  purpose         text not null,
  status          text not null default 'Draft' check (status in ('Draft','Submitted','Approved','Rejected','Cancelled','Closed')),
  status_reason   text,
  estimated_total numeric(18,2) not null default 0,
  approved_at     timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create index requisitions_le_idx on purchase.requisitions (legal_entity_id, status);

create table purchase.requisition_lines (
  id                  uuid primary key default gen_random_uuid(),
  requisition_id      uuid not null references purchase.requisitions (id) on delete cascade,
  line_no             int not null,
  item_id             uuid not null references mdm.items (id),
  uom                 text not null references mdm.uom (code),
  qty                 numeric(18,4) not null check (qty > 0),
  estimated_rate      numeric(18,2) check (estimated_rate >= 0),
  required_by         date,
  suggested_vendor_id uuid references mdm.parties (id),
  remarks             text,
  ordered_qty         numeric(18,4) not null default 0 check (ordered_qty >= 0),   -- filled by purchase orders (part 2)
  unique (requisition_id, line_no),
  unique (requisition_id, item_id)
);

create trigger touch_row before update on purchase.requisitions for each row execute function sys.touch_row();
create trigger guard_status before update on purchase.requisitions for each row execute function sys.guard_status_change();
