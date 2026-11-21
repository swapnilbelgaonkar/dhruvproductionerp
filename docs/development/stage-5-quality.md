# Stage 5 — Quality control and quality assurance: progress report

Order follows D12 (business flow). Stage 5 parts:

1. QC core: specification & method master, instruments & calibration, results against the specification, OOS investigation, controlled CoA — **done**
2. QA core: CAPA, non-conformance, change control, complaints, recall with drill mode — next
3. QA system: controlled documents & SOPs, training, audits, risk register, line clearance, QC and QA dashboards

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
