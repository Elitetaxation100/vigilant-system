# Release pack — dashboard views, profit confirmer, productivity V3, new-task form, views

Everything below is in `main` once PR 12 and the follow-up are merged. **No production history, file, review, audit or productivity record is deleted or rewritten.**

## Spec → where it is
| Spec | Done | Where |
|---|---|---|
| 1–7 dashboard views, single-open rules, tiles, detail panel | ✅ (merged earlier) | `workflow.js buildModes`, `docs/dashboard-modes/` |
| 8–11 Productivity / capacity | ✅ prospective (V3) | `productivity-rules.js`, `docs/productivity-v3.md` |
| 12 review decision | ✅ radio cards, no "is it clean?" question, one decision's fields at a time, system accounts never recipients | `openReviewV2` |
| 13 configurable profit confirmer | ✅ default / team / backup / per-task, audited | `profitConfirmerInfo`, Admin → "Who confirms profit" |
| 14 Admin Task wording | ✅ UI everywhere (stored legacy value kept) | `clientLabel`, `workflow.card` |
| 15 New Task form | ✅ main fields visible; Supporting work collapsible; Delivery section; Admin form | `openNewTask` |
| 16 reviewer or "assign later" | ✅ reason required; submission blocked until a manager assigns; manager exception + alert before the due date | `/api/tasks`, `/complete`, `manager-views.exceptions` |
| 17 attachment hand-off | ✅ proved end to end (6 file types, notification, preview/download, no delete, resubmission, next-cycle) | `review-handoff.e2e.test.js` |
| 18 Timeline | ✅ date scale, today, bars, internal + client markers, delayed stretch, owner + reviewer, 6 filters, paged | `mtDrawTimeline` |
| 19 Calendar | ✅ Month / Week / Agenda, employee + client filters, internal/client toggles, ≤3 per cell, one day drawer | `mtDrawCalendar` |
| 20 Tasks page | ✅ first row Search · Employee · Status · Risk · More filters (one panel); 25/50/100 server paging; newest first | `mtDrawList` |
| 21 data-quality report | ✅ read-only report + CSV with a decision column; nothing auto-fixed | `data-quality.js`, Admin → "Data quality" |
| 22 accessibility | ✅ tabs, tiles, radio decisions, labelled filters, real buttons for every former `href="#"`, keyboard-operable sidebar | static + browser checks |

## Not done (and why)
- **Attachments at task creation** (spec 15, "Supporting work → attachments"): files attach when the work is submitted or reviewed, as before; adding them at creation needs a second upload path. Say if you want it.
- **Classic Task List link** is still there: I cannot prove feature parity, so I did not remove it.
- **Stored `kind: "internal"`** is kept (the code and history depend on it); it is never shown — people see **Admin Task**.
- **Duplicate-user merge, test-user removal, task-title clean-up** are *reported*, never done: they need a person's decision (see the CSV).

## Migration plan
1. **Deploy** — no schema change. New fields are additive and optional: `profitConfirmerAssignedId`, `profitConfirmerId`, `profitConfirmerHistory`, `priority`, `instructions`, `reportRequired`, `reportSenderId`, `profitRequiredDefault`, `reviewerLater`, `state.settingsAudit`, `state.productivityV3History`.
2. **Behaviour that starts immediately:** the new-form reviewer rule (new tasks only), the configured profit confirmer (defaults to the original person until a superadmin changes it), Admin Task wording, the dashboard/timeline/calendar changes, newest-first lists.
3. **Behaviour that starts at a date:** Productivity V3 for work completed on/after **8 Oct 2026 00:00 NZDT**. Nothing earlier is recalculated; finalised months are stored snapshots.
4. **Team/firm Productivity totals** change for periods that included shared logins (HR Administrator, test accounts): their capacity and output leave the sums. Individuals' numbers do not change.
5. **Review the data-quality CSV** (Admin → Data quality → Download CSV), fill the "decision" column, then fix items through the normal screens.

## Rollback
Revert the merge(s) and redeploy. Because no stored value was rewritten, the previous screens and numbers return exactly. To switch only the new productivity credit rule off: set `state.productivityV3EffectiveAt` far in the future. To stop using a configured profit confirmer: clear it in Admin → Who confirms profit (falls back to the original default).

## Permission matrix
| Action | Employee | Manager (admin) | Superadmin |
|---|---|---|---|
| See who confirms profit | ✅ | ✅ | ✅ |
| Change the profit confirmer (default / team / backup) | ❌ | ❌ | ✅ (audited) |
| Per-task profit confirmer | ❌ | ✅ (before confirmation starts; audited on the task) | ✅ |
| Create a review-required task without a reviewer | ❌ must say "later" with a reason | same | same |
| Assign the reviewer on a "later" task | ❌ | ✅ (manager over the assignee) | ✅ |
| Calendar / Timeline | ❌ | ✅ own team | ✅ |
| Data-quality report | ❌ | ❌ | ✅ |
| Download a reviewer's file | task's people only | task's people + manager over the assignee | ✅ |
| Delete or edit a reviewer's file | ❌ | ❌ | ❌ (no such route) |

## Test results
`npm test`: all pass. New in this release: `profit-confirmers.e2e`, `productivity-rules`, `productivity-v3.e2e`, `new-task-v2.e2e`, `review-handoff.e2e`, `views-v2.e2e`, `data-quality` (+ `.e2e`), `batch-a.static`. Browser checks (Playwright, real server): dashboard views, review form radios, new-task form, calendar / timeline / tasks page — see `docs/dashboard-modes/ui-check.js` and `docs/ui-checks/`.
