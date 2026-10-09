# Founder Dashboard — release pack (DRAFT, not published)

Branch `feat/founder-dashboard` (2 commits: `7cbeb26` server + metric layer, then the UI + data check). Nothing is on `main` or live.

## 1. What changed, in one paragraph
The Founder Dashboard now has the same shape as Parvinder's Manager + Reviewer dashboard — three mutually exclusive tabs (**Today**, **Founder View**, **Review & Decisions**), tiles that open the matching list, one detail panel that opens only on click — but its scope is the whole firm. Every number on it comes from one server-side service (`founder-metrics.js`), which calls the *same* productivity engine as the Report Card, Parvinder's dashboard and `/api/productivity`. The screen does no calculating of its own.

## 2. Files
| File | Change |
|---|---|
| `founder-metrics.js` (new) | Pure shared metric layer: periods, scope, eligibility, tiles, KPIs, performance tables, capacity, drill-down, CSV. |
| `productivity-rules.js` | `aggregateTotals()` — firm figure = Σ hours ÷ Σ capacity (never an average of percentages). Used by `/api/productivity` and the Founder dashboard. |
| `server.js` | `productivityExclusionReason`, `ownerOf` (duplicate profile → real person), `createdAt` stamped on new tasks, `/api/productivity` counts only elapsed days, `PATCH /api/employees/:id` accepts `countsInProductivity` and `duplicateOf`; founder-only endpoints below. |
| `public/index.html` | Old client-side founder calculations and DOM removed; new Founder UI; Time Clock hidden on this page. |
| Tests | `founder-metrics.test.js` (9), `founder.e2e.test.js` (19), static UI test in `accessibility.static.test.js`. |

Endpoints (all server-checked: superadmin **and** founder, otherwise 403): `GET /api/founder/dashboard`, `/api/founder/productivity`, `/api/founder/eligibility`, `/api/founder/export?section=…`, `/api/founder/reconcile` (read-only data check).

## 3. Database / migration
**No schema migration.** Three optional fields are added lazily and old data is untouched: `task.createdAt` (new tasks only; old tasks fall back to their first history event), `employee.countsInProductivity` (true/false/unset), `employee.duplicateOf`. No task, attachment, history, review record, date or permission is changed or deleted.

## 4. Exact formulas
- **Productivity %** = Σ allocated hours of tasks approved **Reviewed Clean** in the period ÷ Σ eligible capacity hours × 100.
  - A task counts once, in the period of its reviewed-clean date, under its owner (a duplicate profile maps to the real person).
  - Punch / online / worked / work-log hours, Report Sent and the three-day rule never enter the formula.
  - Submitted, in review, returned for correction, on hold, or missing allocated hours → counted 0, with the reason shown.
- **Eligible capacity** = 7 h × eligible elapsed working days, where a day is not eligible if it is a weekly off (Sunday), public holiday, approved leave day (half-days at half), or a workshop Saturday. **Future days are never counted** — a period running past today is measured through today and the planned end is shown separately.
- **Firm / team / manager** = Σ qualified hours ÷ Σ capacity of the people included.
- **Report Sent** is its own measure (Client Delivery On Time: sent on or before the effective client date ÷ client dates due in the period; with Not sent, Late, No date counts).
- Other KPIs: Internal Commitment Met (by internal due date), First-Pass Approval (first completed review clean), Open Work (as of today), Backlog Change (created − completed). Each shows numerator, denominator, period, optional previous-period comparison, tooltip and a drill-down list.
- **Who is excluded by default:** the founder (unless switched on in Settings → "Include this person in productivity capacity"), HR login, system/test/admin-only accounts, inactive people, profiles marked as duplicates, and non-hours groups. Every exclusion shows its reason in *More insights → Who counts in productivity and capacity*.

## 5. Before / after — what caused the contradictions
I do not have production data on this machine, so **I cannot show real before/after figures for Ranjit or the firm, and have not invented any.** The root causes that produced the listed contradictions, each removed in code (no hardcoded corrections):
1. The old Founder screen computed its own figures in the browser from raw tasks — a second formula. Now it only displays what the service returns.
2. Capacity counted the whole month including future days; now elapsed days only.
3. Firm % was an average of per-person percentages; now Σ ÷ Σ.
4. Duplicate profiles (Manya Nanda, Nitish / Nitish Uppal, Khushi / Khushi Goyal) were counted as separate capacity; now mapped onto the real person (history kept).
5. Tiles and their lists were built by separate code paths; now one query feeds the count, the list and the export (tested: count = list = CSV).
6. Admin/test/HR/inactive profiles inflated capacity (e.g. 0% for someone whose work sat under a duplicate profile); now excluded or mapped.

**To get the real before/after:** after deploy open *Founder View → More insights → Run data check* (read-only). It prints each comparison and both figures. The *Who counts* table lists every excluded and suspected-duplicate person for you to confirm.

## 6. Test results
Full suite: **433 tests, 433 pass, 0 fail** (`node --test --test-concurrency=4`). New: 27 founder tests (metric layer + real-server e2e covering reviewed-clean counting, once-per-task, worked hours/Report Sent not affecting productivity, leave/weekly off/workshop capacity, future days, aggregate-not-average, same result across dashboards, duplicates, tile = list = export, scope and period filters, Not available vs 0%, access 401/403, read-only, reconcile) + 1 static UI test (tabs, aria-selected, tile buttons, view change clears tile/list/detail, labelled filters, collapsed More insights, clutter absent, no client-side calculating).

## 7. Manual QA checklist
- [ ] Sign in as the founder → Founder Dashboard opens on Today; sign in as a manager → 403 on `/api/founder/*`, no menu entry.
- [ ] Switch Today → Founder View → Review & Decisions: only one tile/list/detail ever visible; closing on switch.
- [ ] Click a tile: count = rows listed = Download CSV rows. Click a row: detail opens on the right; Close returns to full width.
- [ ] Productivity KPI → by-employee table → View details → qualifying and excluded tasks with reasons.
- [ ] Change Scope (team / manager / employee) and Period (today … custom) → every section changes.
- [ ] Pick a period ending in the future → "counted only through today".
- [ ] More insights → Who counts: toggle someone off/on, mark a duplicate; numbers update everywhere.
- [ ] More insights → Run data check → every line "Agrees".
- [ ] Phone width: tables become labelled cards, no sideways scroll; Time Clock / Online / Offline absent.
- [ ] Keyboard: arrow keys move between the three tabs; tiles reachable by Tab.

## 8. Screenshots
Playwright is not installed here, so repo screenshots were not regenerated. The preview was inspected at desktop and phone width (tabs, tiles, KPI drill-down, employee detail, Reports Not Sent list, More insights, data check). Capture the six requested screens during the manual QA above.

## 9. Decisions for you
- Only the founder (superadmin + `isFounder`) can open this dashboard; admins/managers are not excluded from *capacity* by role, only by the rules in section 4.
- The spec did not define the **Today** and **Review & Decisions** tiles; I chose: Today = My Tasks Today, My Overdue Tasks, Profit Confirmations Waiting, Decisions Waiting, Reports Requiring My Action, Actions Completed Today; Review = six review/decision tiles.
- The old founder search box was removed (the filters replace it).
