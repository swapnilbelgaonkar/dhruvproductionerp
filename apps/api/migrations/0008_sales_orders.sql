-- Stage 2 part 4 — sales orders (BRD §4 #10, §5.2; MP Part 9; SO-001…011, D01 hybrid approval)

create table sales.sales_orders (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique,
  party_id         uuid not null references mdm.parties (id),
  legal_entity_id  uuid not null references org.legal_entities (id),
  seller_state     char(2) not null,
  bill_to_id       uuid not null references mdm.party_addresses (id),
  ship_to_id       uuid not null references mdm.party_addresses (id),
  place_of_supply  char(2) not null,
  inter_state      boolean not null,
  order_date       date not null,
  required_by      date,
  dealer_po_no     text,
  dealer_po_date   date,
  quotation_id     uuid references sales.quotations (id),   -- set when converted from a quotation (prices locked to it)
  price_list_id    uuid references sales.price_lists (id),
  contact_person   text,
  payment_terms    text not null,
  delivery_terms   text not null,
  notes            text,
  sales_owner_id   uuid not null references org.employees (id),
  territory_id     uuid not null references org.territories (id),
  opportunity_id   uuid references sales.opportunities (id),
  status           text not null default 'Draft'
                   check (status in ('Draft','Submitted','Approved','Rejected','Cancelled','Closed')),
  status_reason    text,
  max_extra_discount numeric(5,2) not null default 0,
  -- credit snapshot at submission (receivables join in Stage 6, D18)
  credit_limit     numeric(18,2),
  open_order_value numeric(18,2),
  over_credit_limit boolean not null default false,
  sub_total        numeric(18,2) not null default 0,
  discount_total   numeric(18,2) not null default 0,
  taxable_total    numeric(18,2) not null default 0,
  cgst_total       numeric(18,2) not null default 0,
  sgst_total       numeric(18,2) not null default 0,
  igst_total       numeric(18,2) not null default 0,
  round_off        numeric(6,2) not null default 0,
  grand_total      numeric(18,2) not null default 0,
  approved_at      timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (required_by is null or required_by >= order_date)
);
create index sales_orders_party_idx on sales.sales_orders (party_id);
create index sales_orders_territory_idx on sales.sales_orders (territory_id);
-- a quotation converts to at most one live order
create unique index sales_orders_quotation_uq on sales.sales_orders (quotation_id) where quotation_id is not null and status <> 'Cancelled';

create table sales.sales_order_lines (
  id                uuid primary key default gen_random_uuid(),
  sales_order_id    uuid not null references sales.sales_orders (id) on delete cascade,
  line_no           int not null,
  item_pack_id      uuid not null references mdm.item_packs (id),
  description       text not null,
  hsn_code          text not null,
  pack_label        text not null,
  qty               numeric(18,4) not null check (qty > 0),
  list_rate         numeric(18,2) not null,
  scheme_discount_pct numeric(5,2) not null default 0,
  extra_discount_pct  numeric(5,2) not null default 0 check (extra_discount_pct between 0 and 100),
  rate              numeric(18,2) not null,
  taxable           numeric(18,2) not null,
  gst_rate          numeric(5,2) not null,
  cgst              numeric(18,2) not null default 0,
  sgst              numeric(18,2) not null default 0,
  igst              numeric(18,2) not null default 0,
  line_total        numeric(18,2) not null,
  dispatched_qty    numeric(18,4) not null default 0 check (dispatched_qty >= 0),  -- filled by dispatch (Stage 5)
  unique (sales_order_id, line_no)
);

create trigger touch_row before update on sales.sales_orders for each row execute function sys.touch_row();
create trigger guard_status before update on sales.sales_orders for each row execute function sys.guard_status_change();

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('SALES_ORDER', 'SO', 6, 'Sales order SO/2026-27/000001')
on conflict (doc_type) do nothing;
