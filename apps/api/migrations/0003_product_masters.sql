-- Stage 1 increment 2 — product master data (MDM-008…010, MP §5.1)
create schema if not exists mdm;

-- Units of measure. Physical units only; business packs live in mdm.item_packs.
create table mdm.uom (
  code      text primary key check (code ~ '^[A-Z0-9]{1,10}$'),
  name      text not null,
  dimension text not null check (dimension in ('MASS','VOLUME','COUNT','LENGTH','AREA')),
  decimals  int not null default 3 check (decimals between 0 and 6),
  status    text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid
);

create table mdm.hsn_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  kind        text not null default 'HSN' check (kind in ('HSN','SAC')),
  description text not null,
  status      text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

-- Effective-dated GST rates; no rate is hardcoded anywhere (MP Rule 3, D27). Periods never overlap per HSN.
create table mdm.tax_rates (
  id         uuid primary key default gen_random_uuid(),
  hsn_id     uuid not null references mdm.hsn_codes (id),
  gst_rate   numeric(5,2) not null check (gst_rate between 0 and 100),
  cess_rate  numeric(5,2) not null default 0 check (cess_rate between 0 and 100),
  valid_from date not null,
  valid_to   date,
  notes      text not null,
  created_at timestamptz not null default now(), created_by uuid,
  check (valid_to is null or valid_to >= valid_from),
  exclude using gist (hsn_id with =, daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&)
);
create trigger tax_rates_append_only before delete on mdm.tax_rates for each row execute function sys.deny_modify();

-- Product categories drive licence eligibility for dealers (BRD p.7; D08 to confirm the mapping).
create table mdm.product_categories (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  licence_required text not null default 'NONE' check (licence_required in ('NONE','FERTILIZER','PESTICIDE','BIOSTIMULANT')),
  status           text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table mdm.items (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  name              text not null,
  item_type         text not null check (item_type in ('FG','RM','PM','SEMI','LAB','SERVICE')),
  category_id       uuid references mdm.product_categories (id),
  base_uom          text not null references mdm.uom (code),
  hsn_id            uuid references mdm.hsn_codes (id),
  formulation       text,
  shelf_life_days   int check (shelf_life_days > 0),
  storage_class     text,
  lot_controlled    boolean not null default true,
  serial_controlled boolean not null default false,
  hazardous         boolean not null default false,
  status            text not null default 'Draft' check (status in ('Draft','Submitted','Active','Rejected','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table mdm.item_packs (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references mdm.items (id),
  pack_code     text not null check (pack_code ~ '^[A-Z0-9-]{1,20}$'),
  pack_size     numeric(18,4) not null check (pack_size > 0),
  pack_uom      text not null references mdm.uom (code),
  container     text not null,
  units_per_box int not null default 1 check (units_per_box > 0),
  gtin          text check (gtin ~ '^[0-9]{8,14}$'),
  status        text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  unique (item_id, pack_code)
);

-- Unit conversions: item_id null = universal conversion; otherwise item-specific (e.g. density kg <-> L).
create table mdm.uom_conversions (
  id        uuid primary key default gen_random_uuid(),
  item_id   uuid references mdm.items (id),
  from_uom  text not null references mdm.uom (code),
  to_uom    text not null references mdm.uom (code),
  factor    numeric(20,10) not null check (factor > 0),
  created_at timestamptz not null default now(), created_by uuid,
  check (from_uom <> to_uom)
);
create unique index uom_conv_uq on mdm.uom_conversions (coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid), from_uom, to_uom);

do $$
declare t text;
begin
  foreach t in array array['mdm.hsn_codes','mdm.product_categories','mdm.items'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
  end loop;
end $$;
create trigger guard_status before update on mdm.items for each row execute function sys.guard_status_change();

-- Reference units (physical constants only)
insert into mdm.uom (code, name, dimension, decimals) values
  ('KG','Kilogram','MASS',3), ('G','Gram','MASS',0), ('MT','Metric tonne','MASS',4),
  ('L','Litre','VOLUME',3), ('ML','Millilitre','VOLUME',0), ('KL','Kilolitre','VOLUME',4),
  ('NOS','Numbers','COUNT',0), ('BAG','Bag','COUNT',0), ('BOX','Box / carton','COUNT',0), ('DRUM','Drum','COUNT',0),
  ('POUCH','Pouch','COUNT',0), ('BTL','Bottle','COUNT',0), ('BKT','Bucket','COUNT',0), ('CAN','Can','COUNT',0);
insert into mdm.uom_conversions (from_uom, to_uom, factor) values
  ('G','KG',0.001), ('KG','G',1000), ('MT','KG',1000), ('KG','MT',0.001),
  ('ML','L',0.001), ('L','ML',1000), ('KL','L',1000), ('L','KL',0.001);
