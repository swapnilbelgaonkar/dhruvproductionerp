**DHRUV AGRO TECHNOLOGIES PVT. LTD.**

ENTERPRISE ERP 2.0  
COMPLETE PROGRAMME BLUEPRINT

Combined Phases 1–7 \| Analysis • Workflows • Functional & Technical
Design • Implementation • Client Approval • Scope Validation

| **DOCUMENT ATTRIBUTE** | **VALUE**                                                   |
|------------------------|-------------------------------------------------------------|
| Reference BRD          | BRD-DHRUV-ERP-2026-V2.4 (20-page source)                    |
| Prepared               | 18 November 2026                                            |
| Coverage               | Seven consecutive project planning phases                   |
| Classification         | Confidential — Draft for management review                  |
| Authority              | Not a signed statement of work or development authorization |

## How to use this consolidated document

The seven phases appear consecutively in the order developed. Original
BRD requirements and recommended additions are differentiated where
material. Working figures, architecture selections and client decision
points remain provisional until verified and formally approved.
Interactive worksheets from the chat have been converted into printable
tables and checklists.

## Contents

1\. Phase 1 — Complete BRD Analysis & Gap Assessment

2\. Phase 2 — Revised End-to-End ERP Workflow & Client Approval
Blueprint

3\. Phase 3 — Functional & Technical Specification Blueprint

4\. Phase 4 — Detailed Module-Wise Specifications & Implementation
Architecture

5\. Phase 5 — Implementation Roadmap, Resource Plan & Cost Estimation

6\. Phase 6 — Final Client Proposal & Approval Package

7\. Phase 7 — Requirements Validation, Scope Freeze & Development
Readiness

**PHASE 1 / 7**

# Complete BRD Analysis & Gap Assessment

Objective: review every documented functional area, assess process
readiness, distinguish original scope from identified gaps, and
establish corrective recommendations.

Document status: Working proposal / not client-approved. No software
development or production deployment authorized.

## 1. Executive assessment

The 20-page BRD is a substantial foundation for chemical and
bio-agricultural manufacturing ERP. It describes nine-tier commercial
governance; 18 sales modules; six QC modules; 17 QA functions; 16
production functions; procurement, warehouse, logistics, invoicing,
document management and AWS hosting. It is not yet a final build-ready
specification: cross-module dependencies, transaction corrections,
exception handling and financial synchronization are insufficiently
detailed.

| **Dimension**         | **Assessment**     | **Reason**                                                          |
|-----------------------|--------------------|---------------------------------------------------------------------|
| Functional coverage   | Strong             | Broad module coverage across operational departments                |
| Workflow readiness    | Partial            | Exceptions and handovers are not consistently specified             |
| Regulatory controls   | Needs verification | Product-specific and evolving obligations need approved rules       |
| Development readiness | Not approved       | Client sign-off, exact field definitions and APIs remain incomplete |

## 2. Original BRD coverage

| **Functional area** | **Existing BRD coverage**                                                 | **Gap theme**                                             |
|---------------------|---------------------------------------------------------------------------|-----------------------------------------------------------|
| Access & governance | Four main admins, nine sales tiers, QC/QA/plant roles                     | Segregation of duties, override governance                |
| CRM and sales       | 18 submodules including pipeline, pricing, targets, beat plan and samples | Order amendments and conditional approvals                |
| Partners & products | Dealers, vendors, transporters, chemical SKUs                             | Conditional KYC, category-based licences, master controls |
| Commercial          | Quotation, order, invoice, taxes                                          | Credit, backorder, posting and correction flows           |
| Procurement         | RFQ, PO, three-way matching                                               | Purchase requisition, partials, disputes, returns         |
| Inventory           | Multi-warehouse, available/quarantine/reserved                            | Location stock ledger, expiry and adjustments             |
| Production          | 16 manufacturing modules                                                  | BOM version, exceptions, capacity, reconciliation         |
| QC                  | Six laboratory modules                                                    | Sample custody, raw-data integrity, lab status            |
| QA                  | 17 compliance modules                                                     | Final disposition, controlled document lifecycle          |
| Logistics           | Dispatch, LR, POD, box QR and offline scanner                             | Returns, scan conflicts, freight settlement               |
| Finance             | Partner ledgers, credit restrictions and GST summary                      | GL/finance integration, closing and reconciliation        |
| Cloud               | AWS conceptual layers                                                     | Operational targets, backup tests, cost and observability |

## 3. Existing process and core architectural weakness

The source business stages include Lead → Quotation → Sales Order →
Approval → Stock Check → Manufacturing / QC / QA → Dispatch → Invoice &
Ledger. However, not every order requires manufacturing, and purchases,
stock and finance operate as separate but connected lifecycles. The ERP
should explicitly support lead-to-cash, procure-to-pay and
plan-to-produce rather than force a single linear model.

## 4. Department-specific gap register

| **Department**          | **Missing or weak requirements**                                                                                           | **Recommendation**                                              |
|-------------------------|----------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------|
| Sales & CRM             | Duplicate capture; lead ownership transfers; lost reasons; quotation amendments; conditional approvals; territory handover | Connect lead-to-collection with versioned commercial decisions. |
| Dealer & vendor masters | Legal-entity-specific KYC; category licences; GST/PAN duplication; suspension and reactivation; bank detail verification   | Approved business-partner master with conditional onboarding.   |
| Procurement             | PR and budget approval; PO amendments; partial GRN; supplier returns; matching tolerances; advance settlement              | Control requisition-to-payment with traceable exceptions.       |
| Inventory               | Bins; FEFO/FIFO; in-transit transfers; cycle count; damaged/expired/rejected stock; UOM; negative stock prevention         | Immutable movements, reservations and quality restrictions.     |
| Manufacturing           | Effective-date BOM; order cancel/amend; shortages; substitutions; rework genealogy; maintenance and capacity               | Controlled production lifecycle and material genealogy.         |
| QC                      | Sample chain of custody; retest authorization; raw results; retention samples; reagent expiry; calibration lock            | Formal laboratory review and material dispositions.             |
| QA                      | Final disposition clarity; SOP effective dates; training effectiveness; CAPA effectiveness; retention; rework/reject       | Independent finished goods release and quality evidence.        |
| Logistics               | Partial delivery; RTO; damage; freight reconciliation; scan deduplication; offline conflict                                | Connected pick-pack-ship and returns workflow.                  |
| Finance                 | General ledger or finance adapter; bank reconciliation; AR/AP; credit notes; GST e-invoice; posting period lock            | Determine authoritative accounting system early.                |
| IT & Security           | Privilege approval; DR RTO/RPO; device security; retention/privacy; incident response; integrations monitoring             | Enforce secure and resilient enterprise operations.             |

## 5. Workflow correction priorities

### Sales approvals

The BRD proposes SE/TSM → ASM → SASM → RSM → ZSM → Accounts → Warehouse
while also defining approval thresholds for all nine tiers. Recommend a
policy engine that routes by amount, discount, territory, credit and
exception; material edits revalidate affected approvals. Client must
decide whether all signatures are mandatory.

### Procurement

Add PR, budget/authority approval and supplier selection, then PO →
GRN/quarantine → QC → supplier invoice/three-way match → AP settlement.
Handle partial receipts, price/tax mismatches, rejections and returns.

### QC/QA

Analytical approval and finished-goods disposition are separate. QC
determines the required testing result, while authorized QA reviews
manufacturing records, outstanding deviations and final commercial
release.

### Inventory

Available, quarantined and reserved are insufficient as mutually
exclusive stock states. Model physical stock, quality holds,
reservations, in-transit goods, expiry and damaged/rejected quantities
separately.

### Finance

The source describes ledgers and GST summaries but not complete
accounting. Decide early between native finance and integration to an
existing accounting platform.

### QR & mobile

Scan events must have globally unique IDs, server authority,
anti-duplication, reconciliation and distinct internal versus public
verification access.

## 6. Regulatory and standards verification register

| **Topic**                    | **Required correction / confirmation**                                                                                         |
|------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| ISO quality                  | BRD references ISO 9001:2015; determine current published revision, transition timetable and client certification obligations. |
| GST e-invoicing              | Confirm applicability, turnover, exclusions, IRN and signed QR response/cancellation requirements.                             |
| E-way bills                  | Specify generation/update/validity and exceptions, not merely storage of an E-way number.                                      |
| FCO / biostimulants          | Verify effective amendments, product category classification, registration and product specifications.                         |
| Pesticides / chemical safety | Verify actual licences, applicability of hazardous material requirements and transport obligations.                            |
| Privacy                      | Confirm applicable personal-data processing, KYC retention, access and notice requirements.                                    |
| Tax master                   | Use approved effective-dated HSN/GST policy; do not hardcode illustrative rate tables.                                         |
| 7-day quotation/PO validity  | Treat as a configurable commercial policy unless a specific statutory obligation is established.                               |
| GSTIN format                 | 15-character alphanumeric, not 15-digit.                                                                                       |
| KYC documents                | Do not universally demand five directors or three security cheques across all constitution types.                              |
| OEE                          | Use Availability × Performance × Quality; otherwise label output/planned capacity appropriately.                               |
| APK claims                   | URL parameters do not create installable APKs; specify packaging/deployment independently.                                     |

## 7. Priority gap register

| **ID** | **Priority** | **Issue**                                                |
|--------|--------------|----------------------------------------------------------|
| G01    | P0           | Finance accounting ownership and reconciliation          |
| G02    | P0           | QC/QA disposition boundaries                             |
| G03    | P0           | Stock state and ledger integrity                         |
| G04    | P0           | Conditional versus sequential order routing              |
| G05    | P0           | Applicable tax/product/licence rules                     |
| G06    | P0           | Privileged override and sensitive identity documents     |
| G07    | P1           | Purchase requisition, supplier returns and AP exceptions |
| G08    | P1           | BOM version, rework and production exceptions            |
| G09    | P1           | Dispatch returns and offline scan conflicts              |
| G10    | P1           | Migration and opening balances                           |
| G11    | P1           | Recovery, integration and operational services           |
| G12    | P2           | KPI/OEE and reporting definitions                        |
| G13    | P2           | Exact screen and field definitions                       |
| G14    | P2           | Optional AI/forecasting                                  |

## 8. Client approval sequence

1.  Confirm company sites, legal entities, volumes and current software.

2.  Approve master data ownership and identity/permission model.

3.  Approve commercial, credit, purchase and order workflows.

4.  Approve manufacturing, inventory, quality and logistics workflows.

5.  Approve accounting, invoice, collections and tax boundaries.

6.  Validate regulatory, security and exception control rules.

7.  Agree on phase priorities, reporting, acceptance and
    commercialization.

Phase 1 conclusion: Preserve the BRD as the baseline, correct workflow
assumptions and critical controls, and secure departmental sign-off
before making the system development-ready.

**PHASE 2 / 7**

# Revised End-to-End ERP Workflow & Client Approval Blueprint

Purpose: define department activities, responsibilities, approvals,
exceptions and cross-department handovers for client workflow
authorization.

Document status: Working proposal / not client-approved. No software
development or production deployment authorized.

## 1. Enterprise model and three operating cycles

Executive Management → Central Administration / Workflow Engine → Sales,
Procurement, Stores, Production, QC, QA, Logistics, Finance, Mobile and
Reporting. Shared records must have unique identifiers, ownership,
approval history, attachments and traceable outcomes.

| **Cycle**       | **Proposed sequence**                                                                                                 |
|-----------------|-----------------------------------------------------------------------------------------------------------------------|
| Lead-to-cash    | Lead → Dealer Verification → Quotation → Sales Order → Approval → Stock Allocation → Dispatch → Invoice → Collection  |
| Procure-to-pay  | Requirement → Purchase Requisition → RFQ → Supplier Evaluation → PO → GRN → QC → Invoice Match → Payment              |
| Plan-to-produce | Forecast / Demand → MRP → Production Order → Material Issue → Manufacturing → IPQC → QC → QA Release → Saleable Stock |

## 2. Department workflows

### Central Administration

Workflow: Create user or master request → verify documentation /
permissions → independent approval → activate → audit changes.

Primary owners: Admin / Master Data Owner

Exceptions: Conflicting records, expired permissions, unauthorized
privilege changes.

Client decision: Master ownership, delegation and independent privileged
approval.

### Dealer and Distributor Onboarding

Workflow: Sales registration → legal/tax/product licence verification →
commercial review → credit assessment → authorized approval →
activation.

Primary owners: Sales, Compliance and Finance

Exceptions: Duplicate GST/PAN, failed credit review, expired category
licence.

Client decision: Constitution-specific documents and approved
credit/security requirements.

### Sales and CRM

Workflow: Lead → BANT qualification → field visit or trial → opportunity
→ quote → dealer PO → order → approval → fulfillment → collections.

Primary owners: Sales, Managers and Accounts

Exceptions: Quote revisions, cancelled orders, price changes, shortage,
overdue credit.

Client decision: Sequential versus conditional approval policy.

### Quotation and Sales Order

Workflow: Validate quote items and policy → attach dealer PO → validate
product and credit → commercial approval → released stock
reservation/backorder → warehouse handover.

Primary owners: Commercial Owner / Finance

Exceptions: Expired quote, illegal edit, rejected order, shortage.

Client decision: Quotation period, amendment rules and credit exposure
model.

### Procurement

Workflow: Material demand → PR → budget approval → RFQ → comparative
evaluation → vendor selection → PO → gate entry → GRN/QC → invoice match
→ payment.

Primary owners: Requesting Dept, Purchase, QC, Accounts

Exceptions: Partial receipt, supplier return, excess quantity, price/tax
discrepancy.

Client decision: Purchase limits, single source and tolerance rules.

### Inventory

Workflow: Gate entry → GRN → lot/quarantine → QC result → eligible stock
→ issue/reserve/transfer/dispatch.

Primary owners: Stores and QC

Exceptions: Damage, physical count mismatch, expiry, negative
availability, transfer loss.

Client decision: Bins, valuation, FEFO/FIFO, adjustment authority.

### Production

Workflow: Demand/MRP → approved schedule/BOM → reserved released lots →
production execution → IPQC → packaging → QC → QA → stock release.

Primary owners: Plant / Stores / QC / QA

Exceptions: Material shortage, off-spec, downtime, rework, yield loss.

Client decision: Planning model, recipe authority, substitutions and
yield tolerance.

### QC

Workflow: Sample request → sample identification → lab test →
observations → independent review → CoA/approved results → disposition
input.

Primary owners: QC Analyst / QC Manager

Exceptions: OOS/OOT, failed calibration, retest, sample error.

Client decision: Sampling and raw-material disposition authorization.

### QA

Workflow: Batch-record review → QC and deviation verification → final
disposition → release / hold / reject; manage CAPA/SOP/recall.

Primary owners: QA Executive/Manager/Head

Exceptions: Open deviation, rejected batch, recall, rework.

Client decision: Final release delegation and unresolved-event policy.

### Logistics

Workflow: Approved allocation → pick/pack → box validation → vehicle/LR
→ compliant shipping documents → dispatch → POD → freight close.

Primary owners: Warehouse/Logistics/Accounts

Exceptions: Partial shipment, duplicated scan, freight dispute, RTO.

Client decision: Shipment-finalization event and returns responsibility.

### Mobile QR

Workflow: Authorized scan → local record if offline → sync → deduplicate
/ validate → accepted movement or exception.

Primary owners: Warehouse Operator / IT

Exceptions: Device loss, stale event, duplicate/cross-device scan.

Client decision: Hardware, online/offline operational requirements.

### Finance

Workflow: Invoice/posting → customer ledger → receipts/allocations →
reconciliation; supplier match → payable → payment.

Primary owners: Accounts / Finance Head

Exceptions: Failed external posting, partial receipt, adjustment,
reversal.

Client decision: Authoritative accounting system and tax posting
ownership.

### Executive MIS

Workflow: Use governed records → calculate per-role KPI → filter and
report → evidence-backed decision.

Primary owners: Management and Data Owners

Exceptions: Incorrect metric definition, stale sync, unauthorized
export.

Client decision: KPI formulas, refresh rates and report access.

## 3. Cross-department handovers

| **Event**                   | **From → To**                | **Gate**                                      |
|-----------------------------|------------------------------|-----------------------------------------------|
| Dealer activation           | Sales → Finance/Admin        | Commercial and KYC approval                   |
| Sales order for fulfillment | Sales → Accounts/Stores      | Commercial and credit authorization           |
| Material demand             | Plant/MRP → Purchase         | Approved PR                                   |
| Receipt                     | Stores → QC                  | GRN and quarantined lot                       |
| QC-approved material        | QC → Stores/Plant            | Material disposition and lot eligibility      |
| Production completion       | Plant → QC/QA                | Completed batch record and testing            |
| FG release                  | QA → Warehouse               | Authorized release                            |
| Shipment handover           | Warehouse → Logistics        | Pick, box and document checks                 |
| Delivery                    | Logistics → Finance          | POD, quantities and freight evidence          |
| Complaint or return         | Sales → QA/Logistics/Finance | Approved case and linked original transaction |

## 4. Shared exception-handling rules

| **Situation**        | **Required response**                                             |
|----------------------|-------------------------------------------------------------------|
| Licence expired      | Restrict affected product-category transactions and notify owners |
| Credit breach        | Hold prohibited credit sales or route for authorized exception    |
| Order amended        | Recompute price/tax/credit/stock and reapprove affected gates     |
| QC failed            | Block material, investigate and disposition                       |
| QA open deviation    | Prohibit final release until authorized closure/disposition       |
| Production shortage  | Hold/partially schedule and request replenishment                 |
| Partial dispatch     | Post only scanned and confirmed quantities                        |
| Return after invoice | Control physical, tax and financial adjustments                   |
| Offline conflict     | Queue for server-side reconciliation and operator resolution      |

## 5. Client decisions and departmental approvals

| **Decision ID** | **Question**                                          |
|-----------------|-------------------------------------------------------|
| D01             | Sales order approval hierarchy                        |
| D02             | Native accounting versus external finance integration |
| D03             | Make-to-stock versus make-to-order/hybrid             |
| D04             | QC versus QA disposition responsibility               |
| D05             | Stock reservation, location and lot controls          |
| D06             | Purchase approvals and emergency procurement          |
| D07             | Conditional dealer onboarding/KYC                     |
| D08             | Current statutory obligations and product taxonomy    |
| D09             | Android/PWA hardware and offline synchronization      |
| D10             | Legacy sources and migration opening balances         |
| D11             | Communication alerts and escalations                  |
| D12             | First-release scope and exclusions                    |

Suggested departmental sign-off: Managing Director, Executive Director,
Sales, Purchase, Stores, Plant, QC, QA, Logistics, Finance and ERP/IT.
Shared workflows require agreement from all affected owners. Phase 2
conclusion: Proposed, not yet formally approved.

**PHASE 3 / 7**

# Functional & Technical Specification Blueprint

Purpose: translate proposed workflows into module inventory, principal
screens, fields, business validations, shared data and acceptance
criteria.

Document status: Working proposal / not client-approved. No software
development or production deployment authorized.

## 1. Functional architecture

ERP web portal and mobile clients access a controlled application/API
layer with separate logical business domains. Transactional data, secure
document storage, approval workflow, events, notifications and reports
are centrally governed. Shared masters represent the authoritative
organizational, commercial and item records.

## 2. Module inventory

| **Module**         | **Functional coverage**                             | **Treatment** |
|--------------------|-----------------------------------------------------|---------------|
| M01 Administration | Users, roles, approval policies, audit and settings | Strengthen    |
| M02 Master Data    | Parties, product, location, warehouse, legal entity | Expand        |
| M03 Sales & CRM    | All 18 original submodules                          | Retain        |
| M04 Commercial     | Quote, order, approval, fulfillment                 | Correct       |
| M05 Procurement    | PR, RFQ, PO, GRN matching and supplier return       | Expand        |
| M06 Inventory      | Location, ledger, lot, reservation and adjustment   | Expand        |
| M07 Production     | All 16 original functions                           | Retain        |
| M08 QC             | Six original laboratory modules                     | Retain        |
| M09 QA             | 17 original quality modules                         | Retain        |
| M10 Logistics      | Pick, dispatch, LR, POD, freight and returns        | Expand        |
| M11 Mobile & QR    | Serialization, scan, offline, verification          | Strengthen    |
| M12 Finance        | AR/AP, invoice, posting/reconciliation              | Conditional   |
| M13 MIS            | Role KPI, dashboards and custom reports             | Correct       |
| M14 Integrations   | Communication, accounting, GST and queues           | Specify       |

## 3. Master records

| **Master**              | **Principal fields**                               | **Owner**           |
|-------------------------|----------------------------------------------------|---------------------|
| Legal Entity            | Name, code, PAN/GSTIN, registered address          | Corporate/Finance   |
| Plant / Warehouse / Bin | Location ID, company, capacity and status          | Plant / Stores      |
| Employee and Role       | Name, manager, department, role, scope, status     | HR / IT             |
| Dealer                  | Legal name, tax ID, licence, credit, territory     | Sales / Finance     |
| Vendor                  | Identity, items, qualification, banking            | Purchase            |
| Transporter             | Permit, SLA, vehicle coverage, banking             | Logistics           |
| Product & Pack          | SKU, formula, pack, UOM, HSN, tax                  | Product Owner       |
| Material / Packaging    | Item, UOM, category, spec, safety                  | Production / Stores |
| BOM / Recipe            | Version, inputs, quantities, yield, effective date | Plant / QA          |
| Test Spec / Instrument  | Methods, limits, calibration, effective date       | QC / QA             |

## 4. Module-level principal screens and functions

### Administration

User directory; role matrix; workflow approvals; delegation; audit
viewer; configuration and template controls.

### Party onboarding

Dealer/vendor/transporter directory; create/edit forms; file
verification; credit; licences; partner 360.

### Sales and CRM

Lead/BANT; opportunities Kanban; beat plans; activity logs; samples;
trials; targets; competitor information; pricing; debt monitoring;
dashboards.

### Quotations and orders

Quote register/editor; PO attachment; sales order details; decision
inbox; credit validation; allocation and backorder.

### Procurement

PR; RFQ; supplier comparative statement; purchase order; delivery
tracking; invoice matching; supplier return.

### Inventory

GRN; stock ledger; warehouse/bin view; reservation; issue; transfer;
adjustments; expiry/hold/rejection.

### Manufacturing

MRP; schedule; BOM; production order; material dosing; batch execution;
IPQC; yield/loss; packaging; cost and genealogy.

### QC

Sampling; lab worklist; observations; CoA; OOS/OOT; calibration; raw lot
disposition.

### QA

SOP/document version; change/deviation; CAPA; NC; batch review; audits;
training; quality risk; complaints; recall.

### Logistics

Dispatch queue; picking; packing; shipment assignment; scan validation;
shipping documents; LR/POD; freight; returns.

### Mobile

Task queue; camera/industrial QR scan; local event queue; sync; scan
history; product authentication.

### Finance

Invoices; credit; receipt allocation; AP matching; accounting sync;
reconciliation; period-close controls.

### MIS

Executive dashboard; sales, supply, production, quality, logistics and
finance reports; export policy.

## 5. Data design conventions

- Every transaction has immutable internal ID, readable document number,
  organizational scope, date, status, initiator, version and linked
  source records.

- Data master changes are effective-dated when material and subject to
  approvals.

- Inventory balances derive from controlled movements and reservations,
  not editable item quantity fields.

- Financial postings require acknowledgments, reversal trails and
  reconciliation against the authoritative ledger.

- Batch genealogy links approved finished goods to exact raw-material
  lots, packaging and QC/QA records.

- No hard deletion of posted stock, approved quality data or financial
  documents.

## 6. Validations and controls

| **Record**      | **Validation**                                                         |
|-----------------|------------------------------------------------------------------------|
| GSTIN           | Fifteen alphanumeric characters; verify business context               |
| Product         | Unique SKU, active item and effective tax/quality policy               |
| Quotation       | Approved price, validity, quantity and calculation                     |
| Sales Order     | Active dealer, role/territory, approved discount, credit and stock     |
| GRN             | Link source PO/exception; assign traceable lot and quarantine          |
| Inventory Issue | Positive eligible quantity; approved lot and purpose                   |
| Production      | Valid BOM revision, approved materials, controlled parameters          |
| QC              | Effective specification, authorized result and calibration             |
| QA Release      | Completed relevant QC, batch review and deviation assessment           |
| Dispatch        | Valid allocation, serials, quantities and release status               |
| Finance         | Source-document integrity, duplicate control and posting-period checks |

## 7. Acceptance matrix

| **UAT ID** | **Scenario**                      | **Expected**                               |
|------------|-----------------------------------|--------------------------------------------|
| 01         | Register valid dealer             | Active only after approvals                |
| 02         | Expired product licence           | Affected transaction blocked               |
| 03         | Standard price order              | Correct approval path                      |
| 04         | Excess discount/credit            | Exception authority required               |
| 05         | Change approved order             | Prior relevant approval invalidated        |
| 06         | Partial purchase receipt          | Outstanding quantity preserved             |
| 07         | Failed raw material QC            | Material blocked                           |
| 08         | Production consumes released lots | Genealogy correct                          |
| 09         | Unresolved QA deviation           | Batch release prevented                    |
| 10         | Scan same box twice               | Conflicting operation rejected             |
| 11         | Partial customer payment          | Outstanding correctly allocated            |
| 12         | Invoiced return                   | Stock/tax/financial corrections reconcile  |
| 13         | Unauthorized user action          | Access denied and logged                   |
| 14         | Accounting timeout                | No duplicate posting on retry              |
| 15         | Recall batch                      | Affected inventory and customers traceable |

Phase 3 conclusion: The functional structure and baseline control model
are prepared. Full screen field dictionary, detailed API contracts,
physical ERD and formal decisions remain pending.

**PHASE 4 / 7**

# Detailed Module-Wise Specifications & Implementation Architecture

Purpose: establish preliminary screen groups, technical modules, data
relationships, transaction lifecycle, APIs, cloud topology,
mobile/offline logic and tests.

Document status: Working proposal / not client-approved. No software
development or production deployment authorized.

## 1. Proposed technology and application structure

| **Layer**          | **Recommended direction**                    | **Reason**                                     |
|--------------------|----------------------------------------------|------------------------------------------------|
| Frontend           | React + TypeScript                           | Reusable, consistent enterprise UX             |
| Backend            | Node.js + TypeScript (structured framework)  | Domain boundaries and API contracts            |
| Database           | PostgreSQL                                   | Relational transactions and constraints        |
| Application design | Modular monolith initially                   | Simpler consistency and operational deployment |
| File storage       | Private S3-compatible object storage         | Controlled documents and evidence              |
| Workers            | Durable queue and independent processing     | Reliable notifications, PDFs, external sync    |
| Mobile             | PWA or packaged Android after device testing | Offline scan and field work                    |
| Identity           | Managed/central identity, strong MFA         | Security, access and audit                     |
| Cloud              | AWS-based managed hosting option             | Aligns with initial BRD direction              |

## 2. Module screen-and-field register (principal groups)

### M01 Administration

| **Screen**        | **Principal fields**                                   | **Actions**               |
|-------------------|--------------------------------------------------------|---------------------------|
| User Directory    | Employee, department, manager, role, territory, status | Create, suspend, activate |
| Role Matrix       | Module/action/scope/effective date                     | Propose, approve          |
| Approval Policies | Document type, thresholds, approver, SLA               | Simulate, publish         |
| Audit Viewer      | Actor, action, old/new, object, time                   | Search, investigate       |

### M02 Masters

| **Screen**         | **Principal fields**                              | **Actions**       |
|--------------------|---------------------------------------------------|-------------------|
| Dealer Master      | Code, legal name, constitution, GST, PAN, contact | Create, verify    |
| Commercial Profile | Credit days, amount, targets, price group         | Approve, revise   |
| Licence Vault      | Category, number, issuer, expiry, evidence        | Verify, block     |
| Vendor/Transport   | Rating, category, permits, SLA, banking           | Onboard, suspend  |
| Product/Location   | SKU, formulation, pack, UOM, warehouses, bins     | Version, activate |

### M03 Sales CRM

| **Screen**           | **Principal fields**                   | **Actions**      |
|----------------------|----------------------------------------|------------------|
| Leads/BANT           | Source, contact, need, budget, owner   | Qualify, assign  |
| Opportunities        | Stage, value, win%, date               | Advance, close   |
| Activities/Beat      | Rep, route, GPS, visit, follow-up      | Log, schedule    |
| Sample/Trial         | Batch, crop, dosage, agronomy outcomes | Request, assess  |
| Pricing/Target       | Rate, discount, contract, zone quota   | Submit, approve  |
| Collection/Analytics | Invoices, aging, territory KPIs        | Escalate, report |

### M04 Quotation/Orders

| **Screen**       | **Principal fields**                      | **Actions**             |
|------------------|-------------------------------------------|-------------------------|
| Quotation        | Dealer, date, validity, multi-item, taxes | Create, revise, print   |
| Dealer PO        | Reference, image/PDF, linked quote        | Attach, verify          |
| Order Approval   | Lines, terms, credit, workflow states     | Submit, approve, reject |
| Stock Allocation | Batch, available, reserved, shortage      | Reserve, backorder      |

### M05 Procurement

| **Screen**           | **Principal fields**                    | **Actions**       |
|----------------------|-----------------------------------------|-------------------|
| Purchase Requisition | Item, qty, cost centre, date, reason    | Submit, approve   |
| RFQ/Comparison       | Vendors, price, freight, tax, quality   | Evaluate, select  |
| Purchase Order       | Vendor, item, rate, terms, destination  | Approve, issue    |
| Invoice Match        | PO, GRN, invoice, tolerances            | Review, post      |
| Supplier Returns     | Original receipt, lot, reason, quantity | Authorize, settle |

### M06 Inventory

| **Screen**        | **Principal fields**                          | **Actions**         |
|-------------------|-----------------------------------------------|---------------------|
| GRN               | Vehicle, PO, item, supplier lot, received qty | Receipt, quarantine |
| Stock Ledger      | Item, lot, bin, movement, running qty         | View, reconcile     |
| Issue/Transfer    | From, to, lot, quantity, reference            | Approve, post       |
| Adjustment/Expiry | Physical count, variance, reason, expiry      | Approve, block      |

### M07 Manufacturing

| **Screen**     | **Principal fields**                      | **Actions**        |
|----------------|-------------------------------------------|--------------------|
| Planning/MRP   | Demand, availability, lead time, plan     | Calculate, release |
| BOM/Work Order | Version, inputs, planned output, line     | Approve, schedule  |
| Dosing/IPQC    | Material lots, actual qty, observations   | Record, hold       |
| Yield/Rework   | Inputs, outputs, loss, scrap, disposition | Review, approve    |
| Packaging/Cost | Pack serial, output, overhead, cost/MT    | Complete, report   |

### M08 QC

| **Screen**      | **Principal fields**                            | **Actions**           |
|-----------------|-------------------------------------------------|-----------------------|
| Sample Worklist | Sample, spec, method, analyst, instrument       | Assign, test          |
| Results/CoA     | Parameter, result, limits, evidence, signatures | Review, approve       |
| OOS/OOT         | Investigation, root cause, retest               | Resolve               |
| Calibration     | Instrument, due date, status                    | Restrict, verify      |
| Disposition     | Lot, result, officer, timestamp                 | Release, reject, hold |

### M09 QA

| **Screen**        | **Principal fields**                             | **Actions**           |
|-------------------|--------------------------------------------------|-----------------------|
| SOP/Change        | Doc no, revision, owner, effectivity             | Approve, publish      |
| Deviation/CAPA    | Incident, cause, task, evidence, effective check | Review, close         |
| Batch Review      | BMR/BPR, QC, outstanding deviation               | Release, reject, hold |
| Audit/Training    | Schedule, qualification, findings                | Track, approve        |
| Complaints/Recall | Case, batch, dealer, investigation               | Contain, recall       |

### M10 Logistics

| **Screen**         | **Principal fields**                       | **Actions**       |
|--------------------|--------------------------------------------|-------------------|
| Dispatch Queue     | Approved order, priority, warehouse        | Plan              |
| Pick/Pack/Scan     | Lot, serial, ordered/packed qty            | Scan, verify      |
| Shipment/LR        | Carrier, vehicle, route, challan, LR       | Assign, dispatch  |
| POD/Freight/Return | Delivery result, charges, shortage, return | Reconcile, settle |

### M11 Mobile

| **Screen**    | **Principal fields**                  | **Actions**    |
|---------------|---------------------------------------|----------------|
| QR Scanner    | Code, user, device, transaction       | Scan, validate |
| Offline Queue | Event ID, local time, sync status     | Retry, resolve |
| Serial Trace  | Box, batch, movement history          | Verify         |
| Public Verify | Token and limited authenticity fields | Check          |

### M12 Finance

| **Screen**     | **Principal fields**                 | **Actions**      |
|----------------|--------------------------------------|------------------|
| Invoice/Credit | Order, tax, invoice, limit           | Issue, review    |
| Receipt/AP     | Amount, allocation, due date, PO/GRN | Allocate, settle |
| Posting/Close  | Posting ID, ledger, period, sync     | Post, reconcile  |

### M13 MIS

| **Screen**         | **Principal fields**                     | **Actions**     |
|--------------------|------------------------------------------|-----------------|
| Executive Reports  | Sales, stock, production, overdue, holds | Filter          |
| Department Reports | Quality, finance, purchase, logistics    | Export          |
| Report Builder     | Dataset, fields, permission, schedule    | Create, publish |

## 3. Conceptual database entity domains

| **Domain**    | **Proposed tables**                                                      |
|---------------|--------------------------------------------------------------------------|
| Organization  | legal_entities; plants; warehouses; warehouse_bins; territories          |
| Security      | users; roles; permissions; role_assignments; delegations; audit_events   |
| Partner       | business_parties; party_contacts; party_licences; credit_profiles        |
| Items         | items; item_pack_variants; uom_conversions; tax_rules                    |
| Sales         | leads; opportunities; quotations; quote_lines; sales_orders; order_lines |
| Workflow      | workflow_versions; approval_requests; steps; decisions                   |
| Purchase      | purchase_requisitions; rfqs; purchase_orders; goods_receipts             |
| Inventory     | inventory_lots; stock_movements; stock_reservations; stock_transfers     |
| Manufacturing | bom_versions; production_orders; batch_records; material_consumptions    |
| QC/QA         | qc_samples; results; coa; deviations; capa; qa_dispositions; recalls     |
| Logistics     | shipments; shipment_lines; box_serials; scan_events; delivery_proofs     |
| Finance       | invoices; receipts; allocations; accounting_postings                     |
| Integration   | outbox_events; integration_jobs; external_references                     |

These are conceptual names and data boundaries, not finalized physical
schemas. Important many-to-many relationships and invariants must be
modelled explicitly.

## 4. Transaction state models

### Sales Order

Normal path: Draft → Submitted → Commercial Review → Credit Review →
Approved → Allocated/Backordered → Fulfilled → Closed

Exception path(s): Rejected / On Hold / Cancelled

### Purchase Order

Normal path: Draft → Submitted → Approved → Issued → Acknowledged →
Partially/Fully Received → Closed

Exception path(s): Hold / Rejected / Cancelled

### Raw Material Lot

Normal path: GRN → Quarantined → Sampled → QC Reviewed → Released →
Consumed/Transferred

Exception path(s): Held / Rejected / Returned / Expired

### Production Batch

Normal path: Planned → Approved → Reserved → In Progress → Completed →
QC → QA → Closed

Exception path(s): On Hold / Rework / Rejected

### Shipment

Normal path: Planning → Picking → Packed → Loaded → Dispatched → In
Transit → Delivered → Closed

Exception path(s): Partial / Damaged / Returned / Disputed

### CAPA

Normal path: Logged → Triaged → Investigation → Plan → Implementation →
Effectiveness → Closed

Exception path(s): Reopened / Escalated

## 5. Roles and permission model

| **Action**              | **Required control**                               |
|-------------------------|----------------------------------------------------|
| View/Create/Edit        | Role + object + territory + state scope            |
| Submit/Approve/Reject   | Authority and maker-checker validation             |
| Amend approved document | Revision creation; impacted approvals invalidated  |
| Release material/batch  | Quality-specific delegated authority               |
| Post or reverse ledger  | Finance permissions, period and audit controls     |
| Override                | Independent exceptional authorization and evidence |
| Export sensitive data   | Permission, purpose and audit event                |

## 6. Proposed API boundary samples

| **Method** | **Route**                            | **Function**      |
|------------|--------------------------------------|-------------------|
| POST       | /api/v1/dealers                      | Create dealer     |
| POST       | /api/v1/quotations                   | Create quote      |
| POST       | /api/v1/sales-orders/{id}/submit     | Submit order      |
| POST       | /api/v1/approvals/{id}/decisions     | Record decision   |
| POST       | /api/v1/purchase-requisitions        | Create PR         |
| POST       | /api/v1/goods-receipts               | Record GRN        |
| GET        | /api/v1/inventory/lots/{id}          | Lot details       |
| POST       | /api/v1/production-orders            | Create work order |
| POST       | /api/v1/qc/samples/{id}/results      | Record lab result |
| POST       | /api/v1/qa/batches/{id}/dispositions | QA disposition    |
| POST       | /api/v1/shipments/{id}/dispatch      | Confirm dispatch  |
| POST       | /api/v1/scans/batches                | Sync scans        |
| GET        | /api/v1/reports/{id}                 | Run report        |

Each route requires typed payloads, authorization, error codes, API
version, idempotency where needed, event/audit behavior and test
specification. Integration transaction outbox and durable workers should
separate business commits from asynchronous notifications.

## 7. Mobile/offline scanning design

8.  Authorize user and device; download permitted limited task data.

9.  Record locally unique scan event with actor, device, time and
    intended transaction.

10. Store events in encrypted local store while offline.

11. On reconnection, submit events with idempotency identifiers.

12. Server validates current shipment/stock/serial status and rejects
    conflicts.

13. Return accepted, rejected and pending states for operator
    reconciliation.

## 8. Cloud, non-functional controls and testing

| **Layer**   | **Requirement**                                                   |
|-------------|-------------------------------------------------------------------|
| Web hosting | Secure CDN and HTTPS on approved domain                           |
| Application | Managed container or app platform, private networking             |
| Database    | PostgreSQL backups, high availability and restore tests           |
| Documents   | Private encrypted storage, controlled access URLs                 |
| Worker      | Durable queued tasks with retries and dead-letter handling        |
| Security    | MFA, RBAC, encryption, audit protection and vulnerability reviews |
| Operations  | Metrics, alerting, logs and documented incident response          |
| Recovery    | Approved RPO/RTO and tested disaster recovery                     |
| Testing     | Unit, API, integration, security, load, mobile, UAT, recovery     |

## 9. Pre-coding specification artifacts

- Full FRS and screen-level field register with all
  mandatory/conditional inputs.

- Physical ERD and complete data dictionary.

- OpenAPI request-response contracts and event dictionary.

- State-transition matrices and permissions/segregation matrix.

- Integration provider specification, recovery and reconciliation rules.

- Security, privacy, performance, backup and retention targets.

- Migration design and complete UAT test scripts.

Phase 4 conclusion: A proposed system-level design is documented, but
detailed engineering artifacts and client decisions remain necessary
before programming.

**PHASE 5 / 7**

# Implementation Roadmap, Resource Planning & Cost Estimation

Purpose: define delivery options, release dependencies, resources,
preliminary estimates, migration, commercial milestones and risk
management.

Document status: Working proposal / not client-approved. No software
development or production deployment authorized.

## 1. Three scope and budget scenarios

| **Option**              | **Indicative custom build scope**                                                                 | **Duration**  | **Planning cost**   |
|-------------------------|---------------------------------------------------------------------------------------------------|---------------|---------------------|
| A — Operational Pilot   | One site; representative sales, purchase, inventory, batch/QC/QA and dispatch flow                | 5–7 months    | ₹35–65 lakh         |
| B — Integrated Core ERP | Masters, sales, procurement, stock, production, essential quality, logistics, finance integration | 9–15 months   | ₹85 lakh–₹1.5 crore |
| C — Complete Enterprise | All approved BRD functions, advanced quality, mobile/offline, multi-site and analytics            | 15–24+ months | ₹1.6–3 crore+       |

Indicative consultant planning allowances only; not binding vendor
quotes. Exclude GST, licences, hardware, hosting, maintenance, unusual
migration and uncontracted functions unless included explicitly.

## 2. Reference integrated-core roadmap

| **Workstream**               | **Illustrative months** | **Gate**                      |
|------------------------------|-------------------------|-------------------------------|
| Discovery / FRS              | 1–2                     | Signed baseline               |
| Foundation / Masters         | 2–4                     | Access and master tests       |
| Sales & Procurement          | 4–7                     | Order and PO UAT              |
| Inventory / Manufacturing    | 5–9                     | Stock and batch UAT           |
| QC/QA / Dispatch             | 6–10                    | Quality-to-delivery UAT       |
| Finance / Integrations       | 7–10                    | Posting and reconciliation    |
| Testing / Migration / Launch | 9–12                    | Controlled go-live acceptance |

## 3. Resource plan

| **Role**                          | **Approximate staffing** | **Responsibility**                |
|-----------------------------------|--------------------------|-----------------------------------|
| Project Manager                   | 0.5–1 FTE                | Schedule, issues and coordination |
| Business Analyst / ERP Functional | 1–2 FTE                  | Requirements, SOP, UAT            |
| Solution Architect                | 1 FTE                    | Design and technical governance   |
| Backend Developers                | 2–3 FTE                  | Rules, APIs, database             |
| Frontend Developers               | 2 FTE                    | Web applications                  |
| UX Designer                       | 0.5 FTE                  | Design system and screens         |
| QA Engineers                      | 1–2 FTE                  | Regression, integration, UAT      |
| Cloud/DevOps                      | 0.5 FTE                  | Deployments and monitoring        |
| Migration / Integration           | 0.5–1 FTE                | Mapping and reconciliation        |
| Security / Compliance             | Part-time                | Independent control review        |

Client staffing includes executive sponsor, project owner and Sales,
Purchase, Stores, Plant, QC, QA, Finance and IT representatives. FTE
allocations fluctuate by delivery stage.

## 4. Integrated core preliminary work-package budget

| **Work Package**                            | **Budget (₹ lakh)** |
|---------------------------------------------|---------------------|
| Discovery, business requirements and FRS    | 8                   |
| Foundation, security, workflows, masters    | 14                  |
| Sales/CRM/quotations/order management       | 14                  |
| Procurement and inventory                   | 20                  |
| Manufacturing / batch control               | 20                  |
| Essential QC and QA                         | 16                  |
| Logistics and dispatch                      | 9                   |
| Finance interface and standard integrations | 9                   |
| Migration, UAT, training and go-live        | 12                  |
| Base                                        | 122                 |
| 15% contingency                             | 18.30               |
| Illustrative total                          | 140.30              |

Example total ₹1.403 crore inclusive of the stated 15% contingency on
₹1.22 crore base. Not a contract price. Native full accounting, entire
specialized QA, substantial mobile/IoT and multi-plant rollout may
require separate costing.

## 5. Illustrative monthly cloud allowances

| **Service category**            | **Pilot monthly** | **Integrated production monthly** |
|---------------------------------|-------------------|-----------------------------------|
| Compute/load balancing          | ₹5k–15k           | ₹12k–35k                          |
| Database/backup                 | ₹7k–20k           | ₹15k–45k                          |
| Storage/documents               | ₹1k–4k            | ₹2k–10k                           |
| Network/CDN/security/monitoring | ₹4k–12k           | ₹10k–30k                          |
| Queue/secrets/supporting        | ₹1k–5k            | ₹3k–10k                           |
| Estimated subtotal              | ₹18k–56k          | ₹42k–1.30L                        |

These are allowance ranges and not actual cloud calculator quotations;
approve workload assumptions and the target AWS region before quoting.
Separate communication, GST provider, finance software, support and
maintenance fees.

## 6. Milestone payments and acceptance

| **Milestone**           | **Proposed %** | **Acceptance gate**               |
|-------------------------|----------------|-----------------------------------|
| Initiation/discovery    | 10%            | Contract and charter              |
| FRS and scope baseline  | 15%            | Signed design baseline            |
| Foundation              | 15%            | Access/masters tested             |
| Commercial and purchase | 15%            | Departmental UAT                  |
| Production and quality  | 20%            | Quality and genealogy UAT         |
| End-to-end UAT          | 15%            | Reconciliation and critical tests |
| Go-live/stabilization   | 10%            | Formal launch acceptance          |

## 7. Migration and rollout

14. Inventory existing systems and data sources.

15. Assign owners and cleanse party, product, financial, quality and
    stock records.

16. Map IDs, units, statuses, opening balances and references.

17. Trial migrate into non-production and reconcile.

18. Rehearse cutover with inventory physical count and financial
    balances.

19. Pilot on one site/limited team, stabilize, then expand in waves.

## 8. Delivery risks

| **Risk**               | **Mitigation**                                           |
|------------------------|----------------------------------------------------------|
| Workflow ambiguity     | Approve process and exception routing before engineering |
| Scope creep            | Formal change-request process                            |
| Legacy data errors     | Test migrations and signed reconciliation                |
| QC/QA bypass           | System-enforced release gate and independent UAT         |
| Financial duplicates   | Idempotency, reconciliation, corrective posting          |
| Offline scan conflicts | Server-authoritative validation                          |
| Operational adoption   | Department champions, training and supervised go-live    |
| Vendor lock-in         | Source/data access, ownership and exit clauses           |

Phase 5 conclusion: A phased integrated-core plan is the preferred
budgeting model, preceded by build-vs-adapt review. Final cost, duration
and staffing must follow signed scope and real operational volumes.

**PHASE 6 / 7**

# Final Client Proposal & Approval Package

Purpose: provide a management-facing narrative, signed
workflow/functional/commercial approvals, responsibilities and decision
annexures.

Document status: Working proposal / not client-approved. No software
development or production deployment authorized.

## 1. Formal executive proposal

Dhruv Agro Technologies Pvt. Ltd. intends to implement Enterprise ERP
2.0 to unify chemical and bio-agricultural manufacturing, distribution,
procurement, quality, logistics and finance. The existing BRD provides a
broad functional basis. The recommended approach preserves documented
business requirements while strengthening cross-department handovers,
approval logic, inventory integrity, quality disposition, financial
reconciliation and governance.

The objective is not simply to digitize existing forms: it is to
establish an integrated, controlled, traceable and efficient operating
system.

## 2. Business outcomes and scope

- Centralized verified partner, product, material, employee and location
  masters.

- A connected lead-to-cash commercial lifecycle and credit controls.

- Controlled purchase-to-pay, GRN and material-release processes.

- Manufacturing execution against approved BOM versions and exact
  raw-material lots.

- Independent QC testing and QA disposition for relevant finished goods.

- Batch/box traceability from inward supply through outward shipment.

- Reliable invoice, payment and financial reconciliation.

- Management dashboards with governed metric definitions and secure
  access.

## 3. Department operating model for client review

| **Department**                    | **Client-facing summary of approved target workflow**                                                                                          |
|-----------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| Dealer and Distributor Onboarding | Sales registration → legal/tax/product licence verification → commercial review → credit assessment → authorized approval → activation.        |
| Sales and CRM                     | Lead → BANT qualification → field visit or trial → opportunity → quote → dealer PO → order → approval → fulfillment → collections.             |
| Procurement                       | Material demand → PR → budget approval → RFQ → comparative evaluation → vendor selection → PO → gate entry → GRN/QC → invoice match → payment. |
| Inventory                         | Gate entry → GRN → lot/quarantine → QC result → eligible stock → issue/reserve/transfer/dispatch.                                              |
| Production                        | Demand/MRP → approved schedule/BOM → reserved released lots → production execution → IPQC → packaging → QC → QA → stock release.               |
| QC                                | Sample request → sample identification → lab test → observations → independent review → CoA/approved results → disposition input.              |
| QA                                | Batch-record review → QC and deviation verification → final disposition → release / hold / reject; manage CAPA/SOP/recall.                     |
| Logistics                         | Approved allocation → pick/pack → box validation → vehicle/LR → compliant shipping documents → dispatch → POD → freight close.                 |
| Finance                           | Invoice/posting → customer ledger → receipts/allocations → reconciliation; supplier match → payable → payment.                                 |

## 4. Proposed improvement register

| **Area**      | **Improvement for consideration**                             |
|---------------|---------------------------------------------------------------|
| Sales         | Conditional authority and order amendment controls            |
| Dealer        | Entity- and licence-specific onboarding                       |
| Purchase      | PR, tolerance rules and supplier returns                      |
| Stock         | Location-level ledger and controlled adjustments              |
| Manufacturing | Effective-dated BOM and rework genealogy                      |
| QC            | Sampling, CoA and laboratory evidence controls                |
| QA            | Final release ownership and quality case lifecycle            |
| Logistics     | Partial delivery and reverse logistics                        |
| Finance       | Complete posting/reconciliation architecture                  |
| Security      | Maker-checker, restricted overrides and auditable permissions |

## 5. Proposed implementation stages

20. Requirements confirmation and scope agreement.

21. Foundation and master-data configuration/build.

22. Commercial and procurement flows.

23. Stock, production and material traceability.

24. QC/QA release and dispatch.

25. Finance and external integrations.

26. Integrated testing, migration, training and controlled go-live.

## 6. Commercial options (indicative)

| **Package**     | **Duration**  | **Budget**  |
|-----------------|---------------|-------------|
| Pilot           | 5–7 months    | ₹35–65 lakh |
| Core ERP        | 9–15 months   | ₹85L–1.5Cr  |
| Full Enterprise | 15–24+ months | ₹1.6–3Cr+   |

Quotes require validated scope, approved infrastructure assumptions,
provider licence obligations, staffing and agreed delivery terms. A
build-versus-adapt assessment is recommended before choosing full custom
build.

## 7. Client responsibilities

- Nominate project sponsor and empowered coordinator.

- Assign department process owners and approve revised workflows.

- Provide source documents, real transactions and existing system access
  when agreed.

- Validate statutory quality and tax requirements through appropriate
  advisers.

- Provide reliable data, opening balances and migration verification.

- Participate in UAT, change decisions, training and launch acceptance.

## 8. Implementation partner responsibilities

- Deliver agreed specifications, architecture, code/configuration and
  integrations under signed SOW.

- Maintain traceability between requirement, workflow, implementation
  and test evidence.

- Test and remedy defects according to contract.

- Support migration, training, deployment and stabilization within
  scope.

- Provide agreed documentation, ownership and support/exit conditions.

## 9. Approval stages

| **Approval**              | **Meaning**                                                                                 |
|---------------------------|---------------------------------------------------------------------------------------------|
| A — Workflow              | Business processes, actors, exceptions and departmental handovers are reviewed and accepted |
| B — Functional Scope      | Requirements, enhancements, exclusions and release priorities are accepted                  |
| C — Commercial & Delivery | Schedule, costs, obligations, acceptance, warranty and support are contractually agreed     |
| Development Authorization | Explicit separate instruction after required approvals; not implied by proposal approval    |

## 10. Sign-off table

| **Designation**         | **Decision** | **Signature / Date**                 |
|-------------------------|--------------|--------------------------------------|
| Managing Director       | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| Executive Director      | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| Sales Head              | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| Purchase Head           | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| Plant Head              | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| Stores & Logistics Head | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| QC Head                 | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| QA Head                 | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| Finance Head            | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |
| ERP/IT Project Owner    | Pending      | \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_ |

Approval choices: Approved / Approved with Changes / Revision Required /
Rejected. Capture outstanding conditions and amended annexure revisions.
Approval of an earlier BRD does not automatically approve the revised
ERP, pricing or development.

## 11. Annexures required for sign-off

| **Annexure**                 | **Purpose**                                           |
|------------------------------|-------------------------------------------------------|
| A — Workflow Matrix          | All department steps, actors, gates and exceptions    |
| B — Scope Register           | Every BRD requirement and its disposition             |
| C — Access / Authority       | Roles, limits, QA/QC releases and overrides           |
| D — Delivery and Commercials | Milestones, price, assumptions and exclusions         |
| E — UAT / Acceptance         | Evidence and acceptance criteria for each requirement |

Phase 6 conclusion: Management proposal and approval structure are
prepared; no formal client approval or contract authorization has been
received.

**PHASE 7 / 7**

# Requirements Validation, Scope Freeze & Development Readiness

Purpose: reconcile every documented requirement, record client
decisions, validate department rules, freeze release scope and identify
prerequisites for coding.

Document status: Working proposal / not client-approved. No software
development or production deployment authorized.

## 1. Programme status after six phases

| **Phase** | **Output**                  | **Status**                               |
|-----------|-----------------------------|------------------------------------------|
| 1         | BRD gap assessment          | Initial analysis prepared                |
| 2         | Department workflows        | Proposed; not signed                     |
| 3         | Functional architecture     | Preliminary                              |
| 4         | Technical/module design     | Preliminary                              |
| 5         | Roadmap and budget          | Illustrative                             |
| 6         | Client proposal             | Draft                                    |
| 7         | Validation and scope freeze | Framework prepared; verification pending |

## 2. Requirements Traceability Matrix structure

| **Field**         | **Definition**                               |
|-------------------|----------------------------------------------|
| Requirement ID    | Unique code tied to source/function          |
| Source and page   | Original BRD clause or proposed addition     |
| Functional module | ERP feature owner                            |
| Description       | Testable system behavior                     |
| Classification    | Original / Correction / Addition             |
| Priority          | P0 / P1 / P2 / Optional                      |
| Business owner    | Named accountable department                 |
| Decision status   | Pending / Approved / Revise / Rejected       |
| Release           | Pilot / Core / Enterprise expansion          |
| Acceptance case   | Objective test and evidence                  |
| Dependencies      | Required master, rule, integration or module |

## 3. Initial traceability examples

| **ID**  | **Requirement**                                  | **Classification**  |
|---------|--------------------------------------------------|---------------------|
| SEC-001 | Four executive super-admin accounts              | Original            |
| SAL-001 | Nine-tier commercial hierarchy                   | Original            |
| SAL-002 | Threshold-based discount and order-value control | Original            |
| SAL-003 | Conditional manager routing                      | Proposed correction |
| CRM-001 | All 18 sales submodules                          | Original            |
| PUR-001 | Multi-item procurement                           | Original            |
| PUR-002 | PR approval before PO                            | Proposed addition   |
| INV-001 | Quarantine and stock segregation                 | Original            |
| INV-002 | Controlled stock ledger and reservations         | Proposed addition   |
| QCL-001 | All six laboratory submodules                    | Original            |
| QAS-001 | All 17 QA submodules                             | Original            |
| MFG-001 | All 16 plant modules                             | Original            |
| LOG-001 | Box QR and traceability                          | Original            |
| MOB-001 | Offline mobile scanning                          | Original            |
| FIN-001 | Partner ledgers and credit control               | Original            |
| FIN-002 | Finance model decision                           | Open decision       |

This sample is not the complete RTM. Every individual BRD requirement
must eventually be recorded, connected to the final screen/rule/API and
verified by a test.

## 4. Department validation checklist

| **Owner** | **Items requiring validation**                                                                                |
|-----------|---------------------------------------------------------------------------------------------------------------|
| Sales     | Nine-tier hierarchy, lead/BANT, sample, quote, targets, discount limits, edit/cancel, credit/stock handovers. |
| Purchase  | Vendor qualification, PR authority, RFQ, PO changes, partial receipts, invoice match and returns.             |
| Stores    | Locations, bins, quality holds, FEFO/FIFO, transfers, count adjustment and expiry.                            |
| Plant     | Planning model, BOM effectivity, consumption, yield tolerance, downtime, rework.                              |
| QC        | Sampling, six core submodules, CoA authority, OOS/OOT, calibration, lot disposition.                          |
| QA        | 17 functions, BMR/BPR, deviation/CAPA, batch release, SOP effectivity, complaints/recall.                     |
| Logistics | Pick/pack/scan, carrier, LR, POD, freight, partial dispatch and return.                                       |
| Finance   | Authoritative ledger, credit, invoice, payment, reconciliation, tax and closing.                              |
| IT        | Role matrix, MFA, audit, integration, backup, recovery, devices and migration.                                |

## 5. Business rule register

| **Rule** | **Owner**      | **Required rule**                                      |
|----------|----------------|--------------------------------------------------------|
| BR-01    | Sales          | Discounts by delegated authority and policy            |
| BR-02    | Sales/Finance  | Amendment triggers revalidation                        |
| BR-03    | Finance        | Dealer credit exposure and overdue controls            |
| BR-04    | QC/Stores      | Quarantined raw material not issuable                  |
| BR-05    | QA             | Finished goods not saleable without authorized release |
| BR-06    | Stores         | Eligible stock never double-allocated                  |
| BR-07    | Plant/QA       | Approved effective BOM revision mandatory              |
| BR-08    | Stores/Finance | Independent stock adjustment approval                  |
| BR-09    | Finance        | Controlled financial corrections/reversals             |
| BR-10    | Logistics/IT   | Scan idempotency and conflict resolution               |
| BR-11    | Compliance     | Licences restrict affected products/transactions       |
| BR-12    | Executive/IT   | Sensitive override approval and review                 |

## 6. Open decisions and formal change control

| **Open issue**       | **Required action**                                              |
|----------------------|------------------------------------------------------------------|
| Sales hierarchy      | Client selects mandatory or conditional order routing            |
| Finance architecture | Select native accounting or integrated platform                  |
| Quality authority    | Joint QC/QA release responsibility confirmation                  |
| KYC and licences     | Apply legal constitution/product category requirements           |
| Plant process        | Decide make-to-stock, make-to-order or hybrid                    |
| Stock/finance        | Approve valuation, counts, financial periods and adjustments     |
| Mobile               | Test scanner hardware and offline working conditions             |
| Legacy               | Identify source systems, opening quantities/balances and cutover |
| Release scope        | Approve inclusion/defer/exclusion for every requirement          |
| Operations           | Specify uptime, recovery, privacy, retention and support         |

Every subsequent change must show original requirement, proposed
revision, rationale, impacted systems, price/schedule effect and
authorized approval. No verbal scope changes during demonstrations.

## 7. Fully testable requirement example — quarantine

ID: INV-001. When Stores creates a GRN for raw material, a traceable lot
is created and automatically quarantined. Its quantity may not be issued
for production until authorized quality disposition is recorded. System
actions must be attributable to user, time and source evidence. QC
failures, incomplete tests, expiry and quantity differences must hold
material for investigation or disposition.

- Create GRN with physical quantity and internal lot.

- Place lot in quarantine automatically.

- Create/link sampling and tests.

- Require authorized review and disposition.

- Make only eligible released quantity available.

- Prevent unauthorized or concurrent issue; preserve audit history.

Acceptance: quarantined lot cannot be issued; unauthorized release
attempts fail; approved release updates only eligible quantity; all
movements reconcile and are traceable.

## 8. Development entry criteria

- Owner and process approved for each P0 requirement.

- Full mandatory/conditional fields, validation, authority and exception
  behavior documented.

- Dependencies and precise API/data effects described.

- UAT acceptance criteria and test data defined.

- No unresolved policy decision that affects implementation of the
  feature.

- SOW, security and commercial authorization executed before build
  activity.

## 9. Module exit and go-live readiness

- Module and end-to-end tests passed; evidence available.

- Unauthorized functions blocked and logged.

- Stock, production and financial transactions reconcile.

- Quality release and compliance controls verified.

- Critical defects resolved; training and support processes ready.

- Authorized business owners give formal acceptance.

## 10. Current readiness

| **Dimension**                              | **Status**                              |
|--------------------------------------------|-----------------------------------------|
| Goals/functional categories                | Defined in BRD and preliminary analysis |
| Workflow architecture                      | Proposed; validation pending            |
| Requirement-by-requirement RTM             | Not completed                           |
| Client policies and authority              | Unresolved decisions                    |
| Physical schema and complete API contracts | Not finalized                           |
| Migration and operating SLOs               | Not finalized                           |
| Contractual and development authorization  | Not received                            |

Phase 7 conclusion: A disciplined validation and scope-freeze framework
exists, but actual verification and formal approvals remain outstanding.
Recommended subsequent phase: evaluate build-versus-adapt options,
including existing ERP platforms and fit-gap/licensing analyses, before
commissioning a complete custom build.

# Consolidated closing notes

This document compiles the seven planning phases sequentially into one
client-reviewable file. Original Dhruv Agro BRD statements, proposed
design corrections, industry verification topics and indicative
financial estimates must not be interpreted as signed contractual
requirements. Full line-level BRD traceability and technical engineering
specifications should be completed after the necessary client decisions
and before coding.

## Primary reference

Dhruv Agro Enterprise ERP 2.0 — Business Requirements Document (BRD),
reference BRD-DHRUV-ERP-2026-V2.4, November 2026, 20 pages. Additional
industry standards and cost assumptions referenced in prior discussion
are subject to independent final verification.
