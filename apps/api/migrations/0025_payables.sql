-- Stage 6 part 4 — payables: vendor ledger, payments against approved supplier invoices and freight bills (with approval), debit-note adjustment,
-- transporter freight bills checked against the shipments (BRD p.19; MP §17.4–17.6; FIN-009…FIN-012, LOG-008 freight)

-- what has been settled against a supplier invoice: payments released + debit notes adjusted
alter table purchase.supplier_invoices add column amount_settled numeric(18,2) not null default 0;
alter table purchase.debit_notes add column adjusted_at timestamptz, add column adjusted_by uuid references iam.users (id);

-- ---------------------------------------------------------------- freight bills (transporter invoices for paid freight)
create table logistics.freight_bills (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique,
  transporter_id   uuid not null references logistics.transporters (id),
  legal_entity_id  uuid not null references org.legal_entities (id),
  bill_no          text not null,                -- the transporter's number
  bill_date        date not null,
  due_date         date not null,
  taxable_total    numeric(18,2) not null,
  gst_rate         numeric(5,2) not null default 0,
  reverse_charge   boolean not null default true, -- GTA: tax paid by us under RCM unless the transporter charges it
  gst_amount       numeric(18,2) not null default 0,
  grand_total      numeric(18,2) not null,        -- payable to the transporter (excludes RCM tax)
  amount_settled   numeric(18,2) not null default 0,
  variance         numeric(18,2) not null default 0,   -- billed − agreed freight on the shipments
  status           text not null default 'Submitted' check (status in ('Submitted','Approved','Rejected','Cancelled')),
  status_reason    text,
  remarks          text,
  document_id      uuid references sys.documents (id),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (due_date >= bill_date)
);
create unique index freight_bills_no_uq on logistics.freight_bills (transporter_id, bill_no) where status <> 'Cancelled';
create table logistics.freight_bill_lines (
  id             uuid primary key default gen_random_uuid(),
  freight_bill_id uuid not null references logistics.freight_bills (id) on delete cascade,
  shipment_id    uuid not null references logistics.shipments (id),
  amount         numeric(18,2) not null check (amount > 0),
  agreed         numeric(18,2)                 -- the freight recorded at dispatch
);

-- ---------------------------------------------------------------- payments (vendors and transporters)
create table fin.payments (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique,
  legal_entity_id  uuid not null references org.legal_entities (id),
  payee_type       text not null check (payee_type in ('VENDOR','TRANSPORTER')),
  party_id         uuid references mdm.parties (id),
  transporter_id   uuid references logistics.transporters (id),
  payment_date     date not null,
  mode             text not null check (mode in ('NEFT','RTGS','IMPS','UPI','CHEQUE')),
  from_account     text,                    -- our bank account
  amount           numeric(18,2) not null check (amount > 0),   -- gross settled against the bills
  tds_section      text check (tds_section in ('194C','194Q','194J','194H','194I')),
  tds_amount       numeric(18,2) not null default 0 check (tds_amount >= 0),
  net_amount       numeric(18,2) not null,                      -- paid to the bank = amount − TDS
  reference        text,                    -- UTR / cheque number, given when the payment is released
  status           text not null default 'Draft' check (status in ('Draft','Submitted','Approved','Rejected','Paid','Cancelled')),
  status_reason    text,
  paid_on          date,
  remarks          text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check ((payee_type = 'VENDOR') = (party_id is not null) and (payee_type = 'TRANSPORTER') = (transporter_id is not null)),
  check (net_amount = amount - tds_amount and tds_amount < amount),
  check (status <> 'Paid' or (reference is not null and paid_on is not null))
);
create table fin.payment_lines (
  id                  uuid primary key default gen_random_uuid(),
  payment_id          uuid not null references fin.payments (id) on delete cascade,
  supplier_invoice_id uuid references purchase.supplier_invoices (id),
  freight_bill_id     uuid references logistics.freight_bills (id),
  amount              numeric(18,2) not null check (amount > 0),
  check ((supplier_invoice_id is null) <> (freight_bill_id is null))
);

do $$
declare t text;
begin
  foreach t in array array['logistics.freight_bills','fin.payments'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('PAYMENT', 'PAY', 6, 'Payment to a vendor or transporter PAY/2026-27/000001'),
  ('FREIGHT_BILL', 'FRB', 6, 'Transporter freight bill FRB/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.settings (key, value, description) values
  ('logistics.freight.varianceTolerancePct', '5', 'FIN-012: a freight bill more than this % above the freight agreed at dispatch needs the finance head as well')
on conflict (key) do nothing;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('FREIGHT_BILL', 'Transporter freight bill', '{logistics.freight_bill}', false, false, 8)
on conflict (code) do nothing;
