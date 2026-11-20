# Stage 2 — Sales: progress report

Order follows D12 (business flow). Stage 2 parts:

1. Dealer onboarding — **done** (this report)
2. Leads, BANT, opportunities and activities (CRM)
3. Pricing, quotations
4. Sales orders with hybrid approval (D01)

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
