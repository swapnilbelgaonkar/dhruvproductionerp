# Stage 7 — Reporting, mobile, integrations and alerts: progress report

Stage 7 parts:

1. Management dashboard and reports — **done**
2. Alerts, escalations and scheduled reports (email; WhatsApp after D11) — next
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
- Totals: **86 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local, [SAMPLE] data): the super admin opened the dashboard, the KPI dictionary, the catalogue, the order grid filtered to Approved, the CSV export, the posting reconciliation, quarantine ageing and stock. A sales executive sees 19 reports.

### Not built yet (part 1)
- **Scheduled e-mailed reports (S-M13-08):** with alerts in part 2, once the mail provider is fixed (D11).
- **Report builder (MIS-005):** Enterprise scope.
- **Inventory adjustments, purchase price variance and training compliance reports:** stock adjustments need their approval rule (D05, parked); PPV and training compliance can be added on request.
- **Departmental dashboards:** production and quality already have theirs. Sales, purchase, logistics and finance dashboards beyond the reports and the executive view wait for the KPI workshop (D23).
