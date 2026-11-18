# 01 — Requirements Inventory & Traceability Matrix (RTM)

Covers MP Part 30, Step 1, and the RTM structure in P7 §2.

## 1. Conventions

| Column | Meaning |
|---|---|
| **ID** | Module prefix plus a sequence number. IDs never change. A withdrawn requirement is marked `Rejected`, not renumbered. |
| **Requirement** | The behaviour the system must show, written so it can be tested. |
| **Source** | `BRD` = original requirement as reported by P1/P7/MP (exact clause pending, D00). `P1`–`P7` = planning phase and section. `MP§` = Master Prompt part. `UI§` = UI prompt section. |
| **Class** | `O` original BRD · `C` approved-in-principle correction to the BRD · `A` proposed addition or enhancement · `M` missing requirement found during this analysis · `X` conflicting, needs a decision |
| **Pri** | `P0` must exist for a safe first operation · `P1` needed for core ERP · `P2` important but deferrable · `Opt` optional |
| **Owner** | Department that is accountable for sign-off |
| **Rel** | Proposed release: `Pi` Pilot (Option A) · `Co` Integrated Core (Option B) · `En` Enterprise expansion (Option C). Depends on D12. |
| **Dec** | Open decisions that block this requirement. `—` means none. |
| **Test** | Acceptance test reference in doc 13. `TC-xx` = mandatory scenario, `UAT-xx` = P3 acceptance matrix, `MT-<mod>` = module test suite. |

**Decision status for every row below is `Pending`.** Nothing has been client-approved yet.

### 1.1 Inventory summary

| Class | Count | Meaning for the client |
|---|---|---|
| O — Original BRD | 93 | Kept as specified, or kept with details still to confirm |
| C — Correction | 19 | BRD intent kept, but how it works changes (for example, conditional approval routing) |
| A — Addition | 101 | Recommended in P1–P7 / MP and not present in the BRD |
| M — Missing | 10 | Found during this analysis and not covered by any source |
| X — Conflict | 12 | Sources disagree. Listed again in doc 12 §2 |
| **Total** | **235** | |

---

## 2. Security, identity and administration (SEC, ADM)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| SEC-001 | Four designated executive administration positions exist (BRD "four main admins"). | BRD; P7 §3; MP§4.2 | O | P0 | MD / IT | Pi | D14 | MT-ADM |
| SEC-002 | Admin power is split into Super, Executive, Security and Emergency administration. No role can bypass business controls without leaving a trace. | MP§4.2; P1 §7 G06 | X | P0 | MD / IT | Pi | D14 | TC-01, TC-18 |
| SEC-003 | Sensitive overrides need a written justification and an independent second approval, and are reviewed afterwards. | MP§4.2; P7 BR-12 | A | P0 | Executive / IT | Pi | D14 | MT-ADM |
| SEC-004 | Users log in with username or email and password. Passwords are hashed with argon2id. | MP§4.1 | O | P0 | IT | Pi | D22 | MT-AUTH |
| SEC-005 | MFA is mandatory for privileged, finance, QA-release and admin roles, and optional for others according to policy. | MP§4.1, §24 | A | P0 | IT | Pi | D22 | MT-AUTH |
| SEC-006 | Password recovery uses a single-use, time-limited token. Recovery does not reveal whether the account exists. | MP§4.1 | O | P0 | IT | Pi | — | MT-AUTH |
| SEC-007 | Session management: idle and absolute timeouts, a list of the user's active sessions, and revocation of any session. | MP§4.1 | A | P1 | IT | Co | — | MT-AUTH |
| SEC-008 | Accounts lock after a configurable number of failed logins. Suspicious-login alerts go to Security Admin. | MP§4.1 | A | P0 | IT | Pi | — | MT-AUTH |
| SEC-009 | User lifecycle: Invited → Active → Suspended → Deactivated. A deactivated user can never log in again and their history is kept. | MP§4.1 | O | P0 | HR / IT | Pi | — | MT-ADM |
| SEC-010 | Permissions are checked by the backend on every API call. The UI only hides actions the user cannot take. | MP§4.5, R4 | C | P0 | IT | Pi | — | TC-01 |
| SEC-011 | Row-level scoping by legal entity, plant, warehouse, territory subtree and assigned records. It applies to lists, reports, exports and search. | MP§4.5, §19.2 | A | P0 | IT | Pi | — | TC-01 |
| SEC-012 | Maker-checker: the same user can never both create and approve a record that the policy marks for segregation. | P4 §5; MP§24 | A | P0 | IT | Pi | — | MT-APR |
| SEC-013 | An append-only audit event is written for every create, update and state change, with actor, time, before/after values, IP and device. | MP§24; P3 §5 | O | P0 | IT | Pi | — | MT-AUD |
| SEC-014 | Exporting sensitive data needs its own permission and a stated purpose, and creates an audit event. | P4 §5 | A | P1 | IT | Co | — | MT-ADM |
| SEC-015 | API rate limiting per user and per IP. The login endpoint has stricter limits. | MP§24 | A | P1 | IT | Co | — | MT-SEC |
| SEC-016 | Security is checked against OWASP ASVS Level 2 before go-live. | MP§24 | A | P1 | IT | Co | — | Sec test |
| SEC-017 | Data is encrypted in transit (TLS 1.2+) and at rest (database, object storage, backups). | MP§24 | A | P0 | IT | Pi | D21 | Sec test |
| SEC-018 | Privileged access is approved by an independent approver and recertified periodically. | P1 §4 IT | A | P1 | IT | Co | — | MT-ADM |
| ADM-001 | Role matrix screen: module × action × scope × effective date. Changes are proposed, then approved. | P4 §2 M01 | A | P0 | IT | Pi | — | MT-ADM |
| ADM-002 | Approval delegation with a start and end date, limited to the delegator's own authority. | MP§20.1; P4 §3 | A | P1 | IT | Co | — | MT-APR |
| ADM-003 | Audit viewer: search by actor, object, action and time, with a before/after diff. | P4 §2 M01 | A | P0 | IT | Pi | — | MT-AUD |
| ADM-004 | System configuration (number series, templates, policy values) is versioned and effective-dated. | MP§3.3 | A | P1 | IT | Pi | D28 | MT-ADM |

## 3. Organisation & sales hierarchy (ORG)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| ORG-001 | Nine-tier sales hierarchy: BH, NSM, DSM, ZSM, RSM, SASM, ASM, TSM, SE. | BRD; MP§4.3; P7 SAL-001 | O | P0 | Sales | Pi | — | MT-ORG |
| ORG-002 | Each user record holds: employee ID, department, designation, reporting manager, territory, status, roles, approval authority and login identity. | MP§4.3 | O | P0 | HR | Pi | — | MT-ORG |
| ORG-003 | Territory tree is configured by admins: National → Zone → State → Region → District → Taluka → Dealer/Retail Beat. Nothing is hardcoded. | MP§4.3, R3 | O | P0 | Sales | Pi | — | MT-ORG |
| ORG-004 | Moving a territory from one owner to another transfers open leads, opportunities and dealers, and keeps the history. | P1 §4 Sales | M | P1 | Sales | Co | — | MT-ORG |
| ORG-005 | Legal entity, plant, warehouse, zone and bin hierarchy. More plants and warehouses can be added without code changes. | MP§11.1, R14 | O | P0 | Plant / Stores | Pi | D26 | MT-ORG |
| ORG-006 | Departments master and cost centres. | MP§5.1 | A | P1 | Finance | Co | — | MT-MDM |

## 4. Master data (MDM)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| MDM-001 | All 20 master types in MP§5.1 are managed centrally. | MP§5.1; P3 §3 | O | P0 | Data owners | Pi | — | MT-MDM |
| MDM-002 | Master lifecycle: Draft → Submitted → Verified → Approved → Active, plus Suspended and Inactive. | MP§5.2; P2 Admin | A | P0 | Data owners | Pi | — | MT-MDM |
| MDM-003 | Unique codes, duplicate detection (GSTIN, PAN, mobile, name similarity) and mandatory/conditional field rules. | MP§5.2 | A | P0 | Data owners | Pi | — | TC-19 |
| MDM-004 | Material changes (price group, credit, tax, BOM, spec) are effective-dated and keep their version history. | P3 §5; MP§5.2 | A | P0 | Data owners | Pi | — | MT-MDM |
| MDM-005 | An unverified or inactive master cannot be used in commercial or regulated transactions. | MP§5.2 | A | P0 | Data owners | Pi | — | TC-03 |
| MDM-006 | A master that has transactions cannot be hard-deleted. It can only be deactivated. | MP§5.2; P3 §5 | A | P0 | IT | Pi | — | TC-18 |
| MDM-007 | GSTIN validation: 15 alphanumeric characters, pattern and checksum, and state code matching the address. | P1 §6; P3 §6 | C | P0 | Finance | Pi | — | MT-MDM |
| MDM-008 | Product SKU master: formulation, pack variants, UOM conversions, HSN, effective tax rule, shelf life and storage class. | P3 §3 | O | P0 | Product owner | Pi | D08 | MT-MDM |
| MDM-009 | HSN/GST tax master is effective-dated. Rates are configured, not hardcoded. | P1 §6; R3 | C | P0 | Finance | Pi | D27 | MT-MDM |
| MDM-010 | UOM master with item-specific conversions (for example kg ↔ L by density) and rounding rules. | P1 §4 Inv | A | P0 | Stores | Pi | — | MT-MDM |
| MDM-011 | Vendor master: identity, items supplied, qualification status, bank account (verified) and rating. | P3 §3 | O | P0 | Purchase | Pi | — | MT-MDM |
| MDM-012 | Transporter master: permits, SLA, vehicle coverage and bank details. | P3 §3 | O | P1 | Logistics | Co | — | MT-MDM |
| MDM-013 | Equipment and instrument master, linked to calibration (QC) and production lines. | MP§5.1 | O | P1 | Plant / QC | Co | — | MT-MDM |
| MDM-014 | Bulk import with validation, and a per-row error report. Nothing is committed while invalid references remain. | MP§3.5; TC-19 | A | P1 | IT | Co | D10 | TC-19 |
| MDM-015 | Document types master: name, mandatory-for rules, expiry tracking flag and retention period. | MP§5.1 | A | P1 | Admin | Co | D25 | MT-DMS |

## 5. Dealer & distributor management (DLR)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| DLR-001 | Dealer registration captures business, commercial, statutory and security information (MP§6.1). Dealer code is generated automatically. | BRD; MP§6.1 | O | P0 | Sales | Pi | — | UAT-01 |
| DLR-002 | Required KYC documents depend on constitution type (proprietor, partnership, LLP, Pvt Ltd, etc.). | P1 §4; MP§6.1 | C | P0 | Compliance | Pi | D07 | UAT-01 |
| DLR-003 | Three security cheques and five director KYC records are collected only where the approved policy says so. They are not universal. | BRD; P1 §6; MP§6.1 | X | P1 | Finance | Pi | D07 | MT-DLR |
| DLR-004 | Licence vault: fertilizer and pesticide licence number, issuer, validity and eligible product categories, with evidence attached. | BRD; MP§6.1 | O | P0 | Compliance | Pi | D08 | TC-03 |
| DLR-005 | Onboarding workflow: Registration → Document Verification → Commercial Review → Finance Review → Final Approval → Activation. | MP§6.2; P2 | C | P0 | Sales / Fin | Pi | D07 | UAT-01 |
| DLR-006 | Each stage records remarks, a rejection reason and requests for pending documents. | MP§6.2 | A | P0 | Sales | Pi | — | MT-DLR |
| DLR-007 | Dealers can be suspended and reactivated with a reason. A suspended dealer cannot get new quotations or orders. | MP§6.2 | A | P0 | Sales / Fin | Pi | — | MT-DLR |
| DLR-008 | Licence expiry alerts go out at T-60, T-30 and T-7 days (configurable). On expiry, orders for the affected product categories are blocked. | MP§6.2; P2 §4; BR-11 | A | P0 | Compliance | Pi | D08 | TC-03, UAT-02 |
| DLR-009 | Dealer 360° view: profile, people, leads, quotations, orders, invoices, outstanding, credit, dispatches, complaints, returns, documents and timeline. | MP§6.3 | O | P1 | Sales | Co | — | MT-DLR |
| DLR-010 | Bank account details are verified before any refund or credit note payout. | P1 §4 | A | P1 | Finance | Co | — | MT-DLR |
| DLR-011 | Duplicate GSTIN or PAN across dealers is blocked. If allowed by policy, a multi-branch dealer is linked to a parent instead. | P2 Dealer | A | P0 | Sales | Pi | — | TC-02 |
| DLR-012 | Decide whether dealers get their own portal login to place orders and view their ledger. | — | M | P2 | Sales | En | D31 | — |

## 6. Sales & CRM — all 18 BRD submodules kept (CRM)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| CRM-001 | All 18 Sales & Marketing Hub submodules are kept (the list is in doc 02 §M03). | BRD; P7 CRM-001; MP§7 | O | P0 | Sales | Co | — | MT-CRM |
| CRM-002 | CRM dashboard with the 10 KPIs in MP§7.1, scoped to the viewer's territory subtree. | MP§7.1 | O | P1 | Sales | Co | D23 | MT-MIS |
| CRM-003 | Lead capture with the fields in MP§7.2 and configurable sources (exhibition, IndiaMART, field, referral, dealer enquiry). | BRD; MP§7.2 | O | P0 | Sales | Co | — | MT-CRM |
| CRM-004 | Leads are checked for duplicates on mobile, GSTIN and company name. A duplicate can be merged, keeping its history. | P1 §4 Sales | A | P1 | Sales | Co | — | MT-CRM |
| CRM-005 | Lead ownership transfer with a reason. The audit trail keeps the previous owner. | P1 §4 Sales | A | P1 | Sales | Co | — | MT-CRM |
| CRM-006 | BANT qualification, plus configurable extra qualification fields. | BRD; MP§7.3 | O | P1 | Sales | Co | — | MT-CRM |
| CRM-007 | Opportunity pipeline (Kanban) with the 5 stages, value, expected close date, probability, product demand, activities and a mandatory loss reason. | BRD; MP§7.4 | O | P1 | Sales | Co | — | MT-CRM |
| CRM-008 | Activities: calls, meetings, dealer and field visits, agronomist discussions, follow-ups, reminders and a timeline. | BRD; MP§7.5 | O | P1 | Sales | Co | — | MT-CRM |
| CRM-009 | Annual targets split monthly and down the hierarchy. The total of children cannot exceed the parent. Shows achievement vs target. | BRD; MP§7.6 | O | P1 | Sales | Co | D23 | MT-CRM |
| CRM-010 | Pricing: base rates, dealer price groups, volume slabs, trade and promotional discounts, contract prices, effective dates and approved exceptions. | BRD; MP§7.7 | O | P0 | Sales / Fin | Co | — | MT-CRM |
| CRM-011 | Sample workflow: Request → Approval → Warehouse Allocation → Dispatch → Trial → Feedback. Each sample is linked to a released batch. | BRD; MP§7.8 | O | P1 | Sales / Stores | Co | — | MT-CRM |
| CRM-012 | Field trial record: crop, location, product, dosage, date, baseline, observations, performance, farmer feedback and findings. | BRD; MP§7.9 | O | P2 | Sales / Agronomy | Co | — | MT-CRM |
| CRM-013 | Competitor intelligence register with restricted visibility. | BRD; MP§7.10 | O | P2 | Sales | Co | — | MT-CRM |
| CRM-014 | Beat planning: monthly tour plan, daily schedule, GPS check-in/out, visit outcome and follow-up tasks. | BRD; MP§7.11 | O | P1 | Sales | Co | D09 | MT-CRM |
| CRM-015 | Beat expenses are captured and approved, if the client brings them into scope. | MP§7.11 | X | Opt | Sales / Fin | En | D30 | — |
| CRM-016 | Contract and annual volume agreements, with a consumption tracker. | BRD; MP§7.12 | O | P2 | Sales | Co | — | MT-CRM |
| CRM-017 | Outstanding debt and recovery: aging, a promise-to-pay log and escalation. | BRD; MP§7.12 | O | P1 | Sales / Fin | Co | — | MT-CRM |
| CRM-018 | Order approval register and executive sales analytics. | BRD; MP§7.12 | O | P1 | Sales | Co | — | MT-MIS |
| CRM-019 | Standard Excel/CSV exports, permission-controlled and audited. | MP§7.12 | O | P1 | Sales | Co | — | MT-MIS |
| CRM-020 | Customer 360°. It shares its implementation with the Dealer 360° view (DLR-009). | MP§7.12 | O | P1 | Sales | Co | — | MT-DLR |

## 7. Quotation (QUO)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| QUO-001 | Multi-item quotation with the header fields in MP§8.1 and the line columns in MP§8.2. | BRD; MP§8 | O | P0 | Sales | Pi | — | MT-QUO |
| QUO-002 | The server calculates tax as CGST+SGST (intra-state) or IGST (inter-state), based on the place of supply. Rounding follows the configured rules. | MP§8.2 | O | P0 | Finance | Pi | D27 | MT-QUO |
| QUO-003 | All 14 actions in MP§8.3, including Revise, Duplicate, PDF, Email and Convert to Sales Order. | MP§8.3 | O | P0 | Sales | Pi | — | MT-QUO |
| QUO-004 | Validity period is a configurable policy (BRD default 7 days). An expired quotation can be revalidated or reissued but not converted. | BRD; P1 §6; MP§8.3 | C | P0 | Sales | Pi | D16 | MT-QUO |
| QUO-005 | Every revision is kept as an immutable version (Q-0001/R1, R2 …) with a diff. | MP§8.3 | A | P0 | Sales | Pi | — | MT-QUO |
| QUO-006 | A discount above the user's tier limit sends the quotation for approval before it can be sent to the dealer. | BRD; MP§4.4 | O | P0 | Sales | Pi | D15 | TC-04 |

## 8. Sales order (SO)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| SO-001 | A sales order can come from an approved quotation, a dealer PO, contract pricing or another approved channel. The dealer PO number and attachment are captured. | BRD; MP§9.1 | O | P0 | Sales | Pi | — | MT-SO |
| SO-002 | The 10 validations in MP§9.2 run on the server at submit and again at approval. | MP§9.2; P3 §6 | A | P0 | Sales / Fin | Pi | — | TC-03, TC-04 |
| SO-003 | The same dealer PO reference cannot be used twice for one dealer. | MP§9.2 | A | P0 | Sales | Pi | — | MT-SO |
| SO-004 | Approval is routed by a policy engine (value, discount, credit, territory, exception). Sequential BRD chain vs conditional routing is a client decision. | BRD; P1 §5; P7 SAL-003 | X | P0 | Sales / MD | Pi | D01 | TC-04, UAT-03 |
| SO-005 | Approval stages: Commercial approval → Accounts/credit review → Fulfilment allocation → Dispatch authorisation. | MP§9.3; P4 §4 | C | P0 | Sales / Fin | Pi | D01 | UAT-03 |
| SO-006 | Order statuses follow the harmonised set in doc 05 §12.1. | MP§9.4; P4 §4 | C | P0 | Sales | Pi | — | MT-SO |
| SO-007 | Amendments create a new revision. A material change (qty, price, discount, product, terms) invalidates the affected approvals and re-runs validation. | MP§9.5; BR-02 | C | P0 | Sales / Fin | Pi | D17 | TC-05, UAT-05 |
| SO-008 | Backorders and partial fulfilment are supported, with the open quantity tracked per line. | P4 §4; MP§9.4 | A | P0 | Stores | Pi | D03 | MT-SO |
| SO-009 | Cancelling an order releases its reservations and records the reason. Cancellation after dispatch is not allowed; a return is used instead. | MP§9.4 | A | P0 | Sales | Pi | — | MT-SO |

## 9. Approval engine (APR)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| APR-001 | One central approval engine is reused by every module. | MP§20 | A | P0 | IT | Pi | — | MT-APR |
| APR-002 | Actions: Submit, Approve, Reject, Hold, Return for Correction, Request Revision, Escalate, Delegate, Cancel, Close. | MP§20.1 | A | P0 | IT | Pi | — | MT-APR |
| APR-003 | Rules depend on transaction type, value, discount, credit exposure, department, hierarchy, territory, product category, exception type and approver group. | MP§20.2 | A | P0 | IT | Pi | D01 | MT-APR |
| APR-004 | Rules are versioned, simulated before publishing and effective-dated. Each decision stores the rule version that applied. | MP§20.4; P4 M01 | A | P0 | IT | Pi | — | MT-APR |
| APR-005 | SLA timers and an escalation ladder, with notifications. | MP§20.2, §21 | A | P1 | IT | Co | D11 | MT-APR |
| APR-006 | Approval register with aging and priority. Approval inbox per user. | MP§20.3 | A | P0 | IT | Pi | — | MT-APR |
| APR-007 | Approvals cannot be bypassed through the API. State changes are allowed only through the workflow service. | MP§20.4, R4 | A | P0 | IT | Pi | — | TC-01 |
| APR-008 | Sales authority limits (MP§4.4 table) are seeded as an inactive configuration and switched on only after business approval. | BRD; MP§4.4 | O | P0 | Sales / MD | Pi | D15 | TC-04 |

## 10. Procurement (PUR)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| PUR-001 | Multi-item procurement documents. | BRD; P7 PUR-001 | O | P0 | Purchase | Pi | — | MT-PUR |
| PUR-002 | A purchase requisition, with approval, is required before a PO (fields in MP§10.1). | P7 PUR-002; MP§10.1 | A | P0 | Purchase | Pi | D06 | MT-PUR |
| PUR-003 | Budget and authority check on the PR, by cost centre. | P2 Proc | A | P1 | Finance | Co | D06 | MT-PUR |
| PUR-004 | RFQ to several vendors for several items, with a deadline, uploaded vendor responses and technical compliance. | BRD; MP§10.2 | O | P1 | Purchase | Co | — | MT-PUR |
| PUR-005 | Comparative statement with landed cost, lead time, quality rating and qualification. Choosing a vendor other than the cheapest needs a reason. | MP§10.3 | A | P1 | Purchase | Co | — | MT-PUR |
| PUR-006 | Multi-item PO (fields in MP§10.4) with an approval workflow. | BRD; MP§10.4 | O | P0 | Purchase | Pi | D06 | MT-PUR |
| PUR-007 | PO amendments are versioned and re-approved. Cancelling the balance is supported. | P1 §4 | A | P1 | Purchase | Co | — | MT-PUR |
| PUR-008 | Partial receipts against PO lines keep the outstanding quantity. | P1 §4; TC-09 | A | P0 | Stores | Pi | — | TC-09, UAT-06 |
| PUR-009 | Three-way match (PO, GRN, invoice) with configurable quantity, price and tax tolerances. Anything outside tolerance goes to an exception queue. | BRD; MP§10.6 | O | P0 | Finance | Co | D06 | TC-10 |
| PUR-010 | Supplier returns against the original GRN and lot, with a debit note. | P1 §4; MP§10.5 | A | P1 | Purchase | Co | — | MT-PUR |
| PUR-011 | Emergency or single-source purchase path with retrospective approval. | P2 D06 | X | P2 | Purchase | Co | D06 | MT-PUR |
| PUR-012 | Supplier advance payment and its settlement against the invoice. | P1 §4 | M | P2 | Finance | Co | D02 | MT-FIN |

## 11. Inventory & warehouse (INV)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| INV-001 | GRN creates a traceable internal lot and puts it in quarantine automatically. A quarantined lot cannot be issued (full spec in P7 §7). | BRD; P7 §7; BR-04 | O | P0 | Stores / QC | Pi | D04 | TC-08 |
| INV-002 | Stock ledger: balances come only from movements. There is no editable quantity field. | P3 §5; P7 INV-002 | A | P0 | Stores | Pi | — | MT-INV |
| INV-003 | Stock is described by three separate dimensions — location, quality status and allocation — rather than one exclusive state (doc 04 §5). | P1 §5; MP§11.2 | C | P0 | Stores | Pi | D05 | TC-07 |
| INV-004 | GRN fields as listed in MP§11.3, including supplier batch, internal lot, manufacturing and expiry dates, and vehicle. | MP§11.3 | O | P0 | Stores | Pi | — | MT-INV |
| INV-005 | Gate entry is recorded before the GRN. | P2 Inv | A | P1 | Stores | Co | — | MT-INV |
| INV-006 | Multi-warehouse with zones and bins. The BRD's warehouse structure is configured as master data. | BRD; MP§11.1 | O | P0 | Stores | Pi | D26 | MT-INV |
| INV-007 | Reservations are safe under concurrent use: the same eligible quantity can never be reserved twice. | BR-06; TC-07 | A | P0 | Stores | Pi | — | TC-07 |
| INV-008 | Negative stock is blocked unless an authorised exception exists. | MP§11.6 | A | P0 | Stores | Pi | — | MT-INV |
| INV-009 | FEFO/FIFO picking suggestions per item class. A different lot can be chosen with a reason. | MP§11.6 | A | P1 | Stores | Co | D05 | MT-INV |
| INV-010 | Transfers between warehouses go through an in-transit state, with any loss recorded on receipt. | P1 §4 | A | P1 | Stores | Co | — | MT-INV |
| INV-011 | Cycle counts: count sheet → variance → independent approval → adjustment movement. | MP§11.5; BR-08 | A | P1 | Stores / Fin | Co | D05 | MT-INV |
| INV-012 | Expired, damaged and rejected stock is segregated automatically and blocked from issue and dispatch. | MP§11.5 | A | P0 | Stores / QA | Pi | — | MT-INV |
| INV-013 | Reorder and expiry alerts, configured per item and warehouse. | MP§11.5 | O | P1 | Stores | Co | — | MT-INV |
| INV-014 | Inventory valuation method (weighted average or FIFO) per legal entity. | MP§11.5 | X | P1 | Finance | Co | D05 | MT-INV |
| INV-015 | Every movement carries a source document and an authorised actor. Posted movements are corrected only by reversal. | MP§11.4, R7 | A | P0 | Stores | Pi | — | TC-18 |

## 12. Manufacturing — all 16 BRD functions kept (MFG)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| MFG-001 | All 16 production functions are kept (the list is in doc 02 §M07). | BRD; P7 MFG-001 | O | P0 | Plant | Co | — | MT-MFG |
| MFG-002 | Production dashboard with the KPIs in MP§12.1. | BRD; MP§12.1 | O | P1 | Plant | Co | D23 | MT-MIS |
| MFG-003 | OEE = Availability × Performance × Quality. Any other ratio is labelled differently. | P1 §6; MP§12.1 | C | P1 | Plant | Co | D23 | MT-MFG |
| MFG-004 | MRP uses sales orders, forecast, FG stock, BOM, raw material stock, lead times, safety stock and capacity, and produces planned orders and PR proposals. | BRD; MP§12.2 | O | P1 | Plant | Co | D03 | MT-MFG |
| MFG-005 | Production order fields as listed in MP§12.3. | BRD; MP§12.3 | O | P0 | Plant | Pi | — | MT-MFG |
| MFG-006 | BOM/formulation versions are effective-dated. Only an approved, effective version can be released to production. | BRD; MP§12.4; BR-07 | C | P0 | Plant / QA | Pi | — | MT-MFG |
| MFG-007 | Execution: Reserve → Issue → Batch start → Dosing → Processing → IPQC → Completion → Packaging. Actual lots, quantities, operators, equipment and readings are recorded. | BRD; MP§12.5 | O | P0 | Plant | Pi | — | UAT-08 |
| MFG-008 | Consumption above BOM tolerance needs an authorised deviation. | TC-11 | A | P0 | Plant / QA | Pi | — | TC-11 |
| MFG-009 | Approved material substitutions within the approved alternates list. | P1 §4 | A | P1 | Plant / QA | Co | D03 | MT-MFG |
| MFG-010 | Yield and mass-balance reconciliation: planned and actual yield, variance, scrap, waste, recovered material and rework. | BRD; MP§12.6 | O | P0 | Plant | Pi | — | MT-MFG |
| MFG-011 | Packaging work order, packing material issue, filled and rejected packs, box serials and QR label printing. | BRD; MP§12.7 | O | P0 | Plant | Pi | D24 | MT-MFG |
| MFG-012 | Backward and forward traceability, including rework genealogy. | BRD; MP§12.8 | O | P0 | Plant / QA | Pi | — | UAT-15 |
| MFG-013 | Production order amendment and cancellation, with stock reversal. | P1 §4 | A | P1 | Plant | Co | — | MT-MFG |
| MFG-014 | Downtime logging with reason codes (feeds OEE availability). | MP§12.1 | O | P1 | Plant | Co | — | MT-MFG |
| MFG-015 | Production cost per batch and per MT (material, plus labour and overhead allocation). | BRD; P4 M07 | O | P2 | Plant / Fin | Co | D32 | MT-MFG |
| MFG-016 | Capacity and line scheduling, and maintenance windows. | P1 §4 | A | P2 | Plant | En | — | MT-MFG |

## 13. Quality control — all 6 BRD submodules kept (QC)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| QC-001 | All 6 QC submodules are kept (doc 02 §M08). | BRD; P7 QCL-001 | O | P0 | QC | Pi | — | MT-QC |
| QC-002 | QC dashboard with the KPIs in MP§13.1. | MP§13.1 | O | P1 | QC | Co | — | MT-MIS |
| QC-003 | Sample IDs are unique and carry chain-of-custody events (collected, received, split, retained, disposed). | MP§13.2; P1 §4 | A | P0 | QC | Pi | — | MT-QC |
| QC-004 | Results are entered against an effective specification and method, with instrument, analyst and raw evidence attached. | MP§13.3 | O | P0 | QC | Pi | — | MT-QC |
| QC-005 | The analyst who enters a result cannot be the reviewer who approves it (enforced by the system). | MP§13.4 | A | P0 | QC | Pi | — | MT-QC |
| QC-006 | Controlled CoA document, versioned, with reviewer and approver. | BRD; MP§13.5 | O | P0 | QC | Pi | — | MT-QC |
| QC-007 | An OOS/OOT result automatically opens an investigation. A retest needs authorisation. The original result is never overwritten. | BRD; MP§13.6 | O | P0 | QC | Pi | — | TC-12 |
| QC-008 | An instrument that is overdue for calibration cannot be selected for a result. | BRD; MP§13.7 | O | P1 | QC | Co | — | MT-QC |
| QC-009 | Raw-material lot disposition (Release, Reject, Hold) with authorised signatory. | P4 M08; P2 QC | C | P0 | QC / QA | Pi | D04 | TC-08 |
| QC-010 | Retention samples, and reagent and standard expiry tracking. | P1 §4 | M | P2 | QC | Co | — | MT-QC |

## 14. Quality assurance — all 17 BRD submodules kept (QA)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| QA-001 | All 17 QA submodules are kept (MP§14 list; doc 02 §M09). | BRD; P7 QAS-001 | O | P0 | QA | Co | — | MT-QA |
| QA-002 | QA dashboard with the KPIs in MP§14.1. | MP§14.1 | O | P1 | QA | Co | — | MT-MIS |
| QA-003 | FG release requires: QC results approved → BMR/BPR reviewed → deviations reviewed → QA disposition. | MP§14.2; BR-05 | C | P0 | QA | Pi | D04 | TC-13, UAT-09 |
| QA-004 | Only the designated QA release authority can set the disposition (Released, On Hold, Rejected, Rework Authorised). | MP§14.2 | C | P0 | QA | Pi | D04 | TC-13 |
| QA-005 | Release is blocked while a deviation linked to the batch is still open. | P2 §4; TC-13 | A | P0 | QA | Pi | — | TC-13 |
| QA-006 | Controlled document lifecycle: number, version, owner, author, reviewer, approver, effective date, review date and history. | MP§14.3 | O | P1 | QA | Co | — | MT-QA |
| QA-007 | CAPA lifecycle with effectiveness verification. | MP§14.4 | O | P1 | QA | Co | — | MT-QA |
| QA-008 | Recall case: affected shipments, dealers, stock, actions and reconciliation, with recall drill mode. | MP§14.5 | O | P1 | QA | Co | — | UAT-15 |
| QA-009 | Deviation, NC, incident and change control registers, cross-linked to batches, lots and CAPA. | BRD; MP§14 | O | P1 | QA | Co | — | MT-QA |
| QA-010 | Internal, supplier and customer/regulatory audits with findings that link to CAPA. | BRD; MP§14 | O | P2 | QA | Co | — | MT-QA |
| QA-011 | Training compliance: each SOP version requires training, and effectiveness is recorded. An untrained user can be blocked from SOP-bound tasks. | BRD; P1 §4 | C | P2 | QA / HR | En | — | MT-QA |
| QA-012 | Quality risk register (FMEA-style scoring). | BRD; MP§14 | O | P2 | QA | En | — | MT-QA |
| QA-013 | Complaint investigation linked to the batch, shipment and dealer, flowing to CAPA and recall. | BRD; MP§14 | O | P1 | QA | Co | — | MT-QA |
| QA-014 | "QA Rights Governance" — QA authorities are delegated, recorded and recertified. | BRD; MP§14 | O | P1 | QA | Co | — | MT-QA |
| QA-015 | The ISO 9001 revision and the client's certification obligations are confirmed. No compliance claim is made in the system. | P1 §6; R11 | C | P2 | QA | — | D08 | — |

## 15. Logistics & dispatch (LOG)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| LOG-001 | Dispatch planning queue of approved, allocated orders, grouped as in MP§15.1. | BRD; MP§15.1 | O | P0 | Logistics | Pi | — | MT-LOG |
| LOG-002 | Pick list → batch validation → pack → box scan → loading confirmation. | BRD; MP§15.2 | O | P0 | Stores | Pi | — | MT-LOG |
| LOG-003 | Only QA-released lots can be picked (enforced by the server). | MP§11.6; BR-05 | A | P0 | Stores | Pi | — | TC-13 |
| LOG-004 | Transporter, vehicle and driver allocation, with freight terms. | BRD; MP§15.3 | O | P0 | Logistics | Pi | — | MT-LOG |
| LOG-005 | Shipping documents: invoice, delivery challan, packing list, e-way bill reference and LR. | BRD; MP§15.4 | O | P0 | Logistics | Pi | D08 | MT-LOG |
| LOG-006 | POD with received quantity, recipient, upload, and shortage/damage remarks. | BRD; MP§15.5 | O | P0 | Logistics | Pi | — | TC-16 |
| LOG-007 | Exceptions: partial dispatch, short loading, damage, failed delivery, RTO, customer return and freight dispute. | P1 §4; MP§15.6 | A | P1 | Logistics | Co | — | TC-16 |
| LOG-008 | Freight reconciliation against the transporter invoice. | P1 §4 | A | P1 | Logistics / Fin | Co | — | MT-LOG |
| LOG-009 | Only scanned and confirmed quantities are posted as dispatched. | P2 §4 | A | P0 | Logistics | Pi | — | TC-14 |

## 16. QR & mobile (QR, MOB)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| QR-001 | Each FG box gets a unique serial identity linked to product, SKU, batch, manufacturing and expiry dates, serial and verification token. | BRD; MP§16.1; P7 LOG-001 | O | P0 | Plant / IT | Pi | D24 | MT-QR |
| QR-002 | Server-side verification uses an HMAC-signed token. A visible hash alone is never trusted. | MP§16.1 | C | P0 | IT | Pi | — | MT-QR |
| QR-003 | Internal scan actions: pack, move, pick, load, dispatch, receive, return and verify. | BRD; MP§16.2 | O | P0 | Stores | Pi | — | MT-QR |
| QR-004 | A box cannot be scanned into two incompatible shipments. The second scan is rejected and logged. | TC-14; UAT-10 | A | P0 | Stores | Pi | — | TC-14 |
| MOB-001 | Offline scanning: event ID, device, user, scan type, local time, sync status, server response and conflict status are captured. | BRD; MP§16.3; P7 MOB-001 | O | P1 | Stores / IT | Co | D09 | TC-15 |
| MOB-002 | The server reconciles all offline events. Duplicates are ignored idempotently. Conflicts go to an operator resolution queue. | MP§16.3; BR-10 | A | P1 | IT | Co | — | TC-15 |
| MOB-003 | Device registration, remote wipe/revocation and an encrypted local store. | P4 §7 | A | P1 | IT | Co | D09 | MT-MOB |
| MOB-004 | Public verification page shows only product name, pack, batch, dates and a genuine/not-genuine result. It is rate-limited. | MP§16.4, R10 | A | P1 | IT | Co | D24 | MT-QR |
| MOB-005 | Packaging and installation method (PWA or Android APK) is decided after device testing. "APK by URL parameter" is not a valid method. | P1 §6; P4 §1 | C | P1 | IT | Co | D09 | — |
| MOB-006 | Mobile field-sales tasks: beat plan, check-in, lead and activity capture. | MP§7.11 | A | P2 | Sales | En | D09 | MT-MOB |

## 17. Finance (FIN)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| FIN-001 | Ledgers for dealers, vendors and transporters, and credit restriction. | BRD; P7 FIN-001 | O | P0 | Finance | Co | D02 | MT-FIN |
| FIN-002 | Finance model: native accounting (Model A) or subledgers plus external accounting integration (Model B). Only one is built. | P7 FIN-002; MP§17 | X | P0 | Finance / MD | — | D02 | — |
| FIN-003 | Invoice engine with the fields in MP§17.2. Invoices are created from dispatched quantities. | BRD; MP§17.2 | O | P0 | Finance | Pi | D27 | MT-FIN |
| FIN-004 | GST e-invoice (IRN, signed QR, cancellation window) and e-way bill generation, if applicable after confirmation. | P1 §6; MP§17.2 | X | P1 | Finance | Co | D08, D27 | MT-INT |
| FIN-005 | Credit control checks outstanding, aging, limit, open exposure and terms. An overrun needs an authorised exception and never passes silently. | BRD; MP§17.3; BR-03 | O | P0 | Finance | Pi | D18 | TC-06, UAT-04 |
| FIN-006 | Receipts and allocation to invoices: partial, on-account and advance. | MP§17.1; UAT-11 | A | P0 | Finance | Co | D02 | UAT-11 |
| FIN-007 | Credit and debit notes linked to the source (return, rate difference, shortage). | MP§17.1 | A | P1 | Finance | Co | — | UAT-12 |
| FIN-008 | Vendor payable from the matched invoice, and vendor payments. | MP§17.1 | A | P1 | Finance | Co | D02 | MT-FIN |
| FIN-009 | Bank reconciliation. | MP§17.1 | A | P2 | Finance | Co | D02 | MT-FIN |
| FIN-010 | Postings are idempotent. Each one keeps a source reference, a posting status and the external acknowledgment. A retry can never post twice. | MP§17.4, R6 | A | P0 | Finance | Co | — | TC-17, UAT-14 |
| FIN-011 | Posting period lock and financial close checklist. | P1 §4; MP§17.1 | A | P1 | Finance | Co | — | MT-FIN |
| FIN-012 | GST tax summary reports (GSTR-1 style outward, inward register). | BRD; MP§19.2 | O | P1 | Finance | Co | D08 | MT-FIN |
| FIN-013 | A return after invoicing reconciles stock, tax and finance together. | P2 §4; UAT-12 | A | P1 | Finance | Co | — | UAT-12 |

## 18. Documents, notifications, reporting (DMS, NTF, MIS)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| DMS-001 | Central document vault for the 16 categories in MP§18. Files are kept in private object storage; their metadata is kept in PostgreSQL. | BRD; MP§3.4, §18 | O | P0 | Admin | Pi | — | MT-DMS |
| DMS-002 | Upload, preview, versioning, authorised download through short-lived signed URLs, expiry tracking, review and audit. | MP§18 | O | P0 | Admin | Pi | — | MT-DMS |
| DMS-003 | Uploads are virus-scanned and their MIME type and size checked. | — | M | P1 | IT | Co | — | Sec test |
| DMS-004 | Retention schedule per document type, and legal hold. | P1 §6 privacy | M | P2 | Compliance | Co | D25 | MT-DMS |
| NTF-001 | The 17 notification types in MP§21.1. | MP§21.1 | A | P1 | IT | Co | D11 | MT-NTF |
| NTF-002 | Channels: in-app, email, and WhatsApp Business (where approved). Delivery status and history are kept. | BRD; MP§21.2 | O | P1 | IT | Co | D11 | MT-NTF |
| NTF-003 | Admin-configurable trigger, condition, recipients, channel, template, escalation and active flag. | MP§21.3 | A | P2 | IT | Co | — | MT-NTF |
| NTF-004 | No duplicate notifications on retry: each message has a dedupe key. | MP§21.3 | A | P1 | IT | Co | — | MT-NTF |
| MIS-001 | Ten departmental dashboards (MP§19). | BRD; MP§19 | O | P1 | Mgmt | Co | D23 | MT-MIS |
| MIS-002 | Report catalogue as in MP§19.2 (about 50 reports, listed in doc 06 §4). | MP§19.2 | O | P1 | Mgmt | Co | D23 | MT-MIS |
| MIS-003 | Reports apply the same row-level scope as the screens. | MP§19.2 | A | P0 | IT | Co | — | TC-01 |
| MIS-004 | Each KPI has a written formula, an owner and a refresh rate (KPI dictionary). | P2 MIS; P1 G12 | A | P1 | Mgmt | Co | D23 | MT-MIS |
| MIS-005 | Report builder: dataset, fields, permission and schedule. | P4 M13 | A | P2 | Mgmt | En | — | MT-MIS |
| MIS-006 | Global search across permitted records. | MP§3.1; UI§23 | A | P1 | IT | Co | — | MT-UI |

## 19. Platform, data, operations (PLT)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| PLT-001 | React + TypeScript frontend. Vite (MP) or Next.js (UI prompt) still to be decided. | MP§3.1; UI§40 | X | P0 | IT | Pi | D19 | — |
| PLT-002 | Node.js + TypeScript backend built as a NestJS modular monolith. | MP§3.2; P4 §1 | O | P0 | IT | Pi | — | — |
| PLT-003 | PostgreSQL with separate schemas per domain, foreign keys, and optimistic concurrency columns. | MP§3.3, §23 | O | P0 | IT | Pi | — | MT-DB |
| PLT-004 | Transactional outbox, durable job queue with retries, idempotency and a dead-letter queue. | MP§3.5; P4 §6 | A | P0 | IT | Pi | — | TC-17 |
| PLT-005 | Versioned REST API `/api/v1`, documented with OpenAPI 3.1, and a standard error envelope. | MP§22 | A | P0 | IT | Pi | — | MT-API |
| PLT-006 | Three environments: Development, Staging/UAT and Production. Nothing goes to production without promotion through them. | MP§25, R12 | A | P0 | IT | Pi | D21 | — |
| PLT-007 | Agreed availability target, RPO and RTO, backed by tested restores. | MP§25; P4 §8 | A | P0 | IT | Co | D21 | TC-20 |
| PLT-008 | Observability: structured logs, metrics, traces, alerting and an incident runbook. | MP§24; P4 §8 | A | P1 | IT | Co | — | — |
| PLT-009 | Clearly marked sample data in dev and demo environments only. Production data is never invented. | MP§28 | A | P0 | IT | Pi | — | — |
| PLT-010 | Data migration: inventory of sources, cleansing, mapping, trial loads, reconciliation and cutover rehearsal. | P5 §7 | A | P0 | IT / all | Co | D10 | TC-19 |
| PLT-011 | Number series per document type, legal entity and financial year (Indian FY, April–March). | — | M | P0 | Finance | Pi | D28 | MT-ADM |
| PLT-012 | Monetary amounts are stored as `numeric(18,2)`, quantities as `numeric(18,4)`, and all times in UTC, displayed in IST. Indian digit grouping (₹1,50,000) is used. | — | M | P0 | IT | Pi | — | MT-DB |
| PLT-013 | Personal data processing follows India's DPDP Act 2023 (notice, purpose, retention, access), as confirmed by the client's adviser. | P1 §6 privacy | M | P1 | Compliance | Co | D25 | — |
| PLT-014 | Multi-language UI (English first; Hindi/Marathi to be decided). | — | M | Opt | Mgmt | En | D29 | — |
| PLT-015 | Build-versus-adapt assessment before a full custom build is commissioned. | P7 §10 | X | P0 | MD | — | D13 | — |

## 20. UI / UX (UI)

| ID | Requirement | Source | Class | Pri | Owner | Rel | Dec | Test |
|---|---|---|---|---|---|---|---|---|
| UI-001 | One design system (tokens and components in doc 10) applied to every module. | MP§2.1; UI§1–43 | A | P0 | IT / UX | Pi | D20 | MT-UI |
| UI-002 | Tables are searchable, filterable, sortable and paginated on the server. | MP§2.1 | A | P0 | UX | Pi | — | MT-UI |
| UI-003 | A distinct status badge for each status, always shown with a text label and never by colour alone. | MP§2.1; UI§26, §38 | A | P0 | UX | Pi | — | MT-UI |
| UI-004 | Only the actions the user is permitted to take are shown. Hidden actions are also blocked by the server. | MP§2.1 | A | P0 | UX | Pi | — | TC-01 |
| UI-005 | WCAG 2.2 AA: keyboard navigation, visible focus, labels, contrast and touch targets of at least 44px. | UI§38 | A | P1 | UX | Pi | — | MT-UI |
| UI-006 | Responsive layout for desktop and tablet. Mobile layouts only for field and warehouse tasks. | MP§2.1; UI§36 | A | P1 | UX | Co | — | MT-UI |
| UI-007 | The reference screenshot the UI prompt mentions must be supplied, and the generic navigation mapped to ERP modules. | UI§1, §41 | X | P0 | UX | Pi | D20 | — |
| UI-008 | Density modes: "comfortable" (UI prompt defaults) and "compact" for transaction editors and large registers. | UI§25 vs MP§2.1 | X | P1 | UX | Pi | D20 | MT-UI |

---

## 3. Coverage check against the Master Prompt

| MP Part | Covered by RTM IDs |
|---|---|
| 4 Login, users, roles | SEC-001…018, ORG-001…003, APR-008 |
| 5 Masters | MDM-001…015 |
| 6 Dealer | DLR-001…012 |
| 7 Sales & CRM | CRM-001…020 |
| 8 Quotation | QUO-001…006 |
| 9 Sales order | SO-001…009 |
| 10 Procurement | PUR-001…012 |
| 11 Inventory | INV-001…015 |
| 12 Manufacturing | MFG-001…016 |
| 13 QC | QC-001…010 |
| 14 QA | QA-001…015 |
| 15 Logistics | LOG-001…009 |
| 16 QR & mobile | QR-001…004, MOB-001…006 |
| 17 Finance | FIN-001…013 |
| 18 Documents | DMS-001…004 |
| 19 Dashboards/reports | MIS-001…006 |
| 20 Approval engine | APR-001…008 |
| 21 Notifications | NTF-001…004 |
| 22–25 API, DB, security, cloud | PLT-001…015, SEC-010…018 |
| 2 UI | UI-001…008 |

**Next step for the RTM:** once the BRD v2.4 is supplied (D00), each `BRD` source is replaced with its clause and page number, and any BRD statement not yet represented gets a new row. P7 §3 notes that the current list is built from summaries, so the BRD may contain more line items.
