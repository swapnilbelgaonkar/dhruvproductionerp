# Stage 7 — Reporting, mobile, integrations and alerts: progress report

Stage 7 parts:

1. Management dashboard and reports — **done**
2. Alerts and escalations — **done** (in-app; e-mail, WhatsApp and scheduled e-mailed reports follow D11)
3. Mobile PWA and offline scanning (D09)
4. Statutory and bank integrations: e-invoice IRN, e-way bill, GST filing through the GSP (D27), bank payment files, TDS

## Part 1 — Management dashboard and reports (BRD p.6, p.19; MP §19; MIS-001…MIS-004, MIS-007, MIS-008)

| Area | What works | RTM |
|---|---|---|
| Executive dashboard | The six BRD KPI cards, company-wide and live. **Sales pipeline:** green above ₹50 L, red below ₹20 L. **Active orders:** amber above 15. **OEE over 30 days:** green above 85 %. **Quarantine hold:** red when any lot exceeds 48 h. **Overdue debt:** red above ₹10 L. **Pending dispatch:** amber above 10. Each card shows its status, target and drill-down. Thresholds are in setting `mis.kpiThresholds` (provisional, D23) | MIS-007 |
| KPI dictionary | On the dashboard, each card shows its formula, owner, refresh and source report | MIS-004 |
| Trend panels | Six months of net sales against collections, and orders booked against production output. Receivables by age, top dealers this financial year, and 11 operational counters (approvals waiting, open POs, QC pending, batches running, open deviations, CAPAs overdue, complaints, shipments in transit, calibration overdue, payables overdue), each linking to its screen or report | MIS-001 |
| Report catalogue | 50 reports in 8 areas, shown only when the user's role may open them: 44 run in the report viewer and 6 link to existing report screens (ageing, trial balance, statements, GST, production dashboard). Searchable | MIS-002 |
| Row scope | Reports apply the same scope as the screens: legal-entity scope for entity documents, the territory tree for sales. A user limited to another entity sees none of this entity's invoices | MIS-003 |
| Sales order grid | Filters by sales tier, region/state (including sub-territories), product category, quantity in MT, value range and approval status | MIS-008 |
| Viewer | Filters with sensible defaults (financial year to date), sortable columns, totals, links to the source documents, a print layout with the filters stated, and CSV export (UTF-8 with BOM so ₹ and names open correctly in Excel). Up to 5,000 rows on screen, with a warning when the list is cut | MIS-002 |
| Posting reconciliation | General-ledger control accounts against their sub-ledgers: receivables, vendor and transporter payables, inventory. On the demo data every difference is nil except ₹0.01 of rounding on inventory | FIN-014 |

### Reports by area
- **Sales (8):** sales order grid, quotation conversion, lead and opportunity pipeline, territory performance, target vs achievement, collections register, outstanding and ageing, sales owner performance.
- **Procurement (5):** requisition status, pending purchase orders with days late, supplier performance (on time, rejection), purchase register, vendor price history.
- **Inventory (6):** stock by item and warehouse, lot stock with expiry, stock movement ledger, quarantine ageing, near-expiry and expired, stock valuation.
- **Production (6):** batch register, planned vs actual, material consumption vs formulation, downtime, production cost per batch, production dashboard.
- **QC (4):** inspections and turnaround, CoA register, OOS investigations, calibration status.
- **QA (6):** batch release register, deviations, CAPA ageing and effectiveness, complaints, audit findings, recalls and drills.
- **Logistics (6):** pending dispatch, shipment status, POD pending, delivery performance, freight cost, customer returns.
- **Finance (9):** invoice register, credit exposure, collection efficiency, payables ageing, payment register, posting reconciliation, trial balance, financial statements, GST summary.

### Evidence
- `apps/api/test/mis.test.ts` has 2 tests:
  - **Reports.** Every report in the catalogue runs. The grid filters by status, MT and value, and bad dates or values are refused. The invoice register shows the dispatch invoice with its totals.
  - **Scope and permissions.** An accountant scoped to another entity sees none of its rows. The storekeeper's catalogue has stock reports but not payments, and opening one outside it returns not found.
  - **CSV.** The file has a BOM, the header row, the data rows and a total line.
  - **Reconciliation.** Receivables in the ledger equal the sub-ledger at ₹5,040.
  - **Dashboard.** The six cards have status, formula and owner, and six months of trend. A sales executive is refused the dashboard. Lowering the overdue threshold in the setting turns the card red.
- Totals at the end of part 1: 86 API + 4 contract tests passing. Typecheck clean.
- Browser run (local, [SAMPLE] data): the super admin opened the dashboard, the KPI dictionary, the catalogue, the order grid filtered to Approved, the CSV export, the posting reconciliation, quarantine ageing and stock. A sales executive sees 19 reports.

### Not built yet (part 1)
- **Scheduled e-mailed reports (S-M13-08):** with alerts in part 2, once the mail provider is fixed (D11).
- **Report builder (MIS-005):** Enterprise scope.
- **Inventory adjustments, purchase price variance and training compliance reports:** stock adjustments need their approval rule (D05, parked); PPV and training compliance can be added on request.
- **Departmental dashboards:** production and quality already have theirs. Sales, purchase, logistics and finance dashboards beyond the reports and the executive view wait for the KPI workshop (D23).

## Part 2 — Alerts and escalations (BRD p.6, p.19; MP §19.4; NOT-001…NOT-006, WF-008)

| Area | What works | RTM |
|---|---|---|
| Rule engine | Ten rules. Each turns a business condition into one alert per subject (approval step, instrument, lot, invoice, dealer, bill, PO, CAPA, shipment) and notifies in-app the person responsible plus the rule's roles. No repeat notifications on later checks | NOT-001 |
| Life cycle | **Worsens:** due becomes overdue, severity rises to critical and everyone is told again. **Acknowledged** with a note: it stops escalating. **Escalated** if not acknowledged within the rule's hours: to the escalation roles and, where set, the reporting manager of the person responsible. **Resolves itself** when the condition clears (approved, calibrated, paid, received, delivered, closed) or the rule is switched off | NOT-002, WF-008 |
| Rules | **Approval past its SLA:** to the approvers; escalates to their manager and the executive admin. **Calibration due:** 7 days ahead and overdue. **Stock nearing expiry:** 30 days. **Quarantine over 48 h** (BRD KPI). **Dealer payment due:** 3 days ahead to the sales owner; overdue to accounts as well, escalating to credit control and the finance head. **Dealer order-taking frozen** (D18). **Bill to pay due:** supplier invoices and freight bills. **Purchase order delivery late. CAPA overdue. POD pending:** 7 days | NOT-003 |
| Configuration | Administrators switch each rule on or off and set its days or hours, the roles notified, the escalation hours and roles, and manager escalation. Unknown roles or settings are refused, and every change is audited. "Check now" runs all rules | NOT-004 |
| Schedule | Hourly in the worker, alongside the existing licence-expiry, quotation-expiry and unacknowledged-PO checks. Each rule runs on its own, so one failure does not stop the rest | NOT-005 |
| Alerts page | Each user sees the alerts sent or escalated to them: open, resolved or all, by area, with links to the record and acknowledgement. Administrators can switch to everyone's alerts. Alerts also arrive in the notification bell | NOT-006 |

### Evidence
- `apps/api/test/alerts.test.ts` has 2 tests:
  - **Calibration life cycle.** Every rule runs on the full test database without failure. An instrument due in 3 days raises a warning to the QC manager and nobody else, and a second check does not repeat it. Overdue raises it to critical and it is re-sent. Once acknowledged it does not escalate even after 3 days. Calibrating the instrument resolves it.
  - **Approval escalation.** A credit-note approval 30 h past its SLA alerts the finance head as critical. After 25 h unacknowledged it escalates to the finance head's reporting manager, who sees it on their alerts page. Approving the credit note resolves it.
  - **Receivable rules.** An invoice 10 days overdue raises "Payment overdue 10 days" and the dealer-freeze alert.
  - **Configuration.** Only the administrator can open the rules. An unknown role or setting is refused. Switching the rule off clears its alerts.
- Totals: **88 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local, [SAMPLE] data):
  1. The checks found three real overdue approvals in the demo data.
  2. Widening "Stock nearing expiry" to 730 days raised alerts for six lots, which reached the stores head. The stores head acknowledged one with a note.
  3. Setting the rule back to 30 days resolved all six.

### Not built yet (part 2)
- **E-mail, SMS and WhatsApp delivery**, and **scheduled e-mailed reports**: the channel and provider are open in D11. The rule and recipient model is channel-ready.
- **Reminders to dealers themselves** (payment reminders by WhatsApp): needs the D11 channel and dealer consent.
- **Low-stock / reorder alerts**: items have no reorder levels yet. They will be added with stock controls (D05, parked).
