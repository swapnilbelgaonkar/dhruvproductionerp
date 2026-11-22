-- Stage 6 part 3 — receivables: customer receipts and allocation to invoices, cheque bounce, ageing, dealer statement,
-- credit exposure and the overdue order freeze (BRD p.7, p.19; MP §17.1–17.3; FIN-005, FIN-006, FIN-007, FIN-008; D18)
create schema if not exists fin;

create table fin.receipts (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique,
  legal_entity_id  uuid not null references org.legal_entities (id),
  party_id         uuid not null references mdm.parties (id),
  receipt_date     date not null,
  mode             text not null check (mode in ('NEFT','RTGS','IMPS','UPI','CHEQUE','DD','CASH')),
  reference        text,                    -- UTR / cheque or DD number; not for cash
  instrument_date  date,                    -- cheque / DD date
  drawee_bank      text,
  deposit_account  text,                    -- our bank account the money went into
  amount           numeric(18,2) not null check (amount > 0),
  allocated        numeric(18,2) not null default 0 check (allocated >= 0),
  status           text not null default 'Posted' check (status in ('Posted','Bounced','Cancelled')),
  status_reason    text,
  bounced_on       date,
  remarks          text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  version int not null default 1,
  check (allocated <= amount),
  check (mode = 'CASH' or reference is not null)
);
create index receipts_party_idx on fin.receipts (party_id, receipt_date);
-- the same UTR / cheque cannot be entered twice for a dealer
create unique index receipts_reference_uq on fin.receipts (legal_entity_id, party_id, mode, reference) where status <> 'Cancelled' and reference is not null;

create table fin.receipt_allocations (
  id           uuid primary key default gen_random_uuid(),
  receipt_id   uuid not null references fin.receipts (id),
  invoice_id   uuid not null references sales.invoices (id),
  amount       numeric(18,2) not null check (amount > 0),
  status       text not null default 'Active' check (status in ('Active','Reversed')),
  allocated_at timestamptz not null default now(),
  allocated_by uuid references iam.users (id),
  reversed_at  timestamptz,
  reversed_by  uuid references iam.users (id),
  reversal_reason text
);
create index receipt_allocations_invoice_idx on fin.receipt_allocations (invoice_id) where status = 'Active';

do $$
begin
  execute 'create trigger touch_row before update on fin.receipts for each row execute function sys.touch_row()';
  execute 'create trigger guard_status before update on fin.receipts for each row execute function sys.guard_status_change()';
end $$;

-- credit snapshot of a sales order now includes receivables (D18 exposure formula, doc 04 §4.10)
alter table sales.sales_orders add column outstanding_value numeric(18,2), add column overdue_value numeric(18,2), add column on_account_value numeric(18,2);

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('RECEIPT', 'RCT', 6, 'Customer receipt RCT/2026-27/000001')
on conflict (doc_type) do nothing;

insert into sys.settings (key, value, description) values
  ('sales.credit.overdueFreeze', 'true', 'D18 (BRD p.7, p.19): a dealer with an invoice unpaid beyond its due date (credit days) cannot have new orders submitted'),
  ('sales.credit.overdueGraceDays', '0', 'D18: days after the due date before the order freeze applies (0 = the day after the due date; provisional)'),
  ('finance.receipt.cashLimitPerDay', '199999', 'Income-tax s.269ST: cash accepted from one dealer in one day must stay below ₹2 lakh')
on conflict (key) do nothing;

insert into sys.document_types (code, name, entity_types, requires_expiry, sensitive, retention_years) values
  ('PAYMENT_ADVICE', 'Payment advice / bank slip / cheque copy', '{fin.receipt}', false, false, 8)
on conflict (code) do nothing;
