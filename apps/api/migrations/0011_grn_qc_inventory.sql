-- Stage 3 part 3 — goods receipt, quarantine, QC lot release, stock ledger
-- (BRD p.14–15; MP §10.5, Part 11, Part 13; PUR-008, INV-001…, QC-001…; roadmap rule: quarantine + QC release ship with receipt)

create schema if not exists inv;
create schema if not exists qc;

-- ---------------------------------------------------------------- lots
create table inv.lots (
  id             uuid primary key default gen_random_uuid(),
  lot_no         text not null unique,
  item_id        uuid not null references mdm.items (id),
  party_id       uuid references mdm.parties (id),                  -- supplier
  vendor_lot_no  text,
  mfg_date       date,
  expiry_date    date,
  source_type    text not null check (source_type in ('GRN','PRODUCTION','OPENING')),
  source_id      uuid not null,
  qc_status      text not null default 'Quarantine' check (qc_status in ('Quarantine','Released','Rejected','Hold')),
  qc_decided_by  uuid references iam.users (id),
  qc_decided_at  timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  check (expiry_date is null or mfg_date is null or expiry_date > mfg_date)
);
create index lots_item_idx on inv.lots (item_id, qc_status);

-- ---------------------------------------------------------------- stock ledger (append-only; balances are sums)
create table inv.stock_ledger (
  id           bigint generated always as identity primary key,
  posted_at    timestamptz not null default now(),
  item_id      uuid not null references mdm.items (id),
  lot_id       uuid not null references inv.lots (id),
  warehouse_id uuid not null references org.warehouses (id),
  bucket       text not null check (bucket in ('QUARANTINE','UNRESTRICTED','REJECTED','BLOCKED')),
  qty          numeric(18,4) not null check (qty <> 0),               -- base unit, signed
  unit_cost    numeric(18,4) not null default 0,
  txn_type     text not null check (txn_type in ('GRN','GRN_REVERSAL','QC_RELEASE','QC_REJECT','QC_HOLD','SAMPLE')),
  source_type  text not null,
  source_id    uuid not null,
  created_by   uuid
);
create index stock_ledger_item_idx on inv.stock_ledger (item_id, warehouse_id);
create index stock_ledger_lot_idx on inv.stock_ledger (lot_id);
create trigger deny_modify before update or delete on inv.stock_ledger for each row execute function sys.deny_modify();

create view inv.stock_balances as
  select item_id, lot_id, warehouse_id, bucket, sum(qty) as qty, sum(qty * unit_cost) as value
    from inv.stock_ledger group by item_id, lot_id, warehouse_id, bucket having sum(qty) <> 0;

-- ---------------------------------------------------------------- goods receipt
create table purchase.goods_receipts (
  id                uuid primary key default gen_random_uuid(),
  doc_no            text not null unique,
  purchase_order_id uuid not null references purchase.purchase_orders (id),
  party_id          uuid not null references mdm.parties (id),
  warehouse_id      uuid not null references org.warehouses (id),
  receipt_date      date not null,
  challan_no        text not null,
  challan_date      date,
  vendor_invoice_no text,
  vehicle_no        text,
  remarks           text,
  status            text not null default 'Draft' check (status in ('Draft','Posted','Cancelled')),
  status_reason     text,
  posted_at         timestamptz,
  posted_by         uuid references iam.users (id),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create index goods_receipts_po_idx on purchase.goods_receipts (purchase_order_id);

create table purchase.goods_receipt_lines (
  id               uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid not null references purchase.goods_receipts (id) on delete cascade,
  line_no          int not null,
  po_line_id       uuid not null references purchase.purchase_order_lines (id),
  item_id          uuid not null references mdm.items (id),
  uom              text not null references mdm.uom (code),
  challan_qty      numeric(18,4) not null check (challan_qty >= 0),   -- as per the vendor's challan
  received_qty     numeric(18,4) not null check (received_qty > 0),   -- physically counted / weighed
  vendor_lot_no    text,
  mfg_date         date,
  expiry_date      date,
  lot_id           uuid references inv.lots (id),
  unique (goods_receipt_id, line_no)
);

do $$
declare t text;
begin
  foreach t in array array['purchase.goods_receipts'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- QC inspection of received lots
create table qc.inspections (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  lot_id          uuid not null unique references inv.lots (id),
  item_id         uuid not null references mdm.items (id),
  source_type     text not null default 'GRN',
  source_id       uuid not null,
  status          text not null default 'Pending' check (status in ('Pending','Sampled','Tested','Released','Rejected','Hold')),
  sample_qty      numeric(18,4) check (sample_qty >= 0),
  sampled_by      uuid references iam.users (id),
  sampled_at      timestamptz,
  coa_document_id uuid references sys.documents (id),                -- vendor's certificate of analysis
  coa_received    boolean not null default false,
  tested_by       uuid references iam.users (id),
  tested_at       timestamptz,
  recommendation  text check (recommendation in ('Release','Reject','Hold')),
  decision        text check (decision in ('Release','Reject','Hold')),
  decision_remarks text,
  decided_by      uuid references iam.users (id),
  decided_at      timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create trigger touch_row before update on qc.inspections for each row execute function sys.touch_row();
create trigger guard_status before update on qc.inspections for each row execute function sys.guard_status_change();

create table qc.inspection_results (
  id            uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references qc.inspections (id) on delete cascade,
  seq           int not null,
  parameter     text not null,
  specification text not null,
  result        text not null,
  pass          boolean not null,
  unique (inspection_id, seq)
);

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('GRN', 'GRN', 6, 'Goods receipt GRN/2026-27/000001'),
  ('LOT', 'LOT', 6, 'Lot LOT/2026-27/000001'),
  ('QC_INSPECTION', 'QCI', 6, 'QC inspection QCI/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('COA', 'Certificate of analysis (vendor)', '{qc.inspection}', false, false, 8),
  ('DELIVERY_CHALLAN', 'Delivery challan / weighbridge slip', '{purchase.goods_receipt}', false, false, 8)
on conflict (code) do nothing;

insert into sys.settings (key, value, description) values
  ('purchase.grn.overReceiptPct', '2', 'Receipt tolerance above the ordered quantity, % (D06 default qty +2% / −0%)')
on conflict (key) do nothing;
