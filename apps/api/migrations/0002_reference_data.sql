-- Reference data that every installation needs. No personal or business records here.

insert into sys.settings (key, value, description) values
  ('auth.lockout.maxAttempts', '5', 'Failed logins before the account is locked'),
  ('auth.lockout.minutes', '15', 'Lockout duration in minutes'),
  ('auth.session.idleMinutes', '30', 'Session idle timeout in minutes'),
  ('auth.session.absoluteHours', '12', 'Session absolute lifetime in hours'),
  ('sales.quotation.validityDays', '7', 'Quotation validity in days (BRD p.13; D16)'),
  ('approvals.defaultSlaHours', '24', 'Default SLA for an approval step');

insert into sys.number_series_formats (doc_type, prefix, padding, description) values
  ('APPROVAL', 'APR', 6, 'Approval requests'),
  ('DEALER', 'DLR', 4, 'Dealer codes (BRD p.8 format DLR-2026-884)');

-- BRD territory jurisdictions (p.3–4). Configurable; D37 pending.
insert into org.territory_levels (level, name, tier_hint) values
  (1, 'National', 'BH / NSM'), (2, 'Zone Cluster', 'DSM'), (3, 'Zone', 'ZSM'), (4, 'State', 'RSM'),
  (5, 'District Cluster', 'SASM'), (6, 'District', 'ASM'), (7, 'Taluka', 'TSM'), (8, 'Beat', 'SE');

-- Sales authority limits exactly as BRD p.3–4. INACTIVE until approved (D15).
insert into iam.authority_limits (tier, rank, title, max_discount_pct, max_order_value, can_approve) values
  ('BH',   1, 'Business Head',             null,  null,       true),
  ('NSM',  2, 'National Sales Manager',    25.00, 1000000.00, true),
  ('DSM',  3, 'Deputy Sales Manager',      20.00,  750000.00, true),
  ('ZSM',  4, 'Zonal Sales Manager',       15.00,  500000.00, true),
  ('RSM',  5, 'Regional Sales Manager',    12.00,  350000.00, true),
  ('SASM', 6, 'Senior Area Sales Manager', 10.00,  250000.00, true),
  ('ASM',  7, 'Area Sales Manager',         7.00,  150000.00, true),
  ('TSM',  8, 'Territory Sales Manager',    5.00,   75000.00, true),
  ('SE',   9, 'Sales Executive',            0.00,       0.00, false);
