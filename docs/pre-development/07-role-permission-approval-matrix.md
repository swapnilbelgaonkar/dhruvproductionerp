# 07 — Role, Permission & Approval Matrix

Covers MP Parts 4 and 20, P4 §5, and P6 Annexure C. All values are proposals until approved. **No role names are tied to named employees** (MP Rule 3).

## 1. Permission model

```
Effective permission =
  Role grants (resource, action)
  ∩ Data scope (legal entity · plant · warehouse · territory subtree · own/assigned)
  ∩ Document state allows the action (state machine)
  ∩ Segregation rules (maker ≠ checker; analyst ≠ reviewer; requester ≠ approver)
  ∩ Authority limits (value / discount / credit) for approval actions
```

Actions (MP§4.5): `view`, `create`, `edit_draft`, `submit`, `approve`, `reject`, `hold`, `amend`, `cancel`, `release`, `post`, `export`, `configure`, `deactivate`, `override`.

## 2. Administrative model (answers SEC-001/002; D14)

| Position | Can | Cannot | Controls |
|---|---|---|---|
| Super Administration (1 position) | Platform settings, create admin roles, emergency approval (as one of two) | Approve business transactions; change audit; approve own privilege change | MFA (hardware key recommended), every action reviewed monthly |
| Executive Administration (2 positions, e.g. MD and ED) | Approve policies, authority limits, number series and settings; final approval on business exceptions per policy | Grant themselves roles; bypass QA release | MFA; maker-checker with each other |
| Security Administration (1 position, IT) | Users, roles, scopes, devices, sessions, audit viewer | Approve business documents; edit settings | MFA; role changes need EA approval |
| Emergency Access ("break-glass") | Time-boxed (≤ 4 h) elevation for a named user | Persist beyond the window | Two of the Super/Executive admins approve; mandatory post-review within 2 working days |

This keeps the BRD requirement for **four executive administration positions** and removes unrestricted bypass, as MP§4.2 requires.

## 3. Role catalogue (proposed)

| Department | Roles |
|---|---|
| Executive | Managing Director, Executive Director, Management Viewer |
| Sales | BH, NSM, DSM, ZSM, RSM, SASM, ASM, TSM, SE, Sales Ops / Coordinator, Agronomist |
| Compliance | Document Verifier |
| Purchase | Purchase Executive, Purchase Head |
| Stores | Gate Security, Storekeeper, Warehouse Supervisor, Stores Head, Scanner Operator |
| Plant | Production Planner, Production Supervisor, Operator, Plant Head |
| QC | QC Analyst, QC Reviewer / Manager, QC Head |
| QA | QA Executive, QA Manager, QA Head (release authority) |
| Logistics | Logistics Executive, Logistics Head |
| Finance | Accounts Executive, Credit Controller, Finance Head |
| IT / Admin | Super Admin, Executive Admin, Security Admin, Master Data Owner (per master), Auditor (read-only) |

## 4. Permission matrix (principal resources)

`V` view · `C` create/edit draft · `S` submit · `A` approve/reject/hold · `R` release · `P` post · `X` export · `K` configure · `—` none · `s` within own scope only

| Resource ↓ / Role → | SE–TSM | ASM–NSM | BH | Sales Ops | Doc Verifier | ACC | FH | PUR | PH | ST | SH | PLN | PS | PLH | QCA | QCM | QAE | QAM | QAH | LOG | MD/ED | SecA |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Lead / Opportunity | CSs | VCAs | VA | V | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | V | — |
| Dealer onboarding | CSs | VAs | VA | V | VA | VA (credit) | VA | — | — | — | — | — | — | — | — | — | — | — | — | — | VA | — |
| Price list / scheme | V | VC | VA | V | — | V | VA | — | — | — | — | — | — | — | — | — | — | — | — | — | V | — |
| Quotation | CSs | CSAs | A | V | — | V | V | — | — | — | — | — | — | — | — | — | — | — | — | — | V | — |
| Sales order | CSs | CSAs | A | CS | — | VA (credit) | A | — | — | Vs | Vs | V | — | — | — | — | — | — | — | Vs | V | — |
| Credit limit change | — | — | V | — | — | C | A | — | — | — | — | — | — | — | — | — | — | — | — | — | A (above FH) | — |
| PR | — | — | — | — | — | V | A (budget) | CS | A | CS | CS | CS | CS | A | CS | — | — | — | — | — | V | — |
| PO | — | — | — | — | — | V | A (high value) | CS | A | V | V | V | — | V | — | — | — | — | — | — | A (≥ limit) | — |
| GRN | — | — | — | — | — | V | — | V | V | CP | AP | V | — | V | V | V | V | V | V | — | V | — |
| Lot disposition RM/PM | — | — | — | — | — | — | — | — | — | V | V | V | — | V | V | R* | V | R* | R* | — | V | — |
| Stock adjustment | — | — | — | — | — | A (value) | A | — | — | C | A | — | — | — | — | — | — | — | — | — | V | — |
| BOM version | — | — | — | — | — | — | — | — | — | — | — | C | V | A | — | V | V | A | A | — | V | — |
| Production order | — | — | — | — | — | — | — | — | — | V | V | CS | V | A | — | — | — | — | — | — | V | — |
| Batch execution | — | — | — | — | — | — | — | — | — | V | — | V | CP | A | — | — | V | V | V | — | V | — |
| QC result | — | — | — | — | — | — | — | — | — | — | — | — | — | V | CS | A | V | V | V | — | V | — |
| CoA | — | V | V | V | — | — | — | — | — | — | — | — | — | V | C | A | V | V | V | V | V | — |
| Deviation / CAPA | C | C | C | C | — | — | — | C | C | C | C | C | C | C | C | C | CS | A | A | C | V | — |
| FG batch release | — | — | — | — | — | — | — | — | — | — | — | — | — | V | — | V | V | R (delegated) | R | — | V | — |
| Recall | — | V | V | — | — | V | V | — | — | V | V | — | — | V | — | V | C | CS | A | V | VA | — |
| Shipment / dispatch | — | — | — | V | — | V | — | — | — | C | A | — | — | — | — | — | — | — | — | CSP | V | — |
| Invoice | Vs | Vs | V | V | — | CP | A | — | — | — | — | — | — | — | — | — | — | — | — | V | V | — |
| Receipt / allocation | — | — | — | — | — | CP | A | — | — | — | — | — | — | — | — | — | — | — | — | — | V | — |
| Users / roles | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | A | CK |
| Approval policies / limits | — | — | — | — | — | — | V | — | — | — | — | — | — | — | — | — | — | — | — | — | AK | — |
| Audit log | — | — | — | — | — | — | V | — | — | — | — | — | — | — | — | — | — | — | — | — | V | VX |

`R*` = raw-material lot release authority, assigned to QC Manager **or** QA Manager/Head depending on D04.

## 5. Sales authority limits (seed values from the BRD, MP§4.4; inactive until approved, D15)

| Tier | Code | Max discount | Max order value | Proposed policy role |
|---|---|---|---|---|
| 1 | BH | Exceptional (unbounded, needs justification) | Exceptional | Final approver of exceptions |
| 2 | NSM | 25% | ₹10,00,000 | |
| 3 | DSM | 20% | ₹7,50,000 | |
| 4 | ZSM | 15% | ₹5,00,000 | |
| 5 | RSM | 12% | ₹3,50,000 | |
| 6 | SASM | 10% | ₹2,50,000 | |
| 7 | ASM | 7% | ₹1,50,000 | |
| 8 | TSM | 5% | ₹75,000 | |
| 9 | SE | Catalogue price (0%) | Catalogue pricing | Initiator only |

### 5.1 Two routing options for D01

| | Option 1 — Sequential (BRD) | Option 2 — Conditional (recommended in P1 §5) |
|---|---|---|
| Rule | Every order passes SE/TSM → ASM → SASM → RSM → ZSM → Accounts → Warehouse | The order goes to the **lowest tier whose limits cover both the order value and the highest line discount**, walking up the initiator's reporting chain. Then Accounts (credit), then Dispatch authorisation |
| Example: ₹1,20,000 at 6% | 5 sales signatures | ASM only → Accounts |
| Example: ₹4,00,000 at 4% | 5 sales signatures | ZSM (value > RSM limit) → Accounts |
| Example: ₹90,000 at 13% | 5 sales signatures | ZSM (discount > RSM's 12%) → Accounts |
| Example: ₹12,00,000 | 5 signatures + ? | BH (value > NSM) → Accounts → MD if a credit exception also applies |
| Pros / cons | Simple to explain; slow; most approvals are rubber stamps | Fast; approval effort scales with risk; needs well-maintained hierarchy data |

Optional hybrid: conditional routing, plus a "notify-only" copy to the intermediate managers who were skipped.

**Vacant tier:** if the reporting chain skips a tier (for example, no SASM in a region), the engine moves to the next existing manager. Gaps are flagged on the Admin dashboard.

## 6. Approval matrix by document (proposed)

| Document | Trigger / condition | Approver(s) in order | SLA | Escalation |
|---|---|---|---|---|
| Dealer onboarding | Always | Doc Verifier → Commercial (ASM+) → Credit Controller/FH → Final (RSM/ZSM by requested limit) | 2 working days per step | Next tier up |
| Dealer credit limit ≥ ₹X (D18) | Limit change | FH → MD | 2 days | MD |
| Price list / scheme | Always | Sales Head (BH) + FH (parallel) | 3 days | MD |
| Quotation | Discount > initiator authority | Per §5 routing | 1 day | Next tier |
| Sales order | Always (value/discount) | Per §5 → Accounts (credit) → Dispatch authorisation | 1 day per step | Next tier / FH |
| Credit exception | Exposure > limit, or overdue > N days | FH; above ₹Y → MD | 4 h | MD |
| SO amendment (material) | Material field changed (D17) | Re-run the policy for the new revision | as SO | — |
| PR | Always | Department head → budget owner if over budget | 1 day | PH |
| PO | By value: < ₹1L PH; ₹1–10L PH + FH; > ₹10L + MD (to be set, D06) | — | 2 days | MD |
| Emergency PR/PO | Emergency flag | PH immediately, retrospective FH review within 3 days | — | — |
| Three-way match exception | Outside tolerance | PUR (justify) → FH | 2 days | — |
| Stock adjustment | Any; value > ₹Z also FH | SH → ACC / FH | 2 days | FH |
| RM lot disposition | After QC review | QC Manager or QA (D04) | 1 day | QA Head |
| BOM version | Always | Plant Head → QA Manager | 3 days | QA Head |
| Specification version | Always | QC Head → QA Manager | 3 days | QA Head |
| FG batch release | Always | QA Head or delegated QA Manager (single authorised signature, with re-authentication) | 1 day | — |
| Deviation (major/critical) | Severity | QA Manager → QA Head | 1 day | MD (critical) |
| CAPA closure | Always | Owner → QA Manager (effectiveness) | — | QA Head |
| Recall initiation / closure | Always | QA Head → MD | Immediate | — |
| Credit / debit note | Always; > ₹V also FH | ACC → FH | 2 days | MD |
| Role / privilege change | Always | SecA proposes → EA approves | 1 day | — |
| Policy / authority-limit publish | Always | EA ×2 (maker-checker) | — | — |
| Emergency access | Always | Two of SA/EA | Immediate | — |

## 7. Segregation-of-duties rules (enforced by the system)

| ID | Rule |
|---|---|
| SOD-01 | Document initiator ≠ any approver of that document revision |
| SOD-02 | QC analyst ≠ result reviewer for the same sample |
| SOD-03 | The person who records the count ≠ the approver of the adjustment |
| SOD-04 | PO creator ≠ PO approver; GRN poster ≠ supplier invoice matcher (configurable) |
| SOD-05 | Invoice creator ≠ credit note approver for that invoice |
| SOD-06 | Security admin ≠ approver of their own role changes |
| SOD-07 | Batch supervisor ≠ QA releaser for the same batch |
| SOD-08 | A delegate cannot approve a document they initiated, even when acting for someone else |
