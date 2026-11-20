-- Stage 2 part 1 — business parties and dealer onboarding (BRD §3.1 p.7–8; MP Part 6; DLR-001…015)

-- One identity per business: dealers now; vendors and transporters reuse this table in later stages.
create table mdm.parties (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  legal_name     text not null,
  trade_name     text,
  constitution   text not null check (constitution in ('PROPRIETORSHIP','PARTNERSHIP','LLP','PVT_LTD','PUBLIC_LTD','FPO')),
  pan            text check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  gst_registered boolean not null default true,
  gstin          text check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  contact_person text not null,
  mobile         text not null check (mobile ~ '^[6-9][0-9]{9}$'),
  email          citext,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create unique index parties_gstin_uq on mdm.parties (gstin) where gstin is not null;
create index parties_pan_idx on mdm.parties (pan);
create index parties_mobile_idx on mdm.parties (mobile);
create index parties_name_trgm on mdm.parties (lower(legal_name));

create table mdm.party_addresses (
  id         uuid primary key default gen_random_uuid(),
  party_id   uuid not null references mdm.parties (id),
  kind       text not null check (kind in ('REGISTERED','BILLING','SHIPPING')),
  label      text,
  line1      text not null,
  line2      text,
  city       text not null,
  district   text not null,
  state_code char(2) not null,
  pincode    text not null check (pincode ~ '^[1-9][0-9]{5}$'),
  is_default boolean not null default false,
  status     text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid
);
create index party_addresses_party_idx on mdm.party_addresses (party_id);

create table mdm.party_licences (
  id            uuid primary key default gen_random_uuid(),
  party_id      uuid not null references mdm.parties (id),
  licence_type  text not null check (licence_type in ('FERTILIZER','PESTICIDE','BIOSTIMULANT')),
  number        text not null,
  issuer        text not null,
  valid_from    date not null,
  valid_to      date not null,
  document_id   uuid not null references sys.documents (id),
  verification  text not null default 'Pending' check (verification in ('Pending','Verified','Rejected')),
  verified_by   uuid references iam.users (id),
  verified_at   timestamptz,
  remarks       text,
  status        text not null default 'Active' check (status in ('Active','Superseded')),
  created_at timestamptz not null default now(), created_by uuid,
  check (valid_to >= valid_from)
);
create unique index party_licences_live_uq on mdm.party_licences (party_id, licence_type) where status = 'Active';
create index party_licences_expiry_idx on mdm.party_licences (valid_to) where status = 'Active';

-- Proprietor / partners / directors / authorised signatories. Identity numbers are never stored in full (D25, X26).
create table mdm.party_signatories (
  id          uuid primary key default gen_random_uuid(),
  party_id    uuid not null references mdm.parties (id),
  full_name   text not null,
  designation text not null,
  id_type     text not null check (id_type in ('PAN','AADHAAR','PASSPORT','VOTER_ID','DRIVING_LICENCE')),
  id_last4    text not null check (id_last4 ~ '^[A-Z0-9]{4}$'),
  document_id uuid not null references sys.documents (id),
  status      text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid
);

create table mdm.dealer_profiles (
  party_id          uuid primary key references mdm.parties (id),
  dealer_category   text not null check (dealer_category in ('DISTRIBUTOR','DEALER','RETAILER','INSTITUTION')),
  territory_id      uuid not null references org.territories (id),
  sales_owner_id    uuid not null references org.employees (id),
  licence_types     text[] not null default '{}',       -- what the dealer will buy: drives licence requirements (BRD p.7)
  price_group       text not null default 'STANDARD',
  credit_days       int not null default 0 check (credit_days between 0 and 365),
  credit_limit      numeric(18,2) not null default 0 check (credit_limit >= 0),
  annual_target     numeric(18,2) check (annual_target >= 0),
  target_fy         text check (target_fy ~ '^[0-9]{4}-[0-9]{2}$'),
  status            text not null default 'Draft' check (status in ('Draft','Submitted','Active','Rejected','Suspended','Inactive')),
  status_reason     text,
  activated_at      timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (licence_types <@ array['FERTILIZER','PESTICIDE','BIOSTIMULANT']::text[])
);
create index dealer_profiles_territory_idx on mdm.dealer_profiles (territory_id);

-- Configurable KYC rules (D07 pending). The active rule set is chosen by setting dealer.kyc.policy.
create table mdm.kyc_requirements (
  id            uuid primary key default gen_random_uuid(),
  policy        text not null check (policy in ('BOTH','CONDITIONAL','BRD_STRICT')),
  constitution  text not null default '*',
  requirement   text not null,                    -- a sys.document_types code, or SIGNATORY (count of signatories with ID proof)
  min_count     int not null default 1 check (min_count > 0),
  condition     text not null default 'ALWAYS' check (condition in ('ALWAYS','GST_REGISTERED','CREDIT_ABOVE')),
  threshold     numeric(18,2),
  note          text not null
);

do $$
declare t text;
begin
  foreach t in array array['mdm.parties','mdm.dealer_profiles'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
  end loop;
end $$;
create trigger guard_status before update on mdm.dealer_profiles for each row execute function sys.guard_status_change();

-- Codes like DLR-2026-0001 (BRD p.8)
insert into sys.settings (key, value, description) values
  ('dealer.kyc.policy', '"CONDITIONAL"', 'Dealer KYC rule set: CONDITIONAL (recommended, D07) or BRD_STRICT (3 cheques + 5 directors for every dealer)'),
  ('licence.alertDays', '[60, 30]', 'Licence expiry alerts, days before expiry (BRD p.8 and p.19)')
on conflict (key) do nothing;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('LETTERHEAD', 'Official letterhead with stamp and signature', '{mdm.party}', false, false, 8),
  ('CANCELLED_CHEQUE', 'Cancelled cheque / bank proof', '{mdm.party}', false, true, 8),
  ('SECURITY_CHEQUE', 'Security cheque (Section 138 NI Act)', '{mdm.party}', false, true, 8),
  ('SIGNATORY_ID', 'Identity proof of proprietor / partner / director', '{mdm.party}', false, true, 8),
  ('PARTNERSHIP_DEED', 'Partnership deed', '{mdm.party}', false, false, 8),
  ('BOARD_RESOLUTION', 'Board resolution / authorisation letter', '{mdm.party}', false, false, 8),
  ('BIOSTIMULANT_REGISTRATION', 'Bio-stimulant registration (FCO Schedule VI)', '{mdm.party}', true, false, 8)
on conflict (code) do nothing;

-- Conditional matrix from doc 12 §3, and the BRD-strict alternative (BRD p.8).
insert into mdm.kyc_requirements (policy, constitution, requirement, min_count, condition, threshold, note) values
  ('BOTH', '*', 'PAN_CARD', 1, 'ALWAYS', null, 'PAN of the business / proprietor'),
  ('BOTH', '*', 'GST_CERTIFICATE', 1, 'GST_REGISTERED', null, 'GST certificate (same line as GSTIN, BRD p.7)'),
  ('BOTH', '*', 'LETTERHEAD', 1, 'ALWAYS', null, 'Letterhead with stamp and signature (BRD p.8)'),
  ('BOTH', '*', 'CANCELLED_CHEQUE', 1, 'ALWAYS', null, 'Bank proof for refunds and credit notes'),
  ('BOTH', '*', 'SIGNATORY', 1, 'ALWAYS', null, 'At least one authorised signatory with ID proof'),
  ('BOTH', 'PARTNERSHIP', 'PARTNERSHIP_DEED', 1, 'ALWAYS', null, 'Partnership deed'),
  ('BOTH', 'LLP', 'INCORPORATION', 1, 'ALWAYS', null, 'LLP incorporation certificate'),
  ('BOTH', 'PVT_LTD', 'INCORPORATION', 1, 'ALWAYS', null, 'Certificate of incorporation'),
  ('BOTH', 'PUBLIC_LTD', 'INCORPORATION', 1, 'ALWAYS', null, 'Certificate of incorporation'),
  ('BOTH', 'FPO', 'INCORPORATION', 1, 'ALWAYS', null, 'FPO registration certificate'),
  ('BOTH', 'PVT_LTD', 'BOARD_RESOLUTION', 1, 'ALWAYS', null, 'Board resolution naming the signatory'),
  ('BOTH', 'PUBLIC_LTD', 'BOARD_RESOLUTION', 1, 'ALWAYS', null, 'Board resolution naming the signatory'),
  ('BOTH', 'FPO', 'BOARD_RESOLUTION', 1, 'ALWAYS', null, 'Board resolution naming the signatory'),
  ('CONDITIONAL', '*', 'SECURITY_CHEQUE', 3, 'CREDIT_ABOVE', 0, '3 security cheques for credit dealers only'),
  ('CONDITIONAL', 'PVT_LTD', 'SIGNATORY', 5, 'CREDIT_ABOVE', 500000, 'KYC of 5 directors when credit limit is above ₹5,00,000'),
  ('CONDITIONAL', 'PUBLIC_LTD', 'SIGNATORY', 5, 'CREDIT_ABOVE', 500000, 'KYC of 5 directors when credit limit is above ₹5,00,000'),
  ('BRD_STRICT', '*', 'SECURITY_CHEQUE', 3, 'ALWAYS', null, 'BRD p.8: 3 security cheques for every dealer'),
  ('BRD_STRICT', '*', 'SIGNATORY', 5, 'ALWAYS', null, 'BRD p.8: KYC of minimum 5 directors / partners');

-- Code format DLR-<FY start year>-<sequence>
insert into sys.number_series_formats (doc_type, prefix, padding, description) values ('DEALER_CODE', 'DLR', 4, 'Dealer code DLR-2026-0001 (BRD p.8)')
on conflict (doc_type) do nothing;
