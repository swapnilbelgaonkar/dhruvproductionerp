# Stage 4 — Production: progress report

Order follows D12 (business flow). Stage 4 parts:

1. Plant & line settings and the formulation (BOM) master — **done**
2. Production orders: release against the formulation in force, reservation of QC-released lots, material issue, quarantine override (D33) — next
3. Batch execution: dosing with tolerance and deviations, IPQC, completion with mass balance, the finished-goods lot into quarantine
4. Packaging, finished-goods QC and QA release (blocked by open deviations), transfer to WH-01, traceability, costing and the production dashboard

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
