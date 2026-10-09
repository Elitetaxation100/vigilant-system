# Processor Dashboard — release pack (DRAFT, nothing is published)

Branch `feat/processor-dashboard`. It is built **on top of** `feat/founder-dashboard` (main merged into it first), so the Founder dashboard, the Manager/Reviewer dashboard, the Performance page, the Report Card and every export read **one** productivity service. Publishing this branch publishes the Founder dashboard too — say so if you want them separated.

## 1. Root causes found

| Symptom on Ranjit's dashboard | Cause |
|---|---|
| Total tasks 34, but 18 open + 19 sent for review + 16 finished = 53 | The Total tile added open + finished-in-period + reviewed, but **left out "Sent for review"** (19). Fixed: *Work in scope* = open + sent for review + finished in the period (the three never overlap), and the sub-line adds up to it. |
| Status chart 81, Done 44 | The chart is **every task, all time, current state** — a different question from the tile (period activity). It is now titled "every task, all time" and says it is not the same as Work in scope. |
| 38.2 h "done this month", 6.5 h Done tile, 23.5 h performance, 5.94 h queue | Four different things under similar words: header = hours of tasks *submitted* this month **plus review time**; Done tile = allocated hours of finished work; Performance = qualified hours; queue = open allocated hours. The header figure is removed; every remaining hours figure says what it is (*reviewed-clean allocated hours*, *actionable workload (allocated hours)*, *eligible capacity hours*). |
| Task credited 1.0 h of 2.0 h | **Month-end banking**: held tasks were credited the hours *logged* so far at a month-close. Removed — a task earns its full allocated hours on Reviewed Clean, or 0. |
| Tasks qualifying on "Report sent" | The V2 rule (27 Sep → 7 Oct) used the report dispatch as the event. **One rule now applies to every period**: Reviewed Clean, on the Reviewed Clean timestamp. Report Sent only feeds its own score. |
| "Closed — no review needed" client tasks credited | Client work now qualifies only when Reviewed Clean, or when a manager exception is on record (who, when, why). Older closures without one earn nothing and are listed in the Data-quality report (*Client task closed without review*). |
| Performance page showed 161 h / 61.5 % then 49 h / 48 % under "This month" | Overlapping requests: an older answer repainted over a newer selection. Every change of person or period now starts a new calculation, clears the old numbers at once ("Calculating…") and ignores any older answer. |
| Generic holds became "client queries" | The Hold box pre-selected a client query (fixed earlier); now a hold opens **no** query — the owner records one with how/when/evidence. |

## 2. What changed

**Status model.** One primary status shown everywhere: New / Awaiting Acceptance · To Do · In Progress · On Hold · **Ready to Resume** · Sent for Review · Fix Needed · Reviewed Clean · Ready to Send · Report Sent · Completed · Cancelled. Overdue, at risk, waiting on client/manager/reviewer, previous rework, processor SLA paused, reviewer SLA breached, report sent late are **badges**, never part of the status. (The stored working statuses are unchanged — this is a display layer, so no migration and no test of old data breaks.)

**Hold model** (`hold-model.js`, shared). Ten categories: waiting on client information · client documents · IRD/external authority · manager decision · reviewer · internal dependency · rework blocked · scheduled for a future date · no confirmation received · other. A hold **requires** category, reason, who it waits on and a follow-up date (expected-reply date optional). Server-enforced.
- A hold never changes capacity, allocated hours, the client date, or productivity, and never opens a client query.
- A query is recorded only with *how, real date + time, evidence*, and only for client/authority categories. A processor-recorded query asks a manager to approve pausing the processor's **own** responsibility; until approved nothing is paused. A manager's own hold is approved on the spot. Approved pause runs from the verified query time and ends on resume.
- The **client commitment date is never moved by a hold or a query** (this reverses the earlier "query shifts the client date" rule — see decisions).
- A hold does not remove an existing miss, and does not protect one that has not happened: only an approved pause on a verified external wait pauses responsibility.
- Resume closes the hold interval (end, duration, resumed by, reason, status before/after), restores the right state (To Do / In Progress / Fix Needed), tells the processor and manager, and never completes the task or grants credit.
- *Ready to Resume*: when the client reply is logged, or someone marks the dependency resolved, the task moves there (it never resumes by itself).
- Fields kept per hold (camelCase of the spec's names): `holdId, category, reason, waitingOnType, waitingOnPerson, heldAt, resumedAt/resumedTs, heldHours, createdBy, approvedBy, querySentAt, queryEvidence, followUp, expectedResponseDate, responsibilityPaused, pauseStartedAt, pauseEndedAt, originalInternalDueDate, originalClientCommitmentDate, resumedBy, resumeReason, statusBeforeHold, statusAfterResume, updates[], evidence[]`. Earlier holds keep working exactly as saved.

**Processor Dashboard** (default for every ordinary employee; a superadmin can switch anyone off in Manage Access). Six tiles — **Due Today · Fix Needed · Ready to Resume · Waiting on Others · Sent for Review · Reports to Send** — each tile's number is the number of unique tasks in its list. One tile, one list, one detail panel at a time. Held work never appears in Due Today. Allocated-hour strip in plain words (actionable workload, fix needed, on hold, sent for review — "allocated, not time spent, not capacity"). Task panel: category, reason, waiting on, held for, follow-up, responsibility paused?, client commitment, latest review result and notes, manager, action owner, Report Sent (separate), attachments (reviewer's files and the processor's corrected files, by round, with who/when), full timeline. Actions follow the state: Resume, Ready to resume, Update hold (follow-up / evidence), Record query, Request new date, Send report…, Put on hold, Reopen / change reviewer, resubmit with corrected files.

**Productivity** (one service, every dashboard): Productivity % = Σ allocated hours of tasks approved **Reviewed Clean** (or valid admin work completed) ÷ eligible capacity hours × 100; full hours or zero; counted once per task; dated by the Reviewed Clean timestamp; never worked/punch/online hours, Report Sent, the three-day rule or on-hold time.

**Capacity**: 7 h × eligible elapsed days. Leave, weekly off (Sunday), workshop Saturday (Superadmin calendar), public/non-working days and partial leave are deducted. Holds, review waits, rework, being unassigned or blocked never reduce it. Future days are never counted. The calculation panel now has a **date-by-date table** (standard hours, each deduction, final hours, reason, source record) that adds up to the capacity.

**Internal commitment** (separate from productivity): judged on the **first** hand-in against the internal date (moved only by an approved external pause). Wording: Submitted on time / Submitted late / Not submitted — internal date passed / Paused by verified external dependency / Submitted on time — waiting for reviewer / Submitted on time · correction due … / correction resubmitted on time|late. A manager- or SOP-caused correction says so and is not the processor's miss.

**Manager exceptions**: "Pause of responsibility awaiting your approval"; "On hold for the client with no query evidence recorded".

**Removed / reduced on the processor view**: Time Clock, Online/Offline, extra hours built on actual work time, the big history chart, founder/manager navigation, the "hrs done" header.

## 3. Files
`hold-model.js` (new) · `workflow.js` · `server.js` · `manager-views.js` · `data-quality.js` · `db.js` (none for this work) · `public/index.html` · tests: `processor-dashboard.e2e.test.js` (new, 17), plus updates to `history-commitment`, `workflow-rules`, `alerts-measures`, `founder`, `today`, `productivity-v3`, `workflow`, `file-attachments`, `accessibility.static` · `docs/ui-checks/qa-processor-server.js` (a throwaway server with a realistic day for Ranjit) · `.claude/launch.json` (adds the `qa-processor` preview).

## 4. Database / migrations
**No migration.** New optional fields appear only on new activity: `holdHistory[]` extras, `queries[].evidence/pauseStatus/…`, `holdResolvedAt`, `dateRequests[]`, `correctionAttachments[]`, `firstSubmittedAt/submissions[]`. Nothing is deleted or overwritten; dismissed/removed queries are kept (marked dismissed). Old month-close credits stay on their tasks, uncounted.

## 5. Ranjit's numbers
Production data is not available on this machine, so **I cannot print Ranjit's real corrected totals** and have not invented any. To read them live after publishing: *Performance → Report Card → Ranjit → View calculation*: it lists every qualifying task (full hours, Reviewed Clean date), every excluded task with its reason, who acts next, the date-by-date capacity table, and the Report Sent figures separately; *Admin → Data quality* lists the client tasks closed without review. On the QA dataset (`node docs/ui-checks/qa-processor-server.js`) the page shows, e.g., 56 h capacity for 1–9 Oct (8 scheduled days × 7 h; Saturday 3 Oct counts unless it is marked a workshop Saturday in the Superadmin calendar — the day table shows it), 1.0 h qualified (two tasks × 0.5 h), 1.8 %.
**Check the eighth day yourself:** in the Report Card day table, find Saturday 3 Oct. If its reason says "Standard working Saturday" it was not marked as a workshop Saturday; if it says "Workshop Saturday" it was.

## 6. Decisions you should confirm (they change earlier behaviour)
1. **The client date no longer moves because of a query** (the earlier Query-Aware rule shifted it). Only an authorised manager change moves it. 
2. **A held task is shown at risk / overdue like any other** (my 9 Oct "do not count on-hold" change is reversed; only an approved pause on a verified external wait pauses the processor's own responsibility).
3. **One productivity rule for every period from go-live** — earlier periods that used "sent for review" or "report sent" will recalculate.
4. **Month-end banking is retired** (history kept, not counted).
5. **Every ordinary employee gets the focused dashboard by default** (Time Clock hidden; attendance stays a separate matter).
6. A processor's recorded query needs a **manager's approval** before it pauses responsibility.

## 7. Tests
Full suite 484/484 (`node --test --test-concurrency=4`). The 34 cases of the spec map to `processor-dashboard.e2e.test.js` (hold, resume, query, productivity, capacity, files, permissions, reconciliation, wording) plus the existing founder tests (capacity types, future days, leave/workshop) — see the test titles, which carry the spec numbers.

## 8. Manual QA checklist (use `qa-processor` preview, or your own data)
A. **Client query**: start a task → Put on hold → *Waiting on client information* → tick "I really sent a query", fill how/date/time/evidence → it leaves Due Today and shows in Waiting on Others (client) with "pause awaiting manager approval"; as the manager approve it; capacity unchanged; log the reply → Ready to Resume; Resume; send for review; reviewer approves → full hours on that day; report still in Reports to Send; sending it does not change productivity.
B. **Manager clarification**: hold → *Waiting on manager decision* → no query option; responsibility never paused; manager "Ready to resume".
C. **Rework**: reviewer returns with a file → Fix Needed with the file (preview/download) → upload a corrected file, choose the reviewer, resubmit → reviewer sees both files by round → approve → full hours once.
D. **Report not sent**: reviewed clean → full productivity immediately; in Reports to Send; Report Sent score 0 until sent; productivity unchanged after sending.
E. **Period switching**: Performance → Report Card, flip the period quickly — only the last choice ever shows, with its own label.
F. **Permissions**: as a processor try the founder pages / other people's data — refused by the server.
G. **Keyboard**: Tab to a task title (a button), Enter opens the panel and focus lands on its heading; Esc closes it.

## 9. Screenshots
Playwright is not installed here, so repo screenshots were not regenerated. The screens were checked in the preview at the sizes available. Capture the eight requested screens (main dashboard, Waiting on Others, hold form, held task, Ready to Resume, Fix Needed with reviewer attachment, productivity calculation, Reports to Send) while doing the checklist above.
