-- Stage 2 part 3 — pricing and quotations (BRD §4 #9, §5.1 p.13; MP Parts 7.7 and 8; CRM-010, QUO-001…007)

-- Price lists per dealer price group, effective-dated, maker-checker (Sales head + Finance head).
create table sales.price_lists (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  price_group text not null check (price_group ~ '^[A-Z0-9_-]{1,30}$'),
  valid_from  date not null,
  valid_to    date,
  notes       text,
  status      text not null default 'Draft' check (status in ('Draft','Submitted','Active','Rejected','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (valid_to is null or valid_to >= valid_from)
);
create index price_lists_group_idx on sales.price_lists (price_group, status);

create table sales.price_list_items (
  id            uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references sales.price_lists (id),
  item_pack_id  uuid not null references mdm.item_packs (id),
  rate          numeric(18,2) not null check (rate > 0),          -- per pack, before GST
  created_at timestamptz not null default now(), created_by uuid,
  unique (price_list_id, item_pack_id)
);

-- Volume slabs (BRD §4 #9 "slab discounts"): scheme discount from a minimum quantity of packs.
create table sales.price_slabs (
  id                 uuid primary key default gen_random_uuid(),
  price_list_item_id uuid not null references sales.price_list_items (id) on delete cascade,
  min_qty            numeric(18,4) not null check (min_qty > 0),
  discount_pct       numeric(5,2) not null check (discount_pct > 0 and discount_pct < 100),
  unique (price_list_item_id, min_qty)
);

create table sales.quotations (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null,
  revision         int not null default 1,
  party_id         uuid not null references mdm.parties (id),
  legal_entity_id  uuid not null references org.legal_entities (id),
  seller_state     char(2) not null,
  bill_to_id       uuid not null references mdm.party_addresses (id),
  ship_to_id       uuid not null references mdm.party_addresses (id),
  place_of_supply  char(2) not null,
  inter_state      boolean not null,
  quote_date       date not null,
  valid_until      date not null,
  price_list_id    uuid references sales.price_lists (id),
  contact_person   text,
  payment_terms    text not null,
  delivery_terms   text not null,
  notes            text,
  sales_owner_id   uuid not null references org.employees (id),
  territory_id     uuid not null references org.territories (id),
  opportunity_id   uuid references sales.opportunities (id),
  status           text not null default 'Draft'
                   check (status in ('Draft','Submitted','Approved','Sent','Accepted','Converted','Rejected','Expired','Superseded','Cancelled')),
  status_reason    text,
  needs_approval   boolean not null default false,
  max_extra_discount numeric(5,2) not null default 0,
  sub_total        numeric(18,2) not null default 0,     -- at list rates
  discount_total   numeric(18,2) not null default 0,
  taxable_total    numeric(18,2) not null default 0,
  cgst_total       numeric(18,2) not null default 0,
  sgst_total       numeric(18,2) not null default 0,
  igst_total       numeric(18,2) not null default 0,
  round_off        numeric(6,2) not null default 0,
  grand_total      numeric(18,2) not null default 0,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  unique (doc_no, revision),
  check (valid_until >= quote_date)
);
create index quotations_party_idx on sales.quotations (party_id);
create index quotations_territory_idx on sales.quotations (territory_id);

create table sales.quotation_lines (
  id                uuid primary key default gen_random_uuid(),
  quotation_id      uuid not null references sales.quotations (id) on delete cascade,
  line_no           int not null,
  item_pack_id      uuid not null references mdm.item_packs (id),
  description       text not null,
  hsn_code          text not null,
  pack_label        text not null,
  qty               numeric(18,4) not null check (qty > 0),        -- number of packs
  list_rate         numeric(18,2) not null,
  scheme_discount_pct numeric(5,2) not null default 0,
  extra_discount_pct  numeric(5,2) not null default 0 check (extra_discount_pct between 0 and 100),
  rate              numeric(18,2) not null,                          -- net per pack
  taxable           numeric(18,2) not null,
  gst_rate          numeric(5,2) not null,
  cgst              numeric(18,2) not null default 0,
  sgst              numeric(18,2) not null default 0,
  igst              numeric(18,2) not null default 0,
  line_total        numeric(18,2) not null,
  unique (quotation_id, line_no)
);

do $$
declare t text;
begin
  foreach t in array array['sales.price_lists','sales.quotations'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('QUOTATION', 'QT', 6, 'Quotation QT/2026-27/000001'),
  ('PRICE_LIST_CODE', 'PL', 3, 'Price list PL-2026-001')
on conflict (doc_type) do nothing;

insert into sys.settings (key, value, description) values
  ('sales.defaultPaymentTerms', '"Payment within credit days from invoice date"', 'Default payment terms printed on quotations'),
  ('sales.defaultDeliveryTerms', '"Ex-works Chakan; freight as per agreement"', 'Default delivery terms printed on quotations'),
  ('company.bankDetails', '""', 'Bank details printed on quotations and invoices (leave empty to omit)')
on conflict (key) do nothing;
