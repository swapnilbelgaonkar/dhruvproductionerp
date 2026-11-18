# 02 — Complete Module Inventory

Covers MP Part 30, Step 2. Module codes M01–M14 follow P3 §2. Screen codes such as `S-M04-03` are defined in doc 06.

## 0. Module map

```mermaid
flowchart LR
  subgraph Platform["Platform services (shared)"]
    M01[M01 Administration<br/>Identity · RBAC · Audit]
    APR[Workflow / Approval engine]
    DMS[Document vault]
    NTF[Notifications]
    M14[M14 Integrations<br/>Outbox · Jobs]
  end
  M02[M02 Master Data] --> M03 & M04 & M05 & M06 & M07 & M08 & M10 & M12
  M03[M03 Sales & CRM] --> M04[M04 Quotation & Orders]
  M04 -->|reservation| M06[M06 Inventory]
  M04 -->|demand| M07[M07 Manufacturing]
  M07 -->|PR proposals| M05[M05 Procurement]
  M05 -->|GRN| M06
  M06 -->|sample request| M08[M08 QC]
  M07 -->|batch sample| M08
  M08 -->|results| M09[M09 QA]
  M09 -->|FG release| M06
  M06 -->|pick/pack| M10[M10 Logistics]
  M11[M11 Mobile & QR] <--> M06 & M10
  M10 -->|dispatch| M12[M12 Finance]
  M05 -->|3-way match| M12
  M12 -->|credit status| M04
  M13[M13 MIS] -.reads.-> M03 & M05 & M06 & M07 & M08 & M09 & M10 & M12
```

## 1. Summary

| Module | Treatment (P3) | Submodules | Screens (doc 06) | Upstream dependencies | Release |
|---|---|---|---|---|---|
| M01 Administration & Security | Strengthen | 9 | 14 | — | Pilot |
| M02 Master Data | Expand | 20 masters | 22 | M01 | Pilot |
| M03 Sales & CRM | Retain 18 | 18 | 24 | M01, M02 | Core |
| M04 Quotation & Sales Orders | Correct | 6 | 10 | M02, M03, APR, M12 credit | Pilot |
| M05 Procurement | Expand | 8 | 12 | M02, APR, M06 | Pilot/Core |
| M06 Inventory & Warehouse | Expand | 13 | 16 | M02, M05, M08 | Pilot |
| M07 Manufacturing | Retain 16 | 16 | 18 | M02, M06, M08 | Pilot/Core |
| M08 Quality Control | Retain 6 | 6 (+dashboard, disposition) | 11 | M02, M06, M07 | Pilot |
| M09 Quality Assurance | Retain 17 | 17 | 22 | M07, M08, DMS | Pilot/Core |
| M10 Logistics & Dispatch | Expand | 7 | 10 | M04, M06, M09, M11 | Pilot |
| M11 Mobile & QR | Strengthen | 6 | 8 | M06, M07, M10 | Pilot/Core |
| M12 Finance | Conditional on D02 | 10 | 14 | M04, M05, M10 | Core |
| M13 MIS & Reporting | Correct | 4 | 9 | all | Core |
| M14 Integrations & Platform | Specify | 7 | 4 | — | Pilot |

---

## M01 — Administration & Security

**Responsibilities:** identity, authentication, roles and permissions, data scope, approval policies, delegation, audit, configuration, number series and the four executive administration positions.

| # | Submodule / feature | Key functions | Approval needed |
|---|---|---|---|
| 1 | User directory | Invite, activate, suspend, deactivate; link to employee | Independent approval for privileged roles |
| 2 | Authentication | Login, MFA, recovery, lockout, sessions, devices | — |
| 3 | Role & permission matrix | Module × action × scope; propose, approve, effective date | Security Admin + Executive Admin |
| 4 | Data-scope assignment | Legal entity, plant, warehouse, territory subtree | Security Admin |
| 5 | Approval policy designer | Rules, thresholds, approver groups, SLA; simulate, publish | Executive Admin |
| 6 | Delegation | Time-bound, limited to the delegator's authority | Delegator's manager (configurable) |
| 7 | Emergency access ("break-glass") | Time-boxed elevation with justification and post-review | Two executive admins |
| 8 | Audit viewer | Search, diff, export (audited) | — |
| 9 | Configuration & number series | Versioned settings, document templates, FY series | Executive Admin |

**Data:** `iam.users`, `roles`, `permissions`, `role_permissions`, `user_role_assignments` (with scope), `delegations`, `sessions`, `devices`, `sys.audit_events`, `sys.settings`, `sys.number_series`.
**Depends on:** none. Every other module depends on M01.

## M02 — Master Data Management

**Responsibilities:** authoritative records shared by every module (MP Rule 8). Lifecycle: Draft → Submitted → Verified → Approved → Active.

| # | Master | Owner | Notable rules |
|---|---|---|---|
| 1 | Company / Legal Entity | Finance | PAN and GSTIN per state registration |
| 2 | Branch / Plant | Plant | Linked to a legal entity |
| 3 | Warehouse / Zone / Bin | Stores | Type: RM, PM, FG, quarantine, rejected, transit, sample |
| 4 | Employee | HR | Manager, department, designation, tier |
| 5 | Department / Cost Centre | Finance | — |
| 6 | Territory | Sales | 7-level tree, effective-dated ownership |
| 7 | Dealer / Distributor | Sales / Fin | See M03/DLR; party model |
| 8 | Vendor / Supplier | Purchase | Qualification status, approved items |
| 9 | Transporter | Logistics | Permits, vehicles |
| 10 | Product (FG SKU) | Product owner | Pack variants, HSN, shelf life, category licence |
| 11 | Raw Material | Plant / Stores | Spec, storage class, hazard data |
| 12 | Packaging Material | Stores | — |
| 13 | Units of Measure | Stores | Item-specific conversions |
| 14 | Tax & HSN | Finance | Effective-dated rates |
| 15 | Product Category | Product owner | Drives licence eligibility (fertilizer, bio-stimulant, pesticide …) |
| 16 | BOM / Formulation | Plant / QA | Versioned, effective-dated (owned in M07) |
| 17 | Quality Specification | QC / QA | Parameters, methods, limits, versions (owned in M08) |
| 18 | Equipment / Instrument | Plant / QC | Calibration linkage |
| 19 | Bank & Financial Reference | Finance | IFSC, bank accounts |
| 20 | Document Types | Admin | Mandatory rules, expiry, retention |

**Design choice:** dealers, vendors and transporters share one `party` table with role records (`party_roles`), so one GSTIN cannot exist as two unrelated records and a vendor that is also a dealer gets one ledger identity.

## M03 — Sales & CRM (18 BRD submodules kept)

The MP lists 17 Sales functions by name. The 18th is assumed to be the quotation/order desk handled in M04. **Confirm the exact list of 18 against the BRD (D00).**

| # | Submodule | Main screens | Approvals |
|---|---|---|---|
| 1 | CRM Dashboard | S-M03-01 | — |
| 2 | Lead Management | Lead register, lead form | — |
| 3 | Lead Qualification (BANT+) | Qualification panel | — |
| 4 | Opportunity Pipeline | Kanban, opportunity detail | Loss approval optional |
| 5 | Commercial Activities | Activity log, calendar | — |
| 6 | Territory & Target Management | Target allocation tree, achievement | Target publish by BH/NSM |
| 7 | Pricing Management | Price lists, schemes, contract prices | Price list approval (Sales + Finance) |
| 8 | Sample Management | Sample request, sample register | Sample approval |
| 9 | Field Trial Management | Trial plan, observations | — |
| 10 | Competitor Intelligence | Competitor register | — |
| 11 | Beat Planning | Tour plan, daily beat, check-in | Tour plan approval by manager |
| 12 | Customer / Dealer 360° | 360 view | — |
| 13 | Contracts & Annual Volume Agreements | Contract register | Contract approval |
| 14 | Outstanding Debt & Recovery | Aging, recovery log | — |
| 15 | Order Approval Register | Register view (reads APR) | — |
| 16 | Executive Sales Analytics | Analytics dashboards | — |
| 17 | Standardised Exports | Export centre | Export permission |
| 18 | Quotation & Order Desk (assumed) | Delivered by M04 | — |

**Data:** `sales.leads`, `lead_qualifications`, `opportunities`, `activities`, `targets`, `price_lists`, `price_list_items`, `schemes`, `samples`, `field_trials`, `competitor_entries`, `beat_plans`, `beat_visits`, `contracts`.
**Depends on:** M01 (territory scope), M02 (party, product), M12 (outstanding).

## M04 — Quotation & Sales Orders

| # | Submodule | Functions |
|---|---|---|
| 1 | Quotation editor | Multi-item lines, taxes, validity, versions, PDF/email |
| 2 | Quotation approval | Discount/value routing via APR |
| 3 | Sales order | From quote, PO, contract or channel; dealer PO attachment |
| 4 | Order validation | The 10 checks in MP§9.2 |
| 5 | Order approval & amendments | Revisions, approval invalidation |
| 6 | Allocation & backorder | Reserve released FG lots, backorder, MTO trigger |

**Data:** `sales.quotations`, `quotation_lines`, `quotation_versions`, `sales_orders`, `sales_order_lines`, `sales_order_revisions`; links to `inv.reservations`, `wf.approval_requests`.
**Depends on:** M02, M03 (pricing), APR, M06 (availability), M12 (credit exposure).

## M05 — Procurement

| # | Submodule | Functions | Approval |
|---|---|---|---|
| 1 | Purchase Requisition | Manual or from MRP; cost centre; priority | Dept head, then budget owner |
| 2 | RFQ | Multi-vendor and multi-item; deadline; responses | — |
| 3 | Comparative Statement | Landed cost, quality, lead time | Purchase Head (vendor selection) |
| 4 | Purchase Order | Multi-item; schedule lines; terms; versions | Value-based |
| 5 | Delivery Tracking | Expected vs received schedule | — |
| 6 | Invoice Matching | Three-way match, tolerances, exception queue | Finance for exceptions |
| 7 | Supplier Returns | Against GRN and lot; debit note | Purchase + QC |
| 8 | Vendor Performance | OTIF, rejection %, price variance | — |

**Data:** `proc.purchase_requisitions(+lines)`, `rfqs`, `rfq_vendors`, `vendor_quotes(+lines)`, `purchase_orders(+lines, +revisions)`, `supplier_invoices(+lines)`, `match_results`, `supplier_returns`.

## M06 — Inventory & Warehouse

| # | Submodule | Functions |
|---|---|---|
| 1 | Gate entry | Vehicle in/out, linked PO |
| 2 | GRN & quarantine | Lot creation, automatic quarantine, sample request to QC |
| 3 | Stock ledger | Immutable movements, running balances |
| 4 | Stock search & views | By item, lot, warehouse, bin, quality status |
| 5 | Reservations | Concurrency-safe allocation to SO, production or sample |
| 6 | Material issue | To production order; FEFO suggestion |
| 7 | Transfers | Warehouse to warehouse, via in-transit |
| 8 | Putaway & bin moves | — |
| 9 | Cycle count | Count plan, variance, approval |
| 10 | Adjustments | Independent approval (BR-08) |
| 11 | Damage / expiry / rejection | Automatic and manual segregation |
| 12 | Reorder & expiry alerts | — |
| 13 | Valuation | Weighted average or FIFO (D05) |

**Data:** `inv.lots`, `stock_movements`, `stock_balances` (derived and maintained in the same transaction), `reservations`, `transfers`, `count_sheets`, `adjustments`, `gate_entries`, `goods_receipts(+lines)`.

## M07 — Manufacturing (16 BRD functions kept; list reconstructed, confirm against BRD)

| # | Function | Notes |
|---|---|---|
| 1 | Production dashboard | Plan vs actual, yield, OEE, cost |
| 2 | Demand & forecast intake | Sales orders plus forecast |
| 3 | MRP | Net requirements, planned orders, PR proposals |
| 4 | Production scheduling (line/shift) | Capacity view |
| 5 | BOM & chemical formulation | Versions, effective dates, alternates |
| 6 | Production order | Release, amend, cancel |
| 7 | Material reservation & issue | Released lots only |
| 8 | Batch execution (BMR) | Start, steps, parameters, operators, equipment |
| 9 | Material dosing | Actual lot and quantity per ingredient, tolerance check |
| 10 | Process parameters & readings | Temperature, pH, time … |
| 11 | In-process QC (IPQC) | Sample request to QC; hold step |
| 12 | Yield & mass balance | Loss, scrap, recovered, rework |
| 13 | Packaging (BPR) | Pack work order, PM issue, filled and rejected packs |
| 14 | Box serialisation & QR labels | Through M11 |
| 15 | Downtime & OEE | Reason codes |
| 16 | Production cost & genealogy | Cost per batch and MT; trace forward and backward |

**Data:** `mfg.bom_headers`, `bom_versions`, `bom_lines`, `bom_alternates`, `production_orders`, `batches`, `batch_steps`, `material_consumptions`, `process_readings`, `batch_outputs`, `production_losses`, `packaging_runs`, `downtime_events`.

## M08 — Quality Control (6 BRD submodules kept)

| # | Submodule | Functions |
|---|---|---|
| 1 | Sampling | Sample IDs, chain of custody, retention |
| 2 | Testing / lab worklist | Assign analyst; spec and method; instrument |
| 3 | Result review & approval | Analyst ≠ reviewer |
| 4 | Certificate of Analysis | Controlled and versioned PDF |
| 5 | OOS / OOT investigation | Phase I/II, retest authorisation |
| 6 | Calibration | Schedule; overdue instrument locked |
| + | QC dashboard | MP§13.1 |
| + | Raw-material lot disposition | Release, Reject, Hold. Who signs is decided in D04 |

**Data:** `qc.specifications(+versions, +parameters)`, `test_methods`, `samples`, `sample_custody_events`, `test_results`, `result_reviews`, `coas`, `oos_cases`, `instruments`, `calibrations`, `lot_dispositions`.

## M09 — Quality Assurance (17 BRD submodules kept)

| # | Submodule | Links |
|---|---|---|
| 1 | SOP Management | DMS, Training |
| 2 | Document Version Control | DMS |
| 3 | Change Control | BOM, spec, SOP versions |
| 4 | CAPA Management | Deviation, NC, audit, complaint |
| 5 | Deviation Management | Batch and lot; blocks release |
| 6 | Non-Conformance | Lot, supplier |
| 7 | Incident Management | — |
| 8 | BMR/BPR Review | M07 batch record |
| 9 | Internal Quality Audits | CAPA |
| 10 | Supplier Quality Audits | Vendor qualification |
| 11 | Customer / Regulatory Audits | CAPA |
| 12 | Training Compliance | SOP version, user |
| 13 | Specification Approval | M08 specs |
| 14 | Quality Risk Management | Risk register |
| 15 | Complaint Investigation | Dealer, shipment, batch |
| 16 | Recall Management | Genealogy, shipments |
| 17 | QA Rights Governance | M01 QA authorities |
| + | Finished-goods disposition | Release, Hold, Reject, Rework |

**Data:** `qa.controlled_documents(+versions)`, `change_requests`, `deviations`, `non_conformances`, `incidents`, `capas`, `capa_actions`, `batch_reviews`, `batch_dispositions`, `audits`, `audit_findings`, `training_requirements`, `training_records`, `risks`, `complaints`, `recalls`, `recall_lines`.

## M10 — Logistics & Dispatch

| # | Submodule | Functions |
|---|---|---|
| 1 | Dispatch planning | Queue grouped by destination, date, dealer, warehouse, priority |
| 2 | Picking | Pick list from reservations; FEFO; lot validation |
| 3 | Packing & box scan | Box to shipment line |
| 4 | Transporter allocation | Vehicle, driver, LR |
| 5 | Shipping documents | Invoice, DC, packing list, e-way bill reference, LR |
| 6 | POD | Received quantity, shortage, damage, upload |
| 7 | Exceptions & returns | Partial, RTO, return, freight dispute, freight reconciliation |

**Data:** `log.shipments`, `shipment_lines`, `shipment_boxes`, `pick_lists`, `vehicle_assignments`, `lorry_receipts`, `delivery_proofs`, `returns(+lines)`, `freight_charges`.

## M11 — Mobile & QR

| # | Submodule | Functions |
|---|---|---|
| 1 | Serial & QR generation | Box serial, HMAC token, label print jobs |
| 2 | Internal scanner | Pack, move, pick, load, dispatch, receive, return, verify |
| 3 | Offline queue & sync | Local event store, idempotent batch sync |
| 4 | Conflict resolution | Operator queue on the web |
| 5 | Serial trace | Box history |
| 6 | Public verification | Limited, rate-limited page |

**Data:** `log.serial_boxes`, `scan_events`, `scan_conflicts`, `iam.devices`.

## M12 — Finance (scope depends on D02)

| # | Submodule | Model A (native) | Model B (subledger + external GL) |
|---|---|---|---|
| 1 | Customer / vendor / transporter ledgers | Full | Subledger |
| 2 | Credit control | ✔ | ✔ |
| 3 | Invoice engine & e-invoice / e-way bill | ✔ | ✔ |
| 4 | Receipts & allocation | ✔ | ✔ |
| 5 | Vendor payable & payments | ✔ | Payable; payment in external GL |
| 6 | Credit / debit notes | ✔ | ✔ |
| 7 | Accounting posting | Native GL journal | Posting to external system with acknowledgment |
| 8 | Bank reconciliation | ✔ | External |
| 9 | Tax reporting | ✔ | Outward/inward registers |
| 10 | Period close | ✔ | Posting lock + reconciliation |

**Data:** `fin.invoices(+lines)`, `credit_profiles`, `receipts`, `allocations`, `credit_notes`, `debit_notes`, `ledger_entries`, `posting_batches`, `external_postings`, `periods`.

## M13 — MIS & Reporting

| # | Submodule | Functions |
|---|---|---|
| 1 | Departmental dashboards (10) | Executive, Sales, Purchase, Warehouse, Production, QC, QA, Logistics, Finance, Admin |
| 2 | Standard reports (about 50) | Listed in doc 06 §4 |
| 3 | KPI dictionary | Formula, owner, refresh rate |
| 4 | Report builder & schedules | Enterprise release |

Reads from read-optimised SQL views and materialised views. Row-level scope is enforced in the query layer.

## M14 — Integrations & Platform

| # | Component | Purpose |
|---|---|---|
| 1 | Transactional outbox | Reliable domain events |
| 2 | Job queue & workers | PDF, notifications, imports, schedules |
| 3 | Notification service | In-app, email, WhatsApp |
| 4 | GST e-invoice / e-way bill adapter | Through a GSP (D27) |
| 5 | Accounting adapter | Model B (D02) |
| 6 | Document / PDF service | Quotation, PO, CoA, invoice, DC, LR templates |
| 7 | Import / export service | Masters and opening balances |
