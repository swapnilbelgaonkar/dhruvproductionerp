# Stage 1 — Foundation: progress report (increments 1 and 2)

Authorised by the client on 18 Nov 2026 ("build the system first, take pending decisions later"). The decisions that apply are logged in doc 12 §1.1.

## 1. Delivered in increment 1

| Area | What works | RTM |
|---|---|---|
| Monorepo | pnpm workspace: `apps/api` (Express + TypeScript), `apps/web` (React + Vite), `packages/contracts` (shared Zod validation) | PLT-001/002/005 |
| Database | PostgreSQL schemas `sys`, `iam`, `org`, `wf`; SQL migrations; catalogue sync on every migrate | PLT-003 |
| Authentication | Email + password (argon2id); lockout after 5 failures; generic error messages and equal timing (no user enumeration); sessions stored hashed, with idle and absolute timeouts; CSRF double-submit token; login rate limit | SEC-004/006/007/008 |
| MFA | TOTP enrolment (QR) and verification. Mandatory for privileged roles; the session is held at a gate until done. Secrets stored AES-256-GCM encrypted | SEC-005, X16 |
| First sign-in gates | MFA enrolment, then a forced password change (passwords cannot contain the email name or reuse the old password); all other sessions are revoked on change | SEC-006 |
| Users | Create, edit, link to employee, suspend, reactivate, deactivate (sessions and roles revoked), reset MFA, unlock, sign out everywhere. Nobody can change their own status | SEC-009 |
| Roles & permissions | 37 roles (admin model doc 07 §2, 9 sales tiers, department roles); 54 permissions; read-only permission matrix screen | ADM-001, SEC-001/002 |
| Data scope | Role grants carry a legal-entity scope. Lists, details, search and dashboards filter by it; out-of-scope records return 404 | SEC-011 |
| Privileged role grants | Pending until an Executive Admin approves. No self-grants. The last Super Admin cannot be removed | SEC-018, SOD-06 |
| Approval engine | Versioned policies; steps by role, reporting manager or **authority ladder (D01 hybrid)**; notify-only steps for skipped managers; approve, reject, return, hold, resume and withdraw; remarks required where needed; separation of duties (initiator ≠ approver, distinct approvers per request); SLA due dates; unified inbox; policy simulator; maker-checker on publishing policy versions | APR-001…009, SO-011 |
| Status protection | A database trigger rejects any status change made outside the workflow service, including direct SQL | MP Rule 4 |
| Organisation masters | Legal entities (PAN, GST registrations with checksum and PAN match), plants and warehouses with the full Draft → Submitted → Active lifecycle and maker-checker; departments, territory tree (BRD levels, D37), employees (reporting line, sales tier, loop prevention). Dependency checks: a master cannot be submitted against inactive parents, and a parent cannot be deactivated while it has active children | MDM-001…007, ORG-001…008 |
| Authority limits | BRD values seeded **inactive** (D15). Editable with a reason; activation by a different executive than the editor | APR-008 |
| Number series | Indian FY numbering (`APR/2026-27/000001`), concurrency-safe | PLT-011 |
| Settings | Lockout, session timeouts, quotation validity and approval SLA, editable with an audited reason | ADM-004 |
| Audit | Every action logged with before/after diff and reason; append-only (database triggers); SHA-256 hash chain with a "Verify integrity" check; filters; CSV export (itself audited) | SEC-013 |
| UI | App shell per the reference image (Phosphor duotone navigation, collapsible sidebar, Ctrl-K search, right panel); Overview dashboard with live data; registers, details, forms, dialogs, toasts, empty and loading states; mobile layout | UI-001…006 |
| Provisional data | `pnpm db:seed -- --org-from-brd` loads the BRD's legal entity, 2 plants and 4 warehouses, marked provisional (D26) | ORG-008 |

## 2. Evidence

- `apps/api/test/foundation.test.ts` and `ladder.test.ts`: **23 tests passing** against a real PostgreSQL database. They cover:
  - lockout and audit of failed logins
  - the MFA and password gates
  - CSRF
  - permission denial (TC-01)
  - scope hiding (TC-01)
  - maker-checker
  - rejection that requires remarks
  - the SQL status-bypass block (TC-18)
  - inactive references (MDM-005)
  - optimistic locking
  - GSTIN check digit and PAN match
  - privileged grant approval
  - an audit chain that cannot be modified
  - reporting-loop prevention
  - the D01 routing examples from doc 07 §5.1, including vacant tiers and orders above ZSM limits
- `packages/contracts/src/gst.test.ts`: 4 tests.
- A browser run (Playwright) of the full UI journey also passed:
  1. Bootstrap admin: MFA enrolment, then password change.
  2. Create two users and grant their roles.
  3. Maker creates a legal entity; submission without PAN is blocked; fix and submit.
  4. Checker approves from the inbox; the entity becomes Active.
  5. Audit integrity verified, search, mobile layout.

## 2a. Delivered in increment 2 (product masters, documents, notifications)

Order follows D12 (business flow): what the Sales stage needs first.

| Area | What works | RTM |
|---|---|---|
| Units of measure | 14 reference units, universal conversions (g/kg/MT, ml/L/KL); mass↔volume conversions only per item (density) | MDM-010 |
| HSN & GST rates | HSN/SAC master; effective-dated GST + cess rates; a new rate closes the previous one; overlapping periods are rejected by the database; rate history is never deleted; effective-rate lookup by date for invoicing. **No rates are pre-loaded** (D27) | MDM-009 |
| Product categories | Category → dealer licence required (Fertilizer / Pesticide / Bio-stimulant / None) | MDM-008, DLR-004 |
| Items & pack sizes | FG/RM/PM/semi/lab/service items with maker-checker approval; stock items need HSN and category; FG and RM need shelf life; FG needs at least one pack size; packs are frozen once Active | MDM-008, MDM-005 |
| Document vault | Upload PDF/PNG/JPEG (real type checked from the file contents, not its name); per-type size limits and mandatory expiry dates; versions (append-only); archive with reason; downloads only through 5-minute signed links tied to the user; every link and download audited; sensitive document types flagged | DMS-001/002, X26 |
| Notifications | Outbox relay turns approval events into in-app notifications (approval needed, notify-only copies, approved/rejected/returned/on hold); safe on several servers and on retry; bell with unread badge, mark read / all read | NTF-001/004, PLT-004 |
| Idempotency | `Idempotency-Key` on POST/PUT: retries replay the first result, a reused key with another body is refused | PLT-004 |
| Worker process | `src/worker.ts` runs the relay separately in production (`RUN_RELAY=false` on API servers) | doc 03 §2 |
| Provisional BRD products | `pnpm db:seed -- --products-from-brd` loads the 5 BRD categories and HSN codes, marked provisional, without GST rates | — |

Evidence: `apps/api/test/masters-documents.test.ts` (6 tests). Total **29 API + 4 contract tests passing**. A browser run also passed:
1. The maker creates PRD-CHEL-01; submission without a pack is blocked.
2. The maker adds a 1 kg pouch pack and uploads the product specification PDF, then submits.
3. The approver sees it in the bell and approves.
4. The item is Active, and the PDF opens through a signed link.

## 3. Remaining for Stage 1

| Item | RTM | Needed by |
|---|---|---|
| Email notifications (SES) and document expiry alerts at 60 and 30 days (scheduled job) | NTF-002, DMS-005 | Stage 2 (licence expiry) |
| Delegation of approvals and SLA escalation job | ADM-002, APR-005 | Stage 2 |
| Master change requests for **active** masters (e.g. new pack on an active item, new GSTIN on an active legal entity) | MDM-004 | Stage 2 |
| Vendor, transporter, equipment, bank and document-type admin screens | MDM-011…017 | Stages 3 and 6 |
| Bulk import with a validation report | MDM-014, TC-19 | Before go-live |
| PDF generation service; S3 storage adapter; virus scanning (`av_status` is recorded as *NotScanned* today) | AD-11/12, DMS-003 | Stage 2 (quotation PDF) / deployment |
| CI pipeline, staging deployment, OpenAPI document | PLT-005/006 | Deployment |

## 4. How to run locally

See the root `README.md`.
