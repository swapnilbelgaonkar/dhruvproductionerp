# Stage 3 — Supply: progress report

Order follows D12 (business flow). Stage 3 parts:

1. Vendor onboarding and purchase requisitions — **done**
2. RFQ, comparative statement and purchase orders — **done**
3. Goods receipt with quarantine, QC sampling and lot release, stock ledger
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
- **Goods receipt, quarantine and QC release**: part 3 (lines already carry a received quantity).
- **Emailing RFQs and POs to vendors**: needs the email integration; print/PDF for now.
- **Single-source purchase with retrospective approval beyond the emergency flag (PUR-011)** and **budget checks (PUR-003)**: need D06 details.
- **Client input**: confirm the D06 bands and the D34 RFQ weights; both are settings, no code change needed.
