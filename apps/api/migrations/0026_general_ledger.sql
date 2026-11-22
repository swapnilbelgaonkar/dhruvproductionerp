-- Stage 6 part 5 — native general ledger (D02): chart of accounts, accounting periods with lock, double-entry journals posted idempotently from
-- the business documents and stock movements, manual journals, trial balance, P&L, balance sheet and GST summaries (BRD p.19; MP §18; FIN-013…FIN-020)

create table fin.accounts (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[0-9]{4,6}$'),
  name        text not null,
  type        text not null check (type in ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
  grp         text not null,              -- statement grouping, e.g. 'Current assets', 'Direct expenses'
  system_key  text unique,                -- used by the posting rules; null for accounts added by finance
  party_ledger boolean not null default false,   -- lines carry the dealer / vendor / transporter
  status      text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz not null default now(), created_by uuid
);

create table fin.periods (
  id               uuid primary key default gen_random_uuid(),
  legal_entity_id  uuid not null references org.legal_entities (id),
  period_start     date not null check (extract(day from period_start) = 1),
  period_end       date not null,
  status           text not null default 'Open' check (status in ('Open','Locked')),
  locked_at        timestamptz,
  locked_by        uuid references iam.users (id),
  unique (legal_entity_id, period_start)
);

create table fin.journals (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique,
  legal_entity_id  uuid not null references org.legal_entities (id),
  journal_date     date not null,
  source_type      text not null,         -- 'manual', 'sales.invoice', 'stock', …
  source_id        uuid,
  source_event     text not null,         -- 'posted', 'cancelled', 'stock:<ledger ids>' …
  source_ref       text,                  -- the document number shown in the ledger
  narration        text not null,
  status           text not null default 'Posted' check (status in ('Draft','Posted','Reversed','Cancelled')),
  reversal_of      uuid references fin.journals (id),
  original_date    date,                  -- set when the document's date fell in a locked period
  created_at timestamptz not null default now(), created_by uuid,
  posted_at  timestamptz, posted_by uuid references iam.users (id),
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1
);
-- idempotent posting: one journal per document event
create unique index journals_source_uq on fin.journals (source_type, source_id, source_event) where source_type <> 'manual';
create index journals_entity_date_idx on fin.journals (legal_entity_id, journal_date);

create table fin.journal_lines (
  id             bigint generated always as identity primary key,
  journal_id     uuid not null references fin.journals (id) on delete cascade,
  account_id     uuid not null references fin.accounts (id),
  debit          numeric(18,2) not null default 0 check (debit >= 0),
  credit         numeric(18,2) not null default 0 check (credit >= 0),
  party_id       uuid references mdm.parties (id),
  transporter_id uuid references logistics.transporters (id),
  narration      text,
  check ((debit > 0) <> (credit > 0))
);
create index journal_lines_account_idx on fin.journal_lines (account_id);
create index journal_lines_journal_idx on fin.journal_lines (journal_id);

-- every stock ledger row is valued into the GL exactly once
create table fin.stock_postings (
  stock_ledger_id bigint primary key references inv.stock_ledger (id),
  journal_id      uuid references fin.journals (id)      -- null when the movement was a transfer with no value change
);

-- a posted journal balances (checked at commit) and is never edited: corrections are reversals
create or replace function fin.check_balanced() returns trigger language plpgsql as $$
declare d numeric; c numeric; st text;
begin
  select status into st from fin.journals where id = new.journal_id;
  if st is distinct from 'Posted' then return null; end if;
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into d, c from fin.journal_lines where journal_id = new.journal_id;
  if d <> c or d = 0 then
    raise exception 'JOURNAL_NOT_BALANCED: journal % debits % credits %', new.journal_id, d, c using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger journal_balanced after insert or update on fin.journal_lines deferrable initially deferred
  for each row execute function fin.check_balanced();

create or replace function fin.guard_posted_lines() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from fin.journals where id = coalesce(old.journal_id, new.journal_id);
  if st in ('Posted','Reversed') then raise exception 'JOURNAL_IMMUTABLE: a posted journal cannot be changed; reverse it' using errcode = 'P0001'; end if;
  return coalesce(new, old);
end $$;
create trigger guard_posted_lines before update or delete on fin.journal_lines for each row execute function fin.guard_posted_lines();

-- no journal may be dated in a locked period
create or replace function fin.guard_locked_period() returns trigger language plpgsql as $$
begin
  if new.status = 'Posted' and exists (select 1 from fin.periods p where p.legal_entity_id = new.legal_entity_id and p.status = 'Locked'
       and new.journal_date between p.period_start and p.period_end) then
    raise exception 'PERIOD_LOCKED: % is in a locked period', new.journal_date using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger guard_locked_period before insert or update on fin.journals for each row execute function fin.guard_locked_period();
create trigger touch_row before update on fin.journals for each row execute function sys.touch_row();

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('JOURNAL', 'JV', 7, 'Journal voucher JV/2026-27/0000001')
on conflict (doc_type) do nothing;

-- Standard chart of accounts (Schedule III groupings). Finance can add accounts and rename; the system keys drive the automatic postings.
insert into fin.accounts (code, name, type, grp, system_key, party_ledger) values
  ('1100', 'Bank accounts', 'ASSET', 'Cash and bank balances', 'BANK', false),
  ('1110', 'Cash in hand', 'ASSET', 'Cash and bank balances', 'CASH', false),
  ('1200', 'Trade receivables — dealers', 'ASSET', 'Trade receivables', 'AR_TRADE', true),
  ('1300', 'Inventory — raw material', 'ASSET', 'Inventories', 'INV_RM', false),
  ('1310', 'Inventory — packing material', 'ASSET', 'Inventories', 'INV_PM', false),
  ('1320', 'Inventory — finished goods', 'ASSET', 'Inventories', 'INV_FG', false),
  ('1330', 'Work in progress', 'ASSET', 'Inventories', 'WIP', false),
  ('1340', 'Inventory — other stores', 'ASSET', 'Inventories', 'INV_OTHER', false),
  ('1400', 'Input CGST', 'ASSET', 'Other current assets', 'INPUT_CGST', false),
  ('1401', 'Input SGST', 'ASSET', 'Other current assets', 'INPUT_SGST', false),
  ('1402', 'Input IGST', 'ASSET', 'Other current assets', 'INPUT_IGST', false),
  ('1403', 'Input GST under reverse charge', 'ASSET', 'Other current assets', 'INPUT_GST_RCM', false),
  ('1404', 'Input GST — freight and services', 'ASSET', 'Other current assets', 'INPUT_GST_OTHER', false),
  ('2100', 'Trade payables — vendors', 'LIABILITY', 'Trade payables', 'AP_TRADE', true),
  ('2110', 'Trade payables — transporters', 'LIABILITY', 'Trade payables', 'AP_TRANSPORT', true),
  ('2200', 'Goods received, not invoiced', 'LIABILITY', 'Other current liabilities', 'GRNI', false),
  ('2300', 'Output CGST', 'LIABILITY', 'Duties and taxes', 'OUTPUT_CGST', false),
  ('2301', 'Output SGST', 'LIABILITY', 'Duties and taxes', 'OUTPUT_SGST', false),
  ('2302', 'Output IGST', 'LIABILITY', 'Duties and taxes', 'OUTPUT_IGST', false),
  ('2303', 'GST payable under reverse charge', 'LIABILITY', 'Duties and taxes', 'RCM_PAYABLE', false),
  ('2400', 'TDS payable', 'LIABILITY', 'Duties and taxes', 'TDS_PAYABLE', false),
  ('3100', 'Share capital', 'EQUITY', 'Equity', 'CAPITAL', false),
  ('3200', 'Opening balance equity', 'EQUITY', 'Equity', 'OPENING_EQUITY', false),
  ('3300', 'Retained earnings', 'EQUITY', 'Equity', 'RETAINED', false),
  ('4100', 'Sales — finished goods', 'INCOME', 'Revenue from operations', 'SALES', false),
  ('4110', 'Sales returns and allowances', 'INCOME', 'Revenue from operations', 'SALES_RETURNS', false),
  ('4900', 'Rounding off', 'INCOME', 'Other income', 'ROUND_OFF', false),
  ('5100', 'Cost of goods sold', 'EXPENSE', 'Cost of materials and goods sold', 'COGS', false),
  ('5200', 'Freight outward', 'EXPENSE', 'Other expenses', 'FREIGHT_OUTWARD', false),
  ('5300', 'Packing material consumed', 'EXPENSE', 'Cost of materials and goods sold', 'PACKING_CONSUMED', false),
  ('5310', 'Production losses', 'EXPENSE', 'Cost of materials and goods sold', 'PRODUCTION_LOSS', false),
  ('5320', 'QC samples consumed', 'EXPENSE', 'Other expenses', 'QC_SAMPLES', false),
  ('5330', 'Inventory adjustments and write-offs', 'EXPENSE', 'Other expenses', 'INVENTORY_ADJ', false)
on conflict (code) do nothing;
