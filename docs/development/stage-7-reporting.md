# Stage 7 — Reporting, mobile, integrations and alerts: progress report

Stage 7 parts:

1. Management dashboard and reports — **done**
2. Alerts and escalations — **done** (in-app; e-mail, WhatsApp and scheduled e-mailed reports follow D11)
3. Mobile PWA and offline scanning (D09) — **done**
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
- Totals at the end of part 2: 88 API + 4 contract tests passing. Typecheck clean.
- Browser run (local, [SAMPLE] data):
  1. The checks found three real overdue approvals in the demo data.
  2. Widening "Stock nearing expiry" to 730 days raised alerts for six lots, which reached the stores head. The stores head acknowledged one with a note.
  3. Setting the rule back to 30 days resolved all six.

### Not built yet (part 2)
- **E-mail, SMS and WhatsApp delivery**, and **scheduled e-mailed reports**: the channel and provider are open in D11. The rule and recipient model is channel-ready.
- **Reminders to dealers themselves** (payment reminders by WhatsApp): needs the D11 channel and dealer consent.
- **Low-stock / reorder alerts**: items have no reorder levels yet. They will be added with stock controls (D05, parked).

## Part 3 — Mobile scanner, installable app and offline scanning (D09 recommendation: PWA + keyboard-wedge scanners)

| Area | What works | RTM |
|---|---|---|
| Installable app | The portal is a PWA: manifest, icons, home-screen shortcuts (Pick for dispatch, Look up), standalone display, opening on the scanner. A service worker keeps the app itself on the phone, so it opens with no network. Data is never cached by the service worker: it always comes from the server | X08, D09 |
| Mobile scanner (`/m`) | Full-screen, large touch targets, one task per screen: **Pick for dispatch**, **Look up**, **Scans to send**. Reached from the portal menu ("Mobile Scanner") or the home-screen icon. Signing in from the scanner returns to the scanner | D09 |
| Scanner hardware | Keyboard-wedge scanners (rugged handhelds, ring scanners) type the code and Enter. Where the phone's browser can read barcodes (Chrome on Android), a **camera** button reads QR, Code 128/39, EAN-13 and Data Matrix. The box label's QR (the verification link) is understood as the box serial | D09 |
| Feedback | A short high beep and a buzz for an accepted box; a low double buzz and a red message for a refused one (already scanned, wrong pack, lot not released, too many) | — |
| Picking | Choose a planned shipment and scan boxes. Each line shows packs scanned against planned. Every server rule for picking still applies | LOG-002, LOG-003 |
| Offline | Scans made without a network are kept on the phone and sent automatically when it is back (and every 20 seconds while any wait), oldest first. Each carries its own idempotency key, so a send whose reply was lost is replayed safely: the box is never picked twice. A scan is sent only under the sign-in of the person who made it. Shipments opened once stay readable offline. The "Scans to send" screen shows waiting, sent and refused scans | D09, PLT-004 |
| Look up | Scan a box, a label QR or a lot number to see the product, contents, lot, QC status, expiry, packing run, shipment, stock by warehouse, and a plain verdict ("Ready to dispatch", "Lot not released by QA — do not dispatch", "On shipment DSP/…") | INV-001 |

### Evidence
- `apps/api/test/scan.test.ts`:
  - **Look-up.** A box serial, the label's QR link and a lower-case lot number are all recognised. The verdict follows QA release (not released, then ready, then on shipment), and lot stock is shown. An unknown code returns not found; a role without stores, dispatch or packing access is refused.
  - **Replay.** A queued pick sent twice with the same idempotency key is picked once, and the second answer is the replayed first.
- Totals: **89 API + 4 contract tests passing**. Typecheck clean.
- Browser run on an emulated Pixel 7 (local, [SAMPLE] data):
  1. A sales executive raised SO/2026-27/000003 for 36 × 1 L. The TSM, accounts and the finance head (credit override) approved it, and logistics planned DSP/2026-27/000002.
  2. The storekeeper signed in to the scanner and scanned one box online (accepted). A repeat scan of the same box was refused on the phone.
  3. With the phone offline, the storekeeper scanned a label QR and another box. Both were saved and shown as waiting.
  4. Back online, both were sent automatically and the shipment showed 36 of 36 packs.
  5. Look-up showed a dispatched box ("Dispatched on DSP/2026-27/000001") and a released raw-material lot.
- Production build checked: the service worker takes control, and with the network cut the app still opens from the phone.

### Not built yet (part 3)
- **More offline tasks** (goods receipt, stock count, issue to production): these work online in the portal on a phone. Offline versions follow once the device pilot (D09) shows which sites lose network.
- **Native Android wrapper (Capacitor):** only if the device pilot needs features a PWA cannot reach.
- **Look-up offline:** it needs the server, because stock changes all the time.

## Part 4 — Integrations: GST portals, TDS, bank files, e-mail/SMS/WhatsApp (D08, D11, D27)

Every integration has a **mode** set in Administration → Integrations: **Off**; **Manual** (the ERP makes the government or bank file, a person uploads it and records the reply); **Simulated** (a training imitation — results say SIMULATED and never print as valid); **Live** (through a provider). Keys never sit in the database: a live connection names the environment variable that holds them. Every file made and message sent is in the integration log.

| Area | What works | RTM |
|---|---|---|
| E-invoice | INV-01 JSON (schema 1.1) for B2B invoices and approved credit notes, with checks before upload (seller and buyer address and PIN, HSN, totals). Manual: record IRN, acknowledgement and signed QR from the portal — the IRN is checked against the GSTIN, year, type and number, so a wrong one is refused. Cancel within 24 h. An invoice with an active IRN cannot be cancelled; a cancelled document number cannot get a new IRN. The printed invoice carries the QR and IRN | FIN-001, D27 |
| E-way bill | NIC JSON from the dispatched shipment and its invoice (from-warehouse, ship-to, transporter, vehicle, LR, items). Validity worked out from distance (one day per 200 km, ending at midnight IST — setting). Manual: record the EWB number and time. Cancel within 24 h. With the integration on, dispatch no longer asks for a typed number; the delivery cannot be closed above the threshold until the e-way bill exists | LOG-005, D08 |
| GST returns | GSTR-1 (B2B, B2CL, B2CS net of small credit notes, CDNR, HSN, document series) and GSTR-3B (outward supplies from the invoices; ITC from the ledger) per GSTIN and month in the offline-tool JSON. Prepare → download → record ARN. A file is refused if anything changed after it was prepared. Once GSTR-1 is filed, that month's invoices cannot be cancelled | FIN-019, D27 |
| TDS | Sections, rates (individual / other / no PAN) and thresholds (per payment, per year, or only on the excess as for 194Q) are finance master data — none are seeded as facts. Payments work TDS out automatically from the payee's section: lower-deduction certificate, PAN type, s.206AA, transporter declaration u/s 194C(6), base before GST. Manual figures need a reason. Deducted vs deposited by month with the due date, challans (BSR, serial, interest if late) posted to the ledger, quarterly 26Q rows | FIN-010 |
| Bank payment files | Approved NEFT/RTGS/IMPS payments into one bulk file (CSV or host-to-host pipe layout) for a company bank account. The file is not stored (account numbers): it is rebuilt on download and must match its fingerprint, so a changed account invalidates it. The bank's reply file releases paid payments with their UTRs; rejected ones return to the queue with the bank's reason | FIN-010 |
| Messages | One queue for e-mail (SMTP), SMS and WhatsApp (HTTPS providers), retried up to five times, each sent once. Alerts go out on the channels the rule allows and the user chose in My profile. Editable wording per channel (placeholders checked; DLT / WhatsApp template ids) | NOT-002, D11 |
| Dealer reminders | Before the due date and every N days while overdue, to the dealer's e-mail / mobile, once per step | D11 |
| Scheduled reports | Any report e-mailed as CSV daily, weekly or monthly at an IST hour, limited to what the schedule's owner may see | MIS-009 |

### Evidence
- `gst.test.ts` (3), `tds-bank.test.ts` (2), `messaging.test.ts` (4): portal-recorded and simulated IRNs, IRN mismatch, cancel rules, e-way bill validity arithmetic, delivery blocked without EWB, GSTR-1 content, stale-file refusal, ARN, month closed; TDS thresholds, rates, no-PAN, override reason; bank file content, fingerprint, reply with paid/rejected/unknown rows; challan journal and 26Q row; alerts by e-mail, a live SMS gateway receiving the message with its bearer token, reminders once per step, a scheduled report with its CSV attachment.
- Browser: a simulated IRN generated on SI/2026-27/00001; the printed invoice shows the QR marked "SIMULATED — NOT A VALID IRN".

### Waiting on decisions
- **Live GST connection** needs the GST service provider (D27); until then the manual mode is complete.
- **Bank host-to-host** needs the bank's interface; the file layouts cover bulk upload.
- **SMS/WhatsApp** need the provider and DLT / template registration (D11).
