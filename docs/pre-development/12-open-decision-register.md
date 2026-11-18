# 12 — Open Decision & Conflict Register

Covers MP §1.1, P2 §5 and P7 §6. **Nothing here has been decided.** Each entry gives a recommendation for the client to accept or change. IDs D01–D12 keep their P2 numbering.

Priority: **P0** blocks the start of the build (Stage 1/2) · **P1** blocks the stage shown · **P2** can be decided during development.

## 1. Decision register

| ID | Pri | Decision required | Options | Recommendation | Owner | Blocks | Status |
|---|---|---|---|---|---|---|---|
| D00 | P0 | Supply the original BRD v2.4 (20 pages) so every clause can be traced | — | Supply it now; WP-00 reconciles it into the RTM | ERP/IT owner | RTM freeze | Open |
| D01 | P0 | Sales order approval routing | 1 Sequential (BRD chain) · 2 Conditional by value/discount/credit · 3 Hybrid (conditional + notify skipped tiers) | **Option 3** (doc 07 §5.1) | MD, Sales Head | Stage 2 | Open |
| D02 | P0 | Finance model | A Native accounting · B ERP subledgers + external accounting | **B**, integrated with the client's current accounting system, unless the client wants to retire it. Which system is used today? | Finance Head, MD | Stage 2/6 | Open |
| D03 | P1 | Production model | Make-to-stock · make-to-order · hybrid | Hybrid: MTS for standard SKUs, MTO for contract/bulk orders | Plant Head | Stage 4 | Open |
| D04 | P0 | Who dispositions **raw-material lots**, and who releases **finished goods** | RM: QC Manager or QA; FG: QA Head only or delegated QA Managers | RM: QC Manager (QA can override with a hold); FG: QA Head + named delegated QA Managers per plant | QC Head, QA Head | Stage 3 | Open |
| D05 | P0 | Stock controls | Bin-level vs warehouse-level; FEFO vs FIFO; valuation weighted-average vs FIFO; who approves adjustments and at what value | Bins in FG and RM warehouses; FEFO for expiry items, FIFO otherwise; weighted average; SH < ₹25k, FH above (values to set) | Stores Head, FH | Stage 3 | Open |
| D06 | P1 | Purchase approvals, tolerances, emergency procurement | Value bands; qty ±%; price ±% | Bands as in doc 07 §6; qty +2% / −0%, price ±0.5%, emergency PO with review within 3 days | Purchase Head, FH | Stage 3 | Open |
| D07 | P1 | Dealer KYC per constitution; security cheques; director KYC | Universal vs conditional | Conditional matrix (§3 below); cheques only for credit dealers above a limit | Sales Head, FH, Compliance | Stage 2 | Open |
| D08 | P1 | Statutory obligations: FCO/bio-stimulant categories, Insecticides Act licences, GST e-invoice applicability, e-way bill rules, hazardous transport, ISO 9001 revision | — | Client's regulatory/tax adviser confirms. The system keeps everything configurable and makes no compliance claim | Compliance, FH | Stage 2/6 | Open |
| D09 | P1 | Mobile: PWA vs Android app; scanner hardware; offline need per site | — | PWA + keyboard-wedge rugged scanners; device pilot in Stage 3; Capacitor wrapper only if needed | IT, Stores Head | Stage 6/7 | Open |
| D10 | P1 | Legacy sources, opening balances, cutover date | — | Inventory the systems in WP-00; cut over at the start of a month (ideally 1 April) | IT, FH | Stage 8 | Open |
| D11 | P2 | Notification channels, WhatsApp provider, escalation timings | — | In-app + email in Pilot; WhatsApp in Core | EA | Stage 7 | Open |
| D12 | P0 | First-release scope | Option A Pilot · B Integrated Core · C Enterprise | **B**, starting with the Pilot slice at one site (doc 11 §3) | MD | SOW | Open |
| D13 | P0 | Build vs adapt (P7 §10) | Full custom build · configure an existing ERP (Odoo, ERPNext, SAP B1, etc.) + extensions | Run a 3–4 week fit-gap assessment **before** committing to a custom build. This package assumes a custom build because the MP specifies one | MD, ED | Everything | Open |
| D14 | P0 | Mapping of the BRD's four executive administration positions onto the controlled model (doc 07 §2) | — | 1 Super Admin, 2 Executive Admins (MD, ED), 1 Security Admin; break-glass needs 2 of them | MD | Stage 1 | Open |
| D15 | P1 | Activate the authority limits in MP§4.4 as-is? | — | Activate as-is; review after 3 months of data | Sales Head, MD | Stage 2 | Open |
| D16 | P1 | Quotation validity default and revalidation | 7 days (BRD) or another value; revalidation by owner or approval | 7 days default, per-quote override up to 30 days; revalidation without price change by the owner, with price change via approval | Sales Head | Stage 2 | Open |
| D17 | P1 | Which order fields are **material** (amendment resets approvals) | — | Qty ↑, price ↓, discount ↑, product, payment terms, ship-to state (tax change) = material. Delivery date, remarks, ship-to within the same state = non-material | Sales Head, FH | Stage 2 | Open |
| D18 | P1 | Credit exposure formula; hold vs exception; overdue rule | — | Formula in doc 04 §4.10; block if overdue > credit days + 15; exception by FH up to 110% of the limit, above that MD | FH | Stage 2 | Open |
| D19 | P1 | Frontend framework | Vite SPA (MP) · Next.js (UI prompt) | **Vite SPA** (doc 03 AD-05) | IT | Stage 1 | Open |
| D20 | P0 | UI: supply the reference screenshot; approve the ERP departures U1–U8 (doc 10 §10) | — | Approve doc 10 together with a clickable prototype in WP-00 | MD, IT | Stage 1 | Open |
| D21 | P1 | Cloud region, availability, RPO/RTO, retention | — | AWS ap-south-1; 99.5% business hours; RPO 15 min; RTO 4 h | IT | Stage 1 | Open |
| D22 | P1 | Identity: built-in vs managed IdP; MFA factors | — | Built-in + TOTP; OIDC SSO later if the client uses Google Workspace/M365 | IT | Stage 1 | Open |
| D23 | P2 | KPI formulas, targets, refresh rates | — | KPI dictionary workshop in Stage 6 | Management | Stage 7 | Open |
| D24 | P1 | Serialisation level and label hardware; public verification fields | Box only · box + unit · pallet | Box level (BRD); unit level later; public page shows product, pack, batch, mfg/expiry, genuine flag | Plant Head, IT | Stage 4 | Open |
| D25 | P1 | Data retention, privacy (DPDP Act 2023), KYC document storage, Aadhaar handling | — | Avoid storing Aadhaar numbers (masked/last-4 only); retention schedule per document type, confirmed by an adviser | Compliance | Stage 1 | Open |
| D26 | P0 | Real company structure: legal entities, GST registrations, plants, warehouses (the BRD warehouse list) | — | Provide the list in WP-00 | MD, Stores | Stage 1 | Open |
| D27 | P1 | Tax master ownership; GSP provider | — | FH owns HSN/rates; select the GSP in Stage 2 | FH | Stage 6 | Open |
| D28 | P1 | Document number formats and FY reset | — | `TYPE/ENTITY/FY/######`, reset each 1 April | FH | Stage 1 | Open |
| D29 | P2 | UI languages | English only · + Hindi/Marathi | English for Core; i18n-ready strings | MD | — | Open |
| D30 | P2 | Beat/travel expense capture in scope? | — | Defer to Enterprise | Sales Head, FH | — | Open |
| D31 | P2 | Dealer self-service portal (dealers log in) | — | Out of Core; candidate for Enterprise | Sales Head | — | Open |
| D32 | P2 | Production costing method | Standard vs actual | Actual material + standard conversion cost | FH, Plant Head | Stage 4 | Open |

## 2. Conflicts found between sources

| # | Topic | Source A | Source B | Proposed resolution | Decision |
|---|---|---|---|---|---|
| X01 | Admin model | BRD: four main admins (implied bypass) | MP§4.2: no unrestricted bypass | Four positions kept; controlled model | D14 |
| X02 | Order routing | BRD: sequential SE/TSM→…→ZSM→Accounts→Warehouse | P1 §5, P7 SAL-003: conditional | Hybrid | D01 |
| X03 | Stock states | BRD: Available / Quarantine / Reserved (exclusive) | P1 §5, MP§11.2: separate dimensions | Three dimensions + reservation overlay (doc 04 §4.6) | D05 |
| X04 | KYC | BRD: three cheques, five director KYC | P1 §6, MP§6.1: conditional | Conditional matrix (§3) | D07 |
| X05 | Quotation/PO validity | BRD: 7 days | P1 §6: a policy, not a statute | Configurable | D16 |
| X06 | GSTIN | BRD: "15-digit" | P1 §6: 15 alphanumeric | Alphanumeric regex + checksum | — (correction) |
| X07 | OEE | BRD formula (output/planned) | P1 §6: A × P × Q | A × P × Q; output/planned relabelled "Capacity utilisation" | D23 |
| X08 | Mobile packaging | BRD: APK via URL parameters | P1 §6 | PWA / packaged app after device test | D09 |
| X09 | Frontend framework | MP§3.1 Vite | UI§40 Next.js | Vite | D19 |
| X10 | UI layout density | UI prompt (spacious, profile panel always visible) | MP§2.1 (multi-item editors, data-heavy) | Density modes and collapsible panel | D20 |
| X11 | SO status set | MP§9.4 (Under Review …) | P4 §4 (Commercial Review, Credit Review …) | Harmonised (doc 05 §12.1) | — |
| X12 | QC/QA build order | MP Stage 4 Production then Stage 5 QC/QA | MP Stage 5 note + P5 risk "QC/QA bypass" | Gates move into Stages 3–4 (doc 11 §1) | — |
| X13 | ISO reference | BRD: ISO 9001:2015 | P1 §6: confirm the current revision | Adviser confirms | D08 |
| X14 | Sales submodule count | BRD: 18 | MP lists 17 by name | Confirm against the BRD | D00 |

## 3. Proposed conditional KYC matrix (for D07)

| Constitution | Mandatory | Conditional |
|---|---|---|
| Proprietorship | PAN of proprietor, GSTIN (if registered), address proof, cancelled cheque/bank proof, photo ID of proprietor | Shop & establishment registration |
| Partnership firm | Firm PAN, partnership deed, GSTIN, KYC of authorised partner(s), bank proof | KYC of all partners if the credit limit > threshold |
| LLP | LLP PAN, LLPIN/incorporation certificate, GSTIN, designated partner KYC, bank proof | — |
| Private / Public Ltd | Company PAN, CIN/incorporation certificate, GSTIN, board resolution/authorisation, KYC of authorised signatory, bank proof | KYC of up to 5 directors (BRD) if credit limit > threshold or policy requires |
| All (product-based) | Fertilizer licence if selling fertilizer categories; pesticide/insecticide licence if selling pesticide categories; bio-stimulant registration as applicable (D08) | — |
| All (credit-based) | — | Security cheques (BRD: 3) only for credit dealers above the approved threshold |

## 4. Change control (P7 §6)

After approval, every change records: original requirement · proposed revision · rationale · affected modules/screens/APIs/tests · schedule and cost effect · approver and date. Verbal changes during demonstrations are not accepted.
