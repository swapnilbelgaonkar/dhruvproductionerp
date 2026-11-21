# Stage 5 — Quality control and quality assurance: progress report

Order follows D12 (business flow). Stage 5 parts:

1. QC core: specification & method master, instruments & calibration, results against the specification, OOS investigation, controlled CoA — **done**
2. QA core: CAPA, non-conformance, change control, complaints, recall with drill mode — **done**
3. QA system: controlled documents & SOPs, training, audits, risk register, line clearance, QC and QA dashboards — **done**

## Part 1 — QC core (BRD p.15 sub-modules 1, 3, 4, 5, 6; MP §13.3–13.7; QC-004…QC-008, QC-011, QC-013; TC-12)

| Area | What works | RTM |
|---|---|---|
| Test methods | Code, name, technique (HPLC, AAS, titration, pH meter, gravimetric, spectrophotometry, density, visual, other) and the standard it follows (FCO 1985, IS…) | BRD p.15 sub-module 3 |
| Instruments | Code, name, technique, make/model, serial, location, calibration interval. State: calibrated, due within 15 days, **overdue**, out of service, retired | QC-008 |
| Calibration | Date, pass or fail, agency, certificate number, remarks. A pass sets the next due date from the interval; a **fail takes the instrument out of service**. Certificates can be filed in the vault against the instrument | QC-008 |
| Overdue lock | Only active instruments within their due date are offered, and the server refuses a result on an overdue or out-of-service instrument (`INSTRUMENT_OVERDUE`) | QC-008 |
| Specifications | One per item (raw, packaging, semi-finished, finished): parameters with category (physical, chemical, heavy metal, microbial), unit, limit (range, minimum, maximum or expected text) and method. Numbered, effective-dated versions approved by the **QC manager or head, then QA** (policy `qc.spec_version`); approving a version ends the previous one the day before; the author cannot approve | QC-004, QA spec approval |
| Results against the specification | When an item has a specification in force, QC enters a value for **every** parameter with the instrument; pass or fail is **computed from the limits**, not typed. Free-text results are refused for such items | QC-004 |
| OOS (TC-12) | A value out of specification **opens an OOS case automatically** (`OOS/…`), forces the recommendation to Hold and **freezes the results**. The lot cannot be released while a case is open | QC-007, TC-12 |
| Investigation and retest | The QC manager records the laboratory investigation and may **authorise a retest**; only then can the analyst enter retest results, which are added as a new attempt — **the original result is kept**. Closing: **Invalidated** (laboratory error; every failed parameter's retest must pass) lets the lot be decided on the retest; **Confirmed** means the lot must be rejected | QC-007 |
| Release on the latest attempt | The release checks the latest attempt of every test, so an invalidated OOS with a passed retest can be released and a confirmed one cannot (`OOS_CONFIRMED`) | QC-007, QC-009 |
| Certificate of analysis | Issued by the QC manager (never the analyst who tested) after release or QC approval: number `COA/…`, version (a reissue supersedes the previous one), product, lot, dates, specification, results grouped by physical / chemical / heavy metal with methods, conclusion, analyst and approver with time stamps, a quality seal and a **QR code**. A public page checks the QR against the issued record | QC-006, QC-013 |
| QC hierarchy | The analyst enters; the manager authorises retests, closes OOS cases, decides lots and signs the CoA (QC-005, BRD p.15 sub-module 6) | QC-005 |

### Evidence
- `apps/api/test/qc-specs.test.ts` has 2 tests:
  - Specification approval (the author cannot approve; QC head, then QA). Free-text results refused. An uncalibrated AAS refused, then accepted once calibrated. **TC-12**: pH 8.1 against 6.0–7.5 opens the OOS and holds the lot; results frozen; release refused while the case is open; retest refused without authorisation; the analyst cannot authorise; the manager authorises; the retest passes; the case is invalidated. The original 8.1 is kept beside the 7.1 retest, and the lot is released. The analyst cannot sign the CoA; the manager issues it with the retest result. Its QR verifies publicly, and a forged signature does not.
  - A confirmed OOS cannot be invalidated without a passing retest; once confirmed, release is refused and rejection works. A failed calibration takes the instrument out of service.
- Totals: **71 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local, [SAMPLE] data):
  1. The QC manager set up three methods and two instruments, and calibrated the pH meter.
  2. They wrote the zinc sulphate specification (pH 4.0–6.0, Zn ≥ 33 %, Pb ≤ 30 ppm, appearance); the QC head and QA manager approved it.
  3. The analyst found the uncalibrated AAS not offered until the manager calibrated it, then entered pH 8.1, which opened OOS/2026-27/000001.
  4. The manager recorded the investigation (expired buffer) and authorised a retest. The analyst retested at 5.2, and the manager closed the case as invalidated.
  5. The manager released the lot and issued COA/2026-27/000001, whose QR verified on a signed-out phone.

### Not built yet
- **Sample chain of custody and retention samples (QC-003, QC-010)**, **reagent and standard expiry**, **OOT trending**: with the QC dashboard (part 3).
- **Instrument calibration due alerts**: with the alert scheduler in part 3.

## Part 2 — QA core (BRD p.16; MP §14.4–14.5; QA-007, QA-008, QA-009, QA-013, QA-016; UAT-15)

| Area | What works | RTM |
|---|---|---|
| CAPA | `CAPA/…`: title, source (deviation, non-conformance, complaint, audit, OOS, change, recall, other) with a link to it, problem, root cause, owner, due date, and actions (correction, corrective, preventive) each with an owner and due date | QA-007 |
| Actions | Completed by their owner (or QA) with evidence; when the last is done the CAPA moves to the **effectiveness check** | QA-007 |
| Effectiveness | Verified by a QA manager or head **who is not the owner**: effective → Closed; not effective → back to Open for more actions. Overdue CAPA are flagged | QA-007 |
| Non-conformance | `NC/…`: material, process, supplier, product; severity; lot and supplier; closed with a disposition (use as is, rework, return, scrap) and justification. **A critical NC needs a CAPA** before it closes. Plant, QC, stores and purchase can raise one | QA-009 |
| Change control | `CC/…`: type (formulation, specification, process, equipment, SOP, supplier), description, justification, impact, risk, target date. Submitted by the requester; the **QA head** approves, and a **high-risk** change also needs the **executive director** (policy `qa.change_request`); then implemented and closed with verification | QA-009 |
| Complaints | `CMP/…`, logged by sales or QA: dealer, date, channel, category, severity. **The box serial from the label resolves the lot and product** (D24). QA records the findings and closes it as justified or not with the response to the dealer; a **justified major or critical complaint needs a CAPA**. From a complaint, QA can raise the CAPA or start a recall | QA-013 |
| Recall | `RCL/…` from a lot: every lot made from it is traced recursively (forward genealogy), with produced quantity, stock on hand and boxes. **Drill** (QA manager) identifies only. **Actual** (QA head only) also **locks all their stock** (released and quarantine stock moved to blocked, lots put on hold). Trace (and lock) happen in one step; the time is recorded against the **2-hour target** (QA-016). Closed with the reconciliation | QA-008, QA-016, UAT-15 |

### Evidence
- `apps/api/test/qa-core.test.ts` has 2 tests:
  - CAPA: a critical NC cannot close without a CAPA; the CAPA is opened from the NC, which then closes. An action can be completed only by its owner; completing both moves the CAPA to the effectiveness check. The owner cannot verify; the QA manager marks it not effective and it reopens; another action is added and completed, then verified effective and closed. Change control at high risk: QA head, then executive director; implemented; closed.
  - A sales executive logs a complaint by box serial, which resolves to the lot; an unknown serial is refused. Closing without findings is refused; a justified major complaint without a CAPA is refused. A drill by a QA executive is refused; by the QA manager it traces the zinc lot to the FG lot made from it, without moving stock. An actual recall by the QA manager is refused; by the QA head it locks the FG lot's stock and puts it on hold, within the target time.
- Totals: **73 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local): the sales executive logged a complaint against box BX-2026-27-00000003 for the Niphad dealer; it resolved to lot B/2026-27/000001. The QA executive recorded the findings and opened CAPA/2026-27/000001 with two actions. The QA manager ran a recall drill from the complaint: the lot, 969.8 L on hand and 50 boxes, traced in under a second.

### New demo user
`qa-exec` (@demo.local), reporting to the QA manager.

## Part 3 — QA system (BRD p.4, p.16; MP §14.3; QA-006, QA-010, QA-011, QA-012, QA-017, QA-018, QC-002, QA-002)

| Area | What works | RTM |
|---|---|---|
| Controlled documents | Code, title, type (SOP, STP, policy, work instruction, form, manual), department, owner, review cycle. Versions with the file in the vault, effective date and change summary. Approved by a QA reviewer (QA executive or manager), then the **QA head** (policy `qa.document_version`; the author cannot approve). The approved version becomes **Effective** and the previous one **Superseded** | QA-006 |
| Review cycle | Each version's review date = effective date + the cycle (default **24 months**, QA-018); the register flags reviews due within a month and overdue | QA-018 |
| Training compliance | A document lists the roles that must be trained. The **training matrix** shows, for each effective version, every active user in those roles and whether they passed training. QA records training (date, trainer, pass/fail, score) for several people at once. Training gaps appear on the dashboard | QA-011 |
| Audits | Internal, supplier (the supplier is required), customer and regulatory: scope, auditor, date; findings classified observation / minor / major / critical with the clause. **A major or critical finding needs a CAPA before the audit closes** | QA-010 |
| Quality risk register | FMEA: process area, failure mode, effect, severity × occurrence × detection = **RPN**, controls, owner, review date, status. Sorted by RPN; 100 and above is high | QA-012 |
| Line clearance | A QA executive records the checklist for a line before a batch or packing run: previous material removed, line cleaned, labels reconciled, documents in place, equipment ready. Anything unticked is "not cleared" with the reason. **A batch, or a packing run on a line, cannot start without a clearance recorded after the line was last used** (`LINE_NOT_CLEARED`); each clearance is used once. Setting `mfg.lineClearance.required` | QA-017 |
| Quality dashboard | QC: lots waiting (and older than 2 days), in-process tests waiting, open OOS, instruments overdue or due within 15 days, right first time and turnaround over 90 days. QA: batches awaiting release, open deviations, CAPA (and overdue), complaints, NCs, changes in progress, document reviews due, training gaps, high risks, recalls this year; each tile opens its register | QC-002, QA-002 |

### Evidence
- `apps/api/test/qa-system.test.ts` has 2 tests:
  - Documents, training, audits and risk. Submission without a file is refused; the author cannot approve; QA review and the QA head approve; the version becomes Effective with its two-year review date. The supervisor appears untrained, a supervisor cannot record training, and QA records it. A supplier audit without the supplier is refused; a major finding blocks closing until a CAPA is linked. A risk of 5 × 4 × 6 gives RPN 120, counted on the dashboard.
  - Line clearance: a batch is refused without one; a supervisor cannot record it; an unticked checklist needs a reason and counts as not cleared; after a clearance the batch starts and the clearance shows as used by that batch.
- Totals: **75 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local): batch 2 of PRD/2026-27/000001 was refused because Reactor 1 had not been cleared since batch 1. The QA executive ticked the five checks and cleared the line, and the supervisor started batch 2. The QA head opened the quality dashboard.

## Stage 5 status
Stage 5 (QC and QA) is built.

Provisional choices it uses:
- The review cycle is 24 months (QA-018).
- Line clearance is required by default.
- Releasing finished goods stays with the QA head only (D04).

### Not built in Stage 5
- **QA rights governance (QA-014)**: delegation and recertification of QA authorities. Role grants are already audited and privileged ones approved; recertification campaigns come with the security hardening.
- **Training enforcement**: blocking an untrained user from SOP-bound tasks (QA-011, P2) is not switched on; the matrix shows the gaps.
- **Sample chain of custody, retention samples, reagent expiry, OOT trending (QC-003, QC-010)**.
- **Alerts** for calibration due, document reviews due and overdue CAPA: with the notification scheduler in Stage 7.
