# Stage 3 — Supply: progress report

Order follows D12 (business flow). Stage 3 parts:

1. Vendor onboarding and purchase requisitions — **done**
2. RFQ, comparative statement and purchase orders — **done**
3. Goods receipt with quarantine, QC sampling and lot release, stock ledger — **done**
4. Supplier invoice three-way match, supplier returns and debit notes

## Part 1 — Vendor onboarding and purchase requisitions (BRD §3.2 p.8; MP §10.1; MDM-011, MDM-016, PUR-001/002)

| Area | What works | RTM |
|---|---|---|
| Vendor registration | Auto code `VEN-2026-0001`. Legal and trade name, constitution, contact, PAN, GST status and GSTIN (check digit, PAN match), category (raw material, packaging, lab consumables, services, capital, other), MSME with Udyam number, payment terms in days, and the licences the vendor must hold | MDM-011 |
| Statutory licences | CIB&RC registration (pesticide technicals) and the factory manufacturing licence (BRD p.8), plus fertilizer, pesticide and bio-stimulant licences. Certificates are in the vault; a new licence supersedes the old one and must be verified again. The person who entered a licence cannot verify it | MDM-016 |
| Same-line GST certificate | The certificate upload sits on the GSTIN row, as for dealers | MDM-016 |
| Bank account | Account holder, bank, branch, IFSC and account number with a cancelled cheque. The number is stored **encrypted**; purchase sees only the last 4 digits, finance and document verifiers see the full number. Finance verifies it (not the person who entered it). A replaced account must be verified again before the vendor can be ordered from | MDM-011, X26 |
| Items supplied | The approved items with the vendor's item code, lead time and minimum order quantity. Purchase orders (part 2) will only be possible for these items | MDM-011 |
| KYC rules (D07) | The same configurable rule table as dealers, now per party role. Setting `vendor.kyc.policy` = `CONDITIONAL` (PAN, GST certificate, letterhead, signatory, constitution documents) or `BRD_STRICT` (adds 3 security cheques and 5 directors for every vendor, BRD p.8) | D07 |
| Onboarding checklist | Registered address matching the GSTIN state, no duplicate GSTIN/PAN, bank account entered, at least one item, required licences present and valid, KYC documents. Submission is refused until complete | MDM-011 |
| Approval chain | Document verification (every licence verified first) → purchase head → finance (bank account verified first). Policy `mdm.vendor` | MDM-011, doc 07 |
| Suspension | By the purchase head, with a reason | MDM-011 |
| Eligibility | `vendorEligibility()`: vendor active, bank account verified, every required licence valid and verified, approved for the items. Purchase orders will call it | PUR-006 |
| Expiry alerts | Vendor licences are included in the hourly scan; alerts go to the purchase heads and the document verifiers | MDM-016 |
| Access | Vendors are purchase-owned: purchase, document verifiers, finance, accounts, stores and QC view them; sales cannot. Documents attached to a vendor follow vendor permissions | SEC-010 |
| Purchase requisition | Number `PR/2026-27/000001`. Legal entity, deliver-to warehouse, department, required-by date, priority (normal, urgent, emergency), purpose; up to 100 lines with item, quantity (in the item's unit), estimated rate, needed-by date, suggested vendor and remarks. Shows how many approved vendors each item has | PUR-001 |
| Requisition approval | The requester's department head (reporting manager) approves. An **emergency** goes straight to the purchase head (D06 default). Policy `purchase.requisition` | PUR-002, D06 |
| Who sees requisitions | Anyone who needs material (stores, production, plant, QC, QA, logistics, purchase) can raise one and sees their own. Purchase, the stores head, finance and management see all of their legal entities | PUR-002 |
| Cancel | The requester while Draft or Rejected; purchase or the stores head once approved, until something is ordered | PUR-002 |

### Evidence
- `apps/api/test/purchase.test.ts` has 2 tests:
  - vendor: incomplete checklist refused; masked vs full account number; sales cannot see vendors or their documents; licence gate; bank gate; separation of duties on bank verification; Active; eligibility for approved and unapproved items; a replaced bank account blocks ordering; licence alert to the purchase head
  - requisition: past date and duplicate item refused; estimated value; private to the requester; purchase sees all; department head approval; cancellation; emergency routed to the purchase head and listed first
- The dealer module now uses the same shared party code; all 6 dealer tests still pass.
- Totals: **51 API + 4 contract tests passing**. Typecheck and production build clean.
- Browser runs passed:
  1. The purchase executive registered a private-limited vendor (MSME, factory licence), added the address, the GST certificate on the GSTIN line, the licence, a director, the bank account with a cancelled cheque, an item supplied and five KYC documents, and submitted. The verifier verified the licence and approved, the purchase head approved, finance saw the full account number, verified it and approved. The vendor became Active, with the account masked for purchase.
  2. The storekeeper raised a requisition for 2,500 kg of zinc sulphate with an estimated rate and the new vendor suggested; the stores head approved it; purchase sees it.
  3. The dealer onboarding run was repeated on the refactored dealer page and passed.

### Changed during this part
- Addresses, licences, signatories, the duplicate check, KYC checks and the related page sections are shared by dealers and vendors (`modules/parties/shared.ts`, `components/parties/PartyParts.tsx`) instead of being dealer-only.
- KYC rules have a party role column; existing dealer rules are unchanged.

### Not built yet
- **A party that is both a dealer and a vendor**: GSTIN is unique per party, so registering a dealer as a vendor is refused with a clear message. Adding a second role to an existing party comes later.
- **Changing an active vendor's items or terms**: needs a change request with re-approval (with master change requests).
- **Budget check by cost centre (PUR-003)**: needs budgets (D06).
- **Vendor rating**: calculated from receipts and QC results in part 3.
- **Client input**: D06 (purchase value bands and tolerances) — the doc 07 §6 defaults are now live (see part 2).

## Part 2 — RFQ, comparative statement and purchase orders (BRD p.8, p.13–14; MP §10.2–10.4; PUR-004…006, PUR-013/014; D06, D34)

| Area | What works | RTM |
|---|---|---|
| RFQ | Number `RFQ/2026-27/000001`. Items (from an approved requisition with "Request quotes", or added directly), quantities, needed-by dates and specifications; deliver-to warehouse; response deadline; invited vendors — each must be active and approved for at least one of the items | PUR-004 |
| Vendor quotes | Purchase keys in each vendor's quotation: reference, date, validity, payment terms, delivery days, total freight, and per line the rate, discount and whether it meets the specification (technical compliance). Recording again replaces the previous entry until award | PUR-004 |
| Comparative statement | Per line: net rate, freight per unit (the vendor's freight spread over its quoted lines by value), **landed rate**, lead time, vendor rating and a score out of 100 — landed cost 60, lead time 20, quality rating 20 (setting `purchase.rfq.weights`, D34 provisional). A new vendor is scored as average (3/5) until receipts and QC rate it. Non-compliant bids, expired quotes and vendors that are not eligible are shown but not ranked | PUR-005, PUR-014 |
| Award (X17) | The top-ranked bid is pre-selected per line. Purchase confirms; choosing any other qualified bid needs a written reason, which is stored with the award. Awarding drafts **one PO per vendor** at the quoted rates, discounts, payment terms and delivery days, linked to the RFQ and the requisition lines | PUR-005, PUR-014 |
| Purchase order | Number `PO/2026-27/000001`. Vendor, legal entity, ship-to warehouse, PO and delivery dates, payment terms, delivery terms, notes, emergency flag; lines from approved requisitions ("Create purchase order" on the requisition, or "From requisitions" in the editor) or items the vendor is approved for. Rates may carry 4 decimals (₹/kg) | PUR-006 |
| Controls | Vendor must be eligible (active, bank verified, licences valid, approved for every item) on save, submit and issue. A linked requisition line cannot be over-ordered; a requisition **closes** when fully ordered and **reopens** if a PO is cancelled | PUR-002, PUR-006 |
| Tax | GST from each item's HSN rate on the PO date; CGST + SGST when the vendor's state equals the ship-to warehouse state, otherwise IGST; no GST for an unregistered vendor; rounded to the rupee | PUR-006 |
| Approval (D06 defaults) | Up to ₹1 lakh: purchase head. ₹1–10 lakh: purchase head → finance head. Above ₹10 lakh: + executive director (BRD p.3). **Emergency**: purchase head only; the finance heads are notified to review it within 3 days. The person who raised the PO cannot approve it. The bands are a published policy (`purchase.order`), changeable in Approval Policies | PUR-006, PUR-011, D06 |
| Issue and acknowledgement | Issue sets an acknowledgement deadline (setting `purchase.po.acceptanceDays`, 7). Purchase records the vendor's confirmation reference. An hourly job marks unacknowledged POs **Lapsed**; a lapsed PO must be re-issued (with a fresh eligibility check) before it can be acknowledged | PUR-013 |
| Cancel | Before any goods are received, with a reason; requisition quantities are released | PUR-007 (part) |
| A4 print | PURCHASE ORDER with buyer GSTIN for the ship-to state, vendor and ship-to, itemised lines with HSN, rate, discount, taxable value and GST, totals in figures and words, payment and delivery terms, the acknowledgement clause and signature blocks for the vendor and the company. Not-yet-approved POs print with a warning banner | QUO-007 (PO print) |
| Access | Purchase executives and heads run RFQs and POs; finance, accounts, stores and management view POs (stores will receive against them in part 3) | SEC-010 |

### Evidence
- `apps/api/test/calc.test.ts`: purchase line maths with a 4-decimal rate, discount, CGST/SGST, IGST and an unregistered vendor (6 calc tests in all).
- `apps/api/test/purchase-orders.test.ts` has 3 tests:
  - requisition → PO: open lines listed, over-ordering refused, unapproved item refused, tax and rounding checked to the paisa, requisition closes, ₹1–10 lakh routing, initiator cannot approve, issue sets the deadline, acknowledgement, cancel reopens the requisition
  - value bands and lifecycle: IGST for a Karnataka vendor, purchase-head-only band, lapse and re-issue, the executive director band above ₹10 lakh, emergency routing with the finance notification
  - RFQ: unapproved vendor refused, uninvited quote refused, landed cost and scores checked by hand (95.69 vs 79.5), override reason required, award drafts the PO at the quoted rate
- Totals: **55 API + 4 contract tests passing**. Typecheck and production build clean.
- Browser run passed: the purchase executive opened the approved requisition, chose "Request quotes", invited two vendors, issued the RFQ and keyed in both quotations. The cheaper Gujarat quote (₹59.25/kg) carried ₹9,000 freight and a 21-day lead time, so it landed at ₹62.85 and ranked second; the Maharashtra quote (₹61.50, 7 days) was recommended and awarded. The drafted PO (₹1,81,425) went to the purchase head and finance head, was issued, acknowledged and printed; the requisition closed as fully ordered. No browser errors; no horizontal scroll at phone width.

### Changed during this part
- Cards without inner padding now pad their title (the "Products"/"Items" cards on quotation, order and requisition pages had the title flush to the edge).
- Status badges for Issued, Acknowledged, Lapsed, Awarded and receipt statuses.

### Not built yet
- **PO amendment with re-approval (PUR-007)**: for now cancel and re-raise before receipt.
- **Emailing RFQs and POs to vendors**: needs the email integration; print/PDF for now.
- **Single-source purchase with retrospective approval beyond the emergency flag (PUR-011)** and **budget checks (PUR-003)**: need D06 details.
- **Client input**: confirm the D06 bands and the D34 RFQ weights; both are settings, no code change needed.

## Part 3 — Goods receipt, quarantine, QC lot release and the stock ledger (BRD p.14–15; MP §10.5, Parts 11 and 13; PUR-008, TC-09)

| Area | What works | RTM |
|---|---|---|
| Goods receipt | Number `GRN/2026-27/000001`. "Receive goods" on an issued, acknowledged or partly received PO (a **lapsed** PO is refused until purchase re-issues it). Challan number and date, vendor invoice number, vehicle, remarks; per PO line the challan quantity and the **counted** quantity (a difference is flagged), the vendor batch, manufacturing and expiry dates | PUR-008 |
| Receipt checks | Cumulative receipts may exceed the ordered quantity by at most the tolerance (setting `purchase.grn.overReceiptPct`, D06 default 2%). A vendor batch is required for lot-controlled items. Expiry is derived from the manufacturing date and the item's shelf life when not given; material already expired is refused. Drafts can be edited or cancelled; a posted receipt is corrected by a supplier return (part 4) | PUR-008, TC-09 |
| Posting into quarantine | Each line becomes a **lot** (`LOT/2026-27/000001`) held in the **quarantine** bucket of the receiving warehouse, valued at the PO net rate, with a QC inspection (`QCI/2026-27/000001`) created and QC analysts and managers notified. The PO moves to Partly received or Received | INV, QC |
| Stock ledger | Append-only (`inv.stock_ledger`, updates and deletes refused by the database). Buckets: quarantine, unrestricted (released, usable), blocked (QC hold), rejected. Balances are sums of the ledger, never stored totals | INV |
| QC sampling | The analyst draws the sample; its quantity is taken out of quarantine stock (0 for a non-destructive test) | QC |
| QC results | Parameters, specification, result and pass/fail per test (pre-filled from the item's last inspection), the vendor's certificate of analysis (uploaded to the inspection), and the analyst's recommendation. A failed test cannot be recommended for release | QC |
| QC decision (BRD p.15) | A **QC manager decides — never the analyst who recorded the results**. Release needs every test passed **and** the CoA received; the lot moves to unrestricted stock. Reject (reason required) moves it to rejected stock for return. Hold (reason required) blocks it until a later release or rejection | QC, doc 07 §6 |
| Vendor rating | Recalculated at each release or rejection from the vendor's last 20 decided lots: 70% QC acceptance, 30% on-time delivery (received on or before the PO delivery date), on a 0–5 scale. It feeds the RFQ comparison's quality score | MDM-011, PUR-014 |
| Short close | A partly received PO's balance can be closed with a reason when no more deliveries are expected (not while a draft receipt is open) | PUR-007 |
| Stock & lots | Balances per item and warehouse by bucket with the value of released stock and the nearest expiry; lot register with QC status and on-hand; lot page with full **genealogy** (vendor, vendor batch, PO, receipt, inspection, decision) and every movement | INV, traceability |
| Access | Storekeepers and the stores head receive and post; QC analysts sample and test; QC managers and the QC head decide; purchase, finance, plant, production, QA and management view what they need | SEC-010 |

### Evidence
- `apps/api/test/receipts-qc.test.ts` has 2 tests:
  - receipt: open lines, tolerance (2,551 kg refused against 2,500 + 2%), batch required, expired material refused, sales refused; posting into quarantine; lot genealogy and expiry from the shelf life; sampling reduces quarantine; failed results cannot be recommended for release; the analyst cannot decide; release refused without the CoA; release moves the stock and rates the vendor 5.0; the remaining quantity within tolerance completes the PO; the ledger refuses deletion
  - rejection to rejected stock (reason required, rating 1.5), hold to blocked and later release (rating 3.3, calculated by hand), short close of the PO balance
- Totals: **57 API + 4 contract tests passing**. Typecheck and production build clean.
- Browser run passed end to end on top of the part 1 and 2 runs: the storekeeper opened the acknowledged PO, chose "Receive goods", entered challan 1,500 kg and a counted 1,498.5 kg (flagged as different), the vendor batch and the manufacturing date, saved and posted into quarantine. The QC analyst drew a 0.5 kg sample, recorded zinc, moisture and lead results, attached the CoA and recommended release; the QC manager released the lot. Stock shows 1,498 kg released; the lot page shows its genealogy and the four movements; the PO is partly received. No browser errors.

### Changed during this part
- Tests drain the notification outbox fully before checking (a single relay call handles 100 events, and more modules now emit events).
- Side-panel key-value cards use a single column.

### Not built yet
- **Supplier returns and debit notes** for rejected stock, and the **three-way match** of supplier invoices: part 4.
- **Specification master with versioned limits** (QC enters specifications per inspection for now, pre-filled from the last one): Stage 5.
- **Quarantine-lock override** (QC head + plant head, automatic deviation, D33) and **issue of stock to production**: with production (Stage 4) — nothing can consume quarantined stock today because no issue transaction exists yet.
- **Separate quarantine store location / bin management**: quarantine is a stock status in the receiving warehouse for now.
