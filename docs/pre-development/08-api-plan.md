# 08 — API Plan

Covers MP Part 22 and P4 §6. The OpenAPI 3.1 spec is generated from the Zod contracts in `packages/contracts` during Stage 1. This document fixes the conventions and the endpoint catalogue.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1`. Breaking changes go to `/api/v2`; additive changes stay in v1 |
| Resources | Plural kebab-case nouns (`/sales-orders`). Workflow transitions are explicit sub-resources: `POST /sales-orders/{id}/submit` |
| IDs | UUID in paths; `docNo` is returned and searchable but is never used as a key |
| Auth | Session cookie (web) or bearer access token (PWA/devices) + CSRF header for cookie sessions |
| Authorisation | Every handler declares `@Require(resource, action)`; scope filtering happens in the repository layer |
| Pagination | Cursor: `?limit=50&cursor=…` → `{ data, nextCursor, totalEstimate }`; `limit` ≤ 100 |
| Filtering / sort | `?filter[status]=Approved&filter[dateFrom]=2026-04-01&sort=-createdAt` |
| Concurrency | Every mutable resource returns `version`. Updates send `If-Match: <version>`; a mismatch returns 409 |
| Idempotency | `Idempotency-Key` header **required** on: submit/approve/post/dispatch/release commands, payments, receipts, scan batches and all integration callbacks |
| Allowed actions | Every document GET returns `allowedActions: string[]`, computed by the server from state, permission and SoD |
| Money | Decimal strings (`"125000.00"`), never floats; currency is implicitly INR |
| Dates | ISO 8601; `date` for business dates, `date-time` in UTC |
| Errors | Standard envelope (§2) |

## 2. Error envelope & codes

```json
{
  "error": {
    "code": "DISCOUNT_EXCEEDS_AUTHORITY",
    "message": "Line 3 discount 14% exceeds your authority of 7%.",
    "details": [{ "field": "lines[2].discountPct", "code": "MAX", "limit": "7" }],
    "traceId": "01J…"
  }
}
```

| HTTP | Codes (examples) |
|---|---|
| 400 | `VALIDATION_FAILED` |
| 401 | `AUTH_REQUIRED`, `AUTH_INVALID`, `MFA_REQUIRED`, `SESSION_EXPIRED` |
| 403 | `FORBIDDEN`, `OUT_OF_SCOPE`, `SOD_VIOLATION`, `REAUTH_REQUIRED` |
| 404 | `NOT_FOUND` (also returned for out-of-scope records, so their existence is not revealed) |
| 409 | `CONCURRENT_MODIFICATION`, `DUPLICATE_PARTY`, `DUPLICATE_DEALER_PO`, `IDEMPOTENCY_CONFLICT`, `SERIAL_ALREADY_ASSIGNED` |
| 422 | `INVALID_STATE_TRANSITION`, `DEALER_INACTIVE`, `LICENCE_EXPIRED`, `LICENCE_CATEGORY_BLOCKED`, `CREDIT_LIMIT_EXCEEDED`, `INSUFFICIENT_ELIGIBLE_STOCK`, `LOT_NOT_ELIGIBLE`, `BOM_NOT_EFFECTIVE`, `TOLERANCE_EXCEEDED`, `QA_RELEASE_BLOCKED`, `INSTRUMENT_NOT_CALIBRATED`, `PERIOD_CLOSED`, `QUOTE_EXPIRED`, `MATCH_OUT_OF_TOLERANCE` |
| 429 | `RATE_LIMITED` |
| 502/504 | `UPSTREAM_UNAVAILABLE` (GSP/accounting); the command has already been committed and queued |

## 3. Endpoint catalogue

### Platform

| Method | Route | Function |
|---|---|---|
| POST | `/auth/login`, `/auth/logout`, `/auth/refresh` | Session lifecycle |
| POST | `/auth/mfa/enrol`, `/auth/mfa/verify`, `/auth/reauth` | MFA and step-up |
| POST | `/auth/password/forgot`, `/auth/password/reset` | Recovery |
| GET | `/me`, `/me/permissions`, `/me/sessions` | Current user, permissions, navigation manifest |
| CRUD | `/users`, `/roles`, `/roles/{id}/permissions`, `/users/{id}/scopes`, `/delegations`, `/devices` | Identity admin |
| CRUD | `/approval-policies`, `/approval-policies/{id}/versions`; POST `…/simulate`, `…/publish` | Policy engine |
| GET | `/approvals?assignee=me&status=Pending` | Inbox |
| POST | `/approvals/{id}/decisions` `{decision, remarks}` | Approve, reject, hold, return, escalate, delegate |
| GET | `/audit?entityType=&entityId=&actor=&from=&to=` | Audit |
| POST | `/documents` (upload init → pre-signed PUT), `/documents/{id}/versions`; GET `/documents/{id}/download-url` | Vault |
| GET/POST | `/notifications`, `/notifications/{id}/read`, `/notification-rules` | Notifications |
| GET | `/search?q=&types=` | Global search |
| POST | `/imports` (validate), `/imports/{id}/commit`; GET `/imports/{id}/errors` | Bulk import |
| POST/GET | `/exports`, `/exports/{id}` | Async exports |
| CRUD | `/number-series`, `/settings`, `/templates` | Configuration |

### Org & masters

| Method | Route |
|---|---|
| CRUD | `/legal-entities`, `/plants`, `/warehouses`, `/warehouses/{id}/bins`, `/departments`, `/territories`, `/employees` |
| CRUD | `/parties`, `/parties/{id}/addresses\|contacts\|bank-accounts\|licences`; GET `/parties/duplicates` |
| POST | `/dealers`, `/dealers/{id}/submit`, `/dealers/{id}/suspend`, `/dealers/{id}/reactivate`; GET `/parties/{id}/360` |
| CRUD | `/vendors`, `/transporters`, `/items`, `/items/{id}/packs`, `/uom`, `/hsn-codes`, `/tax-rates`, `/product-categories`, `/equipment`, `/document-types` |
| GET/POST | `/master-changes`, `/master-changes/{id}/decisions` |

### Sales

| Method | Route |
|---|---|
| CRUD | `/leads` + POST `/leads/{id}/qualify\|convert\|transfer` |
| CRUD | `/opportunities` + POST `/opportunities/{id}/stage` |
| CRUD | `/activities`, `/targets`, `/price-lists`, `/schemes`, `/contracts`, `/samples`, `/field-trials`, `/competitor-entries`, `/beat-plans`, `/beat-visits` |
| POST | `/quotations/calculate` (stateless pricing and tax) |
| CRUD | `/quotations` + POST `/{id}/submit\|revise\|duplicate\|send\|convert\|cancel`; GET `/{id}/pdf`, `/{id}/revisions` |
| CRUD | `/sales-orders` + POST `/{id}/submit\|revisions\|cancel\|authorise-dispatch\|short-close` |
| GET/POST | `/allocations`, `/reservations/{id}/release` |
| GET | `/parties/{id}/credit` (exposure breakdown) |

### Procurement & inventory

| Method | Route |
|---|---|
| CRUD | `/purchase-requisitions` + `/submit` |
| CRUD | `/rfqs`, `/rfqs/{id}/quotes`; GET `/rfqs/{id}/comparison`; POST `/rfqs/{id}/award` |
| CRUD | `/purchase-orders` + `/submit\|issue\|amend\|cancel\|short-close`; GET `/pdf` |
| CRUD | `/supplier-invoices` + POST `/{id}/match`; GET/POST `/match-exceptions/{id}/resolve` |
| CRUD | `/supplier-returns` |
| POST | `/gate-entries`, `/goods-receipts`, `/goods-receipts/{id}/post`, `/goods-receipts/{id}/reverse` |
| GET | `/inventory/stock`, `/inventory/lots/{id}`, `/inventory/movements`, `/inventory/atp?itemPackId=&warehouseId=` |
| POST | `/inventory/lots/{id}/dispositions` |
| CRUD+POST | `/material-issues`, `/transfers` (`/dispatch`, `/receive`), `/putaways`, `/counts`, `/adjustments` (`/submit`, `/post`) |

### Manufacturing, QC, QA

| Method | Route |
|---|---|
| CRUD | `/forecasts`; POST `/mrp/runs`; GET `/mrp/runs/{id}/suggestions`; POST `/mrp/suggestions/{id}/firm` |
| CRUD | `/boms`, `/boms/{id}/versions` + `/submit\|approve` |
| CRUD | `/production-orders` + `/release\|amend\|cancel\|close` |
| POST | `/batches/{id}/start`, `/consumptions`, `/readings`, `/ipqc`, `/complete`, `/yield` |
| CRUD | `/packaging-runs` + POST `/{id}/serials` (generate boxes), `/label-jobs` |
| GET | `/trace?lotId=&direction=forward\|backward` |
| CRUD | `/qc/specifications(+versions)`, `/qc/methods`, `/qc/samples` + `/custody` |
| POST | `/qc/samples/{id}/results`, `/qc/samples/{id}/review`, `/qc/coas`, `/qc/oos/{id}/retest-authorisations` |
| CRUD | `/qc/instruments`, `/qc/instruments/{id}/calibrations` |
| CRUD | `/qa/documents(+versions)`, `/qa/changes`, `/qa/deviations`, `/qa/ncs`, `/qa/incidents`, `/qa/capas(+actions)`, `/qa/batch-reviews`, `/qa/audits(+findings)`, `/qa/training`, `/qa/risks`, `/qa/complaints`, `/qa/recalls` (+ `/drill`) |
| GET | `/qa/batches/{id}/release-readiness` |
| POST | `/qa/batches/{id}/dispositions` (re-authentication required) |

### Logistics, serialisation, finance, reporting

| Method | Route |
|---|---|
| GET | `/dispatch-queue` |
| CRUD | `/shipments` + POST `/{id}/pick-list\|pack\|assign-transport\|load\|dispatch\|pod\|close` |
| CRUD | `/dispatch-exceptions`, `/returns` (`/authorise`, `/receive`), `/freight` |
| POST | `/scans/batches` → per-event results `{eventId, result, reason, serverState}` |
| GET/POST | `/scan-conflicts`, `/scan-conflicts/{id}/resolve`, `/serials/{serial}` |
| GET | `/public/verify/{token}` (no auth, rate-limited, limited fields) |
| CRUD | `/invoices` + POST `/{id}/issue\|irn\|cancel`; GET `/{id}/pdf` |
| CRUD | `/receipts` + POST `/{id}/allocate`; `/credit-notes`, `/debit-notes`, `/payables`, `/vendor-payments` |
| GET/POST | `/credit-profiles`, `/ledgers/{partyId}`, `/postings` (+ `/{id}/retry`), `/periods/{id}/close`, `/bank-reconciliation` |
| GET | `/dashboards/{key}`, `/reports`, `/reports/{id}/run`, `/kpis` |

## 4. Event dictionary (outbox, principal events)

| Event | Producer | Consumers |
|---|---|---|
| `party.activated`, `party.suspended`, `licence.expiring`, `licence.expired` | masters | notifications, sales (block) |
| `quotation.submitted/approved/expired` | sales | notifications |
| `sales_order.submitted/approved/rejected/amended/cancelled` | sales | notifications, inventory (reserve), MRP |
| `approval.step_assigned/escalated/decided` | workflow | notifications |
| `grn.posted` | inventory | QC (sample request), procurement (PO received qty), notifications |
| `lot.dispositioned` | QC/QA | inventory, manufacturing, notifications |
| `batch.completed` | manufacturing | QC |
| `batch.released/held/rejected` | QA | inventory, allocation job, notifications |
| `shipment.dispatched/delivered` | logistics | finance (invoice job), integrations (e-way bill), notifications |
| `invoice.issued` | finance | integrations (IRN, accounting posting) |
| `posting.failed` | integrations | notifications (Accounts), admin monitor |
| `recall.opened` | QA | inventory (hold), notifications |
| `scan.conflict` | serialisation | notifications |

## 5. API test specification (per route)

Each route is delivered with tests for: the happy path · validation failure · permission denied · out-of-scope access (expects 404) · invalid state transition · concurrency (stale `If-Match`) · idempotent replay (same key returns the same response, a different body returns `IDEMPOTENCY_CONFLICT`) · audit event written.
