# Dhruv Agro Enterprise ERP 2.0

Enterprise ERP for Dhruv Agro Technologies Pvt. Ltd. It covers chemical, fertilizer and bio-agriculture manufacturing and B2B distribution.

## Status

- **Stage 0** pre-development package: [`docs/pre-development/`](docs/pre-development/README.md). The BRD v2.4 and the UI reference image have been reconciled into it.
- **Stage 1 Foundation, increments 1–2:** built and tested (platform, approvals, organisation and product masters, document vault, notifications). See [`docs/development/stage-1-foundation.md`](docs/development/stage-1-foundation.md).
- **Stage 2 Sales (dealers, CRM, price lists, quotations, sales orders):** built and tested. See [`docs/development/stage-2-sales.md`](docs/development/stage-2-sales.md).
- **Stage 3 Purchase, Stores and Quality (vendors, requisitions, RFQs, purchase orders, goods receipts, QC, returns, three-way match):** built and tested. See [`docs/development/stage-3-purchase.md`](docs/development/stage-3-purchase.md).
- **Stage 4 Production (formulations, production orders, batches, QA release, traceability, packing with signed box labels, cost sheet, downtime, dashboard):** built and tested. See [`docs/development/stage-4-production.md`](docs/development/stage-4-production.md).
- **Client decisions and pending items:** [`docs/pre-development/12-open-decision-register.md`](docs/pre-development/12-open-decision-register.md).

## Repository layout

```
apps/api            Express + TypeScript API (modular: auth, iam, org, workflow, admin)
apps/api/migrations SQL migrations (PostgreSQL 16)
apps/web            React + Vite web portal
packages/contracts  Shared Zod schemas and Indian statutory validators (GSTIN, PAN)
docs/               Requirements, architecture and progress reports
```

## Run locally

Prerequisites: Node 22, pnpm 10, and PostgreSQL 16 with the `ltree`, `pgcrypto`, `citext` and `btree_gist` extensions available.

1. Install dependencies.

   ```bash
   pnpm install
   ```

2. Copy the environment template, then fill in `DATABASE_URL`, a 32-byte base64 `APP_ENCRYPTION_KEY`, and the `BOOTSTRAP_ADMIN_*` values.

   ```bash
   cp .env.example apps/api/.env
   ```

3. Create the schema and the bootstrap Super Admin. `--org-from-brd` is optional and loads the BRD plants and warehouses as provisional data. Add `--sample` only on a development machine.

   ```bash
   pnpm db:migrate
   ```

   ```bash
   pnpm db:seed -- --org-from-brd --products-from-brd
   ```

4. Start the API (port 4000) and the web portal (port 5173) in two terminals, then open http://localhost:5173.

   ```bash
   pnpm dev:api
   ```

   ```bash
   pnpm dev:web
   ```

On first sign-in the administrator must enrol an authenticator app and choose a new password.

## Try the demo users (development only)

To walk through the sales, purchase, stores and quality flows with one login per role, seed the demo users and sample data on a development database. Choose your own password in `DEMO_PASSWORD`; it is never stored in the repository.

```bash
DEMO_PASSWORD='choose-a-dev-password' pnpm db:seed -- --org-from-brd --products-from-brd --sample --demo-users
```

Every demo user signs in as `<role>@demo.local` with that password:

| Area | Users |
|---|---|
| Sales | `se`, `tsm`, `rsm`, `nsm`, `ops`, `verifier`, `credit`, `finance` |
| Purchase | `purchase`, `purchase-head`, `accounts` |
| Stores | `storekeeper`, `stores-head` |
| Quality | `qc`, `qc-manager`, `qc-head`, `qa-manager`, `qa-head` |
| Production | `planner`, `supervisor`, `plant-head` |
| Audit (read only) | `auditor` |

Everything the seed creates is marked `[SAMPLE]`. Its tax rates and limits are illustrative, not client-confirmed.

## Hosted demo (Vercel)

`node scripts/vercel-build.mjs` builds the portal and the API into Vercel's prebuilt format (`.vercel/output`); deploy it with `vercel deploy --prebuilt --prod`. The API runs as one Node function (`apps/api/src/vercel.ts`):

- The project needs a Postgres database (Neon through the Vercel marketplace sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`), plus `APP_ENCRYPTION_KEY`, `NODE_ENV=production` and `CRON_SECRET`.
- On a cold start, pending migrations are applied. If the database is empty and `deploy/demo-snapshot.sql` was present at build time, that [SAMPLE] snapshot is loaded first. The snapshot is not committed.
- Uploaded files are kept in Postgres (`sys.file_objects`), because functions have no persistent disk.
- Notifications are relayed when the bell or dashboard is read, and the hourly checks run from a daily Vercel cron job.

This shape is for demonstration only. Production keeps the long-running API and worker processes and an object store (doc 03).

## Tests

The API tests run against a real database. They expect a database named `dhruv_erp_test`; set `DATABASE_URL_TEST` to use a different one.

```bash
pnpm test
```

```bash
pnpm typecheck
```
