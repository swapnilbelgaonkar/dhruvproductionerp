# Dhruv Agro Enterprise ERP 2.0

Enterprise ERP for Dhruv Agro Technologies Pvt. Ltd. It covers chemical, fertilizer and bio-agriculture manufacturing and B2B distribution.

## Status

- **Stage 0** pre-development package: [`docs/pre-development/`](docs/pre-development/README.md). The BRD v2.4 and the UI reference image have been reconciled into it.
- **Stage 1 Foundation, increment 1:** built and tested. See [`docs/development/stage-1-foundation.md`](docs/development/stage-1-foundation.md).
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
   pnpm db:seed -- --org-from-brd
   ```

4. Start the API (port 4000) and the web portal (port 5173) in two terminals, then open http://localhost:5173.

   ```bash
   pnpm dev:api
   ```

   ```bash
   pnpm dev:web
   ```

On first sign-in the administrator must enrol an authenticator app and choose a new password.

## Tests

The API tests run against a real database. They expect a database named `dhruv_erp_test`; set `DATABASE_URL_TEST` to use a different one.

```bash
pnpm test
```

```bash
pnpm typecheck
```
