# Stage 6 — Logistics and finance: progress report

Order follows D12 (business flow). Stage 6 parts:

1. Dispatch: transporters, dispatch queue, shipment planning, picking by box scan, loading with LR and e-way bill, delivery challan, proof of delivery — **done**
2. Sales invoicing: GST tax invoice from the dispatch, credit notes, customer returns — next
3. Receivables: receipts and allocation, ageing, credit exposure and the overdue freeze (D18)
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
- Totals: **76 API + 4 contract tests passing**. Typecheck clean.
- Browser run (local, [SAMPLE] data):
  1. The logistics head added Sahyadri Roadways and planned 24 × 1 L of SO/2026-27/000001 from WH-01.
  2. The storekeeper scanned two boxes; a repeat scan and a third box were refused.
  3. The logistics executive loaded the shipment (vehicle MH12AB4521, LR SRW/7781) and dispatched it. The delivery challan printed with lot B/2026-27/000001 and both box serials.
  4. The POD recorded 23 received with one bottle leaked, so the shipment shows "Delivered short".

### Not built yet
- **Route planning and vehicle capacity (LOG-008)**: Stage 7 (reporting and mobile).
- **E-way bill and e-invoice generation through the NIC portal**: Stage 7 integrations. Numbers are entered by hand until then.
- **Freight bills against shipments**: with payables (part 4).
