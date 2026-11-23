-- Stage 7 part 1 — management dashboard and reports (MIS-001…MIS-008). KPI thresholds from BRD p.6, provisional until the KPI workshop (D23).
insert into sys.settings (key, value, description) values
  ('mis.kpiThresholds', '{"pipelineGreenAbove": 5000000, "pipelineRedBelow": 2000000, "activeOrdersAmberAbove": 15, "oeeGreenAbove": 85, "oeeAmberAbove": 65, "quarantineRedHours": 48, "overdueRedAbove": 1000000, "pendingDispatchAmberAbove": 10}',
   'MIS-007 / D23: executive KPI card thresholds (BRD p.6): pipeline green > ₹50 L, red < ₹20 L; active orders amber > 15; OEE green > 85%; quarantine red > 48 h; overdue debt red > ₹10 L; pending dispatch amber > 10'),
  ('finance.overdueAlertValue', '1000000', 'Receivables ageing: overdue debt above this shows red (BRD p.6, ₹10 lakh)')
on conflict (key) do nothing;
