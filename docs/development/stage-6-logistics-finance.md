# Stage 6 — Logistics and finance: progress report

Order follows D12 (business flow). Stage 6 parts:

1. Dispatch: transporters, dispatch queue, shipment planning, picking by box scan, loading with LR and e-way bill, delivery challan, proof of delivery — **done**
2. Sales invoicing: GST tax invoice from the dispatch, credit notes, customer returns — **done**
3. Receivables: receipts and allocation, ageing, credit exposure and the overdue freeze (D18) — **done**
4. Payables: vendor ledger, payments, debit note adjustment, freight bills
5. Native general ledger (D02): chart of accounts, idempotent postings, trial balance, P&L, balance sheet, period lock, GST summaries

## Part 1 — Dispatch (BRD p.17; MP §15.1–15.6; LOG-001…LOG-007, LOG-009…LOG-011, FIN-015)

| Area | What works | RTM |
|---|---|---|
| Dispatch queue | Approved sales orders with packs still to ship, oldest required-by date first. For each line: ordered, dispatched, on open shipments, still to plan, and packs ready in **QA-released, unshipped boxes** | LOG-001 |
| Planning | Logistics plans a shipment (`DSP/…`) against one order: an active finished-goods warehouse of the order's legal entity, a date not in the past, and packs per line. Planned packs can never exceed what is still open, counting other open shipments | LOG-001 |
| Picking by scan | Stores scans box serials. A box is refused if it is unknown, already on a shipment or dispatched, of a lot **not released by QA**, of a pack not on the shipment, more than the line still needs, or not free in the dispatch warehouse. Scanned boxes can be taken off before dispatch | LOG-002, LOG-003 |
| Transporters | Master with code, name, GSTIN, PAN and contact (logistics head) | LOG-004 |
| Loading and dispatch | Transporter, vehicle number (validated), driver, LR number and date, freight terms (paid, to pay, to be billed) and amount. **Only what was scanned is dispatched** — stock leaves the warehouse lot by lot at its cost (`DISPATCH` ledger entries), boxes become Dispatched, and the sales order's dispatched quantity rises. The order closes itself when every line is fully shipped | LOG-004, LOG-009, LOG-011 |
| E-way bill | Required above the threshold in setting `logistics.ewb.thresholdValue` (₹50,000 by default, D08 provisional): the 12-digit number and validity date are mandatory, an expired bill is refused. NIC portal integration is with Stage 7 integrations | LOG-005, FIN-015 |
| Delivery challan and loading slip | Printable: seller and GSTIN, consignee, transport details, lots with expiry and the box serials of each line, value, signature blocks. Before dispatch it prints as a loading slip | LOG-007 |
| Proof of delivery | Received date and person, packs received per line; a shortage or damage needs remarks and marks the shipment "Delivered short". The signed LR or challan is filed in the document vault (type POD) | LOG-006 |
| Cancel | A planned or picked shipment can be cancelled with a reason; its boxes go back to stock for another shipment | LOG-010 |
| Sales order | The order page shows dispatch progress and its shipments | LOG-001 |
| Roles | Logistics executive: plan, dispatch, POD. Logistics head: also the transporter master. Storekeeper, stores head and scanner operator: scan. Sales, finance, QA and management: view | — |

### Evidence
- `apps/api/test/dispatch.test.ts`: a completed batch packed into 4 boxes of 12 and an order for 30 packs.
  - Planning refuses the wrong warehouse and over-planning, including against another open shipment.
  - A box of an unreleased lot is refused (LOG-003). After release, a double scan, an unknown box and an over-pick are refused; un-pick and re-pick work.
  - With the e-way bill threshold lowered, dispatch needs the number and its validity. Stock falls by exactly the 24 packs scanned, boxes are marked Dispatched, and the order line shows 24 dispatched.
  - POD refuses over-delivery and a shortage without remarks, then records "Delivered short".
  - A remainder shipment of 6 cannot take a box of 12 and is cancelled. Shipping the final 12 closes the order.
- Totals at the end of part 1: 76 API + 4 contract tests passing. Typecheck clean.
- Browser run (local, [SAMPLE] data):
  1. The logistics head added Sahyadri Roadways and planned 24 × 1 L of SO/2026-27/000001 from WH-01.
  2. The storekeeper scanned two boxes; a repeat scan and a third box were refused.
  3. The logistics executive loaded the shipment (vehicle MH12AB4521, LR SRW/7781) and dispatched it. The delivery challan printed with lot B/2026-27/000001 and both box serials.
  4. The POD recorded 23 received with one bottle leaked, so the shipment shows "Delivered short".

### Not built yet (part 1)
- **Route planning and vehicle capacity (LOG-008)**: Stage 7 (reporting and mobile).
- **E-way bill and e-invoice generation through the NIC portal**: Stage 7 integrations. Numbers are entered by hand until then.
- **Freight bills against shipments**: with payables (part 4).

## Part 2 — Sales invoicing (BRD p.18; MP §16.1–16.4; FIN-001…FIN-005, FIN-014, LOG-012)

| Area | What works | RTM |
|---|---|---|
| Tax invoice at dispatch | Dispatching a shipment raises its GST tax invoice in the same step (setting `sales.invoice.autoOnDispatch`, on by default), so the invoice travels with the goods. Accounts can raise it from "Dispatched, not yet invoiced" when the setting is off or after a cancellation. One live invoice per shipment | FIN-001 |
| Pricing and tax | Each line is priced from the approved sales-order line for the packs actually dispatched: list rate, scheme and extra discount, and the GST rate taken from the tax master when the order was made. Nothing is re-keyed. CGST + SGST or IGST follow the order's place of supply. Integer-paise maths, grand total rounded to the rupee | FIN-002 |
| Invoice number | `SI/2026-27/00001`: 16 characters, unique per financial year (GST rule 46), enforced by the database | FIN-002 |
| Due date | Invoice date plus the dealer's credit days | FIN-002 |
| Printable tax invoice | Seller and buyer GSTIN, state codes, place of supply, HSN, quantity, rate, discount, taxable value, tax per line, HSN summary, amount in words, lots with expiry, challan, transporter, LR and e-way bill, reverse-charge statement and signatory. IRN prints once e-invoicing is connected (Stage 7) | FIN-002, FIN-014 |
| Cancellation | Only within `sales.invoice.cancelWindowHours` (24 by default, the IRN window), with a reason, and only while nothing is settled, credited or returned against it. The goods stay dispatched and the shipment can be invoiced again; after the window a credit note is the only route | FIN-003 |
| Credit notes | `CN/2026-27/00001` against one invoice, for a shortage or damage (packs at the invoice line's net rate) or a rate difference, scheme or other reason (taxable value, explanation required). GST follows the invoice line. Credited packs and value can never exceed what was invoiced, counting other notes in flight. Approved through policy `sales.credit_note`: finance head; an executive director too above ₹1 lakh (provisional default, editable in Approval Policies). An approved note settles part of the invoice | FIN-004 |
| Customer returns | Stores receives goods back against the invoice (`CRN/…`): reason, the lot of each line (only lots that went out on that invoice, never more than were sent), condition, transport reference, evidence in the vault. Stock comes back into **quarantine** at the cost it left with, and a credit note for the packs is drafted for accounts | LOG-012, FIN-005 |
| QA decision on returns | The QA manager or head restocks each line to saleable stock (only if the lot is still released) or rejects it to rejected stock. The return closes when every line is decided | LOG-012 |
| Restocked packs ship again | Restocked returns are loose packs outside boxes, so a shipment can pick them by lot. Only packs actually returned and restocked are offered; bulk stock that was never packed is not a pack | LOG-002 |
| Links | Shipment ↔ invoice ↔ credit notes and returns are linked both ways; a "delivered short" shipment points accounts to the invoice to credit | — |
| Roles | Accounts executive and finance head: invoice, cancel, credit notes. The finance head approves credit notes. Storekeeper and stores head: receive returns. QA manager and head: decide returns. Sales, credit control, logistics and management: view | — |

### Evidence
- `apps/api/test/invoicing.test.ts` has 2 tests:
  - **Dispatch raises the invoice.** For 24 packs at ₹200 with 5 % GST intra-state: taxable 4,800, CGST 120, SGST 120, total 5,040. The number is at most 16 characters, and the lots, HSN summary and due date are correct.
  - **Cancel and re-raise.** A second invoice for the same shipment is refused, and logistics cannot cancel. Accounts cancels within the window, and the shipment reappears in "to invoice" and gets a new number. After 25 hours cancellation is refused.
  - **Shortage credit note.** A return reason without goods, over-crediting, and a rate difference without an explanation are all refused. A shortage of 1 pack is credited at ₹210 and approved by the finance head, not accounts, which settles ₹210 and blocks cancellation.
  - **Rate-difference note.** It is drafted, then cancelled.
  - **Customer return.** QA cannot receive it. A return that would push credits past what was invoiced is refused. Two packs come back into quarantine with a ₹420 draft credit note.
  - **QA decision.** The storekeeper cannot decide. QA restocks one pack (unrestricted stock +1) and rejects one (rejected stock +1), and the return closes.
  - **Re-shipping.** The restocked pack is offered as a loose pack on a new shipment: 2 are refused, 1 is picked, and then none are left.
- Totals at the end of part 2: 78 API + 4 contract tests passing. Typecheck clean.
- Browser run (local, [SAMPLE] data, after the part 1 run):
  1. Accounts saw DSP/2026-27/000001 under "Dispatched, not yet invoiced", because it was dispatched before invoicing existed, and raised SI/2026-27/00001 for ₹5,877. The tax invoice printed with the HSN summary and lot.
  2. Accounts credited the 1-pack shortage as CN/2026-27/00001 (₹245), and the finance head approved it.
  3. The storekeeper received 2 damaged packs back as CRN/2026-27/000001 into WH-01 quarantine, which drafted CN/2026-27/00002.
  4. The QA manager restocked both packs. The invoice now shows ₹245 settled and ₹5,632 outstanding.

### Not built yet (part 2)
- **E-invoice IRN and QR from the IRP, e-way bill generation**: Stage 7 integrations.
- **Receipts against invoices, ageing and the overdue freeze**: part 3.
- **GL postings of invoices, credit notes and returns**: part 5. Postings will be generated from these documents idempotently, including the ones already raised.

## Part 3 — Receivables (BRD p.7, p.19; MP §17.1–17.3; FIN-005…FIN-008; D18)

| Area | What works | RTM |
|---|---|---|
| Receipts | `RCT/…` per entity and dealer: date, mode (NEFT, RTGS, IMPS, UPI, cheque, DD, cash), UTR or instrument number and date, drawee bank, our deposit account, amount, and the bank slip in the vault. The same UTR or cheque cannot be entered twice for a dealer. Cash from one dealer in a day must stay within the s.269ST limit (setting, ₹1,99,999) | FIN-006 |
| Allocation | Oldest due first by default, or a chosen split, or kept on account. Never more than the receipt or than an invoice's outstanding. On-account money can be allocated later; an allocation can be reversed with a reason | FIN-006 |
| Bounce | A cheque or DD can be marked bounced with the bank's reason and date: its allocations are reversed and the invoices are due again. A wrong electronic entry is cancelled instead (finance head only) | FIN-007 |
| Ageing | Outstanding per dealer by days past due: not due, 1–30, 31–60, 61–90, 91–180, 180+; oldest overdue days, credit limit and days, unapplied receipts, totals, and a red banner when overdue debt is above the alert level (BRD KPI, ₹10 lakh) | FIN-005, MIS-007 |
| Dealer statement | Invoices and bounced cheques debit; approved credit notes and receipts credit; opening and running balance for any period; printable. Shows today's credit position | FIN-008 |
| Credit exposure (D18) | Unpaid invoices + orders not yet invoiced − unapplied receipts (doc 04 §4.10). Used at order submission: over the limit adds the finance head's credit override (existing policy); the order stores the snapshot (limit, unpaid, overdue, uninvoiced, on account) | FIN-005, SO-004 |
| Overdue freeze (D18) | BRD p.7, p.19: an invoice unpaid beyond its credit days freezes order-taking automatically. Order submission is refused (`OVERDUE_FREEZE`) with the overdue invoices listed. Settings: on/off and grace days (0, provisional). The exception path for the freeze is still open in D18 | FIN-005 |
| Roles | Accounts executive: receipts, allocation, bounce. Finance head: also cancel. Credit control, sales and management: ageing, statements, credit | — |

### Evidence
- `apps/api/test/receivables.test.ts`:
  - **Exposure.** The ₹5,040 invoice plus ₹1,260 of the order not yet invoiced gives exposure of ₹6,300.
  - **Receipts.** The credit controller cannot post receipts, and a missing UTR is refused. NEFT ₹3,000 is allocated in full; a duplicate UTR is refused, and cash of ₹2.5 lakh is refused (s.269ST).
  - **Cheque.** A cheque without its date is refused. A ₹3,000 cheque settles the remaining ₹2,040 and leaves ₹960 on account (exposure ₹300).
  - **Bounce.** NEFT cannot bounce. The cheque bounces, its allocation is reversed, and ₹2,040 is due again.
  - **Manual allocation and cancel.** UPI ₹500 kept on account cannot be over-allocated; it is allocated, then cancelled by the finance head (not accounts), which reverses it.
  - **Overdue.** Five days past due, the invoice ages into 1–30 and the dealer is frozen. The statement reads invoice 5,040 Dr, receipts 3,000 and 3,000 Cr, bounce 3,000 Dr, closing 2,040.
- `apps/api/test/orders.test.ts` (new test): an invoice 5 days overdue freezes the next order (`OVERDUE_FREEZE`, invoice listed). Raising the grace days lets it through, and the order's snapshot records ₹4,000 unpaid and overdue.
- Totals: **80 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local, [SAMPLE] data, after the part 2 run):
  1. Accounts recorded NEFT ₹3,000 for Krishi Seva Kendra (allocated to SI/2026-27/00001) and a ₹2,632 cheque that cleared the rest.
  2. The cheque bounced.
  3. The ageing shows ₹2,632 not yet due. The statement runs invoice, credit note, two receipts and the bounce to ₹2,632 Dr.

### Not built yet (part 3)
- **Bounce charges and interest on overdue**: as debit notes once the GL exists (part 5), if the client wants them.
- **Exception path to lift a freeze**: open in D18.
- **Payment reminders and escalation (`receivable.escalate`)**: with alerts in Stage 7.
