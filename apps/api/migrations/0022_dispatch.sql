-- Stage 6 part 1 — dispatch: transporters, shipments, picking by box scan, loading, documents, POD
-- (BRD p.17; MP §15.1–15.6; LOG-001…LOG-007, LOG-009…LOG-011, FIN-015)
create schema if not exists logistics;

alter table inv.stock_ledger drop constraint stock_ledger_txn_type_check;
alter table inv.stock_ledger add constraint stock_ledger_txn_type_check
  check (txn_type in ('GRN','GRN_REVERSAL','QC_RELEASE','QC_REJECT','QC_HOLD','SAMPLE','SUPPLIER_RETURN',
                      'ISSUE_TO_PROD','RETURN_FROM_PROD','PRODUCTION_OUTPUT','OPENING','QA_RELEASE','QA_REJECT','QA_HOLD','PACKING_LOSS','PACKING_ISSUE','RECALL_HOLD',
                      'DISPATCH','CUSTOMER_RETURN'));

create table logistics.transporters (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9-]{2,20}$'),
  name        text not null,
  gstin       text,
  pan         text,
  contact     text,
  phone       text,
  status      text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);

create table logistics.shipments (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique,
  sales_order_id   uuid not null references sales.sales_orders (id),
  legal_entity_id  uuid not null references org.legal_entities (id),
  party_id         uuid not null references mdm.parties (id),
  ship_to_id       uuid not null references mdm.party_addresses (id),
  warehouse_id     uuid not null references org.warehouses (id),
  planned_date     date not null,
  status           text not null default 'Planned' check (status in ('Planned','Picked','Dispatched','Delivered','Cancelled')),
  status_reason    text,
  transporter_id   uuid references logistics.transporters (id),
  vehicle_no       text,
  driver_name      text,
  driver_phone     text,
  freight_terms    text check (freight_terms in ('PAID','TO_PAY','TBB')),
  freight_amount   numeric(18,2),
  lr_no            text,
  lr_date          date,
  ewb_no           text check (ewb_no is null or ewb_no ~ '^[0-9]{12}$'),
  ewb_valid_until  date,
  dispatched_at    timestamptz,
  dispatched_by    uuid references iam.users (id),
  pod_received_on  date,
  pod_received_by  text,
  pod_document_id  uuid references sys.documents (id),
  pod_remarks      text,
  remarks          text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create index shipments_order_idx on logistics.shipments (sales_order_id);

create table logistics.shipment_lines (
  id             uuid primary key default gen_random_uuid(),
  shipment_id    uuid not null references logistics.shipments (id) on delete cascade,
  so_line_id     uuid not null references sales.sales_order_lines (id),
  item_pack_id   uuid not null references mdm.item_packs (id),
  planned_packs  numeric(18,4) not null check (planned_packs > 0),
  delivered_packs numeric(18,4),
  unique (shipment_id, so_line_id)
);

-- what was actually picked: whole boxes (scanned) or loose packs from a lot (LOG-002, LOG-009)
create table logistics.shipment_picks (
  id                uuid primary key default gen_random_uuid(),
  shipment_line_id  uuid not null references logistics.shipment_lines (id) on delete cascade,
  lot_id            uuid not null references inv.lots (id),
  box_id            uuid references inv.boxes (id),
  packs             numeric(18,4) not null check (packs > 0),
  qty               numeric(18,4) not null check (qty > 0),       -- in the lot's unit (packs × pack size)
  picked_by         uuid not null references iam.users (id),
  picked_at         timestamptz not null default now(),
  unique (box_id)
);
alter table inv.boxes add column shipment_id uuid references logistics.shipments (id);

do $$
declare t text;
begin
  foreach t in array array['logistics.transporters','logistics.shipments'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
  end loop;
  execute 'create trigger guard_status before update on logistics.shipments for each row execute function sys.guard_status_change()';
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('SHIPMENT', 'DSP', 6, 'Shipment / delivery challan DSP/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('POD', 'Proof of delivery (signed LR / challan)', '{logistics.shipment}', false, false, 8)
on conflict (code) do nothing;

insert into sys.settings (key, value, description) values
  ('logistics.ewb.thresholdValue', '50000', 'LOG-005: consignment value (₹, incl. GST) above which dispatch needs an e-way bill number (D08 provisional)')
on conflict (key) do nothing;
