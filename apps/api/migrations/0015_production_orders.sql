-- Stage 4 part 2 — production orders, reservations, material issue and the quarantine override
-- (BRD p.15, p.18; MP §11.6, §12.3, §12.5; MFG-005, MFG-007, MFG-009, MFG-013, INV-007, INV-009; D33 provisional)
create schema if not exists qa;

alter table inv.stock_ledger drop constraint stock_ledger_txn_type_check;
alter table inv.stock_ledger add constraint stock_ledger_txn_type_check
  check (txn_type in ('GRN','GRN_REVERSAL','QC_RELEASE','QC_REJECT','QC_HOLD','SAMPLE','SUPPLIER_RETURN',
                      'ISSUE_TO_PROD','RETURN_FROM_PROD','PRODUCTION_OUTPUT','OPENING'));

-- ---------------------------------------------------------------- production orders (MFG-005)
create table mfg.production_orders (
  id                 uuid primary key default gen_random_uuid(),
  doc_no             text not null unique,
  legal_entity_id    uuid not null references org.legal_entities (id),
  plant_id           uuid not null references org.plants (id),
  line_id            uuid not null references mfg.lines (id),
  item_id            uuid not null references mdm.items (id),
  bom_id             uuid not null references mfg.boms (id),
  bom_version_id     uuid references mfg.bom_versions (id),         -- fixed at release: the version in force that day
  planned_qty        numeric(18,3) not null check (planned_qty > 0),
  uom                text not null references mdm.uom (code),
  batch_count        int not null check (batch_count > 0),
  order_type         text not null check (order_type in ('MTS','MTO')),   -- make to stock / make to order (D03 hybrid)
  sales_order_id     uuid references sales.sales_orders (id),
  priority           text not null default 'NORMAL' check (priority in ('NORMAL','URGENT')),
  planned_start      date not null,
  due_date           date not null,
  shift_id           uuid references mfg.shifts (id),
  issue_warehouse_id uuid not null references org.warehouses (id),   -- raw material store
  fg_warehouse_id    uuid not null references org.warehouses (id),   -- where the output goes (WH-01, MFG-018)
  remarks            text,
  status             text not null default 'Draft' check (status in ('Draft','Submitted','Approved','Rejected','Released','InProgress','Completed','Closed','OnHold','Cancelled')),
  status_reason      text,
  shortage_accepted  boolean not null default false,
  approved_at        timestamptz,
  released_at        timestamptz,
  released_by        uuid references iam.users (id),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (due_date >= planned_start),
  check ((order_type = 'MTO') = (sales_order_id is not null))
);
create index production_orders_status_idx on mfg.production_orders (plant_id, status);

-- material requirement per formulation line, scaled to the order (fixed at release)
create table mfg.order_materials (
  id                  uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references mfg.production_orders (id) on delete cascade,
  bom_line_id         uuid not null references mfg.bom_lines (id),
  line_no             int not null,
  step_no             int not null,
  item_id             uuid not null references mdm.items (id),
  required_qty        numeric(18,4) not null check (required_qty > 0),
  uom                 text not null references mdm.uom (code),
  tolerance_pct       numeric(6,3) not null,
  unique (production_order_id, line_no)
);

-- ---------------------------------------------------------------- reservations (INV-007)
-- A reservation holds part of one lot for a requirement. Open quantity = qty − issued_qty.
-- Lots are locked (select … for update) while reserving, so the same stock is never reserved twice.
create table inv.reservations (
  id                uuid primary key default gen_random_uuid(),
  lot_id            uuid not null references inv.lots (id),
  item_id           uuid not null references mdm.items (id),
  warehouse_id      uuid not null references org.warehouses (id),
  bucket            text not null check (bucket in ('UNRESTRICTED','QUARANTINE')),   -- QUARANTINE only through an approved override (D33)
  qty               numeric(18,4) not null check (qty > 0),
  issued_qty        numeric(18,4) not null default 0 check (issued_qty >= 0),
  factor            numeric(12,6) not null default 1 check (factor > 0),               -- substitute: qty of this item per unit of the requirement
  source_type       text not null,
  source_id         uuid not null,
  source_line_id    uuid,
  override_id       uuid,
  status            text not null default 'Active' check (status in ('Active','Consumed','Cancelled')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (issued_qty <= qty)
);
create index reservations_lot_idx on inv.reservations (lot_id) where status = 'Active';
create index reservations_source_idx on inv.reservations (source_type, source_id);
create trigger touch_row before update on inv.reservations for each row execute function sys.touch_row();

-- ---------------------------------------------------------------- material issue and return (MFG-007)
create table mfg.material_movements (
  id                  uuid primary key default gen_random_uuid(),
  doc_no              text not null unique,
  production_order_id uuid not null references mfg.production_orders (id),
  direction           text not null check (direction in ('ISSUE','RETURN')),
  warehouse_id        uuid not null references org.warehouses (id),
  remarks             text,
  posted_at           timestamptz not null default now(),
  posted_by           uuid not null references iam.users (id)
);
create table mfg.material_movement_lines (
  id                   uuid primary key default gen_random_uuid(),
  movement_id          uuid not null references mfg.material_movements (id) on delete cascade,
  order_material_id    uuid not null references mfg.order_materials (id),
  reservation_id       uuid references inv.reservations (id),
  lot_id               uuid not null references inv.lots (id),
  item_id              uuid not null references mdm.items (id),
  bucket               text not null,
  qty                  numeric(18,4) not null check (qty > 0),
  unit_cost            numeric(18,4) not null default 0
);
create index material_movement_lines_lot_idx on mfg.material_movement_lines (lot_id);

-- ---------------------------------------------------------------- deviations (QA-005; used by the override, dosing and IPQC)
create table qa.deviations (
  id                  uuid primary key default gen_random_uuid(),
  doc_no              text not null unique,
  category            text not null check (category in ('QUARANTINE_OVERRIDE','DOSING_TOLERANCE','IPQC_FAILURE','PROCESS','OTHER')),
  title               text not null,
  description         text not null,
  production_order_id uuid references mfg.production_orders (id),
  lot_id              uuid references inv.lots (id),
  source_type         text not null,
  source_id           uuid not null,
  status              text not null default 'Open' check (status in ('Open','Closed')),
  raised_by           uuid references iam.users (id),
  closure_note        text,
  closed_by           uuid references iam.users (id),
  closed_at           timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
create index deviations_order_idx on qa.deviations (production_order_id, status);
create index deviations_lot_idx on qa.deviations (lot_id, status);

-- ---------------------------------------------------------------- quarantine-lock override (BRD p.15; D33 "allow with safeguards", provisional)
create table mfg.quarantine_overrides (
  id                  uuid primary key default gen_random_uuid(),
  doc_no              text not null unique,
  production_order_id uuid not null references mfg.production_orders (id),
  order_material_id   uuid not null references mfg.order_materials (id),
  lot_id              uuid not null references inv.lots (id),
  qty                 numeric(18,4) not null check (qty > 0),
  reason              text not null,
  status              text not null default 'Submitted' check (status in ('Submitted','Approved','Rejected','Cancelled')),
  status_reason       text,
  deviation_id        uuid references qa.deviations (id),
  requested_by        uuid not null references iam.users (id),
  decided_at          timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
alter table inv.reservations add constraint reservations_override_fk foreign key (override_id) references mfg.quarantine_overrides (id);

do $$
declare t text;
begin
  foreach t in array array['mfg.production_orders','mfg.quarantine_overrides','qa.deviations'] loop
    execute format('create trigger touch_row before update on %s for each row execute function sys.touch_row()', t);
    execute format('create trigger guard_status before update on %s for each row execute function sys.guard_status_change()', t);
  end loop;
end $$;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('PRODUCTION_ORDER', 'PRD', 6, 'Production order PRD/2026-27/000001'),
  ('MATERIAL_ISSUE', 'MIS', 6, 'Material issue to production MIS/2026-27/000001'),
  ('MATERIAL_RETURN', 'MRT', 6, 'Material return from production MRT/2026-27/000001'),
  ('QUARANTINE_OVERRIDE', 'QOV', 6, 'Quarantine-lock override QOV/2026-27/000001'),
  ('DEVIATION', 'DEV', 6, 'Deviation DEV/2026-27/000001')
on conflict (doc_type) do nothing;
