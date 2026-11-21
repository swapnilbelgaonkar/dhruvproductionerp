-- Stage 3 part 4 — supplier returns, debit notes, supplier invoices with three-way match
-- (BRD p.8, p.13–14; MP §10.5–10.6; PUR-009, PUR-010; D06 tolerances)

alter table inv.stock_ledger drop constraint stock_ledger_txn_type_check;
alter table inv.stock_ledger add constraint stock_ledger_txn_type_check
  check (txn_type in ('GRN','GRN_REVERSAL','QC_RELEASE','QC_REJECT','QC_HOLD','SAMPLE','SUPPLIER_RETURN'));

-- ---------------------------------------------------------------- supplier return (against the original receipt and lot)
create table purchase.supplier_returns (
  id                uuid primary key default gen_random_uuid(),
  doc_no            text not null unique,
  party_id          uuid not null references mdm.parties (id),
  goods_receipt_id  uuid not null references purchase.goods_receipts (id),
  purchase_order_id uuid not null references purchase.purchase_orders (id),
  warehouse_id      uuid not null references org.warehouses (id),
  return_date       date not null,
  reason            text not null,
  transporter       text,
  vehicle_no        text,
  status            text not null default 'Draft' check (status in ('Draft','Posted','Cancelled')),
  status_reason     text,
  posted_at         timestamptz,
  posted_by         uuid references iam.users (id),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create table purchase.supplier_return_lines (
  id                 uuid primary key default gen_random_uuid(),
  supplier_return_id uuid not null references purchase.supplier_returns (id) on delete cascade,
  line_no            int not null,
  lot_id             uuid not null references inv.lots (id),
  po_line_id         uuid not null references purchase.purchase_order_lines (id),
  item_id            uuid not null references mdm.items (id),
  bucket             text not null check (bucket in ('REJECTED','UNRESTRICTED','BLOCKED')),
  qty                numeric(18,4) not null check (qty > 0),
  rate               numeric(18,4) not null,
  gst_rate           numeric(5,2) not null,
  unique (supplier_return_id, line_no), unique (supplier_return_id, lot_id)
);

-- Debit note raised on the vendor for returned goods (adjusted against its invoice or payment in Stage 6)
create table purchase.debit_notes (
  id                 uuid primary key default gen_random_uuid(),
  doc_no             text not null unique,
  party_id           uuid not null references mdm.parties (id),
  supplier_return_id uuid references purchase.supplier_returns (id),
  supplier_invoice_id uuid,
  note_date          date not null,
  reason             text not null,
  inter_state        boolean not null,
  taxable_total      numeric(18,2) not null,
  cgst_total         numeric(18,2) not null default 0,
  sgst_total         numeric(18,2) not null default 0,
  igst_total         numeric(18,2) not null default 0,
  round_off          numeric(6,2) not null default 0,
  grand_total        numeric(18,2) not null,
  status             text not null default 'Open' check (status in ('Open','Adjusted','Cancelled')),
  created_at timestamptz not null default now(), created_by uuid
);

-- ---------------------------------------------------------------- supplier invoices and the three-way match
create table purchase.supplier_invoices (
  id                uuid primary key default gen_random_uuid(),
  doc_no            text not null unique,                -- internal reference
  party_id          uuid not null references mdm.parties (id),
  purchase_order_id uuid not null references purchase.purchase_orders (id),
  invoice_no        text not null,                       -- the vendor's number
  invoice_date      date not null,
  due_date          date not null,
  document_id       uuid references sys.documents (id),
  inter_state       boolean not null,
  taxable_total     numeric(18,2) not null default 0,
  tax_total         numeric(18,2) not null default 0,
  round_off         numeric(6,2) not null default 0,
  grand_total       numeric(18,2) not null default 0,
  status            text not null default 'Draft' check (status in ('Draft','Matched','Exception','Submitted','Approved','Rejected','Cancelled')),
  status_reason     text,
  matched_at        timestamptz,
  exception_note    text,                                -- purchase's justification of the variance
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (due_date >= invoice_date)
);
-- the same vendor invoice number can be booked only once (cancelled ones excepted)
create unique index supplier_invoices_dup_uq on purchase.supplier_invoices (party_id, lower(invoice_no)) where status <> 'Cancelled';

create table purchase.supplier_invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  supplier_invoice_id uuid not null references purchase.supplier_invoices (id) on delete cascade,
  line_no             int not null,
  po_line_id          uuid not null references purchase.purchase_order_lines (id),
  item_id             uuid not null references mdm.items (id),
  qty                 numeric(18,4) not null check (qty > 0),
  rate                numeric(18,4) not null check (rate > 0),
  gst_rate            numeric(5,2) not null,
  taxable             numeric(18,2) not null,
  tax                 numeric(18,2) not null,                 -- GST as charged on the invoice
  -- match result (PUR-009)
  po_rate             numeric(18,4),
  po_gst_rate         numeric(5,2),
  billable_qty        numeric(18,4),                          -- received − returned − already invoiced
  qty_variance        numeric(18,4),
  price_variance_pct  numeric(8,4),
  tax_variance        numeric(18,2),
  within_tolerance    boolean,
  match_notes         text,
  unique (supplier_invoice_id, line_no), unique (supplier_invoice_id, po_line_id)
);

alter table purchase.debit_notes add constraint debit_notes_invoice_fk foreign key (supplier_invoice_id) references purchase.supplier_invoices (id);

do $$
declare t text;
begin
  foreach t in array array['purchase.supplier_returns','purchase.supplier_invoices'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('SUPPLIER_RETURN', 'SRN', 6, 'Supplier return SRN/2026-27/000001'),
  ('DEBIT_NOTE', 'DN', 6, 'Debit note DN/2026-27/000001'),
  ('SUPPLIER_INVOICE', 'PINV', 6, 'Supplier invoice (internal) PINV/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('SUPPLIER_INVOICE', 'Supplier tax invoice', '{purchase.supplier_invoice}', false, false, 8)
on conflict (code) do nothing;

insert into sys.settings (key, value, description) values
  ('purchase.match.tolerances', '{"qtyPct": 0, "pricePct": 0.5, "taxAbs": 1}',
   'Three-way match tolerances (D06 defaults): invoice qty over the billable qty %, price ±% against the PO, GST difference in ₹ per line')
on conflict (key) do nothing;
