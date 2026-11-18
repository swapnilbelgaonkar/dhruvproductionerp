# 05 — Workflow Diagrams

Covers MP Part 30, Step 4, and P2. Each diagram shows who is responsible (swimlanes as participants), approval points (◆), failure paths and the transactions that result. Routing that depends on an open decision is labelled with its ID.

---

## 1. Dealer onboarding (DLR-005; D07)

```mermaid
sequenceDiagram
  autonumber
  actor SE as Sales Exec / TSM
  participant SYS as ERP
  actor CMP as Compliance (Doc Verifier)
  actor CM as Commercial Approver (ASM+ per policy)
  actor FIN as Finance (Credit)
  actor FA as Final Approver (RSM/ZSM per policy)
  SE->>SYS: Create dealer draft (business, statutory, commercial, docs)
  SYS->>SYS: Duplicate check GSTIN/PAN/mobile, GSTIN format
  alt duplicate found
    SYS-->>SE: Block / suggest link to existing party
  end
  SE->>SYS: Submit
  SYS->>CMP: ◆ Document verification task
  alt documents invalid / missing
    CMP-->>SE: Return for correction (pending-document list)
  else licence expired
    CMP-->>SYS: Verify with restriction (category blocked)
  end
  CMP->>SYS: Verified
  SYS->>CM: ◆ Commercial review (price group, territory, target)
  CM->>SYS: Approve / Reject (reason)
  SYS->>FIN: ◆ Credit assessment (limit, days, security per D07)
  FIN->>SYS: Approve limit / reduce / reject
  SYS->>FA: ◆ Final approval
  FA->>SYS: Approve
  SYS->>SYS: party_role DEALER = Active, credit_profile active, audit
  SYS-->>SE: Dealer code issued, notifications
```

**Results:** `mdm.parties`, `party_roles(DEALER, Active)`, `party_licences(Verified)`, `credit_profiles`. Suspension is a separate one-step approval and blocks new quotations and orders at once.

---

## 2. Lead-to-cash

```mermaid
flowchart TD
  L[Lead captured<br/>SE] --> Q{BANT qualified?}
  Q -- No --> LD[Disqualified / nurture]
  Q -- Yes --> OP[Opportunity<br/>stages 1–4]
  OP -->|sample/trial| SM[Sample & field trial] --> OP
  OP --> QT[Quotation draft]
  QT --> QD{Discount / value<br/>within SE/TSM limit?}
  QD -- No --> QA1[◆ Quotation approval<br/>policy engine D01/D15]
  QA1 -- Rejected --> QT
  QD -- Yes --> QS[Quotation sent]
  QA1 -- Approved --> QS
  QS --> EXP{Expired?<br/>D16}
  EXP -- Yes --> REV[Revalidate / reissue] --> QS
  EXP -- No --> SO[Sales order + dealer PO]
  SO --> V[Server validations<br/>dealer, licence, price, credit, dup PO, stock]
  V -- fail --> SOH[Return / On Hold with reasons]
  V -- pass --> CA[◆ Commercial approval]
  CA --> CR[◆ Accounts / credit review]
  CR -- breach --> CX[◆ Credit exception authority] -- rejected --> SOH
  CR --> AL{Released FG stock?}
  CX -- approved --> AL
  AL -- Yes --> RES[Reserve lots FEFO]
  AL -- Partial/No --> BO[Backorder → MTO/MRP D03]
  BO --> RES
  RES --> DA[◆ Dispatch authorisation]
  DA --> PK[Pick · pack · scan · load]
  PK --> DSP[Dispatch confirmed]
  DSP --> INV[Invoice + e-invoice IRN D08]
  INV --> EWB[E-way bill]
  DSP --> POD[POD]
  POD -- shortage/damage --> RET[Return / credit note]
  INV --> COL[Collection · receipt allocation]
  COL --> CLS[Order closed]
```

**Transactions:** lead → opportunity → quotation (versions) → sales order (revisions) → approval request → reservations → shipment → stock movements (`PICK`, `DISPATCH`) → invoice → ledger entries → postings → receipt → allocation.

---

## 3. Procure-to-pay

```mermaid
flowchart TD
  D[Demand: MRP suggestion / manual] --> PR[Purchase requisition]
  PR --> PRA[◆ Dept head approval] --> BUD[◆ Budget / authority D06]
  BUD -- reject --> PRX[PR rejected]
  BUD --> RFQ[RFQ to ≥ N vendors]
  RFQ --> CS[Comparative statement<br/>landed cost, quality, lead time]
  CS --> SEL[◆ Vendor selection<br/>non-L1 needs reason]
  SEL --> PO[Purchase order]
  PO --> POA[◆ PO approval by value]
  POA --> ISS[PO issued / acknowledged]
  ISS --> GE[Gate entry] --> GRN[GRN → lots QUARANTINE]
  GRN -- partial --> ISS
  GRN --> QC[QC sampling & test]
  QC -- fail --> REJ[Lot REJECTED → supplier return + debit note]
  QC -- pass --> REL[Lot RELEASED]
  REL --> INVR[Supplier invoice registered]
  INVR --> M3{3-way match<br/>within tolerance?}
  M3 -- No --> EXQ[◆ Match exception: Purchase + Finance]
  EXQ -- resolved --> AP
  M3 -- Yes --> AP[Payable]
  AP --> PAY[◆ Payment approval] --> PD[Payment / external GL D02]
```

---

## 4. Inventory receipt & quarantine (INV-001, P7 §7)

```mermaid
stateDiagram-v2
  [*] --> GateIn: vehicle arrives
  GateIn --> GRNDraft: Stores counts, records supplier batch, dates
  GRNDraft --> Posted: Post GRN
  state Posted {
    [*] --> QUARANTINE
    QUARANTINE --> SAMPLED: QC sample drawn
    SAMPLED --> UNDER_TEST
    UNDER_TEST --> RELEASED: ◆ disposition Release (D04)
    UNDER_TEST --> REJECTED: ◆ disposition Reject
    UNDER_TEST --> QA_HOLD: OOS / investigation
    QA_HOLD --> RELEASED: ◆ after investigation
    QA_HOLD --> REJECTED
    RELEASED --> EXPIRED: expiry job
    RELEASED --> QA_HOLD: complaint / recall hold
  }
  REJECTED --> ReturnedToSupplier
  Posted --> [*]
```

Guards: `ISSUE_TO_PROD`, `PICK` and `TRANSFER` are allowed only for `RELEASED` and `GOOD` stock. Any other attempt returns `422 LOT_NOT_ELIGIBLE` and writes an audit event (TC-08).

---

## 5. Production planning (MRP)

```mermaid
flowchart LR
  SO[Open SO lines<br/>+ backorders] --> NET
  FC[Approved forecast] --> NET
  FG[FG available-to-promise] --> NET
  NET[Net FG requirement] --> PLAN[Planned production orders<br/>batch size, capacity, shift]
  PLAN --> EXP[BOM explosion<br/>effective version]
  EXP --> RMN[RM/PM net requirement<br/>– released – on-order + safety stock]
  RMN --> PRS[PR proposals with need-by = start – lead time]
  PLAN --> PPA[◆ Plant Head approves plan]
  PPA --> PO[Production orders Released]
  PRS --> PRR[Purchase reviews → PR]
```

Make-to-stock, make-to-order or hybrid (D03) decides whether SO lines feed `NET` directly or only through the forecast.

---

## 6. Batch manufacturing

```mermaid
sequenceDiagram
  autonumber
  actor PL as Plant Planner
  actor ST as Stores
  actor OP as Production Supervisor / Operator
  participant SYS as ERP
  actor QC as QC
  PL->>SYS: Release production order (approved effective BOM only)
  SYS->>SYS: Reserve RELEASED RM lots (FEFO), shortage → hold / partial (P2 §4)
  ST->>SYS: Issue materials (scan lot) → ISSUE_TO_PROD
  OP->>SYS: Start batch, record operators, equipment, shift
  loop each dosing step
    OP->>SYS: Actual lot + qty
    SYS->>SYS: Variance vs BOM tolerance
    alt beyond tolerance
      SYS-->>OP: Block step, raise deviation (◆ supervisor + QA)
    end
  end
  OP->>SYS: Process readings
  SYS->>QC: IPQC sample request
  QC-->>SYS: IPQC pass / fail (fail → hold step, deviation)
  OP->>SYS: Complete batch: output qty, losses, recovered, scrap
  SYS->>SYS: Mass-balance check, FG bulk lot created = QUARANTINE
  OP->>SYS: Packaging run: PM issue, packs, rejects, box serials + QR labels
  SYS->>QC: FG sample request
```

---

## 7. QC & QA release

```mermaid
flowchart TD
  S[Sample registered<br/>custody: collected → received] --> W[Lab worklist: analyst assigned]
  W --> CAL{Instrument calibrated?}
  CAL -- No --> BLK[Instrument blocked, choose another]
  CAL -- Yes --> R[Results entered vs effective spec<br/>raw evidence attached]
  R --> OOS{Within limits?}
  OOS -- No --> INV[OOS/OOT case opened automatically]
  INV --> RT[◆ Retest authorised by QC Manager] --> R
  INV --> FAIL[Confirmed fail]
  OOS -- Yes --> REV[◆ Reviewer ≠ analyst approves]
  REV --> COA[CoA generated, version-controlled]
  COA --> BR[QA batch review<br/>BMR · BPR · QC · deviations]
  FAIL --> BR
  BR --> DEV{Open deviations?}
  DEV -- Yes --> HOLD[Release blocked]
  DEV -- No --> DISP[◆ QA release authority D04]
  DISP -->|Released| SAL[FG lot RELEASED → saleable]
  DISP -->|On Hold| QH[QA_HOLD]
  DISP -->|Rejected| RJ[REJECTED → destroy/rework]
  DISP -->|Rework Authorised| RW[Rework order → new batch, genealogy linked]
```

---

## 8. Dispatch & delivery

```mermaid
sequenceDiagram
  autonumber
  actor LOG as Logistics Planner
  actor WH as Warehouse Picker
  participant MOB as Scanner (PWA)
  participant SYS as ERP
  actor TR as Transporter
  LOG->>SYS: Plan shipment from dispatch-authorised orders
  SYS->>WH: Pick list (reserved lots, bins, FEFO)
  WH->>MOB: Scan bin + box
  MOB->>SYS: scan event (online or queued)
  SYS->>SYS: Validate box: lot RELEASED, matches line, not in other active shipment
  alt invalid / duplicate
    SYS-->>MOB: Rejected with reason (TC-14)
  end
  WH->>SYS: Packing complete, packed qty per line
  LOG->>SYS: Assign transporter, vehicle, driver, LR
  WH->>MOB: Load scan
  LOG->>SYS: ◆ Confirm dispatch (only scanned qty)
  SYS->>SYS: DISPATCH movements, SO dispatched qty, invoice job, e-way bill job
  TR-->>LOG: Delivery
  LOG->>SYS: POD: received qty, shortage/damage, upload
  alt shortage / damage / refusal
    SYS->>SYS: Exception case → return / credit note / freight claim
  end
  SYS->>SYS: Shipment Delivered → Closed after freight settled
```

---

## 9. Returns & credits

```mermaid
flowchart TD
  RQ[Return request<br/>dealer / POD exception] --> RA[◆ Return authorisation<br/>Sales + QA if quality reason]
  RA -- rejected --> RX[Closed: rejected]
  RA --> RCV[Receive return: scan boxes / count]
  RCV --> QH[Lot QA_HOLD, condition assessed]
  QH --> QD{QA decision}
  QD -->|Re-sell| RS[RELEASED to FG]
  QD -->|Rework| RW[Rework order]
  QD -->|Destroy| SC[SCRAP movement]
  RCV --> CN[Credit note draft<br/>qty × invoiced rate + tax reversal]
  CN --> CNA[◆ Finance approval] --> POST[Ledger + GST credit note IRN if applicable]
  POST --> REC[Stock, tax and AR reconcile UAT-12]
```

---

## 10. Product recall

```mermaid
flowchart TD
  TRG[Trigger: complaint, OOS on retained sample, supplier alert, regulator] --> RC[◆ QA Head opens recall case]
  RC --> SCOPE[Genealogy query:<br/>supplier lot → batches → FG lots → boxes → shipments → dealers]
  SCOPE --> HOLD[Auto QA_HOLD on all in-house affected stock]
  SCOPE --> NOTIFY[Notify affected dealers + Sales owners]
  NOTIFY --> RET[Dealer returns logged per box/qty]
  RET --> REC[Reconcile: shipped = returned + consumed + unaccounted]
  REC --> CAPA[CAPA linked]
  CAPA --> CLOSE[◆ QA Head closes recall with evidence]
```

A drill mode runs the same scope query and a reconciliation report without changing stock status (MP§14.5).

---

## 11. Financial reconciliation

```mermaid
sequenceDiagram
  autonumber
  participant ERP as ERP (source docs)
  participant OB as Outbox / Worker
  participant EXT as Accounting system (Model B) or native GL (Model A)
  actor AC as Accounts
  ERP->>ERP: Invoice/receipt/credit note committed + postings row PENDING
  OB->>EXT: Post (Idempotency-Key = posting.id)
  alt success
    EXT-->>OB: ack / voucher no
    OB->>ERP: posting POSTED + external_ref
  else timeout / 5xx
    OB->>OB: retry with backoff (same key) — never duplicates (TC-17)
    OB->>ERP: after N attempts → FAILED, DLQ, alert
    AC->>ERP: Review failure, retry or correct source via reversal
  end
  AC->>ERP: Daily reconciliation report: ERP postings vs external ledger totals
  AC->>ERP: Period soft-close → close (posting lock)
```

---

## 12. Document state machines (harmonised)

### 12.1 Sales order (harmonises MP§9.4 with P4 §4)

| State | Meaning | Next states |
|---|---|---|
| Draft | Editable by the creator | Submitted, Cancelled |
| Submitted | Validated; approval request created | Under Review |
| Under Review | Commercial or credit step pending. Sub-status shows `Commercial` or `Credit` | Approved, Rejected, On Hold, Draft (returned for correction) |
| On Hold | Held by an approver or by a system rule (credit, licence) | Under Review, Cancelled |
| Rejected | Final for this revision; a new revision can be created | — |
| Approved | All approvals done | Allocated, Backordered, Partially Fulfilled, Cancelled |
| Backordered | Not enough eligible stock | Allocated, Partially Fulfilled, Cancelled |
| Allocated (Ready for Dispatch) | Fully reserved and dispatch-authorised | Partially Fulfilled, Fulfilled |
| Partially Fulfilled | Some quantity dispatched | Fulfilled, Closed (short-closed with reason) |
| Fulfilled | All quantity dispatched | Closed |
| Cancelled | Before dispatch only; reservations released | — |
| Closed | Invoiced and settled, or short-closed | — |

An amendment to an `Approved`/`Allocated` order creates revision *n+1* in `Under Review` when the change is material (D17). Reservations are kept until the new revision is approved or rejected.

### 12.2 Other documents

| Document | Normal path | Exceptions |
|---|---|---|
| Quotation | Draft → Submitted → (Approval) → Approved/Sent → Accepted → Converted | Rejected, Expired, Superseded (by revision), Cancelled |
| Purchase requisition | Draft → Submitted → Approved → Partially Ordered → Ordered → Closed | Rejected, Cancelled |
| Purchase order | Draft → Submitted → Approved → Issued → Acknowledged → Partially Received → Received → Closed | On Hold, Rejected, Cancelled, Short-closed |
| GRN | Draft → Posted → (QC) → Accepted / Partially Accepted / Rejected | Reversed |
| Lot | Quarantine → Sampled → Under Test → Released | QA Hold, Rejected, Expired, Returned, Consumed |
| Production order | Planned → Approved → Released → In Progress → Completed → Closed | On Hold, Cancelled |
| Batch | In Progress → Completed → QC Pending → QA Review → Released → Closed | On Hold, Rework, Rejected |
| CAPA | Logged → Triaged → Investigation → Plan → Approved → Implementation → Effectiveness Check → Closed | Reopened, Escalated |
| Shipment | Planning → Picking → Packed → Loaded → Dispatched → In Transit → Delivered → Closed | Partial, Damaged, Returned (RTO), Disputed |
| Invoice | Draft → Issued → (IRN Generated) → Posted → Partially Paid → Paid | Cancelled (within the IRN window), Credit-noted |
| Dealer | Draft → Submitted → Verified → Commercially Approved → Credit Approved → Active | Returned, Rejected, Suspended, Inactive |
