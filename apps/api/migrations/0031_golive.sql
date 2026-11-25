-- Stage 8 — go-live: bulk import of masters, opening balances at cut-over (D10), two-factor recovery codes, readiness settings.
-- Opening balances are loaded once, at the cut-over date:
--   * the trial balance as a posted opening journal (every account except inventory, which comes from the stock import);
--   * stock by lot, valued, into its warehouse and QC status (stock movement OPENING, posted against opening balance equity);
--   * open dealer invoices and open vendor bills, so collections, credit control, ageing and payments carry on from the old system.
-- The open bills do not post to the ledger again — the trial balance already holds them; the readiness check compares the two.

alter table sales.invoices alter column sales_order_id drop not null, alter column shipment_id drop not null,
  add column if not exists is_opening boolean not null default false, add column if not exists opening_ref text;
alter table sales.invoices add constraint invoices_source_chk check (is_opening or (sales_order_id is not null and shipment_id is not null));

alter table purchase.supplier_invoices alter column purchase_order_id drop not null,
  add column if not exists is_opening boolean not null default false, add column if not exists legal_entity_id uuid references org.legal_entities (id);
alter table purchase.supplier_invoices add constraint supplier_invoices_source_chk
  check ((is_opening and legal_entity_id is not null) or (not is_opening and purchase_order_id is not null));

create table sys.import_runs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  file_name    text,
  status       text not null check (status in ('Validated','Committed','Failed')),
  row_count    int not null default 0,
  errors       jsonb not null default '[]',
  summary      jsonb not null default '{}',
  created_at   timestamptz not null default now(), created_by uuid references iam.users (id),
  committed_at timestamptz
);

create table iam.mfa_recovery_codes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references iam.users (id),
  code_hash  text not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index mfa_recovery_codes_user_idx on iam.mfa_recovery_codes (user_id) where used_at is null;

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('OPENING_AR', 'OB', 5, 'Open dealer invoice brought forward at go-live OB/2026-27/00001'),
  ('OPENING_AP', 'OBP', 5, 'Open vendor bill brought forward at go-live OBP/2026-27/00001')
on conflict (doc_type) do nothing;

insert into sys.settings (key, value, description) values
  ('app.publicUrl', '""', 'Address of the ERP as users open it (https://erp.example.in), used for links in e-mails and messages'),
  ('golive.cutoverDate', 'null', 'D10: the date the ERP takes over — opening balances are as at the end of the day before'),
  ('golive.signoff', '{}', 'Go-live sign-off: who accepted each manual checklist item and when')
on conflict (key) do nothing;

-- Two-factor sign-in is built (authenticator app, recovery codes, role requirement) but ships switched off, as asked for the
-- pre-go-live period. The go-live checklist shows it as not ready until an administrator switches it on (Administration → Configuration).
update sys.settings set value = 'false',
  description = 'Two-factor sign-in (authenticator app) for roles that require it and for users who enrolled. Off until go-live; switch on in the go-live step.'
  where key = 'auth.mfa.enforced';
