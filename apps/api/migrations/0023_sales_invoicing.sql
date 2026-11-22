-- Stage 6 part 2 — sales invoicing: GST tax invoice from the dispatch, credit notes, customer returns
-- (BRD p.18; MP §16.1–16.4; FIN-001…FIN-006, FIN-014, LOG-012; GST rule 46/53: invoice number ≤ 16 characters, unique per financial year)

create table sales.invoices (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique check (length(doc_no) <= 16),
  legal_entity_id  uuid not null references org.legal_entities (id),
  seller_state     char(2) not null,
  seller_gstin     text,
  party_id         uuid not null references mdm.parties (id),
  party_gstin      text,
  bill_to_id       uuid not null references mdm.party_addresses (id),
  ship_to_id       uuid not null references mdm.party_addresses (id),
  place_of_supply  char(2) not null,
  inter_state      boolean not null,
  sales_order_id   uuid not null references sales.sales_orders (id),
  shipment_id      uuid not null references logistics.shipments (id),
  invoice_date     date not null,
  due_date         date not null,
  payment_terms    text not null,
  status           text not null default 'Posted' check (status in ('Posted','Cancelled')),
  status_reason    text,
  taxable_total    numeric(18,2) not null,
  cgst_total       numeric(18,2) not null default 0,
  sgst_total       numeric(18,2) not null default 0,
  igst_total       numeric(18,2) not null default 0,
  round_off        numeric(6,2) not null default 0,
  grand_total      numeric(18,2) not null,
  -- settled by approved credit notes now; by receipts in part 3
  amount_settled   numeric(18,2) not null default 0,
  irn              text,                    -- e-invoice reference from the IRP (Stage 7 integration)
  cancelled_at     timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (due_date >= invoice_date)
);
create unique index invoices_shipment_uq on sales.invoices (shipment_id) where status <> 'Cancelled';
create index invoices_party_idx on sales.invoices (party_id, invoice_date);

create table sales.invoice_lines (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null references sales.invoices (id) on delete cascade,
  line_no         int not null,
  so_line_id      uuid not null references sales.sales_order_lines (id),
  shipment_line_id uuid not null references logistics.shipment_lines (id),
  item_pack_id    uuid not null references mdm.item_packs (id),
  description     text not null,
  hsn_code        text not null,
  pack_label      text not null,
  qty             numeric(18,4) not null check (qty > 0),
  list_rate       numeric(18,2) not null,
  scheme_discount_pct numeric(5,2) not null default 0,
  extra_discount_pct  numeric(5,2) not null default 0,
  rate            numeric(18,2) not null,
  taxable         numeric(18,2) not null,
  gst_rate        numeric(5,2) not null,
  cgst            numeric(18,2) not null default 0,
  sgst            numeric(18,2) not null default 0,
  igst            numeric(18,2) not null default 0,
  line_total      numeric(18,2) not null,
  -- the lots that left with this line, for the invoice print and returns: [{lotId, lotNo, expiryDate, packs, unitCost}]
  lots            jsonb not null default '[]',
  unique (invoice_id, line_no)
);

-- ---------------------------------------------------------------- customer returns (LOG-012, FIN-005)
create table sales.customer_returns (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique,
  invoice_id       uuid not null references sales.invoices (id),
  legal_entity_id  uuid not null references org.legal_entities (id),
  party_id         uuid not null references mdm.parties (id),
  warehouse_id     uuid not null references org.warehouses (id),
  received_on      date not null,
  reason           text not null check (reason in ('DAMAGED','LEAKAGE','EXPIRED','WRONG_PRODUCT','QUALITY_COMPLAINT','EXCESS','OTHER')),
  remarks          text,
  transport_ref    text,
  status           text not null default 'AwaitingQa' check (status in ('AwaitingQa','Closed')),
  complaint_id     uuid references qa.complaints (id),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create table sales.customer_return_lines (
  id               uuid primary key default gen_random_uuid(),
  return_id        uuid not null references sales.customer_returns (id) on delete cascade,
  invoice_line_id  uuid not null references sales.invoice_lines (id),
  lot_id           uuid not null references inv.lots (id),
  packs            numeric(18,4) not null check (packs > 0),
  qty              numeric(18,4) not null check (qty > 0),     -- in the lot's unit
  unit_cost        numeric(18,4) not null,
  condition        text,
  disposition      text check (disposition in ('Restock','Reject')),
  decided_by       uuid references iam.users (id),
  decided_at       timestamptz,
  decision_remarks text
);

-- ---------------------------------------------------------------- credit notes (FIN-004)
create table sales.credit_notes (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique check (length(doc_no) <= 16),
  invoice_id       uuid not null references sales.invoices (id),
  legal_entity_id  uuid not null references org.legal_entities (id),
  party_id         uuid not null references mdm.parties (id),
  inter_state      boolean not null,
  note_date        date not null,
  reason           text not null check (reason in ('RETURN','SHORTAGE','DAMAGE','RATE_DIFFERENCE','SCHEME','OTHER')),
  remarks          text,
  customer_return_id uuid references sales.customer_returns (id),
  shipment_id      uuid references logistics.shipments (id),
  status           text not null default 'Draft' check (status in ('Draft','Submitted','Approved','Rejected','Cancelled')),
  status_reason    text,
  taxable_total    numeric(18,2) not null default 0,
  cgst_total       numeric(18,2) not null default 0,
  sgst_total       numeric(18,2) not null default 0,
  igst_total       numeric(18,2) not null default 0,
  round_off        numeric(6,2) not null default 0,
  grand_total      numeric(18,2) not null default 0,
  approved_at      timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create index credit_notes_invoice_idx on sales.credit_notes (invoice_id);
create table sales.credit_note_lines (
  id               uuid primary key default gen_random_uuid(),
  credit_note_id   uuid not null references sales.credit_notes (id) on delete cascade,
  invoice_line_id  uuid not null references sales.invoice_lines (id),
  qty              numeric(18,4),            -- null for a value-only note (rate difference, scheme)
  taxable          numeric(18,2) not null check (taxable > 0),
  gst_rate         numeric(5,2) not null,
  cgst             numeric(18,2) not null default 0,
  sgst             numeric(18,2) not null default 0,
  igst             numeric(18,2) not null default 0,
  line_total       numeric(18,2) not null
);

do $$
declare t text;
begin
  foreach t in array array['sales.invoices','sales.customer_returns','sales.credit_notes'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('SALES_INVOICE', 'SI', 5, 'GST tax invoice SI/2026-27/00001 (16 characters, GST rule 46)'),
  ('CREDIT_NOTE', 'CN', 5, 'Credit note CN/2026-27/00001'),
  ('CUSTOMER_RETURN', 'CRN', 6, 'Customer return CRN/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.settings (key, value, description) values
  ('sales.invoice.autoOnDispatch', 'true', 'FIN-001: raise the GST tax invoice in the same step as the dispatch, so it travels with the goods'),
  ('sales.invoice.cancelWindowHours', '24', 'FIN-003: an invoice can be cancelled only within this many hours and before anything is settled against it (e-invoice IRN rule)')
on conflict (key) do nothing;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('RETURN_PROOF', 'Customer return evidence (photos, LR, dealer letter)', '{sales.customer_return}', false, false, 8)
on conflict (code) do nothing;
