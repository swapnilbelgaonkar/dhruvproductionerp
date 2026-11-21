-- Stage 4 part 5 — packing runs with box serials and QR labels, batch cost sheet, downtime
-- (BRD p.17–18 sub-modules 1, 10, 14, 15; MP §12.1, §12.7; MFG-002, MFG-011, MFG-014, MFG-015, QR-001/002; D24 box level; D32 actual cost; D23 KPIs provisional)

alter table inv.stock_ledger drop constraint stock_ledger_txn_type_check;
alter table inv.stock_ledger add constraint stock_ledger_txn_type_check
  check (txn_type in ('GRN','GRN_REVERSAL','QC_RELEASE','QC_REJECT','QC_HOLD','SAMPLE','SUPPLIER_RETURN',
                      'ISSUE_TO_PROD','RETURN_FROM_PROD','PRODUCTION_OUTPUT','OPENING','QA_RELEASE','QA_REJECT','QA_HOLD','PACKING_LOSS','PACKING_ISSUE'));

-- ---------------------------------------------------------------- packing (MFG-011)
create table mfg.packing_runs (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  lot_id          uuid not null references inv.lots (id),          -- the finished-goods (bulk) lot being packed
  item_pack_id    uuid not null references mdm.item_packs (id),
  line_id         uuid references mfg.lines (id),
  packs_filled    int not null check (packs_filled > 0),
  packs_rejected  int not null default 0 check (packs_rejected >= 0),
  spillage_qty    numeric(18,3) not null default 0 check (spillage_qty >= 0),   -- in the lot's unit
  packed_qty      numeric(18,3) not null,                                       -- packs × pack size, in the lot's unit
  box_count       int not null,
  pm_cost         numeric(18,2) not null default 0,
  remarks         text,
  posted_at       timestamptz not null default now(),
  posted_by       uuid not null references iam.users (id)
);
create index packing_runs_lot_idx on mfg.packing_runs (lot_id);

create table mfg.packing_materials (
  id              uuid primary key default gen_random_uuid(),
  packing_run_id  uuid not null references mfg.packing_runs (id) on delete cascade,
  lot_id          uuid not null references inv.lots (id),
  item_id         uuid not null references mdm.items (id),
  warehouse_id    uuid not null references org.warehouses (id),
  qty             numeric(18,4) not null check (qty > 0),
  unit_cost       numeric(18,4) not null default 0
);

-- box-level serialisation (D24) with a signed QR payload (QR-002: HMAC verified by the server)
create table inv.boxes (
  id              uuid primary key default gen_random_uuid(),
  serial          text not null unique,
  lot_id          uuid not null references inv.lots (id),
  item_pack_id    uuid not null references mdm.item_packs (id),
  packing_run_id  uuid not null references mfg.packing_runs (id),
  units           int not null check (units > 0),
  signature       text not null,
  status          text not null default 'Packed' check (status in ('Packed','Dispatched','Destroyed')),
  created_at      timestamptz not null default now()
);
create index boxes_lot_idx on inv.boxes (lot_id);

-- ---------------------------------------------------------------- downtime (MFG-014)
create table mfg.downtime_events (
  id           uuid primary key default gen_random_uuid(),
  line_id      uuid not null references mfg.lines (id),
  started_at   timestamptz not null,
  ended_at     timestamptz not null,
  reason       text not null check (reason in ('BREAKDOWN','CLEANING_CIP','CHANGEOVER','NO_MATERIAL','POWER','PLANNED_MAINTENANCE','QUALITY_HOLD','OTHER')),
  remarks      text,
  batch_id     uuid references mfg.batches (id),
  recorded_by  uuid not null references iam.users (id),
  recorded_at  timestamptz not null default now(),
  check (ended_at > started_at)
);
create index downtime_line_idx on mfg.downtime_events (line_id, started_at);

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('PACKING_RUN', 'PKR', 6, 'Packing run PKR/2026-27/000001'),
  ('BOX', 'BX', 8, 'Box serial BX/2026-27/00000001')
on conflict (doc_type) do nothing;

insert into sys.settings (key, value, description) values
  ('mfg.conversionCost', '{"energyPerHour": 0, "labourPerHour": 0, "overheadPerHour": 0}',
   'Conversion cost per batch hour (D32: actual cost = material + energy + labour + packaging + overhead). Rates in ₹ per hour of batch time; to be set by finance')
on conflict (key) do nothing;
