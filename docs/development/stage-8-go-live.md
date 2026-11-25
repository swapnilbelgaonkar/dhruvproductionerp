# Stage 8 — Go-live

What is built to take the ERP live, and the runbook for doing it. The **Go-live** page (Administration → Go-live) shows, from live data, what is done and what is not; the manual items are signed off there by a named person.

## 1. What is built

| Area | What works |
|---|---|
| Bulk import | CSV import with a template per kind, checked row by row (required fields, formats, PAN/GSTIN/PIN, references, duplicates in the file and in the ERP) and committed all-or-nothing. Masters: HSN codes, employees (managers before reports), transporters, items with a pack size, dealers and vendors. Items, dealers and vendors arrive as **Draft** and go through KYC and approval as usual. Every run is recorded. Masters can be exported in the same columns |
| Opening balances (D10) | Set the **cut-over date** first (fixed once the opening journal is posted). Then: **trial balance** as a posted opening journal dated the day before (every account except inventory; receivable and payable lines by party); **stock by lot** with cost, expiry and QC status (posted against opening balance equity); **open dealer invoices** and **open vendor bills** so collections, credit control, ageing, reminders and payments carry on. These do not post to the ledger again. The checklist proves they agree: opening balance equity nets to zero, open invoices = receivables in the ledger, open bills = payables in the ledger |
| Readiness checklist | Company (legal entities, GSTIN addresses, dispatch addresses, bank accounts), data (no [SAMPLE]/[TEST] records or demo users, masters approved, TDS and GST rates), opening balances per entity, ledger balanced, security (two-step on, temporary passwords changed, production mode, public address), integrations (none simulated, GST and e-mail set). Ten manual sign-offs: decisions, SIT, security test, performance test, UAT, training, backup and restore, hosting, pilot, cut-over plan |
| Two-step verification | Built and **switched off** as asked: authenticator app (QR set-up from My profile at any time, or at sign-in when a role requires it), ten single-use **recovery codes** shown once (new ones void the old), recovery-code sign-in, administrator reset clears codes. Turning it on is one setting (`auth.mfa.enforced`); the checklist shows it as not done until then |
| Production hosting kit | `deploy/Dockerfile` (one image: API, worker, migrations, seed; non-root; health check), `deploy/docker-compose.prod.yml` (PostgreSQL 16, API, worker, Caddy with automatic TLS), `deploy/Caddyfile`, `deploy/.env.example`, `deploy/backup.sh` (nightly dump + files, verified, kept N days), `deploy/restore.sh` |
| Performance check | `scripts/load-test.mjs`: signs in once, N concurrent users loop through the most-used screens, reports p50/p95/p99 per endpoint, fails above a p95 limit |
| Security hardening | Session and CSRF cookies are no longer written to request logs. Dependencies with known high-severity issues upgraded (Express 4.22.3, Nodemailer 10.4.0, React Router 6.30.6) |

### Evidence
- `golive.test.ts` (3): row errors and nothing saved; employees with managers; unknown columns; export; opening receivables / payables / trial balance / stock that agree, shown as ✓ on the checklist; collections and payments see the brought-forward items; cut-over fixed after posting; sign-off; two-step set-up while off, recovery-code sign-in once on, one use per code, new codes void old ones.
- Full suite: **101 API tests + 4 contract tests passing**; typecheck clean.
- Production image built and run against an **empty database**: migrations applied, first administrator created (must change password), sign-in works, no demo data, two-step off.
- Load test on the production image with the demo data: **50 users for 30 s, 537 requests/s, p95 189 ms, p99 237 ms, no failures** (one 4-vCPU container, same-host database). Repeat on the real server with real volumes before go-live.
- `pnpm audit --prod`: no high-severity issue left except **Zod** (fixed only in Zod 4, a major upgrade — mitigated by the 1 MB body limit and bounded arrays; planned) and two moderate React Router issues fixed only in v7.

## 2. Go live on a fresh database — never on the demo

The demo database is full of [SAMPLE] records, demo users and test postings. Production starts empty:

```bash
docker build -f deploy/Dockerfile -t dhruv-erp:<version> .
cp deploy/.env.example deploy/.env      # fill in: domain, DB password, APP_ENCRYPTION_KEY (openssl rand -base64 32), first admin
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d db
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env run --rm migrate
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env run --rm seed
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
```

Keep a sealed offline copy of `APP_ENCRYPTION_KEY`: without it, encrypted bank account numbers and authenticator secrets cannot be read after a restore.

## 3. Order of work after the install

1. First administrator signs in, changes the password, sets up two-step verification (My profile), creates the other administrators.
2. **Company:** legal entities, GST registrations with their address for e-invoicing, plants, warehouses with dispatch address, departments, territories (D26).
3. **Settings to confirm** (all marked provisional): approval policies and limits, invoice cancel window, freight tolerance, overdue freeze, e-way bill threshold, KPI targets, TDS sections, GST rates for every HSN, company bank details, public address.
4. **Import** masters: HSN → employees → transporters → items → dealers → vendors; then approvals and KYC.
5. **Users and roles**: one account per person, roles with scopes; privileged grants need executive approval.
6. **Integrations:** e-invoice / e-way bill / GST returns to Manual (or Live once the GSP adapter is in, D27); bank files Manual; e-mail Live with SMTP; SMS / WhatsApp once registered (D11).
7. **Cut-over** (see §5).
8. **Two-step on:** when every administrator has enrolled, set `auth.mfa.enforced` to true (Administration → Settings). Users of roles that require it set it up at their next sign-in.

## 4. Testing before go-live

| Test | How | Exit |
|---|---|---|
| System integration (SIT) | On the go-live build with imported masters, run end to end: (a) dealer → quotation → order → approval → pick → dispatch → invoice → IRN → e-way bill → POD → receipt; (b) requisition → RFQ → PO → receipt → QC → supplier invoice → payment file → bank reply; (c) production order → batch → IPQC → QA release → packing → labels; (d) month: GSTR-1/3B files, TDS challan, period lock, trial balance | All complete; ledger reconciliation clean |
| Security | External penetration test of the public address; access review of every user's roles and scopes; check audit-log chain verification | No open high findings |
| Performance | `BASE=https://… EMAIL=… PASSWORD=… USERS=<expected peak> SECONDS=300 node scripts/load-test.mjs` on the production server with migrated volumes | p95 under the agreed limit (default 800 ms), no errors |
| UAT | Each department head runs their day-to-day work on the training copy and signs | Signed by sales, purchase, stores, production, QC, QA, logistics, finance, management |
| Backup and restore | `deploy/backup.sh` nightly; restore one backup to a spare server with `deploy/restore.sh`, time it, verify the audit chain | Restore done and timed |
| Pilot | One plant and its dealers live for the agreed weeks | No blocking issues |

## 5. Cut-over

1. Agree the cut-over date and freeze the old system for new transactions from the day before.
2. Set the cut-over date (Go-live page).
3. Load, in this order, checking each against the old system's closing reports: trial balance → stock by lot → open dealer invoices → open vendor bills.
4. The checklist must show **Opening balances agree** for every entity (opening balance equity 0; invoices and bills equal the ledger).
5. Lock the periods before the cut-over (Accounting periods).
6. Sign off the remaining manual items; the page shows **Ready to go live**.
7. Fall-back: until the first day's documents are posted, the old system stays usable; after that, corrections are made in the ERP.

## 6. Still to come after go-live
- Live GST connection through the chosen GSP (D27); bank host-to-host (bank); SMS/WhatsApp providers (D11).
- Zod 4 and React Router 7 upgrades (security advisories above).

## 7. Company product list (loaded 25 Nov 2026)
- Source: `docs/source/products/Dhruv_Products_List_Categorywise.xlsx` (and the same rows as `dhruv-products-category-wise.csv`).
- Loader: `pnpm --filter @dhruv/api exec tsx --env-file=.env src/db/load-products.ts` — runs through the bulk importer's checks; use it on the production database after the install.
- Mapping: Category → product category (11 new; licence requirement NONE until D08); Product Name → item name; Active Ingredient / Type, Composition / Technical Content, Key Benefits / Uses, Advisory Dosage, FCO Grade, Brochure Page → the new item fields; Packing Available → one pack per size (base unit KG or L from the pack units). Codes FG-001…FG-067 follow the Sr No.
- Left empty to fill before approval: HSN, GST rate, shelf life, cost, storage class, container and units per box, and for the six neem insecticides (FG-049…FG-054) the packing and base unit, which the brochure does not give. "Not mentioned in brochure" and "Not marked" are stored as empty.
- All 67 are Draft: complete them and submit for approval before they can be priced, quoted or stocked.
- On the demo database the [SAMPLE] items were removed together with every demo transaction that used them (orders, stock, production, QC, dispatch, invoices, payments, journals). Users, dealers, vendors, settings and the approval history were kept; open approvals for removed documents were cancelled.

## 8. Purchased-material list (loaded 25 Nov 2026)
- Source: the company workbook RawPacking_Labour_Consumables_Material_List.xlsx (stock group summary 1-Apr-26 to 21-Nov-26). Only names and groups are in the repository (`docs/source/materials/materials.csv`); the quantities, rates and values are commercial data and are kept out of git.
- Loader: `pnpm --filter @dhruv/api exec tsx --env-file=.env src/db/load-materials.ts` (through the bulk importer; names already present are skipped).
- 706 Draft items in three categories: Raw Material (259, type RM, RM-001…), Packing Material (432, type PM so packing runs and stores treat them as packaging, PM-001…), Labour Consumables (15, type RM, LC-001…). Codes follow alphabetical order within each group.
- Base unit, HSN, shelf life, vendor and specifications are to be completed before approval. The stock quantities and rates belong to the opening-stock load at cut-over (which also needs warehouse, lot and expiry).

## 9. Vendor list (loaded 25 Nov 2026)
- Source: the company vendor workbook (47 vendors in two groups). It is company data and is not kept in the repository.
- Loader: `pnpm --filter @dhruv/api exec tsx --env-file=.env src/db/load-vendors.ts <vendors.csv>` (columns group, name, address, state, pin_code, mobile_number, mail_id, gstin).
- Taken: name, address, state, PIN (or a PIN written at the end of the address), the first mobile (every number as written is kept in "Other phone numbers"), e-mail, GSTIN with PAN read from it. Packing Material Creditors → Packaging; Factory other creditors → Other. "N/A" is empty. Bank details written inside an address are dropped from it; bank accounts are added with a cancelled cheque and verified by finance.
- Draft vendors may have constitution, PAN, contact person, mobile and parts of the address empty; the onboarding checklist lists what is missing and blocks submission until it is complete. Dealers keep their stricter form.
