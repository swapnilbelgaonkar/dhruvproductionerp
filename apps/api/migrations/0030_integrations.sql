-- Stage 7 part 4 — statutory and outside-world integrations (BRD p.6, p.13; MP §21; D08, D11, D27).
-- Every integration has a mode chosen by the administrator:
--   OFF        not used;
--   MANUAL     the ERP prepares the government / bank file, a person uploads it on the portal and records the reply (IRN, EWB no., ARN, UTR);
--   SIMULATED  a built-in imitation of the portal for training and testing — results are marked SIMULATED and never printed as valid;
--   LIVE       a provider adapter sends it (messages: SMTP and HTTPS webhooks; GST: the GSP chosen under D27).
-- Keys and passwords are never stored here: a live adapter reads them from environment variables named in its config.

create schema if not exists gst;

create table sys.integrations (
  code        text primary key,
  name        text not null,
  area        text not null,
  description text not null,
  modes       text[] not null,                      -- modes this integration supports
  mode        text not null default 'OFF' check (mode in ('OFF','MANUAL','SIMULATED','LIVE')),
  provider    text,
  config      jsonb not null default '{}',
  updated_at  timestamptz not null default now(), updated_by uuid,
  check (mode = any (modes))
);

create table sys.integration_log (
  id           bigint generated always as identity primary key,
  integration  text not null references sys.integrations (code),
  operation    text not null,
  mode         text not null,
  subject_type text,
  subject_id   uuid,
  ok           boolean not null,
  request      jsonb,
  response     jsonb,
  error        text,
  at           timestamptz not null default now(),
  by_user      uuid references iam.users (id)
);
create index integration_log_subject_idx on sys.integration_log (subject_type, subject_id);

insert into sys.integrations (code, name, area, description, modes) values
  ('EINVOICE', 'E-invoice (IRP)', 'GST', 'IRN and signed QR for B2B tax invoices and credit notes (Rule 48(4)); cancel within 24 hours', '{OFF,MANUAL,SIMULATED,LIVE}'),
  ('EWAYBILL', 'E-way bill (NIC)', 'GST', 'E-way bill for consignments above the threshold; validity from distance', '{OFF,MANUAL,SIMULATED,LIVE}'),
  ('GST_RETURNS', 'GST returns (GSTR-1, GSTR-3B)', 'GST', 'Return files in the GST portal offline-tool JSON; filing recorded with its ARN', '{OFF,MANUAL,LIVE}'),
  ('BANK_PAYMENTS', 'Bank payment files', 'Finance', 'Bulk payment file for approved payments; the bank''s reply file releases them with their UTRs', '{OFF,MANUAL}'),
  ('EMAIL', 'E-mail', 'Messaging', 'Alerts, scheduled reports and dealer reminders by e-mail (SMTP)', '{OFF,SIMULATED,LIVE}'),
  ('SMS', 'SMS', 'Messaging', 'Short alerts and dealer reminders by SMS (DLT-registered templates, HTTPS gateway)', '{OFF,SIMULATED,LIVE}'),
  ('WHATSAPP', 'WhatsApp', 'Messaging', 'Dealer reminders and alerts on WhatsApp Business (approved templates, HTTPS provider)', '{OFF,SIMULATED,LIVE}')
on conflict (code) do nothing;

-- ---------------------------------------------------------------- addresses the GST schemas need
alter table org.gst_registrations add column if not exists trade_name text, add column if not exists addr_line1 text,
  add column if not exists location text, add column if not exists pincode text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  add column if not exists einvoice_applicable boolean not null default true;
alter table org.warehouses add column if not exists city text, add column if not exists pincode text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$');

-- ---------------------------------------------------------------- e-invoice
create table gst.einvoices (
  id              uuid primary key default gen_random_uuid(),
  doc_kind        text not null check (doc_kind in ('INV','CRN')),
  invoice_id      uuid references sales.invoices (id),
  credit_note_id  uuid references sales.credit_notes (id),
  legal_entity_id uuid not null references org.legal_entities (id),
  seller_gstin    text not null,
  doc_no          text not null,
  mode            text not null check (mode in ('MANUAL','SIMULATED','LIVE')),
  status          text not null default 'Generated' check (status in ('Generated','Cancelled')),
  irn             text not null check (irn ~ '^[0-9a-f]{64}$'),
  ack_no          text not null,
  ack_date        timestamptz not null,
  signed_qr       text not null,
  payload         jsonb not null,
  cancel_reason   text check (cancel_reason in ('1','2','3','4')),
  cancel_remarks  text,
  cancelled_at    timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  check ((doc_kind = 'INV') = (invoice_id is not null) and (doc_kind = 'CRN') = (credit_note_id is not null))
);
create unique index einvoices_inv_uq on gst.einvoices (invoice_id) where status = 'Generated';
create unique index einvoices_crn_uq on gst.einvoices (credit_note_id) where status = 'Generated';
create unique index einvoices_irn_uq on gst.einvoices (irn);

-- ---------------------------------------------------------------- e-way bill
create table gst.ewaybills (
  id              uuid primary key default gen_random_uuid(),
  shipment_id     uuid not null references logistics.shipments (id),
  invoice_id      uuid not null references sales.invoices (id),
  mode            text not null check (mode in ('MANUAL','SIMULATED','LIVE')),
  status          text not null default 'Generated' check (status in ('Generated','Cancelled')),
  ewb_no          text not null check (ewb_no ~ '^[0-9]{12}$'),
  ewb_date        timestamptz not null,
  valid_until     timestamptz not null,
  distance_km     int not null check (distance_km between 1 and 4000),
  vehicle_no      text,
  transporter_gstin text,
  payload         jsonb not null,
  cancel_reason   text check (cancel_reason in ('1','2','3','4')),
  cancel_remarks  text,
  cancelled_at    timestamptz,
  created_at timestamptz not null default now(), created_by uuid
);
create unique index ewaybills_shipment_uq on gst.ewaybills (shipment_id) where status = 'Generated';
create unique index ewaybills_no_uq on gst.ewaybills (ewb_no);
alter table logistics.shipments add column if not exists distance_km int check (distance_km is null or distance_km between 1 and 4000);

-- ---------------------------------------------------------------- GST returns
create table gst.return_filings (
  id            uuid primary key default gen_random_uuid(),
  gstin         text not null,
  legal_entity_id uuid not null references org.legal_entities (id),
  return_type   text not null check (return_type in ('GSTR1','GSTR3B')),
  period        text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  status        text not null default 'Prepared' check (status in ('Prepared','Filed')),
  payload       jsonb not null,
  payload_sha256 text not null,
  summary       jsonb not null default '{}',
  arn           text,
  filed_on      date,
  prepared_at timestamptz not null default now(), prepared_by uuid references iam.users (id),
  filed_at timestamptz, filed_by uuid references iam.users (id),
  check (status <> 'Filed' or (arn is not null and filed_on is not null))
);
create unique index return_filings_filed_uq on gst.return_filings (gstin, return_type, period) where status = 'Filed';

insert into sys.settings (key, value, description) values
  ('gst.einvoice.required', 'true', 'E-invoice required before the invoice is printed for dispatch (when the e-invoice integration is on). D27: confirm the turnover makes e-invoicing mandatory.'),
  ('gst.uqc.default', '"NOS"', 'GST unit quantity code (UQC) reported for invoice quantities counted in packs'),
  ('gst.gstr1.b2clThreshold', '100000', 'GSTR-1: inter-state invoices to unregistered buyers above this value (₹) go in B2CL — confirm with the tax adviser (D27)'),
  ('logistics.ewb.kmPerDay', '200', 'E-way bill validity: one day for each this many km (Rule 138(10), regular cargo) — confirm (D08)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- TDS (FIN-010)
-- Sections, rates and thresholds are master data kept by finance — they are not seeded as facts. A section is used only once Active.
create table fin.tds_sections (
  code             text primary key check (code ~ '^[0-9]{3}[A-Z]{0,2}$'),
  name             text not null,
  rate_individual  numeric(6,3) check (rate_individual between 0 and 50),   -- %, payee an individual / HUF
  rate_other       numeric(6,3) check (rate_other between 0 and 50),        -- %, any other payee
  rate_no_pan      numeric(6,3) check (rate_no_pan between 0 and 50),       -- %, payee without a valid PAN (s.206AA)
  threshold_single numeric(18,2),                                            -- ₹ per payment / credit, below which nothing is deducted
  threshold_annual numeric(18,2),                                            -- ₹ in a financial year per payee
  deduct_on        text not null default 'BASE' check (deduct_on in ('BASE','EXCESS')),  -- EXCESS: only on the part above the annual threshold (194Q)
  status           text not null default 'Draft' check (status in ('Draft','Active','Inactive')),
  remarks          text,
  updated_at timestamptz not null default now(), updated_by uuid,
  check (status <> 'Active' or (rate_individual is not null and rate_other is not null and rate_no_pan is not null))
);
insert into fin.tds_sections (code, name) values
  ('194C', 'Payments to contractors (incl. transporters)'), ('194J', 'Fees for professional or technical services'),
  ('194H', 'Commission or brokerage'), ('194I', 'Rent'), ('194Q', 'Purchase of goods')
on conflict (code) do nothing;
alter table fin.payments drop constraint if exists payments_tds_section_check;
alter table fin.payments add constraint payments_tds_section_fk foreign key (tds_section) references fin.tds_sections (code);
alter table fin.payments add column if not exists tds_rate numeric(6,3), add column if not exists tds_base numeric(18,2),
  add column if not exists tds_basis text check (tds_basis in ('AUTO','MANUAL','NONE')),
  add column if not exists tds_challan_id uuid, add column if not exists batch_id uuid;

alter table mdm.vendor_profiles add column if not exists tds_section text references fin.tds_sections (code),
  add column if not exists tds_ldc_rate numeric(6,3), add column if not exists tds_ldc_valid_to date;
alter table logistics.transporters add column if not exists tds_section text references fin.tds_sections (code),
  add column if not exists tds_exempt_declaration boolean not null default false,   -- s.194C(6): owns ≤10 goods carriages and gave PAN + declaration
  add column if not exists bank_holder text, add column if not exists bank_ifsc text check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  add column if not exists bank_account_enc text, add column if not exists bank_last4 char(4);

create table fin.tds_challans (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  legal_entity_id uuid not null references org.legal_entities (id),
  section         text not null references fin.tds_sections (code),
  period          text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),   -- month of deduction
  tds_amount      numeric(18,2) not null check (tds_amount > 0),
  interest        numeric(18,2) not null default 0 check (interest >= 0),
  total           numeric(18,2) not null,
  deposited_on    date not null,
  bsr_code        text not null check (bsr_code ~ '^[0-9]{7}$'),
  challan_serial  text not null check (challan_serial ~ '^[0-9]{1,5}$'),
  status          text not null default 'Deposited' check (status in ('Deposited','Cancelled')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (total = tds_amount + interest)
);
alter table fin.payments add constraint payments_challan_fk foreign key (tds_challan_id) references fin.tds_challans (id);
insert into fin.accounts (code, name, type, grp, system_key, party_ledger) values
  ('5350', 'Interest on late TDS', 'EXPENSE', 'Finance costs', 'TDS_INTEREST', false)
on conflict do nothing;

-- ---------------------------------------------------------------- bank payment files (FIN-010)
create table fin.bank_accounts (
  id              uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references org.legal_entities (id),
  name            text not null,
  bank_name       text not null,
  ifsc            text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_no_enc  text not null,
  account_last4   char(4) not null,
  client_code     text,                                   -- corporate id the bank gave for bulk uploads
  file_layout     text not null default 'GENERIC_CSV' check (file_layout in ('GENERIC_CSV','PIPE_H2H')),
  status          text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid
);
create table fin.payment_batches (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  legal_entity_id uuid not null references org.legal_entities (id),
  bank_account_id uuid not null references fin.bank_accounts (id),
  layout          text not null,
  status          text not null default 'Generated' check (status in ('Generated','Closed','Cancelled')),
  status_reason   text,
  payment_count   int not null,
  total           numeric(18,2) not null,
  file_name       text not null,
  file_sha256     text not null,                          -- the file is rebuilt from encrypted data on download and must match
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
alter table fin.payments add constraint payments_batch_fk foreign key (batch_id) references fin.payment_batches (id);

do $$
declare t text;
begin
  foreach t in array array['fin.tds_challans','fin.payment_batches'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('TDS_CHALLAN', 'TDC', 5, 'TDS deposited with a challan TDC/2026-27/00001'),
  ('PAYMENT_BATCH', 'PBT', 5, 'Bank payment file PBT/2026-27/00001')
on conflict (doc_type) do nothing;

-- ---------------------------------------------------------------- messages (D11)
create table sys.message_templates (
  code        text not null,
  channel     text not null check (channel in ('EMAIL','SMS','WHATSAPP')),
  subject     text,                                   -- e-mail only
  body        text not null,                          -- {{placeholders}}
  provider_template_id text,                          -- DLT template id (SMS) / approved template name (WhatsApp)
  updated_at  timestamptz not null default now(), updated_by uuid,
  primary key (code, channel)
);
insert into sys.message_templates (code, channel, subject, body) values
  ('ALERT', 'EMAIL', '{{title}}', E'{{title}}\n\n{{body}}\n\nOpen in the ERP: {{link}}\n\n— Dhruv Agro ERP (automatic message)'),
  ('ALERT', 'SMS', null, '{{title}}. {{body}} -Dhruv Agro'),
  ('ALERT', 'WHATSAPP', null, E'*{{title}}*\n{{body}}'),
  ('REPORT', 'EMAIL', '{{reportName}} — {{date}}', E'Attached: {{reportName}} as of {{date}} ({{rows}} rows).\n\nThis report is sent on a schedule set up by {{owner}}. Reply to them to stop it.\n\n— Dhruv Agro ERP'),
  ('DEALER_PAYMENT_DUE', 'EMAIL', 'Payment due {{dueDate}} — invoice {{invoiceNo}}', E'Dear {{dealer}},\n\nThis is a reminder that ₹{{amount}} against our invoice {{invoiceNo}} dated {{invoiceDate}} is due on {{dueDate}}.\n\nIf you have already paid, please ignore this message or send us the payment reference.\n\nThank you,\nAccounts — {{company}}'),
  ('DEALER_PAYMENT_DUE', 'SMS', null, 'Dear {{dealer}}, Rs {{amount}} against invoice {{invoiceNo}} is due on {{dueDate}}. Please ignore if paid. -{{company}}'),
  ('DEALER_PAYMENT_DUE', 'WHATSAPP', null, E'Dear {{dealer}},\nRs {{amount}} against invoice *{{invoiceNo}}* is due on *{{dueDate}}*.\nPlease ignore if already paid. — {{company}}'),
  ('DEALER_PAYMENT_OVERDUE', 'EMAIL', 'Overdue: invoice {{invoiceNo}} ({{daysOverdue}} days)', E'Dear {{dealer}},\n\nOur invoice {{invoiceNo}} dated {{invoiceDate}} for ₹{{amount}} was due on {{dueDate}} and is now {{daysOverdue}} days overdue. New orders are held while invoices are overdue.\n\nPlease arrange payment, or contact us if there is a query on the invoice.\n\nThank you,\nAccounts — {{company}}'),
  ('DEALER_PAYMENT_OVERDUE', 'SMS', null, 'Dear {{dealer}}, invoice {{invoiceNo}} Rs {{amount}} is {{daysOverdue}} days overdue. Please pay to release new orders. -{{company}}'),
  ('DEALER_PAYMENT_OVERDUE', 'WHATSAPP', null, E'Dear {{dealer}},\nInvoice *{{invoiceNo}}* for Rs {{amount}} is *{{daysOverdue}} days overdue*. New orders are on hold until it is paid. — {{company}}')
on conflict (code, channel) do nothing;

create table sys.messages (
  id           uuid primary key default gen_random_uuid(),
  channel      text not null check (channel in ('EMAIL','SMS','WHATSAPP')),
  template     text not null,
  to_address   text not null,                 -- e-mail address or 10-digit mobile
  to_user_id   uuid references iam.users (id),
  to_party_id  uuid references mdm.parties (id),
  subject      text,
  body         text not null,
  vars         jsonb not null default '{}',
  attachments  jsonb not null default '[]',   -- [{name, contentType, base64}]
  status       text not null default 'Queued' check (status in ('Queued','Sent','Failed','Skipped')),
  attempts     int not null default 0,
  last_error   text,
  provider_ref text,
  mode         text,
  dedupe_key   text not null unique,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index messages_queued_idx on sys.messages (created_at) where status = 'Queued';

alter table iam.users add column if not exists mobile text check (mobile is null or mobile ~ '^[6-9][0-9]{9}$'),
  add column if not exists notify_channels text[] not null default '{}';
alter table sys.alert_rules add column if not exists channels text[] not null default '{}';

create table sys.report_schedules (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  report_id    text not null,
  params       jsonb not null default '{}',
  frequency    text not null check (frequency in ('DAILY','WEEKLY','MONTHLY')),
  weekday      int check (weekday between 1 and 7),       -- ISO, 1 = Monday
  month_day    int check (month_day between 1 and 28),
  hour_ist     int not null default 8 check (hour_ist between 0 and 23),
  run_as       uuid not null references iam.users (id),  -- the report is limited to what this user may see
  recipient_user_ids uuid[] not null default '{}',
  enabled      boolean not null default true,
  next_run_at  timestamptz not null,
  last_run_at  timestamptz,
  last_status  text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(),
  check (frequency <> 'WEEKLY' or weekday is not null), check (frequency <> 'MONTHLY' or month_day is not null)
);

insert into sys.settings (key, value, description) values
  ('dealer.reminders', '{"enabled": false, "daysBefore": 3, "overdueEveryDays": 7, "channels": ["EMAIL"]}',
   'Payment reminders to dealers: before the due date and repeatedly while overdue (D11 — confirm channels and wording)'),
  ('company.displayName', '"Dhruv Agro"', 'Company name used in messages to dealers')
on conflict (key) do nothing;
