# Today dashboard — release pack (DRAFT, not published)

Branch: `draft/today-dashboard` (4 commits ahead of `main`, 13 files, +3,262 / −62 lines). Nothing has been pushed or deployed.
Everything below is what was built and tested **locally**. Production is untouched until you say "publish".

## 1. What was built

| Phase | What you get |
|---|---|
| 1–2 | **Today** page for Parvinder: *Needs your action now / Waiting on others / Completed today*, six counts that each open exactly their list, a task panel with progress tracker, facts, files and timeline. Manager View and Review View. NZ-time greeting and dates. |
| 3 | **Review screen**: Approve · Return for Correction · Escalate. Correction category, who is responsible, due date, files by round. Double-click safe. Escalation to a manager/founder with a decision date. Reviews queue in five sections. Employee sees correction details and files by round. |
| 4 | **Navigation** (Parvinder only): *+ New Task* · Work (Today, Tasks, Reviews, Clients) · Team (My Team) · Communication (Calls, Email) · Me (Time Off, Performance) · collapsed **Admin** (Employees, Attendance Log, Team Assignments, Task Types, Inbound Admin — founders only). Time Clock hidden in his view only. |
| 5 | **My Team** with *Needs Manager Attention*; **Tasks** list filtered and paged on the server (25/50/100), **Calendar**, **Timeline**; row menu (⋯ / right-click): Reassign, Change due date, Change reviewer, Waive the review, Nudge, Put on hold, Resume — every one needs a reason and is written to the task history. |
| 6 | **New Task form**: Client Task / Admin Task, reviewer chosen up front, "Review required" rule (only a manager/founder can waive it, with a reason), Sheet/Cashbook links checked as you type and kept in a link history. **Commitment-date history** that never loses the original dates. **Hold** records who is responsible, the follow-up date and which clocks stopped. |
| 7 | **Manager alerts** (once per problem, resolve themselves, re-raise if the problem returns). **Delivery measures** — five separate measures, never blended. Accessible dialogs (focus trap, Escape, focus return), 44 px touch targets, reduced-motion, loading/empty/error states everywhere. |

## 2. Before / after navigation (Parvinder only; everyone else is unchanged)

| Before | After |
|---|---|
| Today ◦ My Dashboard ◦ Management dashboards ▾ ◦ Tasks ◦ New task ◦ Reviews ◦ Performance ▾ (Performance, Recognition) ◦ Time Off ◦ More ▾ (Calls, Email, Clients, Attendance, Admin, Employees, Task Taxonomy, Team Assignments) — about 17 entries, 5 collapsible groups, Time Clock card | **＋ New Task** · Work: Today, Tasks, Reviews, Clients · Team: My Team · Communication: Calls, Email · Me: Time Off, Performance · Admin ▾ (collapsed) — 9 visible entries, 1 collapsible group, no Time Clock |

The old navigation is still in the page and comes back for any person whose `dashboardV2` flag is off. The classic task list is one link away ("Open the classic task list").

## 3. Database migration plan

**No schema change and no data migration.** The app stores everything as one JSON state, so every new field is optional and old records simply don't have it.

* One **guarded, run-once** switch (`migrationFlags.dashboardV2ForParvinder`) turns the new dashboard on for Parvinder. It is skipped on every later deploy and never overwrites a value someone set by hand.
* New optional task fields (written only by new actions, never back-filled): `originalInternalDeadline`, `originalClientDate`, `assignedReviewerId`, `reviewRequired`, `noReviewAttempts[]`, `linkHistory[]`, `managerActions[]`, `holdResponsibility`, `holdFollowUp`, `holdHistory[].responsibility/followUp/clocksStopped`, review ledger (`reviewEvents[]`, `correction`, `escalation`, tagged `reviewAttachments[]`).
* New optional state keys: `workflowSettings` (link policy, off by default), `managerAlerts` (alert ledger).
* Existing `noReviewAuthorized*` fields (already in every task) are now written by the waiver.
* **Not changed:** statuses, `reviewStatus`, marks, the automatic −20/−30 link marks, productivity, report-sent scoring, capacity.

## 4. API changes

New (all under `/api`):

| Method + path | Who | Purpose |
|---|---|---|
| GET `/workflow/today` | any signed-in person (own scope) | Today payload |
| GET `/workflow/team` | manager / founder | My Team + Needs Manager Attention |
| GET `/workflow/tasks` | manager / founder | filtered, sorted, paged list + filter options |
| GET `/workflow/calendar`, `/workflow/timeline` | manager / founder | calendar and timeline data |
| GET `/workflow/measures?days=` | manager / founder | the delivery measures (1–365 days) |
| POST `/tasks/:id/review-decision` | the reviewer / a manager over the assignee | approve / return / escalate (idempotent by `requestId`) |
| POST `/tasks/:id/escalation/resolve` | the person it was escalated to | decide an escalation |
| POST `/tasks/:id/manager-change` | manager over the assignee / founder | `reassign`, `change_due`, `change_reviewer`, `waive_review` — reason required, audited |
| GET/POST `/admin/workflow-settings` | founder | approved-sites link policy |
| POST `/admin/manager-alerts/run` | founder | run the alert sweep on demand (it also runs every 30 min) |

Extended (old callers keep working unchanged):
* `POST /tasks` — accepts `taskKind` (`client`/`admin`), `reviewerId`, `reviewRequired`, `noReviewReason`, `sheetLink`, `cashbookLink`.
* `POST /tasks/:id/hold` — accepts `responsibility`, `followUpDate`; validated **before** anything changes.
* `POST /tasks/:id/done` — for tasks made with the new form that require review: refused for an employee (attempt recorded, managers alerted once); a manager/founder may close it with a reason.
* `POST /tasks/:id/complete` — falls back to the reviewer chosen at creation.
* `POST /tasks/:id/set-dates` — now also keeps the original dates and tells the assignee/reviewer.
* `PATCH /tasks/:id/links`, `/complete`, `/send-for-review` — links are validated and every change is logged.
* `PATCH /employees/:id` — founder can switch `dashboardV2` per person.

## 5. Permission matrix

| Action | Employee | Manager (admin) | Founder (superadmin) |
|---|---|---|---|
| See their own Today | ✔ | ✔ | ✔ |
| My Team, Tasks list, Calendar, Timeline, Measures | ✘ (403) | their team | everyone |
| Manager change (reassign, due date, reviewer, waive review) | ✘ | people they manage | everyone |
| Close a required-review client task without review | ✘ (refused, recorded, managers told) | ✔ with a reason | ✔ with a reason |
| Waive review when creating a client task | ✘ | ✔ with a reason | ✔ with a reason |
| Approve / return / escalate a review | only if named reviewer | ✔ | ✔ |
| Decide an escalation | only the person it was sent to | ✔ if it was sent to them | ✔ |
| Approved-sites link policy; run alert sweep; switch the dashboard on/off for someone | ✘ | ✘ | ✔ |

Every row above is covered by an automated test (see §6).

## 6. Automated test report

Full suite: **305 tests, 305 passing, 0 failing** (7 s). The new work is covered by:

| File | Tests | What it proves |
|---|---|---|
| `workflow.test.js` | 16 | status, who-owns-next-action, client risk vs employee commitment vs review waiting, tracker, **timezone/daylight-saving** (instants either side of the NZ clock changes land on the right business day; overdue flips at business midnight) |
| `manager-views.test.js` | 8 | pagination, every filter, sort, team counts, exceptions, link domains, calendar/timeline tones |
| `today.e2e.test.js` | 7 | **combined dashboard** on a real server: only my actions, no task in two sections, each count = its list, finished actions move, NZ greeting/date, per-person switch |
| `review-v2.e2e.test.js` | 9 | **reviewer workflow** + **attachment hand-off**: approve, profit step, return needs category/reason/date, files by round, resubmit, double-click safety, escalate, permissions, review queue |
| `manager.e2e.test.js` | 11 | **manager workflow**: permissions, 30-task paging (no skips/repeats), filters combine, My Team numbers = their lists, exceptions, audited manager changes, originals preserved, calendar/timeline, read-only |
| `workflow-rules.e2e.test.js` | 12 | **links & rules**: Client/Admin task, review waiver, close-without-review refusal, reviewer default, link validation + history, approved-sites policy (look-alike hosts rejected), date history, hold record, old callers unchanged |
| `alerts-measures.e2e.test.js` | 9 | alert once / not repeated / auto-resolve / re-raise; measures separate and scoped; window clamped |
| `accessibility.static.test.js` | 5 | dialog role, focus trap + return, focus ring, 44 px targets, reduced motion, cards on phones, loading/empty/error states, labels |

**Attachment hand-off evidence:** `review-v2.e2e.test.js` ("return validation/attachments" and "resubmit") shows files attached on a return are visible to the employee, a resubmission starts a new round, and earlier rounds stay listed.
**Timezone evidence:** `workflow.test.js` (DST) and `today.e2e.test.js` ("the date and greeting come from the BUSINESS clock"); the alert/measure tests deliberately use NZ dates (they failed when written with UTC dates, which is how the NZ-vs-UTC difference was caught and is now covered).

## 7. Screenshots

`docs/screenshots/` — desktop: `desktop-today.jpg`, `desktop-my-team.jpg`, `desktop-tasks-list.jpg`, `desktop-calendar.jpg`; phone: `phone-my-team.jpg`, `phone-tasks-list.jpg`, `phone-new-task-form.jpg`, `phone-delivery-measures.jpg`.
(The desktop images are shown small because the preview pane is narrow; layout is the real 1200 px layout.) Review screen and employee correction screens were checked in Phase 3.

## 8. Production rollback plan

1. Nothing is applied until you say "publish". Publishing is one merge of `draft/today-dashboard` into `main`.
2. **Instant switch-off (no deploy):** a founder sets `dashboardV2` off for Parvinder (Manage Access) — he gets today's navigation back immediately.
3. **Full rollback:** `git revert -m 1 <merge commit>` and push — Railway redeploys the previous build. Because no existing field was changed or removed, older code ignores every new field; nothing has to be undone in the database.
4. New fields left behind after a rollback are harmless and can be ignored or cleaned later.

## 9. Confirmations

* **No production data was deleted, rewritten or recalculated.** All testing used throwaway data folders and the local development database.
* No stored status, mark, productivity figure or report-sent score is recomputed by anything here; the new pages only *read* and derive. The only writes are the explicit, reason-carrying actions listed in §4.
* The automatic missing-link marks (−20/−30) are unchanged.

## 10. Decisions and limits you should know about

* **Approved-sites link policy ships OFF** (so no existing link is rejected). A founder can switch it on and edit the site list.
* **"Serious error"** in the measures is defined as *a task returned three or more times* — tell me if you want a different definition.
* Review turnaround is measured in whole NZ calendar days between submission and the review decision.
* "Waive the review" only exists for tasks made with the new form; older tasks keep today's behaviour so nothing existing breaks.
* The review rule and the new New Task form are on for Parvinder only for now (they follow his dashboard flag).
