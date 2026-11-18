# 13 — Testing & Acceptance Strategy

Covers MP Parts 27 and 28, P3 §7, P4 §8 and P7 §8–9.

## 1. Test levels

| Level | Scope | Tooling | Gate |
|---|---|---|---|
| Unit | Domain rules: pricing/tax calculation, state machines, policy evaluation, credit exposure, mass balance, FEFO | Vitest | ≥ 85% line coverage on `domain`/`policy` code; 100% of business-rule branches in the BR register |
| API / integration | Each route against the doc 08 §5 checklist, using a real PostgreSQL (Testcontainers) | Vitest + Supertest | Every route passes all 8 checks |
| Concurrency | Reservation races, double approval, double scan, idempotent retries | Parallel test harness (N clients) | Zero invariant violations over 1,000 runs |
| Contract | External adapters against recorded sandbox responses | Pact-style fixtures | — |
| End-to-end | Critical user journeys in the browser | Playwright (trace off by default) | Lead-to-cash, procure-to-pay, plan-to-produce, recall drill green |
| Accessibility | axe-core per page plus a manual screen-reader pass per release | @axe-core/playwright | No serious or critical violations |
| Security | ASVS L2 checklist, SAST, dependency scanning, DAST (ZAP), external penetration test | Semgrep, npm audit / OSV, OWASP ZAP | No open high or critical findings |
| Performance | Doc 03 §7 targets at the assumed volumes | k6 | p95 within target |
| Recovery | Restore of PITR and snapshot into an isolated environment | AWS Backup | RPO/RTO met (TC-20) |
| Migration | Trial loads with reconciliation | Import service + SQL reconciliation | Signed reconciliation |
| UAT | Business-run scripts per department | UAT workbook | Owner sign-off per module |

## 2. Test case record format (MP Part 27)

Every test case records these fields: **Test ID · Business process · Preconditions · Input data · User role · Expected outcome · Actual outcome · Evidence · Pass/Fail · Defect reference.**

Actual outcome, evidence, pass/fail and defect reference are filled in during execution. They are left blank in this plan and **must not be pre-filled** (MP Part 28: no false data).

## 3. Mandatory scenarios (MP Part 27, 1–20)

| Test ID | Business process | Preconditions | Input data | User role | Expected outcome | RTM |
|---|---|---|---|---|---|---|
| TC-01 | Access control | User U1 is an SE in territory T-A; SO-X belongs to territory T-B | (a) GET SO-X; (b) POST `/sales-orders/{SO-X}/approve` through the API directly; (c) export the SO register | SE | (a) 404; (b) 403 `FORBIDDEN`; (c) export contains only T-A rows; audit events for the denied attempts | SEC-010/011, APR-007, MIS-003 |
| TC-02 | Dealer onboarding | Dealer D1 exists with GSTIN G1 | New dealer with GSTIN G1; another with an invalid GSTIN format; another missing its mandatory PAN document | SE | `DUPLICATE_PARTY` with a link to D1; `INVALID_GSTIN`; submit blocked with `DOC_REQUIRED:PAN`; no record leaves Draft | DLR-011, MDM-003/007 |
| TC-03 | Licence restriction | Dealer D2 Active; pesticide licence expired yesterday; fertilizer licence valid | SO with one pesticide line and one fertilizer line | TSM | Pesticide line rejected `LICENCE_CATEGORY_BLOCKED`; fertilizer-only order can proceed; licence-expired notification sent at T-7 earlier (job log) | DLR-004/008, SO-002 |
| TC-04 | Approval limits | Limits active as in MP§4.4; conditional policy v1 published | SO ₹4,00,000 at 4% discount raised by TSM; SO ₹90,000 at 13% | TSM → approvers | First routes to ZSM (value); second routes to ZSM (discount); the TSM cannot approve their own order; decisions store `policy_version_id` | SO-004, APR-003/004/008 |
| TC-05 | Order amendment | SO-Y approved and allocated | Increase qty on line 2 by 20%; separately, change remarks only | Sales | Qty change creates revision R2 in Under Review, invalidates the approvals and re-runs credit; reservations are kept until the decision. Remark change keeps the approvals. R1 is preserved and viewable | SO-007 |
| TC-06 | Credit control | Dealer D3 limit ₹5L, exposure ₹4.6L | SO ₹80,000 | TSM / ACC / FH | Credit step flags `CREDIT_LIMIT_EXCEEDED` → order On Hold until the FH exception is approved; nothing passes silently; credit snapshot stored | FIN-005 |
| TC-07 | Concurrent reservation | Lot L1 has 100 units RELEASED and none reserved | Two SO approvals of 70 units each, committed at the same time (10 parallel repeats) | Approvers | Exactly one reserves 70; the other gets 30 + 40 backordered (or `INSUFFICIENT_ELIGIBLE_STOCK` per policy); `reserved ≤ on_hand` always; no negative ATP | INV-007, BR-06 |
| TC-08 | Quarantine | GRN posted → lot L2 QUARANTINE | Issue L2 to production order PO-1 (UI and direct API); release attempt by a user without disposition authority | Storekeeper; PS | Issue rejected `LOT_NOT_ELIGIBLE`; unauthorised release rejected 403; after an authorised release only the released qty becomes available; all attempts audited | INV-001, QC-009, BR-04 |
| TC-09 | Partial receipt | PO line 1,000 kg | GRN 600 kg, then GRN 400 kg | Storekeeper | PO line shows 600/1,000 then 1,000/1,000 (Received); two lots; open qty correct after each step | PUR-008 |
| TC-10 | Three-way match | PO rate ₹100/kg, GRN accepted 600 kg; tolerance ±0.5% | Supplier invoice 600 kg @ ₹103 | ACC | Match result `MATCH_OUT_OF_TOLERANCE` (price +3%); payable not created; exception routed to PUR → FH; once resolved, the payable equals the approved amount | PUR-009 |
| TC-11 | Consumption tolerance | BOM line RM-A 50 kg ±2% | Dosing 53 kg (+6%) | Operator | Step blocked `TOLERANCE_EXCEEDED`; deviation raised; it can continue only after supervisor + QA approval; variance recorded | MFG-008 |
| TC-12 | QC failure | Spec parameter pH 6.0–7.5 | Result pH 8.1 | QC Analyst | OOS case opened automatically; lot stays not-released; a retest needs QC Manager authorisation; the original result is kept, not overwritten | QC-007 |
| TC-13 | QA release with open deviation | Batch B1 QC approved; deviation DV-1 open | QA release attempt (UI and API) | QA Head | "Released" disabled in the UI; API returns `QA_RELEASE_BLOCKED` listing DV-1; picking B1 lots for dispatch is also blocked | QA-003/005, LOG-003 |
| TC-14 | Duplicate box scan | Box S1 packed into shipment SH-1 (Loaded) | Scan S1 into SH-2 | Scanner operator | Rejected `SERIAL_ALREADY_ASSIGNED`; SH-2 count unchanged; scan event stored with result REJECTED | QR-004, LOG-009 |
| TC-15 | Offline conflict | Device D offline; meanwhile S2 is dispatched on the server by another device | Device D queues "pick S2" + 10 valid scans, then reconnects | Scanner operator | 10 accepted; S2 returned as CONFLICT and queued for supervisor resolution; resending the batch causes no duplicates (idempotent `event_id`) | MOB-001/002, BR-10 |
| TC-16 | Partial delivery rejection | SH-3 dispatched 100 boxes | POD: 95 received, 5 damaged and refused | Logistics | Shipment Delivered with an exception; return case for 5 boxes; credit note draft for 5; stock for the 5 in QA_HOLD on receipt; SO line delivered qty = 95 | LOG-006/007, FIN-013 |
| TC-17 | Posting failure | Invoice INV-1 issued; accounting adapter set to time out *after* the external system accepted the voucher | Worker retries | System / ACC | On retry the adapter finds the existing voucher by reference → no duplicate; posting POSTED with one external ref; when failures exceed max attempts, it moves to the DLQ and Accounts is alerted | FIN-010, PLT-004 |
| TC-18 | Finalised record immutability | Invoice INV-2 issued; stock movement M1 posted | PATCH INV-2 lines; DELETE M1; SQL UPDATE as the app role | ACC / attacker | API 422 `INVALID_STATE_TRANSITION`; DB permission denied; correction possible only via a credit note or reversal movement; audit shows the attempts | INV-015, MDM-006 |
| TC-19 | Invalid import | — | Dealer import file: 100 rows, of which 3 have an unknown territory and 2 a duplicate GSTIN | MDO | Validation report lists the 5 rows with reasons; nothing is committed until the file is clean (or the user chooses "commit valid rows" if the policy allows) | MDM-014 |
| TC-20 | Backup recovery | Production-like staging with data | Restore to a point in time T−10 min into an isolated environment | IT | Restore completes within the RTO; data up to the RPO is present; audit hash chain verifies; application starts against the restored DB | PLT-007 |

## 4. UAT acceptance matrix (P3 §7)

| UAT | Scenario | Expected | Department owner |
|---|---|---|---|
| UAT-01 | Register a valid dealer | Active only after all approvals | Sales, Finance |
| UAT-02 | Expired product licence | Affected transaction blocked | Compliance |
| UAT-03 | Standard-price order | Correct approval path | Sales |
| UAT-04 | Excess discount or credit | Exception authority required | Sales, Finance |
| UAT-05 | Change an approved order | Prior approval invalidated | Sales |
| UAT-06 | Partial purchase receipt | Outstanding qty preserved | Purchase, Stores |
| UAT-07 | Failed RM QC | Material blocked | QC, Stores |
| UAT-08 | Production consumes released lots | Genealogy correct | Plant |
| UAT-09 | Unresolved QA deviation | Batch release prevented | QA |
| UAT-10 | Scan the same box twice | Conflicting operation rejected | Stores, Logistics |
| UAT-11 | Partial customer payment | Outstanding correctly allocated | Finance |
| UAT-12 | Return of an invoiced order | Stock, tax and finance corrections reconcile | Finance, Logistics, QA |
| UAT-13 | Unauthorised user action | Access denied and logged | IT |
| UAT-14 | Accounting timeout | No duplicate posting on retry | Finance, IT |
| UAT-15 | Recall a batch | Affected inventory and customers traceable | QA |

## 5. Module test suites (MT-*)

Each module ships with an MT suite covering: every RTM row for that module · every state transition (allowed and forbidden) · every validation in its screen specs · permissions per the doc 07 matrix · the SoD rules that apply · its notifications · its reports' scope filtering. Suites: MT-AUTH, MT-ADM, MT-AUD, MT-ORG, MT-MDM, MT-DLR, MT-CRM, MT-QUO, MT-SO, MT-APR, MT-PUR, MT-INV, MT-MFG, MT-QC, MT-QA, MT-LOG, MT-QR, MT-MOB, MT-FIN, MT-INT, MT-DMS, MT-NTF, MT-MIS, MT-UI, MT-DB, MT-API, MT-SEC.

## 6. Test data

- Synthetic data only, generated by seed scripts. Every name is prefixed `[SAMPLE]` and every GSTIN uses a test state-code range. No real dealers or employees.
- Named fixtures per scenario (for example `fixture:credit-near-limit`), so tests are reproducible.
- UAT uses a rehearsal migration of the client's own data. Production data is never copied to lower environments without anonymisation (D25).

## 7. Definition of done (per feature) and module exit

**Feature done:** acceptance criteria met · unit/API tests green · permissions and scope tested · audit verified · error states implemented · no placeholder or non-working buttons · documentation updated · demoed on staging.

**Module exit (P7 §9):** module and end-to-end tests passed with evidence · unauthorised functions blocked and logged · stock, production and financial transactions reconcile · quality release controls verified · critical/high defects closed · training material ready · formal acceptance by the business owner.

**Go-live:** all TC-01…20 passed in staging with evidence · migration reconciliation signed · DR test passed · pen-test high findings closed · hypercare plan and support rota agreed · go-live authorisation from MD (P5 §6 milestone).
