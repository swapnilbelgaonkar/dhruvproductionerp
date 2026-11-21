# Stage 2 — Sales: progress report

Order follows D12 (business flow). Stage 2 parts:

1. Dealer onboarding — **done**
2. Leads, BANT, opportunities and activities (CRM) — **done**
3. Pricing, quotations — **done**
4. Sales orders with hybrid approval (D01) — **done**

## Part 1 — Dealer onboarding (BRD §3.1 p.7–8, MP Part 6)

| Area | What works | RTM |
|---|---|---|
| Registration | Auto code `DLR-2026-0001` (BRD p.8). Captures legal and trade name, constitution (incl. FPO), contact, mobile, PAN, GST status and GSTIN, category, territory, sales owner, licence types the dealer will buy, credit limit and days, price group, annual target and FY | DLR-001, DLR-015 |
| Tax identity | GSTIN check digit, GSTIN characters 3–12 = PAN, GSTIN state = registered address state | MDM-007 |
| Duplicates | Same GSTIN or PAN blocked (409). Mobile number reported as a possible duplicate while typing | DLR-011, TC-02 |
| Same-line GST certificate | The certificate upload sits on the GSTIN row (BRD p.7) | DLR-013 |
| Addresses | Registered and billing (replace the previous one), multiple shipping addresses | DLR-001 |
| Licences | Fertilizer, pesticide and bio-stimulant licence: number, issuer, validity and certificate (in the vault). A new licence supersedes the old one (renewal) and must be verified again | DLR-004, DLR-014 |
| Signatories | Proprietor, partners and directors with ID proof. Only the last 4 characters of an ID number are stored (D25, X26) | DLR-003 |
| KYC rules (D07 pending) | Data-driven table. Setting `dealer.kyc.policy` = `CONDITIONAL` (recommended: cheques only for credit dealers, 5 directors only for companies above ₹5 L credit) or `BRD_STRICT` (3 cheques and 5 directors for every dealer). Switching needs no code change | DLR-002/003 |
| Onboarding checklist | Live checklist on the dealer page. Submission is refused until every item is complete | DLR-001 |
| Approval chain | Document verification → Commercial review (initiator's reporting manager) → Finance & credit → Final sales approval (RSM/ZSM/DSM/NSM/BH). A credit limit above ₹10 L goes to a director instead (BRD p.7) | DLR-005, MP §6.2 |
| Licence verification gate | The verification step cannot be approved until every licence is verified. The person who entered a licence cannot verify it | DLR-005, SOD |
| Suspension / reactivation | With a reason, by Finance or Executive admin; it blocks eligibility immediately | DLR-007 |
| Eligibility check | `dealerEligibility()`: dealer active and every needed licence present, verified and valid on the date. Quotations and orders will call it | DLR-008, BR-11, TC-03 |
| Expiry alerts | Hourly scan; alerts at 60 days, 30 days and on expiry (setting `licence.alertDays`) go to the sales owner and document verifiers, each once | DLR-008 |
| Territory scope | Sales users see only dealers in their own territory subtree; managers see their whole area. Applies to lists, details, search and documents | SEC-011 |
| Sensitive KYC | Cheques, ID proofs, PAN and bank proof open only for users with `mdm.dealer:view_sensitive` (verifier, credit, finance, executive) | X26 |
| Demo data | `DEMO_PASSWORD=… pnpm db:seed -- --sample --demo-users` creates a [SAMPLE] RSM → TSM → SE hierarchy plus a verifier and a credit controller. Refuses to run in production | — |

### Evidence
- `apps/api/test/dealers.test.ts` has 6 tests:
  - the full chain to Active, including the licence gate and manager routing
  - duplicate and PAN mismatch
  - GSTIN state mismatch
  - territory scope and sensitive documents
  - BRD_STRICT switch
  - expiry alerts sent once
- Totals: **35 API + 4 contract tests passing**.
- A browser run also passed. The sales executive registered a dealer, added 3 addresses, uploaded the GST certificate on the GSTIN line, added a licence, a signatory and 6 KYC documents, then submitted. The verifier verified and approved, then the TSM, credit controller and RSM approved, and the dealer became Active.

### Fixed during this part
- A role grant that lists no legal entities was read as "no access", which hid employees from territory-scoped sales users. Now a grant restricts legal entities only when it lists at least one.
- The onboarding checklist did not refresh after a document upload.

### Not yet built (later parts or stages)
- Dealer 360° view (needs quotations, orders, invoices) — Stage 2 part 4 and Stage 6.
- Changing commercial terms of an active dealer (change request) — with master change requests.
- Credit exposure and overdue freeze — with invoices and receipts (Stage 6, D18).

## Part 2 — CRM: leads, BANT, opportunities, activities (BRD §4 sub-modules 1–5, MP §7.1–7.5)

| Area | What works | RTM |
|---|---|---|
| CRM summary | Open and qualified leads, overdue follow-ups, 90-day conversion rate, open pipeline value and weighted value, won and lost this month, my activities due and overdue. All figures respect territory scope | CRM-002 |
| Leads | Code LEAD-2026-00001. Source (exhibition, IndiaMART, field visit, referral, dealer enquiry, website), requirement and expected quantity, owner, territory, next follow-up. An existing dealer with the same mobile is linked automatically | CRM-003 |
| Duplicates | A second **open** lead with the same mobile is blocked and the existing lead is named | CRM-004 |
| Ownership | Reassignment from ASM upward (BRD p.3 "lead allocation") with a reason; the new owner gets a notification; the history stays in the audit log | CRM-005 |
| BANT | Budget 25 + Authority 25 + Need (1–5 × 5) + Timeline (≤90 days 25, ≤180 days 15, ≤1 year 5). Qualifying needs the score in setting `crm.bant.qualifyScore` (default 60). Disqualifying needs a reason | CRM-006 |
| Conversion | A qualified lead converts to an opportunity; the two are linked both ways | CRM-007 |
| Pipeline (Kanban) | Requirement → Sample/Trial → Quote sent → PO expected → Won/Lost (X19 resolved). Cards move by drag-and-drop or a keyboard-accessible "Move to" menu. Default win % per stage is a setting. **Won** needs a registered **active** dealer; **Lost** needs a loss reason. Every move is kept in an append-only stage history. Closed opportunities can be reopened from RSM upward, with a reason | CRM-007 |
| Activities | Call, meeting, dealer visit, field visit, agronomist discussion, follow-up, task. Each is recorded as done (outcome required) or planned. Visits capture GPS when the browser allows it. Completing a planned activity can schedule the next one. A done activity moves a New lead to Contacted. My activities shows overdue, today and upcoming; only the owner can complete or cancel | CRM-008 |
| Access | Territory scope on leads, opportunities and activities (lists, details and search). Sales tiers create and edit; ASM+ reassign; RSM+ reopen; Management Viewer read-only | SEC-011 |

### Evidence
- `apps/api/test/crm.test.ts` has 4 tests:
  - BANT scoring
  - the full lead → opportunity → won-blocked → won → reopen → lost cycle
  - territory isolation and reassignment with notification
  - planned activity → complete with next action, owner-only
- Totals: **39 API + 4 contract tests passing**.
- A browser run also passed. The SE created a lead, logged a call, scored BANT at 90, qualified it and converted it. In the pipeline the SE moved the opportunity, saw "won" refused without a dealer, and recorded a loss to a competitor. The SE then completed a planned visit and scheduled the next action. The RSM sees the leads of the whole area.

### Not yet built in Stage 2
- Remaining sales sub-modules: samples, field trials, targets, competitor intelligence, beat plans, contracts, outstanding recovery, executive analytics, exports — later Stage 2 increments, after orders and invoices.

## Part 3 — Pricing and quotations (BRD §4 #9, §5.1 p.13; MP §7.7, Part 8)

| Area | What works | RTM |
|---|---|---|
| Price lists | One list per dealer price group (the `price group` on each dealer, default STANDARD), with a start date and an optional end date. The rate is per pack, before GST. Up to 10 volume slabs per pack (for example, 20+ packs 5% off); the best slab reached applies | CRM-010 |
| Price approval | A price list is a Draft until submitted. The sales head (BH or NSM) and then the finance head approve it (policy `sales.price_list`, editable in Approval Policies). An active list cannot be edited | CRM-010 |
| Price revision | "Copy as new version" copies every price and slab into a new Draft. The new list must start later than the active one. When it is approved, the old list automatically ends the day before. A list that would start on or before the active one is refused | CRM-010 |
| Who manages prices | Sales operations, NSM and BH create and submit lists. Finance, accounts, credit and management can view them. Sales tiers see them through quotations | SEC |
| Quotation | Number `QT/2026-27/000001` with revision R1, R2 …. Header: dealer, issuing legal entity, bill-to (registered or billing address), ship-to (any active dealer address), date, contact, payment and delivery terms (defaults from settings), notes and an optional linked opportunity. Up to 100 lines; each pack can appear once | QUO-001 |
| Server-side pricing | The browser sends only pack, quantity and extra discount. The server takes the list rate from the dealer's active price list on the quotation date, applies the slab scheme and then the extra discount, and takes the GST rate from the HSN on that date. If any of these is missing, it stops with a clear message (`NO_PRICE`, `NO_TAX_RATE`). Amounts are in whole paise, so they do not drift | QUO-002 |
| GST split | Seller state = the legal entity's state; place of supply = the ship-to state. If they are the same, CGST and SGST are each half the rate; otherwise IGST. The total is rounded to the rupee and the round-off is shown. The amount is also given in words (Indian numbering) | QUO-002, D27 |
| Dealer eligibility | Only an active dealer with a valid, verified licence for every licensed product category on the quotation can be quoted. The live preview warns; saving and submitting refuse | DLR-008, BR-11 |
| Validity | Quotation date + setting `sales.quotation.validityDays` (7, BRD p.13). An hourly job expires Approved or Sent quotations after their validity date. An expired quotation must be revised, which re-prices it and needs approval again | QUO-004, D16 |
| Discount approval | Policy `sales.quotation`. With no extra discount, the quotation is approved when submitted. With an extra discount, while authority limits are inactive (D15), the initiator's reporting manager approves. Once D15 activates the limits, the quotation is approved directly if the discount is within the initiator's own tier limit; otherwise the authority ladder applies (the lowest covering tier, with skipped tiers notified). This needs only a policy change, not new code | QUO-006, D01, D15 |
| Actions | Edit (Draft/Rejected), Submit, Mark as sent, Record acceptance, Revise (same number, next revision; the old revision becomes Superseded and stays readable), Duplicate (new number), Cancel with a reason, Print. Every change is in the audit log | QUO-003, QUO-005 |
| A4 print | Company header with GSTIN for the seller's state and PAN, bill-to and ship-to with GSTIN, place of supply, itemised lines (list rate, scheme, extra discount, net rate, taxable value, GST % and amount, CGST+SGST or IGST), totals, amount in words, terms, bank details (setting `company.bankDetails`) and a signature block. Quotations not yet approved print with a "not a valid offer" banner. "Print or save as PDF" uses the browser | QUO-007 |
| Links | From an open opportunity linked to a dealer, "Create quotation" pre-fills the dealer and the link. Quotations and price lists appear in global search and in approval links | CRM-007 |
| Access | Quotations follow the dealer's territory (territory scope, as for dealers and leads). Sales tiers and sales operations create, edit, submit, send and cancel. Finance, accounts, credit and management can view | SEC-011 |

### Evidence
- `apps/api/test/calc.test.ts` has 5 tests: the intra-state and inter-state splits, rupee round-off, no paise drift over many lines, slab selection, and amount in words.
- `apps/api/test/quotation.test.ts` has 3 tests:
  - price list: maker-checker approval, frozen once active, start date rule, and automatic close of the old list
  - quotation: no price, ineligible dealer, CGST/SGST maths, approval on submit with no extra discount, send, accept, print data, territory isolation
  - discount: an inter-state quotation with IGST, the concurrent-edit check, reporting-manager approval, revise, duplicate, cancel and expiry
- Totals: **47 API + 4 contract tests passing**. Typecheck and the production build are clean.
- A browser run also passed:
  1. Sales operations created a price list with a volume slab and submitted it. The NSM and the finance head approved it.
  2. The sales executive quoted 24 × 1 L and 6 × 5 L. The 5% slab was applied, with CGST and SGST at 2.5% each and a ₹0.40 round-off. Submitting approved it at once. The executive marked it sent and printed it to PDF.
  3. The executive duplicated it, changed the ship-to to Karnataka (IGST) and gave a 3% extra discount. The TSM approved it, and the executive revised it to R2.
  4. No browser errors, and no horizontal scroll at phone width.

### Changed during this part
- `DATE` columns are now returned as plain `YYYY-MM-DD` strings. Before, a server running in IST could shift a business date by one day.
- The generic master lifecycle gained an `onActivated` hook (used by price lists to close the older list).
- New [SAMPLE] demo users: `nsm@`, `ops@` and `finance@demo.local`.

### Not built yet (and why)
- **Convert to sales order**: done in part 4.
- **Email to dealer**: needs the email integration (doc 09). For now the PDF comes from the browser's print dialog.
- **Revision diff view**: every revision is kept and linked, but a side-by-side diff is not shown yet.
- **Contract prices, promotional schemes and price exceptions** (rest of CRM-010): later, with the schemes sub-module.
- The opportunity stage does not move to "Quote sent" automatically when a quotation is sent. It is still moved by hand.
- **Client inputs still needed**:
  - GST rates for each HSN code (D27). Finance enters them in *HSN & GST Rates*. Without a rate, a product cannot be quoted.
  - The GSTIN of each legal entity, for the print header.
  - The bank details setting.

## Part 4 — Sales orders with hybrid approval (BRD §4 #10, §5.2; MP Part 9; D01)

| Area | What works | RTM |
|---|---|---|
| Two ways in | **Convert** an Approved, Sent or Accepted quotation that is still valid ("Convert to sales order" on the quotation), or enter a **direct order** for an active dealer. Number `SO/2026-27/000001` | SO-001, SO-002 |
| Price lock | A converted order keeps the quotation's rates, slab schemes and extra discounts, even if the price list changes afterwards. GST is applied at the rate in force on the order date. Its products, dealer and addresses are locked; the order details can still be edited. A direct order is priced from the dealer's active price list, exactly like a quotation | SO-002, QUO-002 |
| One order per quotation | A quotation converts once and becomes **Converted**, linked both ways. If that order is cancelled, the quotation returns to **Accepted** and can be converted again while it is still valid | SO-002 |
| Order details | Order date (today or earlier; fixed once saved), required-by date, dealer PO number and date, terms, notes, contact. Dealer eligibility (active, verified licences) is checked on save and again on submit | SO-001, DLR-008 |
| D01 hybrid approval | Policy `sales.order`: commercial approval by the **lowest tier in the initiator's chain** that covers both the order value and the highest extra discount (skipped tiers get a for-information copy), then **accounts review** (accounts executive, credit controller or finance head) | SO-004, D01 |
| While D15 is parked | Tier limits are not active yet, so the commercial step goes to the initiator's **reporting manager**. This is a new option on the ladder step (`whenLimitsInactive: reporting_manager`). Once limits are activated, the ladder applies with no code change. The policy simulator already shows the post-activation route, with a warning | D15 |
| Credit check | At submission the order records the dealer's credit limit, other open orders (Submitted or Approved) and the resulting exposure. **Over the limit**, a third step is added: *credit limit override* by the finance head. A dealer with no credit limit and no credit days is treated as **advance payment** (no override; accounts confirm payment). Outstanding invoices join the exposure once invoicing exists (Stage 6, D18) | SO-004, D18 |
| Actions | Edit (Draft/Rejected), Submit, Cancel with a reason (Draft, Rejected, Approved — until dispatch exists), Print. Every change is audited | SO-003 |
| A4 order acknowledgement | Same layout as the quotation, titled SALES ORDER, with order date, required-by date, dealer PO and the source quotation. Orders not yet approved print with a "not an approved order" banner | SO-009 |
| Dealer page | Active dealers show their recent quotations and orders, with "New quotation" and "New order" shortcuts (the first part of the dealer 360° view) | DLR-010 |
| Access | Territory scope as for quotations. Sales tiers and sales operations create, edit, submit and cancel; accounts, credit, finance and management view. Orders appear in global search (number, dealer or dealer PO) | SEC-011 |

### Evidence
- `apps/api/test/orders.test.ts` has 2 tests:
  - conversion: the price list changes after the quotation but the order keeps the quoted rate; the quotation becomes Converted and cannot convert twice; locked lines refused, header edits allowed; reporting manager then accounts approval; territory isolation; cancel returns the quotation to Accepted and it converts again
  - direct order: future date refused; the second open order takes the dealer over a ₹6,000 limit, so the finance head override is added and all three steps approve it; an approved order cannot be edited; an advance-payment dealer is not flagged
- Totals: **49 API + 4 contract tests passing**. Typecheck and the production build are clean.
- A browser run also passed:
  1. The sales executive converted the sent quotation QT/2026-27/000001 with the dealer's PO number, added a required-by date (products shown locked) and submitted it. The TSM (reporting manager) and the credit controller approved it, and it printed as a sales order.
  2. The executive entered a direct order of 450 × 5 L cans (₹5,43,375). With ₹13,122 already open against a ₹5 lakh limit, the order was flagged over the limit and the finance head override step was added.
  3. The dealer page lists both quotations and both orders. No browser errors, and no horizontal scroll at phone width.

### Changed during this part
- The quotation editor became a shared sales-document editor (quotations and orders), and every header field now updates state safely; a fast click sequence could previously lose the default bill-to address.
- The documents panel no longer fails on a document without a stored file version.

### Not built yet (and why)
- **Stock availability** in the accounts review: needs inventory (Stage 4).
- **Dispatch, partial dispatch and short-close**: Stage 5 (logistics). Lines already carry a dispatched quantity for it.
- **Receivables in the credit exposure** and the overdue-dealer freeze: Stage 6 (D18).
- **Order amendment after approval**: for now, cancel and re-enter (or revise the quotation).
- **Activating tier limits (D15)** is a business decision; when made, quotation and order routing switch to the authority ladder automatically.
