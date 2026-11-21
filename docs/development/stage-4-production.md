# Stage 4 — Production: progress report

Order follows D12 (business flow). Stage 4 parts:

1. Plant & line settings and the formulation (BOM) master — **done**
2. Production orders: release against the formulation in force, reservation of QC-released lots, material issue, quarantine override (D33) — **done**
3. Batch execution: dosing with tolerance and deviations, IPQC, completion with mass balance, the finished-goods lot into quarantine — **done**
4. Packaging, finished-goods QC and QA release (blocked by open deviations), transfer to WH-01, traceability, costing and the production dashboard — next

Pending client decisions use the recommended defaults from doc 12, marked provisional, so the build can continue (client instruction: build the system first, settle the remaining items last).

## Part 1 — Plant & line settings and the formulation master (BRD p.18 sub-modules 5 and 16; MP §12.4; MFG-006, MFG-009, MFG-019)

| Area | What works | RTM |
|---|---|---|
| Production lines | Per active plant: code, name, type (reactor, blender, granulator, fermenter, filling, packing, other), capacity per shift with its unit, and machine parameters (name, value, unit — for example jacket temperature 85 °C, agitator 120 rpm). Lines are deactivated and reactivated with a reason, never deleted | MFG-019 |
| Shifts | Per plant: code, name, start and end. A shift ending before it starts runs past midnight (Night 22:00–06:00), and the screen shows its length | MFG-019 |
| Who sets them up | The plant head (`mfg.settings:configure`), within the legal entities of their role scope. Planners, supervisors, QA and management view them | MFG-019 |
| Formulation | One per output item (finished or semi-finished): code and name. Its recipe is kept in numbered versions | MFG-006 |
| Version | Batch size in the product's unit, standard yield %, reaction temperature and time, process instructions, effective-from date and a change note. Ingredients per batch with dosing step, quantity (in the ingredient's unit), dosing tolerance ±% and notes | MFG-006, MFG-008 |
| Approved substitutes | Up to five per ingredient, with the quantity factor (for example zinc oxide × 0.56 for zinc sulphate). Production will only accept these substitutes | MFG-009 |
| Ingredient rules | Only approved raw or semi-finished materials; never the output item itself. Packaging is planned with the packing run (part 4) | MFG-006 |
| Approval | Plant head, then QA manager or QA head (doc 07 §6). Policy `mfg.bom_version`; the person who prepared it cannot approve it | MFG-006, doc 07 |
| Effective dating (BR-07) | Approved versions of one formulation never overlap (database constraint). Approving a version ends the previous one the day before the new date. A version dated on or before one already approved is refused at submission. The date cannot be in the past | MFG-006 |
| Version state | Current, Scheduled (approved with a future date), Superseded, or the workflow status (Draft, Submitted, Rejected, Withdrawn). Approved versions are frozen; changes need a new version, which can start as a copy of the current one | MFG-006 |
| One open draft | A formulation can have only one draft or submitted version at a time | MFG-006 |
| In force on a date | `effectiveBomVersion(item, date)` returns the approved version in force. Production orders (part 2) will be released only against it | MFG-006 |
| Register | Every formulation with the version in force, batch size, standard yield, ingredient count, and a flag for versions awaiting approval or products without a version in force | MFG-006 |

### Evidence
- `apps/api/test/production-masters.test.ts` has 2 tests:
  - Plant settings: plant head adds a reactor with parameters and three shifts including a night shift; duplicate line code and shift code refused; capacity without a unit refused; the planner cannot configure; the supervisor views; deactivation with a reason.
  - Formulation: one per item; a raw material cannot be an output; packaging and the output item refused as ingredients; one open draft; QA cannot approve before the plant head; v1 Current; approved v1 frozen; v2 from ten days later ends v1 the day before (Scheduled vs Current, and the version in force on each date); a version dated before the scheduled one refused; withdrawal; register counts.
- Totals: **61 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local, [SAMPLE] data):
  1. The plant head added reactor CHK-RX-01 (5 KL, jacket temperature and agitator speed) and filling line CHK-FL-01 to Chakan Plant 1, plus shifts A, B and Night.
  2. The production planner created formulation F-ZN-EDTA-12 for the sample Chelated Zinc 12% and its first version: a 1,000 L batch at 97.5% yield, 80 °C for 120 minutes, DM water, EDTA and zinc sulphate (with zinc oxide × 0.56 as an approved substitute), and submitted it.
  3. The plant head and the QA manager approved it; the supervisor sees v1 as Current.

### New demo users
`plant-head`, `planner`, `supervisor`, `qa-head` and `qa-manager` (@demo.local). The planner and supervisor report to the plant head; the QA manager reports to the QA head.

### Not built yet
- **Plant operations calendar (Gantt), CIP cleaning and maintenance windows (MFG-016/017)**: with production orders and downtime (parts 2 and 4).
- **Alternate packing BOM per pack size**: with packaging (part 4).
- **Client input**: D03 (production model) — make-to-stock and make-to-order are both supported by the order screens in part 2.

## Part 2 — Production orders, reservation, material issue and the quarantine override (BRD p.15, p.18; MP §11.6, §12.3, §12.5; MFG-005, MFG-007, MFG-009, MFG-013, INV-007, INV-009; D33)

| Area | What works | RTM |
|---|---|---|
| Production order | Number `PRD/2026-27/000001`. Product (with a formulation version in force on the planned start), quantity in its unit, the number of batches from the batch size, plant, line and shift, planned start and due date, priority, the raw-material store to draw from and the finished-goods warehouse to deliver to, remarks | MFG-005 |
| Make to stock or to order | An order is for stock or for an approved sales order that includes the product (D03 hybrid, provisional) | MFG-005, D03 |
| Material check | While planning: the formulation in force scaled to the quantity, against free released stock (QC-released, unexpired, not reserved) and quarantine stock, line by line | MFG-007 |
| Approval | The plant head approves (policy `mfg.production_order`) | doc 07 |
| Release | Fixes the formulation version **in force on the day of release** (MFG-006), scales every ingredient to the order, and reserves lots. A shortage is refused unless the planner accepts it with a reason; then the order is released with what is available and the rest is reserved later (**Reserve again**) | MFG-006, MFG-007 |
| Reservation (INV-007) | FEFO — earliest expiry first, then the oldest lot — from released, unexpired lots in the chosen store. Candidate lots are locked while reserving, so the same stock is never reserved twice; a second order sees only free stock | INV-007, INV-009 |
| Approved substitutes | When the formulation item runs short, its approved substitutes are reserved for the rest, converted by their factor (MFG-009) | MFG-009 |
| Material issue | Stores issues reserved lots (`MIS/…`), less than reserved if less is handed over. Stock leaves the store bucket (`ISSUE_TO_PROD`). A lot put on hold, rejected or expired after reservation cannot be issued | MFG-007, INV-012 |
| Return to stores | Unused material goes back (`MRT/…`, `RETURN_FROM_PROD`), into the bucket matching the lot's current QC status; never more than is with production | MFG-007 |
| Hold, resume, cancel | Hold and resume with a reason. Cancel releases the reservations and withdraws pending override requests with their approvals; it is refused while material is still issued — return it first (MFG-013) | MFG-013 |
| Quarantine-lock override (D33, provisional "allow with safeguards") | For an uncovered requirement, the supervisor or planner asks to use a lot still in quarantine, with the quantity and the reason (`QOV/…`). The **QC head and then the plant head** approve (policy `mfg.quarantine_override`). On approval the lot is reserved from quarantine, and a **deviation** is raised automatically and sent to the QA head and QA managers. Stores issues it from quarantine | BRD p.15, D33, X15 |
| Deviation register | Number `DEV/…`, category, what happened, order and lot. QA closes it with a conclusion; an override deviation cannot be closed while the lot is still in quarantine. Part 4 blocks the batch release while it is open | QA-005 |
| Opening stock | A ledger movement type `OPENING` for stock loaded at cutover (D10) | D10 |

### Evidence
- `apps/api/test/production-orders.test.ts` has 2 tests:
  - Order: past start, make-to-order without a sales order and a finished-goods store as the material source refused; the supervisor cannot plan. The material check shows required against free stock. Release before approval refused; release with a shortage refused with the shortages listed and nothing reserved; accepted with a reason. FEFO order of lots; the substitute reserved at its factor; quarantined and expired lots never reserved. Issue by stores only; over-issue refused; a lot put on hold after reservation cannot be issued; ledger balances after issue; return limited to what was issued; cancel refused while material is issued. A second order reserves only free stock. Hold, resume and cancel release the reservations.
  - Override: the quarantined lots offered; a quantity above the shortfall refused; stores cannot request; the plant head cannot approve before the QC head; on approval the reservation from quarantine, the deviation, and the QA head's notification; issue from quarantine; QA cannot close the deviation until QC decides on the lot; the supervisor cannot close it; QA closes it. Cancelling an order withdraws its pending override and that approval.
- Totals: **63 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local, [SAMPLE] opening stock in WH-02):
  1. The planner planned 2,000 L of Chelated Zinc 12% on Reactor 1, shift A, from WH-02 to WH-01. The material check showed EDTA 100 kg short with 500 kg in quarantine. The plant head approved.
  2. The planner released it, accepting the shortage with a reason. DM water, zinc sulphate and two EDTA lots were reserved, the EDTA lot expiring first ahead of the other.
  3. The supervisor asked to use 100 kg of the quarantined EDTA lot. The QC head and the plant head approved; deviation DEV/2026-27/000001 was raised, and the QA head saw it in the notifications, marked as waiting for QC.
  4. The storekeeper issued everything (including 100 kg from quarantine) and returned 20 L of DM water.

### New demo user
`qc-head` (@demo.local); the QC manager now reports to the QC head.

### Not built yet
- **Batches, dosing, consumption and output**: part 3. Returns will then exclude what batches have consumed (already prepared).
- **Plant operations calendar (Gantt) and line capacity scheduling (MFG-016/017)** and **MRP proposals from sales orders and forecasts (MFG-004)**: part 4.

## Part 3 — Batch execution (BRD p.18 sub-modules 6, 7, 8 and 13; MP §12.5–12.6; MFG-007, MFG-008, MFG-010; TC-11)

| Area | What works | RTM |
|---|---|---|
| Batch | Started from a released order once material is issued: number `B/2026-27/000001` (also the finished-goods lot number), line, shift and the operators. One open batch per order; the last batch takes the remainder of the order quantity. The first batch moves the order to In progress | MFG-007 |
| Dosing | Per ingredient: the batch share of the requirement and its tolerance band. Only lots **issued to this order** for that ingredient can be dosed, up to what is still with production. Substitutes count at their factor. Top-ups add to the dose | MFG-007, MFG-008 |
| Tolerance (TC-11) | A dose taking the ingredient beyond its +tolerance is **blocked** (`TOLERANCE_EXCEEDED`, with planned, total and limit). With a reason it is recorded as pending, a **deviation** is raised, and the plant head or another supervisor and then QA approve it (policy `mfg.dosing_deviation`; the person who dosed cannot approve). A rejection puts the batch on hold; it can then only be scrapped | TC-11, MFG-008 |
| Under-dosing | Completing with an ingredient below its −tolerance needs a reason and raises a deviation | MFG-008 |
| Process readings | Parameter, value, unit, within limits or not, remarks, who and when. The formulation's temperature, time and instructions are shown beside them | MFG-007 |
| In-process QC (IPQC) | The supervisor asks QC for a test at a stage (`IPQC/…`). QC sees a worklist and records results per parameter; the person who asked cannot record them. A failed test raises a deviation. The batch completes only after the **latest test passed** | BRD p.18 sub-module 13 |
| Completion | Output, process loss, recovered scrap and waste. **Yield** against planned and the formulation's standard yield | MFG-010 |
| Mass balance | Input = output + process loss + recovered + waste. Computed in KG when every quantity converts to it (the item's own conversion, e.g. density, or a universal one), otherwise in the batch unit; reported as unaccounted. Beyond the tolerance (setting `mfg.massBalance.tolerancePct`, default 2%) completion needs a reason and raises a deviation | MFG-010 |
| Finished-goods lot | Created on completion with the batch number, manufacturing date and expiry from the shelf life, **in quarantine** in the order's finished-goods warehouse (`PRODUCTION_OUTPUT`), at the actual material cost per unit. A QC inspection (`QCI/…`, source PRODUCTION) is queued. **QC cannot release a finished-goods lot**; QA releases it (part 4, D04) | MFG-018, QA-003 |
| Material cost | The lots actually dosed at their issue cost: total and per unit of output | MFG-015 (material part) |
| Order completion | The order becomes Completed when all its batches are complete. Scrapped batches do not count; a new batch can be started | MFG-007 |
| Hold, resume, scrap | Hold and resume with a reason; the plant head scraps a batch, which raises a deviation | MFG-007 |

### Evidence
- `apps/api/test/batches.test.ts` has 2 tests:
  - Normal batch: the planner cannot start one; one open batch at a time; order In progress; batch share and tolerance band; 460 kg of 450 ±2% blocked with the figures; a lot not issued to the order refused; within and under states; IPQC required, pending, failed (deviation), then passed; under-dosing needs a reason; a mass balance gap refused with the figures in KG; completion at 80% yield with no unaccounted quantity; FG lot in quarantine with its quantity and material cost; the QC inspection queued; the dosed quantity no longer returnable.
  - Over-tolerance with a reason: pending approval blocks completion; the person who dosed cannot approve; plant head and QA approve. A second over-dose rejected puts the batch on hold; resume refused; the supervisor cannot scrap, the plant head can; the next batch can start.
- Totals: **65 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local): the supervisor started batch 1 of PRD/2026-27/000001 on shift A. They dosed DM water and EDTA; 460 kg of zinc sulphate showed the tolerance warning and was reweighed to 452 kg. Three readings were recorded and QC was asked to test. The QC analyst recorded pH, zinc, specific gravity and appearance, all passing. The supervisor completed the batch at 975 L (97.5% yield, as standard); the mass balance was 1,452 kg in with 2.18 kg unaccounted, and lot B/2026-27/000001 went into quarantine with its QC inspection.

### Not built yet
- **Packaging run, QA release, transfer and traceability**: part 4.
