# 14 — BRD v2.4 Reconciliation & UI Reference Check

**Inputs received:** `docs/source/BRD-DHRUV-ERP-2026-V2.4.pdf` (20 pages; text copy `.txt`) and `docs/source/ui-reference-dashboard.webp`. These close **D00** and the screenshot part of **D20**.

Page numbers below are the BRD's printed page footers.

## 1. What the BRD changes in this package — summary

| # | Finding | Effect on the package |
|---|---|---|
| 1 | **The BRD carries a completed sign-off matrix** (p.2): MD, ED, VP Sales & Marketing, QA Head, Plant Head and Finance Head, dated 15–17 Nov 2026 | RTM rows of class **O** move from `Pending` to **`Baseline (BRD v2.4 signed)`**. Corrections, additions and conflicts stay `Pending`. **Not signed:** QC Head (only "QA & QC Head" on v2.2), Purchase, Stores/Logistics, ERP/IT. Their areas still need sign-off (P6 §10). |
| 2 | **The exact list of 18 Sales sub-modules** is given (p.10–11). Sub-module 7 is *9-Tier Hierarchy Rights Governance*, not the quotation desk I had assumed | Doc 02 M03 corrected; conflict X14 closed; new row CRM-021 |
| 3 | **The exact list of 16 Production sub-modules** is given (p.18) and differs from my reconstruction (adds Plant Operations Calendar, Loss/Waste/Scrap, Recycle & Rework, FG Stock Transfer, Production Reports & Audits, Plant & Line Settings) | Doc 02 M07 replaced |
| 4 | **The exact list of 6 QC sub-modules** is given (p.15): Testing & CoA Register, Strict Quarantine Lock, Specification & Method Master, OOS/OOT, Instruments & Calibration, QC Hierarchy Governance | Doc 02 M08 replaced |
| 5 | **D04 is answered:** the QC Manager releases quarantined material with an approved CoA; the QA Head is the final FG release authority (p.4, p.15, p.16) | D04 → *Answered by BRD*; doc 07 updated |
| 6 | **A new override path:** "Overrides [of the quarantine lock] require dual authorization from QC Head and Plant Manager" (p.15) | New conflict X15 / decision D33 |
| 7 | **The four admins are named and their powers listed** (p.3). MFA = WhatsApp OTP + 2FA PIN | D14 mapping updated; WhatsApp OTP added to D22 as a security concern (X16) |
| 8 | **PO release above ₹10,00,000 belongs to the Executive Director** (p.3) | Doc 07 PO band corrected (ED, not MD) |
| 9 | **Credit rules** (p.7, p.19): exceeding the credit limit needs *director approval*; invoices older than the credit days *freeze order-taking automatically*; overdue > ₹10 L shows red on the dashboard | D18 answered by the BRD (replaces my "credit days + 15" proposal) |
| 10 | **Licence and document expiry:** alerts 60 days before expiry; expired fertilizer licence blocks billing, expired pesticide licence blocks agrochemical billing; vault badges at 60 / 30 / expired (p.7, p.19) | DLR-008 aligned to 60/30/expired; the block applies at order **and** invoice (MP adds the order-time check) |
| 11 | **Company structure** (p.13, p.18): plants Chakan Plant 1 and Baramati Unit 2; warehouses WH-01 FG Chakan, WH-02 RM Chakan, WH-03 PM Chakan, **WH-04 Central Lab Chemicals Hyderabad** | D26 mostly answered. New question D36: Hyderabad is in Telangana, so it likely needs its own GST registration, and transfers from Chakan are inter-state supplies needing a tax invoice and e-way bill. No warehouse is listed for Baramati |
| 12 | **Finance is a subledger model** (p.19: "independent ledgers for every dealer, vendor and transport partner", GST ITC vs output summary). No general ledger is described | Supports D02 = **Model B**; the external accounting system still has to be named |
| 13 | **AWS plan** (p.20) names **React/Vite SPA**, Node.js/Express containers, ECS Fargate (2–8 instances), RDS PostgreSQL Multi-AZ, S3, **ElastiCache Redis** (sessions, OTP state, PDF queues), WAF + Shield, custom domain via Route 53/ACM, **99.95% uptime** | D19 closed (Vite: BRD + MP agree). New conflicts X20 (Redis vs Postgres queue) and X21 (availability and scale targets) |
| 14 | **Quotation layout** (p.13): columns Sl No, Description, HSN/SAC, Pack Size, Qty, Rate, CGST %, SGST %, Amount; A4 print preview with corporate header, bank details, 7-day validity banner and signature blocks | No IGST or discount columns, although the BRD's own invoice engine supports IGST and its §4 #9 controls discounts. Conflict X18; resolved by showing IGST for inter-state supply and a discount column |
| 15 | **RFQ matrix "auto-selects the winning bidder"** (p.8) | Conflicts with MP §10.3. Conflict X17 / D34 |
| 16 | **Vendors and transporters** must also give 3 security cheques and 5-director KYC (p.8) | Folded into D07 (conditional KYC for all party types) |
| 17 | **Sample GST rates** in the product table (p.9) use a **12% slab** | GST slabs were rationalised in September 2025, and the 12% slab was largely removed. Every HSN rate must be confirmed by the tax adviser (D27). Rates stay configurable (MP Rule 3) |
| 18 | **Recall must trace and lock batches across the supply chain within 2 hours** (p.16) | New measurable requirement QA-016, tested in UAT-15 |

## 2. Section-by-section traceability

| BRD section (page) | Content | Package coverage (RTM IDs) | Status |
|---|---|---|---|
| Doc control & sign-off (p.2) | Versions v1.0–v2.4; six departmental approvals | §1 #1 above | Partially signed |
| Exec summary (p.2) | FCO, CIB&RC, ISO 9001:2015, GST split, 7-day validity, mass balance, box QR crypto, quarantine lock | Across the RTM; regulatory claims → D08 | Covered |
| 1.1 Four main admins (p.3) | MD, ED, Corporate Admin 03 & 04; unrestricted override; WhatsApp OTP + 2FA PIN | SEC-001/002/003, SEC-019/020 | X01, X16 |
| 1.2 Nine-tier hierarchy (p.3–4) | Tiers, jurisdiction, discount and value limits, per-tier permissions | ORG-001/003, APR-008, ORG-007, doc 07 §5.2 | Limits match MP §4.4 exactly |
| 1.3 Ops/QC/QA roles (p.4–5) | QC Analyst/Manager, QA Executive/Head, Store Manager, Plant Production Manager | Doc 07 §3, QC-005, QA-004, QA-017 | Covered |
| 2.1 KPI cards (p.6) | Six KPIs with formulas and thresholds | MIS-007 (new); KPI dictionary (D23) | OEE formula conflict X07 confirmed |
| 2.2 Pipeline funnel (p.6) | 5 stages, ending "Hierarchy Approved & Dispatched" | CRM-007 | Minor conflict X19 (4-stage Kanban vs 5-stage funnel) |
| 3.1 Dealer onboarding (p.7–8) | Field table for business, commercial, licences, documents, 3 cheques, 5 directors; same-line GSTIN + certificate; FPO constitution | DLR-001…015 | X04 confirmed; DLR-013/014/015 new |
| 3.2 Vendor master & RFQ (p.8–9) | CIB registration, manufacturing licence, same-line GST, cheques/KYC, RFQ matrix | MDM-011/016, PUR-004/005/014 | X17 |
| 3.3 Transporter (p.9) | SLA agreement + validity, permit + expiry, GST, cancelled cheque, fleet KYC | MDM-012/017 | Covered |
| 3.4 Product master (p.9) | SKU, trade name, formulation, category, pack, HSN, GST | MDM-008/009 | Rates need adviser check (D27) |
| 4 Sales Hub, 18 sub-modules (p.10–11) | Listed | CRM-001…021 | Covered after correction |
| 5.1 Quotation (p.13) | 7-day validity; re-approval after expiry; multi-item; headers; A4 print | QUO-001…007 | X05, X18 |
| 5.2 Invoice (p.13) | CGST+SGST intra / IGST inter; e-way bill fields; round-off | FIN-003, FIN-015, LOG-005 | E-invoice (IRN) not in the BRD; addition depends on D08 |
| 5.3 Sales order (p.13) | 7-step sequential chain; scanned dealer PO on letterhead; **every approver may edit quantities**; Accounts checks credit and stock | SO-001…011 | X02, plus new X22 (approver edits vs approval reset) and SO-011 (no route above ZSM limits) |
| 5.4 Procurement (p.13–14) | Multi-item PO; HSN after description; CGST/SGST columns; 7-day acceptance validity; 3-way match; A4 print | PUR-001…014 | PR not in the BRD (addition PUR-002 remains a proposal) |
| 5.5 Inventory (p.14) | WH-01…04; triple stock segregation; buffer alerts | INV-003/006/013 | X03 confirmed |
| 5.6 QC, 6 sub-modules (p.15) | Quarantine lock; 5 sample categories; STP master; OOS/OOT; calibration; SoD; CoA layout with signatures and seal | QC-001…013 | X15 |
| 5.7 QA, 17 sub-modules (p.16) | Listed; 2-hour recall; QA 3-tier rights | QA-001…018 | Covered |
| 5.8 Dispatch planning (p.17) | Queue by district and priority; vehicle/driver assignment | LOG-001/004 | Covered |
| 5.9 GRN (p.17) | Gate entry: DC no, vehicle gross/tare weight, package condition; automatic quarantine | INV-001/005/016 | INV-016 new |
| 5.10 Delivery note (p.17) | Loading slip: batch nos, bag counts, box QR; transport challan | LOG-010 | New row |
| 5.11 LR / POD (p.17) | Consignee/carrier copies; freight Paid / To-Pay / TBB; signed POD upload | LOG-006/011 | New row |
| 5.12 Box QR (p.17) | Code, batch, mfg, expiry, serial, verification hash; webcam + USB/Bluetooth 2D imagers | QR-001/002/005 | QR-002 hardens the "hash" (HMAC + server check) |
| 5.13 Mobile APK (p.17) | `?mode=apk`; offline IndexedDB; farmer/dealer verification | MOB-001…005, X08 | Covered |
| 6 Production, 16 sub-modules (p.18) | Listed; mass balance = FG + process loss + recovered scrap; costing = RM + energy + labour + packaging + overhead | MFG-001…020 | D32 answered (actual cost incl. energy) |
| 7.1 Finance (p.19) | Subledgers; credit lock; GST ITC vs output | FIN-001/005/012/014 | "ITC from vendor POs" corrected to ITC from vendor tax invoices (FIN-014) |
| 7.2 Document vault (p.19) | Statutory repository; 60/30/expired badges | DMS-001/002/005 | Covered |
| 7.3 Approvals (p.19) | Unified inbox: SO, PO, credit overrides, deviations, CAPA closures, SOP releases; approve / reject with remarks / hold | APR-009 | Covered |
| 7.4 Users & RBAC (p.19) | Boolean flags create/edit/update/delete/approve/hold/deactivate; immutable audit with IP | SEC-010/013 | `delete` is limited to drafts (MP Rule 7) |
| 7.5 Reports (p.19) | Filter grid by tier, region, category, qty MT, value, approval status; CSV export | MIS-008, CRM-019 | Covered |
| 8 AWS (p.20) | Infrastructure table | PLT-016/017 | X20, X21 |

## 3. New conflicts found in the BRD (added to doc 12 §2)

| # | Topic | BRD says | Other source / concern | Proposed resolution | Decision |
|---|---|---|---|---|---|
| X15 | Quarantine override | Dual authorisation by QC Head + Plant Manager can override the lock (p.15) | MP §11.6 and BR-04: quarantined material is never issued. Using untested material is the quality risk the lock exists to prevent | Keep the override as an **exceptional workflow**: QC Head + Plant Manager **+ QA Head notified, with a deviation raised automatically**. The lot moves to "Released under deviation", the batch is flagged, and it cannot be finally released until the lot's QC result is approved | D33 |
| X16 | Admin MFA | WhatsApp OTP + 2FA PIN (p.3, p.19) | MP §4.1 "approved MFA". WhatsApp OTP depends on the phone/SIM and can be phished or intercepted. A PIN is something the user knows, so OTP + PIN is weaker than an authenticator app | TOTP authenticator or a hardware/WebAuthn key for the four admins and privileged roles; WhatsApp OTP allowed as a fallback factor for ordinary users only | D22 |
| X17 | RFQ award | The matrix "auto-selects the winning bidder" (p.8) | MP §10.3: do not award automatically on lowest price | The system **ranks** bidders with a weighted score (landed cost, quality rating, lead time, qualification) and pre-selects the top one; Purchase confirms, and a reason is required if they choose a different vendor | D34 |
| X18 | Quotation columns | No IGST or discount columns (p.13) | BRD p.13 invoice handles IGST; BRD §4 #9 controls discounts; MP §8.2 lists both | Show discount always; show IGST instead of CGST/SGST when the place of supply is another state | Correction |
| X19 | Pipeline stages | Kanban: 4 stages (p.10); funnel: 5 stages (p.6); MP §7.4: 5 incl. Won/Lost | — | Opportunity stages: Requirement → Sample/Trial → Quote Sent → PO Expected → Won/Lost. The dashboard funnel adds "Approved & Dispatched" from order data | Correction |
| X20 | Job queue | ElastiCache Redis for sessions, OTP state and PDF queues (p.20) | Doc 03 AD-09 proposed a Postgres-backed queue for atomic outbox delivery | Use Redis for cache, rate limits, sessions and OTP state, and **BullMQ on Redis for jobs**, fed from a **Postgres outbox**. This keeps business commits atomic and follows the BRD | D35 |
| X21 | Availability & scale | 99.95% uptime; "thousands of concurrent dealer orders"; sub-50 ms latency; "zero breach tolerance" (p.20) | Doc 03 §7 proposed 99.5% business hours at about 200 concurrent users | 99.95% is achievable on Multi-AZ RDS + ECS but costs more (P5 §5 upper range). Agree measurable targets: uptime, RPO/RTO, p95 latency per user population. "Zero breach tolerance" becomes a security programme, not an SLA | D21 |
| X22 | Approver edits | TSM–ZSM "each possess rights to edit, update, adjust quantities, hold, or approve at their gate" (p.13) | MP §9.5: material amendments invalidate affected approvals | Approvers may **reduce** quantity or discount at their gate without resetting earlier approvals (less risk). Any increase in value, discount or quantity, or a product change, resets the steps already completed | D17 |
| X23 | Route above ZSM | Sequential chain stops at ZSM, then Accounts (p.13) | ZSM limits are ₹5 L / 15%, but DSM, NSM and BH hold higher authority (p.3) | Orders above ZSM limits continue to DSM → NSM → BH as needed (SO-011) | D01 |
| X24 | Territory levels | NSM: 4 zones; DSM: multi-zone cluster; ZSM: zone; RSM: **state**; SASM: multi-district cluster; ASM: district; TSM: taluka; SE: beats (p.3) | MP §4.3: National → Zone → State → **Region** → District → Taluka → Beat | Use the BRD's tree: National → Zone Cluster → Zone → State → District Cluster → District → Taluka → Beat. Levels stay configurable | D37 |
| X25 | Legal name | Cover: "Pvt. Ltd."; page footers: "Ltd." | — | Confirm the registered name for invoices and GST | D26 |
| X26 | Security cheques storage | "3 cheques … PDFs" stored in S3 (p.20) | Cheque images and director Aadhaar copies are sensitive personal and financial data | Restricted document class, encrypted, access logged, masked previews, retention per D25. Aadhaar only masked (last 4 digits) | D25 |

## 4. Decisions answered or narrowed by the BRD

| ID | Before | After BRD |
|---|---|---|
| D00 | BRD not supplied | **Closed.** BRD received and reconciled (this document) |
| D04 | RM/FG release authority open | **Answered:** RM by QC Manager with approved CoA; FG by QA Head. Delegation of the QA Head release to QA Managers is still to be confirmed |
| D14 | Admin mapping proposed | **Narrowed:** Admin 01 = MD (commercial overrides, credit extensions, exceptional prices) → *Executive Admin (Commercial)*; Admin 02 = ED (PO > ₹10 L, vendor credit terms, financial masters) → *Executive Admin (Purchase & Finance)*; Admins 03 & 04 = Executive Board Vault (failover, audit forensics, key custody) → *Security Admin* and *Super Admin / break-glass*. Still to confirm: "full system override" and "schema locks" become controlled exception workflows, and encryption keys stay in AWS KMS (admins hold IAM permissions, never raw keys) |
| D16 | Validity and revalidation | **Answered:** 7 days from quotation date; after expiry, re-approval is needed before conversion. Still open: whether the validity can be overridden per quote |
| D18 | Credit formula | **Answered in principle:** over limit → director approval; invoices beyond credit days → automatic order freeze. Still open: the exposure formula (doc 04 §4.10) and whether the freeze can be lifted by exception |
| D19 | Vite vs Next.js | **Closed: Vite** (BRD p.20 and MP §3.1 agree) |
| D20 | Screenshot missing | **Screenshot received** (§5). The ERP departures U1–U8 still need approval |
| D24 | Serialisation level | **Answered:** box/carton level |
| D26 | Structure unknown | **Mostly answered:** 2 plants, 4 warehouses (above). Still open: legal name, GST registrations (Maharashtra, and Telangana for WH-04?), Baramati storage locations |
| D32 | Costing method | **Answered:** actual landed cost per MT = RM + energy/power + labour + packaging + amortised overhead |
| D02 | Finance model | **Narrowed toward Model B** (BRD scope is subledgers). Still open: which external accounting system |

## 5. UI reference image check (`ui-reference-dashboard.webp`)

### 5.1 What the image confirms

| Element | In the image | Doc 10 token / rule | Match |
|---|---|---|---|
| Primary purple | Feature card, logo, button sampled ≈ `#5D36FF` / `#5E37FF` | `--color-primary #5B38F5` | ✔ (within ~2%) |
| Main canvas | Middle column sampled `#F6F8FE`, sitting on a near-white frame | `--color-canvas #F8F8FD` | ✔ |
| Soft KPI card | `#F7F6F9` | `#FAFAFD` (UI §18) | ✔ |
| Secondary chart bar | `#DED9E8` | `--color-chart-neutral #E9E8F0` | ≈ (slightly darker in the image; use `#DED9E8`) |
| Pink badge / sparkline | `#E36FDF` | `--color-accent #E639CF` | ✔ |
| Activity icon tints | Pink `#FEEBF1`, green `#EAFEF3` | danger-bg / success-bg | ✔ |
| Three-column layout | Sidebar ~360px, workspace, profile panel ~430px at a 1858px width | 280–320 / flexible / 340–390 | ✔ proportionally |
| Feature card | Credit-card style, radius ≈ 30px, strong purple glow, overlapping the grid edge | `FeatureCard` | ✔ |
| Charts | Smooth line, thin rounded twin bars, thin donut with a centred value and a purple pill | Doc 10 §5 | ✔ |
| Active nav | Purple icon + purple text, **no background** | UI §6 | ✔ |
| Sidebar bottom card | Isometric illustration, "PDF Report", full-width purple Download button | Doc 10 §3.2 (MIS pack card) | ✔ |
| Header | Plain search text, "Change view" pill, bell with purple dot, kebab | Doc 10 §3.1 | ✔ |

### 5.2 Differences between the image and the written UI prompt

| # | Image | UI prompt / doc 10 | Recommendation |
|---|---|---|---|
| R1 | Nav icons are **filled / duotone** (filled home in purple, filled grey for the others) | UI §39: Lucide **line** icons, 1.5–2px stroke | Use **Phosphor icons**, which the prompt allows: `duotone` weight in the sidebar and `regular` (line) inside the content. One family, two weights, matching the image. Needs approval (U9) |
| R2 | Headings use a rounded geometric sans (heavy "Overview") | Inter | Keep Inter for data-dense text (tabular figures). Optionally use a geometric display face (e.g. *Plus Jakarta Sans* 700) for page titles and KPIs only. U10 |
| R3 | Secondary text and axis labels are very light grey | — | Confirms the accessibility problem in doc 10 §2.1. Keep the darker `#6B6B80` for informative text (U6) |
| R4 | Only 5 navigation items (Overview, Statistics, Messages, Profile, Documents) | 9 items in UI §41 | The ERP needs about 20 items in groups (doc 10 §3.2). Group headers and the collapsible sidebar keep the spacious look |
| R5 | Content is finance-demo data (card number, USD/IDR, "Robert Washington") | — | Will be replaced with ERP widgets (doc 10 §7): Sales vs target feature card, order trend, dispatch/production bars, credit utilisation donut, approvals feed. No personal names are hardcoded |
| R6 | Whole app framed in a large rounded container with a lavender outer margin | UI §4 "if used in presentation/mockup format" | Use the frame only for marketing/presentation mockups; the live app fills the browser viewport |

### 5.3 Proposed dashboard content mapped onto the reference layout

| Reference slot | Executive Dashboard (ERP) |
|---|---|
| Purple card | **Sales this month**: ₹ achieved vs target, % achievement, pipeline value (BRD KPI "Total Commercial Pipeline") |
| Exchange-rates line chart | **Order intake trend** (₹, monthly) with a filter for Zone/State |
| Last-costs twin bars | **Production plan vs actual (MT)** per month |
| Efficiency donut | **OEE %** (or capacity utilisation, D23) with a change pill |
| Right-panel KPI card | **Overdue collection** (BRD KPI) with sparkline and change % |
| Recent activities | **Approvals & events:** SO approved, batch released, GRN quarantined, dispatch completed |
| Sidebar card | **Monthly MIS pack**: Download |

## 6. Updates made to the other documents

- **Doc 01 RTM:** BRD page references added; class O status set to `Baseline`; 37 new rows from the BRD; row edits for DLR-008, QUO-004, QC-009, FIN-002.
- **Doc 02:** M03, M07 and M08 sub-module lists replaced with the BRD's exact lists.
- **Doc 07:** admin mapping, PO band above ₹10 L to ED, RM/FG release authority, quarantine override, BRD tier permissions.
- **Doc 10:** reference-image findings; U9–U10 added.
- **Doc 12:** decision statuses updated; conflicts X15–X26 and decisions D33–D37 added.
- **README:** source availability and the list of blocking decisions.
