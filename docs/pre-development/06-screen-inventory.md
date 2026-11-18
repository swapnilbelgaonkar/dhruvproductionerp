# 06 — Screen Inventory & Screen Specifications

Covers MP Part 30, Step 5.

- §1 lists every screen.
- §2 gives full specifications for the P0 transaction screens, using the template from MP Step 5.
- §3 holds the shared screen patterns, which every other screen inherits, so they are not repeated per screen.
- §4 is the report catalogue.

The remaining screen specs are written in Stage 1 per module, as part of each module's entry criteria (P7 §8).

**Roles legend:** `SA` Super Admin · `EA` Executive Admin · `SecA` Security Admin · `MDO` Master Data Owner · `S-*` sales tiers (BH…SE) · `ACC` Accounts · `FH` Finance Head · `PUR` Purchase · `PH` Purchase Head · `ST` Stores · `SH` Stores Head · `PLN` Planner · `PS` Production Supervisor · `PLH` Plant Head · `QCA` QC Analyst · `QCM` QC Manager · `QAE` QA Executive · `QAM` QA Manager · `QAH` QA Head · `LOG` Logistics · `DRV` scanner operator · `MGT` Management · `ALL` any authenticated user.

## 1. Complete screen inventory

### Shell and common (S-C)

| Code | Screen | Purpose | Roles | Key actions | Primary API |
|---|---|---|---|---|---|
| S-C-01 | Login | Authenticate | public | Login, forgot password | `POST /auth/login` |
| S-C-02 | MFA challenge / enrolment | Second factor | ALL | Verify, enrol TOTP | `/auth/mfa/*` |
| S-C-03 | Password reset | Recover access | public | Request, reset | `/auth/password/*` |
| S-C-04 | Home / role dashboard | Landing view matching the user's role | ALL | Drill-down | `/dashboards/{role}` |
| S-C-05 | Approval inbox | All pending decisions | approvers | Approve, reject, hold, return, delegate | `/approvals?assignee=me` |
| S-C-06 | Notifications centre | Alerts | ALL | Mark read, open | `/notifications` |
| S-C-07 | Global search overlay | Find any permitted record | ALL | Search, open | `/search?q=` |
| S-C-08 | My profile & sessions | Profile, MFA, active sessions | ALL | Revoke session | `/me`, `/me/sessions` |
| S-C-09 | Document viewer (modal) | Preview, versions, download | per document | Download, new version | `/documents/{id}` |
| S-C-10 | Activity / audit timeline (panel) | History of a record | per record | — | `/audit?entity=` |
| S-C-11 | Export centre | Queued exports | per permission | Download | `/exports` |
| S-C-12 | Error / access denied / 404 | Explain the problem | ALL | Go back | — |

### M01 Administration (S-M01)

| Code | Screen | Purpose | Roles | Key actions | Primary API |
|---|---|---|---|---|---|
| S-M01-01 | User directory | List and manage users | SecA, EA | Invite, suspend, activate, deactivate | `/users` |
| S-M01-02 | User detail | Roles, scope, devices, sessions | SecA | Assign role (approval), reset MFA | `/users/{id}` |
| S-M01-03 | Role list | Role catalogue | SecA | Create, clone | `/roles` |
| S-M01-04 | Role permission matrix | Module × action grid | SecA | Propose, approve | `/roles/{id}/permissions` |
| S-M01-05 | Data scope assignment | Entity, plant, warehouse, territory | SecA | Assign | `/users/{id}/scopes` |
| S-M01-06 | Authority limits | Discount and value limits per tier | EA | Propose, approve, activate | `/authority-limits` |
| S-M01-07 | Approval policy list | Policies per document type | EA | New version | `/approval-policies` |
| S-M01-08 | Approval policy designer & simulator | Rules, steps, SLA; test against sample facts | EA | Simulate, publish | `/approval-policies/{id}/versions` |
| S-M01-09 | Delegations | Out-of-office delegation | ALL approvers | Create, end | `/delegations` |
| S-M01-10 | Emergency access request | Break-glass access | SA | Request, approve, review | `/emergency-access` |
| S-M01-11 | Audit viewer | Investigate | SecA, auditors | Search, diff, export | `/audit` |
| S-M01-12 | Number series | Document numbering | EA | Configure per FY | `/number-series` |
| S-M01-13 | System settings | Policies: quote validity, tolerances, timeouts | EA | Propose, approve | `/settings` |
| S-M01-14 | Templates | PDF, email, WhatsApp templates | EA | Edit version, preview | `/templates` |

### M02 Masters (S-M02)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M02-01 | Legal entities & GST registrations | Company setup | FH, EA | Create, approve | `/legal-entities` |
| S-M02-02 | Plants | Plant setup | PLH, EA | CRUD (approval) | `/plants` |
| S-M02-03 | Warehouses, zones, bins | Location tree | SH | CRUD, bulk bins | `/warehouses` |
| S-M02-04 | Departments & cost centres | — | FH | CRUD | `/departments` |
| S-M02-05 | Territory tree | 7-level tree with owners | BH, NSM, EA | Add node, reassign owner | `/territories` |
| S-M02-06 | Employees | Employee master and hierarchy | HR, EA | CRUD, set manager/tier | `/employees` |
| S-M02-07 | Party directory | Dealers, vendors, transporters | MDO, Sales, PUR, LOG | Filter by role | `/parties` |
| S-M02-08 | Dealer registration wizard | Onboarding (§2.2) | S-SE…S-BH | Save draft, submit | `/dealers` |
| S-M02-09 | Dealer onboarding review | Verification stages | Compliance, ACC, approvers | Verify, return, approve | `/dealers/{id}/onboarding` |
| S-M02-10 | Licence vault | All licences, expiry view | Compliance | Verify, block | `/party-licences` |
| S-M02-11 | Vendor registration & qualification | Vendor onboarding | PUR, QAM | Submit, qualify | `/vendors` |
| S-M02-12 | Transporter master | — | LOG | CRUD, vehicles | `/transporters` |
| S-M02-13 | Item master (FG/RM/PM) | Items | MDO | CRUD (approval), versions | `/items` |
| S-M02-14 | Pack variants | SKU packs | MDO | CRUD | `/items/{id}/packs` |
| S-M02-15 | UOM & conversions | — | MDO | CRUD | `/uom` |
| S-M02-16 | HSN & tax rates | Effective-dated rates | FH | Add rate version | `/tax-rates` |
| S-M02-17 | Product categories | Licence linkage | MDO, Compliance | CRUD | `/product-categories` |
| S-M02-18 | Equipment & instruments | — | PLH, QCM | CRUD | `/equipment` |
| S-M02-19 | Banks & payment terms | — | FH | CRUD | `/banks`, `/payment-terms` |
| S-M02-20 | Document types | Mandatory and expiry rules | EA | CRUD | `/document-types` |
| S-M02-21 | Master change requests | Pending master approvals | MDO approvers | Approve, reject | `/master-changes` |
| S-M02-22 | Bulk import | CSV/XLSX import with validation report | MDO | Upload, validate, commit | `/imports` |

### M03 Sales & CRM (S-M03)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M03-01 | CRM dashboard | MP§7.1 KPIs | Sales tiers | Filter, drill | `/dashboards/sales` |
| S-M03-02 | Lead register | List | Sales | Create, assign, import | `/leads` |
| S-M03-03 | Lead detail & BANT | Qualify | Sales | Qualify, convert, disqualify, transfer | `/leads/{id}` |
| S-M03-04 | Opportunity Kanban | Pipeline | Sales | Drag stage, won/lost | `/opportunities` |
| S-M03-05 | Opportunity detail | — | Sales | Activities, quote | `/opportunities/{id}` |
| S-M03-06 | Activity calendar & log | Calls, meetings, visits | Sales | Log, schedule | `/activities` |
| S-M03-07 | Target allocation tree | Annual → monthly → hierarchy | BH, NSM…TSM | Allocate, publish | `/targets` |
| S-M03-08 | Target vs achievement | Performance | Sales managers | Drill | `/targets/achievement` |
| S-M03-09 | Price lists | Base and group rates | Sales Head, FH | New version, approve | `/price-lists` |
| S-M03-10 | Schemes & discounts | Volume, trade, promo | Sales Head | Create, approve | `/schemes` |
| S-M03-11 | Contract pricing & annual agreements | — | Sales managers | Create, approve, track | `/contracts` |
| S-M03-12 | Sample requests | MP§7.8 | Sales, ST | Request, approve, allocate, dispatch | `/samples` |
| S-M03-13 | Field trials | MP§7.9 | Sales, Agronomy | Plan, record | `/field-trials` |
| S-M03-14 | Competitor intelligence | MP§7.10 | Sales (restricted) | Add, analyse | `/competitor-entries` |
| S-M03-15 | Monthly tour plan | MP§7.11 | Sales | Plan, submit, approve | `/beat-plans` |
| S-M03-16 | Daily beat & check-in (mobile) | GPS visit | SE, TSM | Check-in/out, outcome | `/beat-visits` |
| S-M03-17 | Dealer / customer 360° | MP§6.3 | Sales, ACC | — | `/parties/{id}/360` |
| S-M03-18 | Outstanding & recovery | Aging, promise-to-pay | Sales, ACC | Log follow-up, escalate | `/receivables` |
| S-M03-19 | Order approval register | Register | Sales managers | Filter, export | `/approvals?type=SO` |
| S-M03-20 | Executive sales analytics | Trends, territory comparison | BH, NSM, MGT | Filter, export | `/analytics/sales` |
| S-M03-21 | Team performance | Subordinate view | Managers | Drill | `/analytics/sales/team` |
| S-M03-22 | Lead import | IndiaMART/exhibition lists | Sales admin | Upload, dedupe | `/imports/leads` |
| S-M03-23 | Territory handover | Transfer ownership | NSM, ZSM | Transfer | `/territories/{id}/handover` |
| S-M03-24 | Export centre (sales) | Standardised exports | per permission | Export | `/exports` |

### M04 Quotation & Orders (S-M04)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M04-01 | Quotation register | List and filter | Sales | New, duplicate | `/quotations` |
| S-M04-02 | Quotation editor | §2.3 | Sales | All MP§8.3 actions | `/quotations/{id}` |
| S-M04-03 | Quotation version compare | Diff between revisions | Sales | — | `/quotations/{id}/revisions` |
| S-M04-04 | Sales order register | List | Sales, ACC, ST | New | `/sales-orders` |
| S-M04-05 | Sales order editor / detail | §2.4 | Sales | Submit, amend, cancel | `/sales-orders/{id}` |
| S-M04-06 | Order approval view | Approver context: credit, margin, history | approvers | Decide | `/approvals/{id}` |
| S-M04-07 | Credit review panel | Exposure, aging | ACC, FH | Approve, hold, exception | `/parties/{id}/credit` |
| S-M04-08 | Allocation & backorder | Reserve lots, backorder queue | ST, PLN | Reserve, release, backorder | `/allocations` |
| S-M04-09 | Amendment request | Revision with reason | Sales | Submit revision | `/sales-orders/{id}/revisions` |
| S-M04-10 | Dispatch authorisation queue | Gate before logistics | ACC / Sales Ops | Authorise | `/sales-orders?state=Approved` |

### M05 Procurement (S-M05)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M05-01 | PR register | List | Requesters, PUR | New | `/purchase-requisitions` |
| S-M05-02 | PR editor | Lines, cost centre | Requesters | Submit | `/purchase-requisitions/{id}` |
| S-M05-03 | RFQ editor | Vendors, items, deadline | PUR | Issue, close | `/rfqs` |
| S-M05-04 | Vendor quote entry | Record responses, upload | PUR | Save | `/rfqs/{id}/quotes` |
| S-M05-05 | Comparative statement | Landed cost comparison | PUR, PH | Select vendor | `/rfqs/{id}/comparison` |
| S-M05-06 | PO register | List | PUR | New | `/purchase-orders` |
| S-M05-07 | PO editor | Lines, schedule, terms | PUR | Submit, amend, issue, PDF | `/purchase-orders/{id}` |
| S-M05-08 | Delivery tracking | Expected vs received | PUR | Follow up | `/purchase-orders/schedule` |
| S-M05-09 | Supplier invoice entry | Register invoice | ACC | Save, match | `/supplier-invoices` |
| S-M05-10 | Three-way match workbench | Exceptions | ACC, PUR | Resolve, accept exception | `/match-exceptions` |
| S-M05-11 | Supplier returns | — | PUR, ST | Create, authorise | `/supplier-returns` |
| S-M05-12 | Vendor performance | Scorecard | PH | — | `/analytics/vendors` |

### M06 Inventory (S-M06)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M06-01 | Gate entry | Vehicle log | Security / ST | In, out | `/gate-entries` |
| S-M06-02 | GRN editor | §2.5 | ST | Post | `/goods-receipts` |
| S-M06-03 | Putaway | Bin assignment | ST | Move | `/putaways` |
| S-M06-04 | Stock overview | By item, lot, warehouse, quality | ST, PLN, Sales (ATP) | Filter, drill | `/inventory/stock` |
| S-M06-05 | Lot detail & genealogy | Lot card | ST, QC, QA | Trace | `/inventory/lots/{id}` |
| S-M06-06 | Stock ledger | Movements | ST, ACC | Filter, export | `/inventory/movements` |
| S-M06-07 | Material issue | To production order | ST | Issue (scan) | `/material-issues` |
| S-M06-08 | Stock transfer | Between warehouses | ST | Dispatch, receive | `/transfers` |
| S-M06-09 | Reservations | View, release | ST, Sales Ops | Release | `/reservations` |
| S-M06-10 | Cycle count plan & sheet | Counting | ST, SH | Plan, count | `/counts` |
| S-M06-11 | Count variance & adjustment | Approve variances | SH, ACC | Approve | `/adjustments` |
| S-M06-12 | Damaged, expired & rejected stock | Segregated stock | ST, QA | Move, scrap | `/inventory/blocked` |
| S-M06-13 | Reorder & expiry alerts | Alert lists | ST, PUR | Create PR | `/inventory/alerts` |
| S-M06-14 | Inventory valuation | Value by item and lot | ACC, FH | Export | `/inventory/valuation` |
| S-M06-15 | Warehouse map / bin view | Occupancy | SH | — | `/warehouses/{id}/bins` |
| S-M06-16 | Warehouse dashboard | KPIs | SH | — | `/dashboards/warehouse` |

### M07 Manufacturing (S-M07)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M07-01 | Production dashboard | MP§12.1 | PLH, PLN | — | `/dashboards/production` |
| S-M07-02 | Forecast entry | Demand plan | PLN, Sales | Import, approve | `/forecasts` |
| S-M07-03 | MRP run & suggestions | Planning | PLN | Run, firm, convert to PR | `/mrp/runs` |
| S-M07-04 | Production schedule (Gantt) | Line/shift view | PLN | Drag reschedule | `/production-schedule` |
| S-M07-05 | BOM list | Formulations | PLN, QA | New version | `/boms` |
| S-M07-06 | BOM version editor | Ingredients, tolerances, steps, yield | PLH, QA | Submit, approve, effective date | `/boms/{id}/versions` |
| S-M07-07 | Production order register | — | PLN | New | `/production-orders` |
| S-M07-08 | Production order detail | Release, amend, cancel | PLN, PLH | Release | `/production-orders/{id}` |
| S-M07-09 | Batch execution console (tablet) | BMR steps | PS, operators | Start, dose, record, complete | `/batches/{id}` |
| S-M07-10 | Material dosing step | Scan lot, weigh | Operators | Record | `/batches/{id}/consumptions` |
| S-M07-11 | Process readings | Parameters | Operators | Record | `/batches/{id}/readings` |
| S-M07-12 | IPQC hold & request | — | PS | Request sample | `/batches/{id}/ipqc` |
| S-M07-13 | Yield & mass balance | Reconcile | PS, PLH | Submit, approve | `/batches/{id}/yield` |
| S-M07-14 | Packaging run (BPR) | Pack output | PS | Issue PM, record packs, print labels | `/packaging-runs` |
| S-M07-15 | Downtime log | Reason codes | PS | Record | `/downtime-events` |
| S-M07-16 | OEE report | A × P × Q | PLH | — | `/analytics/oee` |
| S-M07-17 | Production cost | Per batch / MT | PLH, ACC | — | `/analytics/production-cost` |
| S-M07-18 | Traceability explorer | Forward / backward graph | PLH, QA | Trace, export | `/trace` |

### M08 QC (S-M08)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M08-01 | QC dashboard | MP§13.1 | QCM | — | `/dashboards/qc` |
| S-M08-02 | Specification library | Specs and versions | QCM, QAM | New version, approve | `/qc/specifications` |
| S-M08-03 | Test methods | — | QCM | CRUD | `/qc/methods` |
| S-M08-04 | Sample register & custody | Sampling | QCA | Register, receive, split | `/qc/samples` |
| S-M08-05 | Lab worklist | Assigned tests | QCA | Start, enter results | `/qc/worklist` |
| S-M08-06 | Result entry | §2.6 | QCA | Save, submit | `/qc/samples/{id}/results` |
| S-M08-07 | Result review | Reviewer ≠ analyst | QCM | Approve, reject | `/qc/samples/{id}/review` |
| S-M08-08 | CoA generation & register | — | QCM | Generate, approve, issue | `/qc/coas` |
| S-M08-09 | OOS/OOT cases | Investigation | QCM, QAM | Investigate, authorise retest, close | `/qc/oos` |
| S-M08-10 | Instruments & calibration | Schedule, certificates | QCM | Record calibration | `/qc/instruments` |
| S-M08-11 | Lot disposition | RM/PM release | per D04 | Release, reject, hold | `/inventory/lots/{id}/dispositions` |

### M09 QA (S-M09)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M09-01 | QA dashboard | MP§14.1 | QAM, QAH | — | `/dashboards/qa` |
| S-M09-02 | Controlled document register | SOPs and documents | QAE | New, revise | `/qa/documents` |
| S-M09-03 | Document version workflow | Author → review → approve → effective | QAE, QAM | Approve, publish | `/qa/documents/{id}/versions` |
| S-M09-04 | Change control | — | QAE | Raise, assess, approve, close | `/qa/changes` |
| S-M09-05 | Deviation register & form | — | ALL raise, QA manage | Raise, assess, close | `/qa/deviations` |
| S-M09-06 | Non-conformance | — | QAE | Raise, close | `/qa/ncs` |
| S-M09-07 | Incidents | — | ALL raise | Raise, investigate | `/qa/incidents` |
| S-M09-08 | CAPA register & detail | MP§14.4 | QAE, owners | Plan, implement, verify, close | `/qa/capas` |
| S-M09-09 | Batch review (BMR/BPR) | Review checklist | QAE | Review | `/qa/batch-reviews` |
| S-M09-10 | Batch release / disposition | §2.7 | QAH or delegate | Release, hold, reject, rework | `/qa/batches/{id}/dispositions` |
| S-M09-11 | Internal audit planner | — | QAM | Plan, findings | `/qa/audits?type=internal` |
| S-M09-12 | Supplier audits | — | QAM | Plan, rate | `/qa/audits?type=supplier` |
| S-M09-13 | Customer / regulatory audits | — | QAH | Record, CAPA | `/qa/audits?type=external` |
| S-M09-14 | Training matrix | SOP × role × user | QAM, HR | Assign, record | `/qa/training` |
| S-M09-15 | Training record entry | — | Trainers | Record, assess | `/qa/training/records` |
| S-M09-16 | Specification approval queue | — | QAM | Approve | `/qa/spec-approvals` |
| S-M09-17 | Quality risk register | — | QAM | Score, mitigate | `/qa/risks` |
| S-M09-18 | Complaint register & investigation | — | QAE, Sales | Log, investigate, close | `/qa/complaints` |
| S-M09-19 | Recall case | MP§14.5 | QAH | Open, scope, track, close | `/qa/recalls` |
| S-M09-20 | Recall drill | Mock recall | QAH | Run, report | `/qa/recalls/drill` |
| S-M09-21 | QA rights governance | QA authorities | QAH, SecA | Grant, revoke, recertify | `/qa/authorities` |
| S-M09-22 | Retention samples | — | QCM, QAE | Log, dispose | `/qc/retention` |

### M10 Logistics (S-M10)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M10-01 | Dispatch planning board | Grouped queue | LOG | Plan shipment | `/dispatch-queue` |
| S-M10-02 | Shipment detail | Lines, boxes, documents | LOG | Assign, dispatch | `/shipments/{id}` |
| S-M10-03 | Pick list | — | ST | Print, pick (scan) | `/shipments/{id}/pick-list` |
| S-M10-04 | Packing station | Box to line | ST | Scan, close | `/shipments/{id}/packing` |
| S-M10-05 | Transporter & vehicle assignment | — | LOG | Assign, LR | `/shipments/{id}/transport` |
| S-M10-06 | Shipping documents | DC, packing list, invoice, e-way bill | LOG, ACC | Generate, print | `/shipments/{id}/documents` |
| S-M10-07 | POD capture | — | LOG | Record, upload | `/shipments/{id}/pod` |
| S-M10-08 | Dispatch exceptions | Partial, damage, RTO, dispute | LOG | Resolve | `/dispatch-exceptions` |
| S-M10-09 | Customer returns | — | LOG, Sales, QA | Authorise, receive | `/returns` |
| S-M10-10 | Freight reconciliation | Transporter bills | LOG, ACC | Match, approve | `/freight` |

### M11 Mobile & QR (S-M11)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M11-01 | Mobile home / task queue | Assigned tasks | DRV, ST | Open task | `/mobile/tasks` |
| S-M11-02 | Scanner | Camera or hardware scan | DRV, ST | Scan | `/scans/batches` |
| S-M11-03 | Offline queue | Pending events | DRV | Retry, view result | local + `/scans/batches` |
| S-M11-04 | Scan conflict resolution (web) | Operator resolution | SH | Accept, reject, reassign | `/scan-conflicts` |
| S-M11-05 | Serial trace | Box history | ST, QA | — | `/serials/{serial}` |
| S-M11-06 | Label print jobs | QR labels | PS | Print, reprint (audited) | `/label-jobs` |
| S-M11-07 | Device registry | Devices | SecA | Register, revoke | `/devices` |
| S-M11-08 | Public product verification | Authenticity check | public | Verify | `GET /public/verify/{token}` |

### M12 Finance (S-M12)

| Code | Screen | Purpose | Roles | Key actions | API |
|---|---|---|---|---|---|
| S-M12-01 | Finance dashboard | — | FH | — | `/dashboards/finance` |
| S-M12-02 | Invoice register | — | ACC | Filter | `/invoices` |
| S-M12-03 | Invoice detail | §2.9 | ACC | Issue, IRN, cancel, PDF | `/invoices/{id}` |
| S-M12-04 | Credit control | Limits, holds, exceptions | ACC, FH | Change limit (approval), hold | `/credit-profiles` |
| S-M12-05 | Receipts & allocation | — | ACC | Record, allocate | `/receipts` |
| S-M12-06 | Credit / debit notes | — | ACC, FH | Create, approve | `/credit-notes`, `/debit-notes` |
| S-M12-07 | Party ledger | Dealer, vendor, transporter | ACC | Statement, export | `/ledgers/{partyId}` |
| S-M12-08 | Payables | From matched invoices | ACC | Schedule | `/payables` |
| S-M12-09 | Vendor payments | — | ACC, FH | Approve, record | `/vendor-payments` |
| S-M12-10 | Posting monitor | External postings | ACC | Retry, investigate | `/postings` |
| S-M12-11 | Bank reconciliation | — | ACC | Import statement, match | `/bank-reconciliation` |
| S-M12-12 | GST registers | Outward and inward | ACC | Export | `/reports/gst` |
| S-M12-13 | Period close | Checklist, lock | FH | Soft close, close | `/periods` |
| S-M12-14 | Aging (AR/AP) | — | ACC | Export | `/reports/aging` |

### M13 MIS (S-M13)

| Code | Screen | Purpose | Roles | API |
|---|---|---|---|---|
| S-M13-01 | Executive dashboard | Cross-functional KPIs | MGT | `/dashboards/executive` |
| S-M13-02 | Purchase dashboard | — | PH | `/dashboards/purchase` |
| S-M13-03 | Logistics dashboard | — | LOG | `/dashboards/logistics` |
| S-M13-04 | Admin dashboard | Users, approvals aging, jobs health | EA | `/dashboards/admin` |
| S-M13-05 | Report catalogue | All permitted reports | ALL | `/reports` |
| S-M13-06 | Report viewer | Filters, export | per report | `/reports/{id}/run` |
| S-M13-07 | KPI dictionary | Formula, owner | ALL | `/kpis` |
| S-M13-08 | Scheduled reports | Email schedule | per report | `/report-schedules` |
| S-M13-09 | Report builder (Enterprise) | — | Power users | `/report-definitions` |
| S-M13-10…12 | Sales, Production, QC, QA, Warehouse, Finance dashboards | Listed under their own modules | — | — |

### M14 Platform (S-M14)

| Code | Screen | Purpose | Roles | API |
|---|---|---|---|---|
| S-M14-01 | Job & queue monitor | Failed jobs, dead-letter queue | EA, IT | `/admin/jobs` |
| S-M14-02 | Integration log | GSP, accounting, messaging | IT, ACC | `/admin/integrations` |
| S-M14-03 | Notification rules | Trigger, condition, recipients, channel | EA | `/notification-rules` |
| S-M14-04 | Notification delivery log | Status per message | EA | `/notification-deliveries` |

**Total: 206 screens.**

---

## 2. Detailed screen specifications (P0 screens)

### 2.1 S-C-01 Login

| Item | Specification |
|---|---|
| Purpose | Authenticate users. Privileged users are routed to MFA. |
| Fields | Username or email* (text, ≤ 254); Password* (password, ≥ 12 characters by policy); "Keep me signed in on this device" (checkbox, disabled for privileged roles) |
| Validations | Required fields. Generic error "Invalid credentials" (no hint whether the account exists). Lockout after 5 failures in 15 min (configurable). |
| Actions | Sign in · Forgot password |
| APIs | `POST /api/v1/auth/login` → `{mfaRequired, challengeId}` or a session cookie |
| Navigation | → S-C-02 MFA, or → S-C-04 Home (role dashboard), or → the deep link the user came from |
| Errors | `AUTH_INVALID`, `AUTH_LOCKED` (shows the unlock time), `AUTH_SUSPENDED`, `RATE_LIMITED` |
| Acceptance | Locked after N failures; audit events written for success and failure; no user-enumeration timing difference greater than 50 ms |

### 2.2 S-M02-08 Dealer registration wizard

| Item | Specification |
|---|---|
| Purpose | Capture a new dealer and submit it for onboarding (DLR-001…008). |
| Steps | 1 Business · 2 Addresses · 3 Statutory & licences · 4 Commercial · 5 Security & KYC · 6 Documents · 7 Review & submit |
| Fields (selection) | Legal name*, trade name, constitution* (Proprietorship, Partnership, Private Limited, LLP, FPO; BRD p.8), contact person*, mobile* (+91, 10 digits), email, registered address*, billing address*, shipping addresses (1..n), state*, district*, territory* (picker limited to the user's scope), assigned SE* · **GSTIN + GST certificate upload on the same row** (BRD p.7 same-line rule; required unless exempt, D07), fertilizer licence no + expiry + certificate, pesticide licence no + expiry + certificate, official letterhead upload, PAN* (format `AAAAA9999A`), licences [type*, number*, issuer*, valid from*, valid to*, categories*, file*] · requested credit limit, credit days, target financial year, price category*, dealer category*, annual target · security instruments [type, number, bank, amount] (shown only if the D07 policy requires them) · authorised signatories [name, designation, ID document] |
| Conditional rules | The required KYC set is derived from constitution type (D07 table). A pesticide licence is required if a pesticide category is selected, and likewise for fertilizer. Inter-state GSTIN state code must match the address state. |
| Validations | GSTIN regex and checksum; PAN regex; GSTIN chars 3–12 must equal the PAN; duplicate GSTIN/PAN/mobile check (blocking), with a fuzzy name match as a warning; licence valid_to > today (an expired licence can be saved but not submitted without a restriction flag) |
| Actions | Save draft · Submit (only when all mandatory items are complete) · Cancel draft |
| APIs | `POST /dealers`, `PATCH /dealers/{id}`, `POST /dealers/{id}/documents`, `POST /dealers/{id}/submit`, `GET /parties/duplicates?gstin=&pan=&mobile=` |
| Statuses | Draft → Submitted → Verified → Commercially Approved → Credit Approved → Active · Returned · Rejected |
| Errors | `DUPLICATE_PARTY` (links to the existing record), `INVALID_GSTIN`, `DOC_REQUIRED:<type>`, `TERRITORY_OUT_OF_SCOPE` |
| Acceptance | UAT-01, TC-02, TC-03. Submit is blocked while any mandatory document is missing. Audit timeline shows every stage. |

### 2.3 S-M04-02 Quotation editor

| Item | Specification |
|---|---|
| Purpose | Build and revise multi-item quotations (QUO-001…006). |
| Header | Quote no (auto), date*, valid until* (default = date + policy days, D16), dealer* (Active only; shows a licence warning), contact*, bill-to*, ship-to*, place of supply (derived), sales owner*, price list* (derived from the dealer's price group, can be overridden with permission), payment terms*, delivery terms*, remarks |
| Lines | Sr, product code*, description (read-only), HSN (read-only), pack size*, qty* (> 0, multiple of pack), unit, list rate (read-only), discount %, rate, taxable, CGST, SGST, IGST, line total; per-line warnings (licence category blocked, below floor price) |
| Footer | Sub-total, total discount, tax by rate, round-off, grand total (in words for PDF); highest discount % vs the user's authority limit shown as a gauge |
| Calculation | Server endpoint `POST /quotations/calculate`; rounding per line to ₹0.01, invoice-level round-off to ₹1 (configurable) |
| Actions | Save draft · Add item · Delete draft line · Submit · Approve/Reject (approver) · Revise · Duplicate · Print · Download PDF · Email · Convert to sales order. Shown according to `allowedActions`. |
| Validations | Dealer active and verified; licence covers every line's category; quantity limits; discount ≤ authority, otherwise approval is required; validity ≤ policy maximum |
| Statuses | Draft, Submitted, Approved, Sent, Accepted, Converted, Rejected, Expired, Superseded, Cancelled |
| Errors | `DEALER_INACTIVE`, `LICENCE_CATEGORY_BLOCKED`, `DISCOUNT_EXCEEDS_AUTHORITY` (info: approval route preview), `QUOTE_EXPIRED` (on convert) |
| Acceptance | Totals match the reference calculations for intra- and inter-state cases; an expired quote cannot convert; a revision keeps R1 immutable; over-limit discount routes to the correct approver per the active policy version |

### 2.4 S-M04-05 Sales order editor / detail

| Item | Specification |
|---|---|
| Header | SO no, source (Quote/PO/Contract/Channel)*, source ref, dealer*, dealer PO no*, PO date*, PO file*, delivery date*, ship-to*, sales owner*, payment terms*, remarks |
| Lines | As in the quotation, plus `ordered / reserved / dispatched / open` quantity columns (read-only after approval) |
| Side panels | Credit panel (limit, exposure, overdue, headroom), stock panel (ATP per line from released lots), approval timeline, documents, audit |
| Validations | The 10 MP§9.2 checks on submit and on final approval. Duplicate `(dealer, dealer PO no)` is blocked. |
| Actions | Save draft, submit, request amendment (creates a revision), cancel (reason), print/PDF |
| Amendment | A revision dialog shows changed fields, flags whether they are material, and shows which approvals will reset (D17) |
| Acceptance | TC-04, TC-05, TC-06, TC-07; UAT-03…05 |

### 2.5 S-M06-02 GRN editor

| Item | Specification |
|---|---|
| Header | GRN no, gate entry ref*, PO ref* (or an approved no-PO exception), supplier (from PO), vehicle no*, transporter, supplier invoice/DC no*, receipt date*, warehouse* (must be quarantine-capable for regulated items) |
| Lines | PO line*, item (read-only), ordered/open qty (read-only), received qty*, UOM, supplier batch*, internal lot (auto), mfg date*, expiry date* (> mfg date; shelf-life check), condition* (Good/Damaged), containers count, remarks |
| Validations | Received > open qty beyond tolerance → blocked or sent for approval (D06); expiry < today + minimum remaining shelf life → warning or block per item policy; mandatory documents (supplier CoA for RM) |
| On post | Creates lots in `QUARANTINE`, `GRN_IN` movements to the quarantine location, updates PO line received qty, creates a QC sample request (INV-001) |
| Acceptance | TC-08, TC-09, UAT-06 |

### 2.6 S-M08-06 Result entry & S-M08-07 Review

| Item | Specification |
|---|---|
| Header (read-only) | Sample no, source (lot/batch), item, spec version, sampled by and at |
| Grid | Parameter, method, instrument* (only calibrated instruments listed), unit, limits (min/target/max), result* (numeric or text per parameter), pass/fail (computed), raw evidence attachment (required for flagged parameters), remarks |
| Rules | Result outside limits → row flagged and an OOS case is opened on submit; the analyst cannot review their own sample (button hidden and server returns `SOD_VIOLATION`) |
| Review | The reviewer sees results, evidence and history (including superseded retests); Approve → CoA can be generated; Reject → returned to the analyst with remarks |
| Acceptance | TC-12; QC-005 segregation test |

### 2.7 S-M09-10 Batch release / disposition

| Item | Specification |
|---|---|
| Readiness checklist (system-computed, read-only) | ✔ All QC samples approved · ✔ CoA approved · ✔ BMR reviewed · ✔ BPR reviewed · ✔ Mass balance within tolerance or linked deviation closed · ✔ Zero open deviations on the batch and its input lots · ✔ Releaser holds the QA authority for this plant |
| Fields | Decision* (Released / On Hold / Rejected / Rework Authorised), remarks* (mandatory unless Released), e-signature re-authentication* (password + MFA) |
| Rules | "Released" is disabled while any checklist item fails, and the server repeats the check (TC-13) |
| Result | FG lot quality status updated; notifications; backorder allocation job triggered |

### 2.8 S-M11-02 Scanner (mobile)

| Item | Specification |
|---|---|
| Context | Task chosen first (Pack shipment X / Pick list Y / Receive transfer Z); the scan type is set by the task |
| Display | Last scan result (big ✔ or ✖ with reason), counts scanned/expected per line, online/offline badge, pending queue count |
| Offline | Events stored in encrypted IndexedDB with UUIDv7 `event_id`; sync on reconnect; per-event outcome shown |
| Feedback | Beep and vibration patterns that differ for accepted, rejected and duplicate; colour plus icon plus text (never colour alone) |
| Acceptance | TC-14, TC-15 |

### 2.9 S-M12-03 Invoice detail

| Item | Specification |
|---|---|
| Source | Created from a dispatched shipment (quantities = dispatched, prices = SO revision prices) |
| Fields | Invoice no, date, legal entity GSTIN, dealer GSTIN, place of supply, linked SO and shipment, lines (HSN, qty, rate, taxable, CGST/SGST/IGST), round-off, total, payment terms, due date, IRN, Ack no, signed QR (if e-invoice applies), e-way bill no |
| Actions | Issue, generate IRN (job), cancel (within the statutory window and only if not paid), credit note, PDF, email |
| Rules | Lines cannot be edited after issue; corrections only by credit or debit note; posting status visible |
| Acceptance | TC-17, UAT-11, UAT-12 |

---

## 3. Shared screen patterns (inherited by every screen)

| Pattern | Behaviour |
|---|---|
| Register (list) page | Header with title, primary action and saved views · filter bar (status chips, date range, owner, territory, warehouse) · server-side search, sort and pagination (25/50/100) · column chooser · export (permission-checked) · row click opens detail · bulk actions only where safe |
| Detail page | Sticky header: doc no, status badge, key facts, `allowedActions` bar · tabs: Details, Lines, Approvals, Documents, Related, Activity/Audit |
| Editor | Inline validation · unsaved-changes guard · server validation errors mapped to fields · `version` sent on save and a 409 conflict dialog offers to reload |
| Approval decision dialog | Decision, remarks (required for reject, hold and return), re-authentication for flagged decisions, shows the policy step and rule version |
| Empty, loading and error states | Skeletons, empty-state illustration with CTA, retry on network errors (doc 10 §8) |
| Status badges | One fixed colour + icon + label per status (doc 10 §6) |

---

## 4. Report catalogue (MP§19.2)

| Area | Reports |
|---|---|
| Sales (8) | Lead pipeline · Quotation conversion · Orders (booked/open/backordered) · Employee performance · Territory performance · Target vs achievement · Collections · Outstanding / aging |
| Procurement (6) | PR status · Pending POs / delivery schedule · Supplier performance (OTIF, rejection) · Material purchase register · Vendor price history · Purchase price variance |
| Inventory (8) | Item stock · Batch/lot stock · Warehouse stock · Stock movement ledger · Quarantine aging · Near-expiry / expired · Adjustments · Valuation |
| Production (7) | Planned vs actual · Batch production register · RM consumption vs BOM · Yield & loss · Waste/scrap · OEE · Production cost |
| QC (6) | Tests performed / TAT · CoA register · Failures · OOS/OOT · Calibration status · Quarantine aging (QC view) |
| QA (7) | Batch release register · Deviations · CAPA aging/effectiveness · Audit findings · Training compliance · Complaints · Recalls |
| Logistics (6) | Pending dispatch · Shipment status · Delivery performance · POD pending · Freight cost · Returns |
| Finance (7) | Invoice register · Receivables aging · Payables aging · Credit exposure · Collection efficiency · Posting reconciliation · GST summary |
| **Total** | **55** |
