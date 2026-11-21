-- Stage 4 part 4 — QA batch review and finished-goods release (BRD p.4, p.16; MP §14.2; QA-003, QA-004; TC-13; D04 provisional)

alter table inv.stock_ledger drop constraint stock_ledger_txn_type_check;
alter table inv.stock_ledger add constraint stock_ledger_txn_type_check
  check (txn_type in ('GRN','GRN_REVERSAL','QC_RELEASE','QC_REJECT','QC_HOLD','SAMPLE','SUPPLIER_RETURN',
                      'ISSUE_TO_PROD','RETURN_FROM_PROD','PRODUCTION_OUTPUT','OPENING','QA_RELEASE','QA_REJECT','QA_HOLD'));

-- QC's decision on a finished-goods lot is a recommendation; QA disposes (QC approved → QA release)
alter table qc.inspections drop constraint if exists inspections_status_check;
alter table qc.inspections add constraint inspections_status_check
  check (status in ('Pending','Sampled','Tested','Released','Rejected','Hold','QcApproved'));

-- every QA disposition, with the review checklist as it stood (QA-003/004)
create table qa.batch_dispositions (
  id               uuid primary key default gen_random_uuid(),
  lot_id           uuid not null references inv.lots (id),
  batch_id         uuid not null references mfg.batches (id),
  decision         text not null check (decision in ('Released','OnHold','Rejected','ReworkAuthorised')),
  remarks          text,
  checklist        jsonb not null,
  decided_by       uuid not null references iam.users (id),
  decided_at       timestamptz not null default now()
);
create index batch_dispositions_lot_idx on qa.batch_dispositions (lot_id);

alter table inv.lots add column if not exists qa_disposition text check (qa_disposition in ('Released','OnHold','Rejected','ReworkAuthorised'));
