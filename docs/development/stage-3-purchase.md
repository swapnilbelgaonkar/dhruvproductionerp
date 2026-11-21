# Stage 3 — Supply: progress report

Order follows D12 (business flow). Stage 3 parts:

1. Vendor onboarding and purchase requisitions — **done** (this report)
2. RFQ, comparative statement and purchase orders (D06 value bands, PO acceptance validity)
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
- **Client input**: D06 (purchase value bands and tolerances) — defaults from doc 07 §6 will be used in part 2 unless you change them.
