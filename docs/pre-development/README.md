# Dhruv Agro Enterprise ERP 2.0 — Pre-Development Package

| Attribute | Value |
|---|---|
| Client | Dhruv Agro Technologies Pvt. Ltd. |
| Package | Stage 0 — Requirements & Architecture (Master Development Prompt, Part 30, Steps 1–8) |
| Version | 0.2 (BRD v2.4 and UI reference reconciled) |
| Prepared | 18 November 2026 |
| Status | **Submitted for approval. No application code has been written. Development is not authorised.** |

## Source documents and how they rank

When sources conflict, the higher one wins. Every conflict found is logged in [12 — Open Decision Register](12-open-decision-register.md) instead of being resolved silently.

| Rank | Source | Short ref used in this package | Available? |
|---|---|---|---|
| 1 | Original BRD `BRD-DHRUV-ERP-2026-V2.4` (20 pages): `docs/source/BRD-DHRUV-ERP-2026-V2.4.pdf` | `BRD p.n` | Yes. Received in v0.2 and reconciled in doc 14. Signed by six department heads (15–17 Nov 2026). |
| 2 | Seven-phase planning blueprint (`docs/source/Dhruv_Agro_ERP_All_7_Phases.docx`, text copy in `docs/source/phases-1-7-consolidated.md`) | `P1` … `P7` | Yes |
| 3 | Master Development Prompt, Parts 1–30 | `MP§n` | Yes (supplied in the project brief) |
| 4 | UI Design Prompt (sections 1–43), plus reference screenshot `docs/source/ui-reference-dashboard.webp` | `UI§n` | Yes (screenshot checked in doc 14 §5) |
| 5 | Client-approved decisions | `D##` | None approved yet |

## Package contents (Step 8 deliverables)

| # | Deliverable | File |
|---|---|---|
| 1 | Requirements inventory and Requirements Traceability Matrix (RTM) | [01-requirements-traceability-matrix.md](01-requirements-traceability-matrix.md) |
| 2 | Complete module inventory (all 14 modules and their submodules) | [02-module-inventory.md](02-module-inventory.md) |
| 3 | Application architecture | [03-application-architecture.md](03-application-architecture.md) |
| 4 | Database design: ERD, logical schema, keys, indexes, transaction boundaries, audit, migration | [04-database-design.md](04-database-design.md) |
| 5 | Screen inventory and screen specifications | [06-screen-inventory.md](06-screen-inventory.md) |
| 6 | Workflow diagrams (11 end-to-end processes plus state machines) | [05-workflow-diagrams.md](05-workflow-diagrams.md) |
| 7 | Role, permission and approval matrix | [07-role-permission-approval-matrix.md](07-role-permission-approval-matrix.md) |
| 8 | API plan | [08-api-plan.md](08-api-plan.md) |
| 9 | Integration plan | [09-integration-plan.md](09-integration-plan.md) |
| 10 | UI design system, adapted from the UI prompt for ERP use | [10-ui-design-system.md](10-ui-design-system.md) |
| 11 | Development sequence, roadmap and estimated work packages | [11-roadmap-and-work-packages.md](11-roadmap-and-work-packages.md) |
| 12 | Open decision and conflict register | [12-open-decision-register.md](12-open-decision-register.md) |
| 13 | Testing and acceptance strategy | [13-testing-and-acceptance-strategy.md](13-testing-and-acceptance-strategy.md) |
| 14 | BRD v2.4 reconciliation and UI reference check | [14-brd-reconciliation-and-ui-reference-check.md](14-brd-reconciliation-and-ui-reference-check.md) |

## What this package is not

- It is not a signed statement of work, price or schedule. The budget figures come from P5 and are illustrative.
- It does not approve any corrections or additions. Original BRD rows are `Baseline` (BRD signed); every other RTM row is `Pending`.
- It makes no claim of regulatory compliance (MP Rule 11). Statutory items sit in the verification register (D08).

## How to approve

1. Each department owner reviews the RTM rows for their department (column `Owner`) and the workflows for their department.
2. Management answers the open decisions in doc 12. The **P0 decisions that still block the build**: D01, D02 (name the accounting system), D05, D12, D13, D14 (confirm), D20 (UI departures), D26 (legal name, GST registrations), D33, D37. D04 only needs confirmation. Departments that have **not** signed the BRD (QC, Purchase, Stores/Logistics, IT) need to sign off their areas.
3. Approvers record one of: Approved / Approved with Changes / Revision Required / Rejected (P6 §10), and the version they approved.
4. Development starts only after a separate, explicit authorisation (P6 §9) and covers only the stage that was authorised.
