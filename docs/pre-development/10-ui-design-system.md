# 10 — UI Design System (ERP adaptation of the UI Design Prompt)

Covers MP Part 2 and Part 30 Step 6. **Source:** the UI Design Prompt (UI§1–43), supplied "for reference". This document keeps its visual language and records each place where an ERP needs something different. Those departures need sign-off (D20).

> **Missing input:** UI§1 and §43 say to "replicate the attached reference image", but no image was attached. The tokens below come from the written prompt only. Please supply the screenshot before UI sign-off (D20).

## 1. Design principles

1. *"A complex database made extremely simple to understand and operate"* (UI§42). This is the primary UX principle.
2. A clean, purple-and-white SaaS look: white sidebar, lavender canvas, white rounded cards, soft shadows, thin icons (UI§1).
3. **ERP adaptation:** the page shape follows the task. Dashboards use the spacious three-panel layout. Registers and transaction editors use a denser two-panel layout (the right panel collapses into a drawer), so a 12-line sales order fits on one laptop screen without horizontal scrolling.
4. The visual layer never replaces server rules. Buttons come from `allowedActions` (MP§2.1 rule 7).

## 2. Design tokens

### 2.1 Colour (from UI§2, with accessibility corrections)

| Token | Value | Use | Contrast (WCAG) |
|---|---|---|---|
| `--color-primary` | `#5B38F5` | Primary buttons, active nav, links, chart primary | 6.31:1 on white ✔ AA |
| `--color-primary-hover` | `#4931D4` | Hover / pressed | 7.86:1 white text ✔ |
| `--color-primary-alt` | `#6847FF` | Gradient stop | — |
| `--color-primary-soft` | `#EEEAFE` | Selected rows, soft chips | primary text on it 5.36:1 ✔ |
| `--color-primary-tint` | `#F5F2FF` | Hover background (nav, menu) | — |
| `--color-canvas` | `#F8F8FD` | App background | — |
| `--color-canvas-alt` | `#F5F4FB` | Section background | — |
| `--color-surface` | `#FFFFFF` | Cards, panels, modals | — |
| `--color-text` | `#171729` | Primary text | 17.6:1 ✔ |
| `--color-text-secondary` | **`#6B6B80`** (UI prompt: `#86869A`) | Labels, secondary text | `#86869A` is only 3.57:1, which **fails AA** for body text. Darkened to 5.2:1. `#86869A` is kept for ≥ 18px or decorative text only |
| `--color-text-muted` | `#B5B4C4` | Placeholders (decorative), disabled | 2.04:1. Never used for information the user needs |
| `--color-border` | `#EEEFF5` | Hairline dividers | — |
| `--color-input-border` | `#D9D9E3` | Input borders (raised from `#EEEFF5` so inputs are visibly bounded) | ≥ 3:1 against the canvas is not reached; the focus ring carries the state |
| `--color-success` / `-bg` / `-text` | `#5DD6A0` / `#ECFBF4` / **`#177A4D`** | Fill / badge background / badge text | `#5DD6A0` as text = 1.7:1 ✖, so badge text uses `#177A4D` (5.0:1) |
| `--color-danger` / `-bg` / `-text` | `#F16A91` / `#FFF0F4` / **`#B42354`** | | `#F16A91` text 2.64:1 ✖, so `#B42354` (5.75:1) |
| `--color-warning` / `-bg` / `-text` | `#F5A524` / `#FFF4E5` / `#9A4A08` | Pending / On Hold (the UI prompt names orange in UI§26 without a value) | 5.76:1 ✔ |
| `--color-info` / `-bg` / `-text` | `#3B82F6` / `#EAF2FF` / `#2563C9` | Informational, In Transit | 5.03:1 ✔ |
| `--color-neutral-bg` / `-text` | `#F3F3F7` / `#5E5E73` | Inactive, Closed, Draft | 5.71:1 ✔ |
| `--color-accent` | `#E639CF` | Secondary chart series, mini-KPI sparkline | — |
| `--color-chart-neutral` | `#E9E8F0` | Comparison bars, donut track | — |

Dark theme: **not in the first release** (UI prompt: "if required"). Tokens are named semantically so a dark theme can be added later without changing components.

### 2.2 Typography (UI§3)

`font-family: Inter, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;` with tabular numerals (`font-variant-numeric: tabular-nums`) on all numbers in tables and KPIs.

| Token | Dashboard | Register / editor (ERP adaptation) | Weight |
|---|---|---|---|
| Page title | 46–52px, -1.5px tracking (UI§3) | **28px**, -0.5px. A 48px title on every transaction page wastes about 60px of vertical space | 700 |
| Section heading | 20–24px | 18px | 600 |
| Card heading | 17–20px | 16px | 600 |
| KPI large | 34–42px | — | 700 |
| Body | 14–16px | 14px | 400–500 |
| Table cell | 14px | 14px (13px compact) | 400 |
| Label / caption | 12–14px | 12px | 500 |

### 2.3 Spacing, radius, elevation

| Token | Value |
|---|---|
| Spacing scale | 4, 8, 12, 16, 20, 24, 32, 40, 48 |
| Card gap | 24px (dashboard), 16px (registers) |
| Workspace padding | 40px top, 48px sides (≥ 1440px); 24px (1024–1439px); 16px (mobile) |
| Radius | sm 10px (buttons-sm, chips) · md 14px (inputs, buttons) · lg 18px (medium components, dropdowns) · xl 24px (cards) · 2xl 30px (feature card, modal) · full (avatar, badge) |
| Shadow card | `0 8px 30px rgba(41,38,80,0.04)` |
| Shadow hover | `0 12px 36px rgba(41,38,80,0.08)` |
| Shadow primary | `0 10px 24px rgba(91,56,245,0.25)` |
| Focus ring | `0 0 0 3px rgba(91,56,245,0.25)` plus a 1px primary border. Raised from UI§22's 0.08 alpha, which is not visible enough to meet WCAG 2.4.7 |
| Motion | 180–250ms `cubic-bezier(0.4,0,0.2,1)`; page enter 240ms fade + 8px rise; all motion turned off under `prefers-reduced-motion` |

## 3. Layout

### 3.1 App shell

```
┌──────────┬───────────────────────────────────────────────┬──────────────┐
│ Sidebar  │ Utility header: ⌕ Search (⌘K) · Plant/Entity ▾ │ Context panel│
│ 280px    │   · Approvals(3) · 🔔 · ⋯ · avatar            │ 360px        │
│ (80 coll)│───────────────────────────────────────────────│ (dashboards: │
│          │ Page title                       [Primary CTA] │  profile +   │
│ Logo     │ Breadcrumb · status badge · key facts          │  activity;   │
│ Modules  │ ┌──────────────── content ──────────────────┐ │  documents:  │
│  …       │ │ cards / register / editor                 │ │  approvals,  │
│ Report   │ └───────────────────────────────────────────┘ │  audit,docs) │
│ card     │                                               │ collapsible  │
└──────────┴───────────────────────────────────────────────┴──────────────┘
```

| Breakpoint | Behaviour (UI§36–37) |
|---|---|
| ≥ 1440px | Three panels. Context panel open by default on dashboards and closed by default on registers |
| 1024–1439px | Sidebar 240px or collapsed to 80px; context panel opens as an overlay drawer |
| 768–1023px (tablet) | Sidebar becomes a drawer; 2-column cards; line editors scroll horizontally *inside the grid only* |
| < 768px | Top bar plus bottom navigation for mobile tasks (scanner, beat, approvals); tables become stacked cards; 16px gutters |

### 3.2 ERP navigation (replaces the generic menu in UI§6 and §41)

The prompt's menu (Overview, Users, Statistics, Documents, Uploads, Messages, Reports, Profile, Settings) is for a document portal. ERP mapping, filtered by permission:

| Group | Items (Lucide icon) |
|---|---|
| — | Overview (`layout-dashboard`) · Approvals (`check-circle-2`, with counter) |
| Sales | Leads & Pipeline (`target`) · Dealers (`store`) · Quotations (`file-text`) · Sales Orders (`shopping-cart`) · Targets & Pricing (`tags`) · Field (`map-pin`) |
| Supply | Purchase (`clipboard-list`) · Inventory (`warehouse`) |
| Plant | Production (`factory`) · Quality Control (`flask-conical`) · Quality Assurance (`shield-check`) |
| Fulfilment | Dispatch (`truck`) · Scan & Trace (`scan-line`) |
| Finance | Invoices & Receivables (`indian-rupee`) · Payables (`wallet`) |
| Insights | Reports (`bar-chart-3`) · Documents (`folder-open`) |
| System | Masters (`database`) · Administration (`settings`) |

The sidebar bottom card (UI§7) becomes **"Monthly MIS pack — Download"** for management roles, or **"My pending tasks"** for others.

## 4. Components (`packages/ui`)

| Component | Spec highlights |
|---|---|
| `Button` | primary (purple, 48px, radius 14, hover darker + translateY(-1px), active scale .98), secondary (white + border), ghost, danger, icon. Loading state keeps the width |
| `Input`, `Select`, `Combobox`, `DatePicker`, `NumberInput` (Indian grouping), `CurrencyInput` (₹) | 48px height in comfortable mode (UI§22 says 52–56px; 48px meets the 44px touch target with better density); 40px in compact mode. Label above, help text below, error text in `--color-danger-text` with an icon |
| `PartyPicker`, `ItemPackPicker`, `LotPicker` | Async search; shows status badge and warnings (licence, credit) inline |
| `DataTable` | TanStack Table; server pagination, sort, filter chips, column chooser, saved views, sticky header, row hover `#FAF9FF`, row height 56px comfortable / 40px compact (UI§25 says 56–64px), selection, row-action menu (⋯) |
| `LineItemGrid` | Keyboard-first spreadsheet behaviour (Enter moves down, Tab moves across, Ctrl+D duplicates the row); totals footer; per-line warning icons; server recalculation with a 300ms debounce |
| `StatusBadge` | §6 mapping; pill radius 999px; icon + label |
| `ActionBar` | Renders `allowedActions` in a fixed order (primary right-most); destructive actions confirmed |
| `ApprovalTimeline` | Steps, actors, decisions, rule version, SLA countdown |
| `DecisionDialog` | Decision, remarks, re-authentication slot |
| `StatCard`, `FeatureCard` (purple gradient `linear-gradient(135deg,#6843FF,#572CF4)`, radius 30), `ChartCard`, `DonutCard`, `MiniKpi` | UI§12–18 |
| `ActivityFeed` | UI§19 grouped by Today / Yesterday; icon tints per action type |
| `DocumentCard`, `UploadZone` | UI§28–29; drag-over state; per-file progress; AV-scan status |
| `Modal`, `Drawer`, `Toast`, `Tooltip`, `Dropdown`, `Tabs`, `Stepper` (wizards), `EmptyState`, `Skeleton`, `ErrorState`, `Pagination`, `SearchOverlay` (⌘K, UI§23) | Radix primitives; modal radius 28; backdrop `rgba(22,20,45,0.28)` + blur(8px); enter scale .97→1 over 200ms |
| `ScanFeedback` (mobile) | Full-width result banner, haptic and sound pattern, large touch targets (≥ 56px) |

## 5. Charts (UI§30, Recharts)

Primary series `#5B38F5`, comparison `#E9E8F0`, secondary `#E639CF`, positive `#5DD6A0`, alert `#F16A91`. Smooth monotone lines, 3px stroke, faint horizontal guides only, no axis lines, rounded bar tops, white tooltip card (radius 12). Every chart has a visually hidden data table, or a "View as table" toggle, for accessibility (UI§38). Chart colour is never the only way to tell series apart: legends and direct labels are always shown.

## 6. Status badge mapping (MP§2.1 rule 6)

| Status family | Examples | Style | Icon |
|---|---|---|---|
| Draft / neutral | Draft, Planned, Closed, Inactive | neutral | `circle-dashed` / `archive` |
| Pending | Submitted, Under Review, Pending, Awaiting QC | warning | `clock` |
| Approved / positive | Approved, Active, Released, Completed, Delivered, Paid, Passed | success | `check-circle-2` |
| Rejected / negative | Rejected, Failed, OOS, Cancelled | danger | `x-circle` |
| Hold | On Hold, QA Hold, Quarantine, Suspended | warning (outlined) | `pause-circle` / `lock` |
| In progress | In Progress, In Transit, Partially Fulfilled | info | `loader` / `truck` |
| Expired | Expired | danger (outlined) | `calendar-x` |
| Admin / special | Admin, Exception, Override | primary-soft | `shield` |

## 7. Dashboard template (UI§11, §41)

Row 1: `FeatureCard` (5 columns; for example *Sales this month vs target*) + `ChartCard` trend line (7 columns).
Row 2: `ChartCard` grouped bars (7 columns) + `DonutCard` (5 columns; for example *Credit utilisation*, *Batch release rate*).
Row 3+: `DataTable` widget (*Orders awaiting my approval*, *Quarantine aging*).
Right panel: user card, MiniKpi, Recent activities (from audit and notifications).

## 8. States

| State | Pattern |
|---|---|
| Loading | Skeletons in the same shape as the content (UI§33); no spinners for full pages |
| Empty | Soft purple illustration, heading, one-line help, primary CTA (UI§34), e.g. "No quotations yet — Create quotation" |
| Error | Inline error card with retry and a trace ID; field errors on the field; 403 page explains which permission is missing and whom to ask |
| Offline (PWA) | Persistent amber banner "Offline — 12 scans queued" |
| Saving / submitted | Button loading state → toast with the result and a link to the document |
| Conflict (409) | Dialog: "This record was changed by <user> at <time>. Reload to see changes." |

## 9. Accessibility checklist (UI§38, WCAG 2.2 AA)

Colour contrast as in §2.1 · keyboard reachable everything, with a visible focus ring · skip-to-content link · `aria-label` on icon buttons · form fields have programmatic labels and `aria-describedby` for errors · status communicated by text and icon, not colour · touch targets ≥ 44px · charts have text alternatives · reduced-motion respected · tested with axe-core in CI and a manual NVDA/VoiceOver pass per release.

## 10. Departures from the UI prompt that need sign-off (D20)

| # | UI prompt | Proposed | Reason |
|---|---|---|---|
| U1 | Next.js (UI§40) | Vite SPA (MP§3.1) | No SSR needed behind login (D19) |
| U2 | Generic portal navigation | ERP navigation §3.2 | Matches the modules |
| U3 | Right profile panel always visible | Collapsible; closed by default on registers and editors | Space for line editors |
| U4 | Page title 46–52px everywhere | 46–52px on dashboards, 28px on working pages | Vertical space |
| U5 | Table rows 56–64px | Comfortable 56px / compact 40px toggle | Large registers |
| U6 | Secondary text `#86869A`, status text in light tints | Darker text tokens (§2.1) | WCAG AA |
| U7 | Focus glow at 0.08 alpha | 0.25 alpha | Visible focus |
| U8 | Inputs 52–56px | 48px / 40px compact | Density; still ≥ 44px target |
