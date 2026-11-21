-- Stage 3 part 2 — RFQ, comparative statement and purchase orders (BRD p.8, p.13–14; MP §10.2–10.4; PUR-004…006, PUR-013/014; D06, D34)

-- ---------------------------------------------------------------- RFQ
create table purchase.rfqs (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  legal_entity_id uuid not null references org.legal_entities (id),
  warehouse_id    uuid not null references org.warehouses (id),
  response_due    date not null,
  notes           text,
  status          text not null default 'Draft' check (status in ('Draft','Issued','Awarded','Cancelled')),
  status_reason   text,
  issued_at       timestamptz,
  awarded_at      timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create table purchase.rfq_lines (
  id                  uuid primary key default gen_random_uuid(),
  rfq_id              uuid not null references purchase.rfqs (id) on delete cascade,
  line_no             int not null,
  item_id             uuid not null references mdm.items (id),
  uom                 text not null references mdm.uom (code),
  qty                 numeric(18,4) not null check (qty > 0),
  required_by         date,
  specification       text,
  requisition_line_id uuid references purchase.requisition_lines (id),
  unique (rfq_id, line_no), unique (rfq_id, item_id)
);
create table purchase.rfq_vendors (
  rfq_id   uuid not null references purchase.rfqs (id) on delete cascade,
  party_id uuid not null references mdm.parties (id),
  primary key (rfq_id, party_id)
);
-- A vendor's response, keyed in by purchase from the vendor's quotation document (MP §10.2)
create table purchase.vendor_quotes (
  id                 uuid primary key default gen_random_uuid(),
  rfq_id             uuid not null references purchase.rfqs (id),
  party_id           uuid not null references mdm.parties (id),
  quote_ref          text not null,
  quote_date         date not null,
  valid_until        date not null,
  payment_terms_days int not null check (payment_terms_days between 0 and 180),
  delivery_days      int not null check (delivery_days between 0 and 365),
  freight            numeric(18,2) not null default 0 check (freight >= 0),     -- added to landed cost, spread by value
  document_id        uuid references sys.documents (id),
  remarks            text,
  created_at timestamptz not null default now(), created_by uuid,
  unique (rfq_id, party_id),
  check (valid_until >= quote_date)
);
create table purchase.vendor_quote_lines (
  id             uuid primary key default gen_random_uuid(),
  vendor_quote_id uuid not null references purchase.vendor_quotes (id) on delete cascade,
  rfq_line_id    uuid not null references purchase.rfq_lines (id),
  rate           numeric(18,4) not null check (rate > 0),          -- per base unit, before GST
  discount_pct   numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  compliant      boolean not null default true,                    -- meets the specification (technical compliance)
  remarks        text,
  unique (vendor_quote_id, rfq_line_id)
);
-- Award per line, with the reason when the top-ranked bidder is not chosen (D34, X17)
create table purchase.rfq_awards (
  rfq_line_id     uuid primary key references purchase.rfq_lines (id),
  vendor_quote_id uuid not null references purchase.vendor_quotes (id),
  rank            int not null,
  score           numeric(6,2) not null,
  override_reason text,
  awarded_by      uuid not null references iam.users (id),
  awarded_at      timestamptz not null default now(),
  check (rank = 1 or override_reason is not null)
);

-- ---------------------------------------------------------------- purchase orders
create table purchase.purchase_orders (
  id                 uuid primary key default gen_random_uuid(),
  doc_no             text not null unique,
  party_id           uuid not null references mdm.parties (id),
  legal_entity_id    uuid not null references org.legal_entities (id),
  warehouse_id       uuid not null references org.warehouses (id),      -- ship to
  vendor_state       char(2) not null,
  place_of_supply    char(2) not null,
  inter_state        boolean not null,
  vendor_gst_registered boolean not null,
  po_date            date not null,
  delivery_date      date not null,
  payment_terms_days int not null check (payment_terms_days between 0 and 180),
  delivery_terms     text not null,
  notes              text,
  rfq_id             uuid references purchase.rfqs (id),
  emergency          boolean not null default false,
  status             text not null default 'Draft'
                     check (status in ('Draft','Submitted','Approved','Rejected','Issued','Lapsed','Acknowledged','PartiallyReceived','Received','Closed','Cancelled')),
  status_reason      text,
  issued_at          timestamptz,
  ack_due            date,
  acknowledged_at    timestamptz,
  vendor_ack_ref     text,
  sub_total          numeric(18,2) not null default 0,
  discount_total     numeric(18,2) not null default 0,
  taxable_total      numeric(18,2) not null default 0,
  cgst_total         numeric(18,2) not null default 0,
  sgst_total         numeric(18,2) not null default 0,
  igst_total         numeric(18,2) not null default 0,
  round_off          numeric(6,2) not null default 0,
  grand_total        numeric(18,2) not null default 0,
  approved_at        timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (delivery_date >= po_date)
);
create index purchase_orders_party_idx on purchase.purchase_orders (party_id);
create index purchase_orders_status_idx on purchase.purchase_orders (legal_entity_id, status);

create table purchase.purchase_order_lines (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references purchase.purchase_orders (id) on delete cascade,
  line_no             int not null,
  item_id             uuid not null references mdm.items (id),
  description         text not null,
  hsn_code            text,
  uom                 text not null references mdm.uom (code),
  qty                 numeric(18,4) not null check (qty > 0),
  rate                numeric(18,4) not null check (rate > 0),
  discount_pct        numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  net_rate            numeric(18,4) not null,
  taxable             numeric(18,2) not null,
  gst_rate            numeric(5,2) not null,
  cgst                numeric(18,2) not null default 0,
  sgst                numeric(18,2) not null default 0,
  igst                numeric(18,2) not null default 0,
  line_total          numeric(18,2) not null,
  delivery_date       date,
  requisition_line_id uuid references purchase.requisition_lines (id),
  rfq_line_id         uuid references purchase.rfq_lines (id),
  received_qty        numeric(18,4) not null default 0 check (received_qty >= 0),     -- goods receipt (part 3)
  unique (purchase_order_id, line_no)
);

do $$
declare t text;
begin
  foreach t in array array['purchase.rfqs','purchase.purchase_orders'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('RFQ', 'RFQ', 6, 'Request for quotation RFQ/2026-27/000001'),
  ('PURCHASE_ORDER', 'PO', 6, 'Purchase order PO/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.settings (key, value, description) values
  ('purchase.po.acceptanceDays', '7', 'Days the vendor has to acknowledge an issued PO before it must be re-issued (BRD p.13, PUR-013)'),
  ('purchase.rfq.weights', '{"price": 60, "leadTime": 20, "quality": 20}', 'RFQ comparison weights in % — landed cost, lead time, vendor quality rating (D34 provisional)'),
  ('purchase.defaultDeliveryTerms', '"Delivered to the warehouse named on this order; freight included unless stated"', 'Default delivery terms printed on purchase orders')
on conflict (key) do nothing;
