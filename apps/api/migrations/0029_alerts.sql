-- Stage 7 part 2 — alerts and escalations (BRD p.6, p.19; MP §19.4; NOT-001…NOT-006, WF-008 approval SLA escalation)
-- A rule finds conditions (overdue approval, calibration due, expiring lot…), raises one alert per condition, notifies the owner and the
-- recipient roles in-app, escalates to the escalation roles (or the owner's manager) if nobody acknowledges in time, and resolves itself
-- when the condition clears. E-mail and WhatsApp delivery follow D11.

create table sys.alert_rules (
  code                 text primary key,
  name                 text not null,
  description          text not null,
  area                 text not null,
  enabled              boolean not null default true,
  params               jsonb not null default '{}',
  recipient_roles      text[] not null default '{}',
  escalate_after_hours int check (escalate_after_hours is null or escalate_after_hours > 0),
  escalate_roles       text[] not null default '{}',
  escalate_to_manager  boolean not null default false,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table sys.alerts (
  id              uuid primary key default gen_random_uuid(),
  rule_code       text not null references sys.alert_rules (code),
  subject_key     text not null,                 -- what the condition is about, unique per open alert of a rule
  subject_type    text,
  subject_id      uuid,
  subject_ref     text,
  severity        text not null check (severity in ('warning','critical')),
  title           text not null,
  body            text not null default '',
  link            text,
  raised_at       timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  notified_user_ids  uuid[] not null default '{}',
  escalated_at    timestamptz,
  escalated_user_ids uuid[] not null default '{}',
  acknowledged_at timestamptz,
  acknowledged_by uuid references iam.users (id),
  ack_note        text,
  resolved_at     timestamptz
);
create unique index alerts_open_uq on sys.alerts (rule_code, subject_key) where resolved_at is null;
create index alerts_users_idx on sys.alerts using gin (notified_user_ids);
create index alerts_esc_users_idx on sys.alerts using gin (escalated_user_ids);

insert into sys.alert_rules (code, name, description, area, params, recipient_roles, escalate_after_hours, escalate_roles, escalate_to_manager) values
  ('APPROVAL_OVERDUE', 'Approval past its SLA', 'An approval step is still pending after its SLA hours. The approvers are reminded; if it stays unacknowledged it escalates to their reporting manager.',
   'Workflow', '{}', '{}', 24, '{EXEC_ADMIN}', true),
  ('CALIBRATION_DUE', 'Instrument calibration due', 'An active instrument is due for calibration within the lead days, or overdue (it is then locked for results).',
   'QC', '{"daysBefore": 7}', '{QC_MANAGER,QC_HEAD}', 48, '{QA_HEAD}', false),
  ('LOT_EXPIRY', 'Stock nearing expiry', 'A lot with stock expires within the lead days, or has expired.', 'Inventory', '{"daysBefore": 30}', '{STORES_HEAD,QA_MANAGER}', 72, '{PLANT_HEAD}', false),
  ('QUARANTINE_HOLD', 'Lot held in quarantine too long', 'A lot has waited in quarantine longer than the hours set (BRD KPI: 48 hours) for a QC or QA decision.',
   'Quality', '{"hours": 48}', '{QC_HEAD,QC_MANAGER}', 24, '{QA_HEAD,PLANT_HEAD}', false),
  ('RECEIVABLE_DUE', 'Dealer payment due or overdue', 'A dealer invoice falls due within the lead days (reminder to the sales owner) or is overdue (to accounts as well).',
   'Finance', '{"daysBefore": 3}', '{ACCOUNTS_EXEC}', 72, '{CREDIT_CONTROLLER,FINANCE_HEAD}', false),
  ('DEALER_FROZEN', 'Dealer order-taking frozen', 'A dealer has an invoice unpaid beyond its credit days plus the grace days, so new orders are refused (D18).',
   'Finance', '{}', '{CREDIT_CONTROLLER}', 72, '{FINANCE_HEAD}', false),
  ('PAYABLE_DUE', 'Bill to pay due or overdue', 'An approved supplier invoice or freight bill falls due within the lead days, or is overdue.',
   'Finance', '{"daysBefore": 3}', '{ACCOUNTS_EXEC}', 48, '{FINANCE_HEAD}', false),
  ('PO_DELIVERY_LATE', 'Purchase order delivery late', 'An issued purchase order line is past its delivery date with quantity still to receive.',
   'Procurement', '{"graceDays": 0}', '{PURCHASE_EXEC}', 72, '{PURCHASE_HEAD}', false),
  ('CAPA_OVERDUE', 'CAPA overdue', 'A corrective or preventive action is past its due date and not closed.', 'Quality', '{}', '{QA_MANAGER}', 48, '{QA_HEAD}', false),
  ('POD_PENDING', 'Proof of delivery pending', 'A dispatched shipment has no proof of delivery after the days set.', 'Logistics', '{"days": 7}', '{LOGISTICS_EXEC}', 72, '{LOGISTICS_HEAD}', false)
on conflict (code) do nothing;
