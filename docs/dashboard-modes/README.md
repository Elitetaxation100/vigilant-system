# Dashboard views — Today / Manager View / Review View

One view is on screen at a time. Each view has its own six tiles; a tile is a list of task ids, so **the number on a tile is the length of the list it opens** (`workflow.js → buildModes`). Nothing here is stored — no migration, no data changed.

## Tile → selector

| View | Tile | Tasks included |
|---|---|---|
| Today | Needs My Review | In Review, no open escalation, I am the named reviewer |
| Today | Client Delivery at Risk | Client due ≤ 2 days / today / overdue **and** I own the next action |
| Today | Waiting for My Decision | Date-change/assignment approvals, escalations to me, profit confirmation (if I confirm), urgent unassigned |
| Today | Reports I Must Send | Approved, client work, profit confirmation not pending, **I** am the report sender, not yet sent |
| Today | My Overdue Actions | I own the next action and (my submission date passed, or client overdue, or review past SLA). Never client / external / profit waits |
| Today | Actions Completed Today | Reviews approved, returned, escalations, reports sent, assignments and reassignments I did today |
| Manager | Team Delivery at Risk | Whole team: client deadline overdue / today / ≤ 2 days (client holds excluded) |
| Manager | Team Overdue | Employee-owned, Assigned / In Progress, internal due date passed |
| Manager | Reviews Blocking Delivery | In Review, reviewer owns it, and client deadline at risk or review SLA breached |
| Manager | Reports Not Sent | Approved client work not sent; breakdown overdue / today / later / waiting for profit confirmation |
| Manager | Waiting on Client | Authorised client holds |
| Manager | Needs Manager Attention | Open exceptions (same rule as the Needs Manager Attention page) |
| Review | Urgent Reviews | My reviews with client deadline at risk or review SLA breached |
| Review | New Submissions | My reviews that are not resubmissions |
| Review | Corrections Resubmitted | **All** my resubmissions (also shown under Urgent when urgent — the page says so) |
| Review | Waiting on Employee Correction | Work I returned that is with the employee |
| Review | Reviews Completed Today | Approved, returned, escalated today (actions, not tasks) |
| Review | Review SLA Breached | My reviews waiting longer than the review SLA (`workflowSettings.reviewSlaHours`, default 48 h) |

## Interaction rules (all enforced in `public/index.html`)
- Proper tabs (`role=tablist/tab/tabpanel`, `aria-selected`, arrow / Home / End keys). The chosen view is remembered across refresh.
- Changing view clears the old view's tile, open section, selected task and search. Nothing from the old view stays on screen.
- One tile selected at a time; one task detail at a time; one secondary section open at a time. One dialog at a time (single dialog box, focus trapped, Escape closes).
- The task panel emphasises what the view is for (what to do / delivery & people / submission & review waiting).
- Every list runs **newest first** (`taskNewest`, and `newest` is now the default sort of the manager Tasks list). Pages without their own search get a "Search this page" box.

## Tests
`npm test` (workflow.test.js: tile reconciliation, personal vs team scope, resubmission counting, SLA; accessibility.static.test.js; manager-views.test.js). `ui-check.js` drives a real browser (needs `playwright`): tabs, single-open rules, tile count = list length, search, refresh restore, page search, newest-first.

## Data safety / rollback
No stored data, history, files or audit records are touched and nothing is migrated. The server only adds derived fields to `GET /api/workflow/today` (`modes`, plus `sortAt`/`holdStart`/`holdFollowUp`/`submittedAt` on cards); the old fields are unchanged. **Rollback:** revert the merge commit and redeploy.

## Not in this change
Productivity / capacity formulas, review-form radio cards, configurable profit confirmer, Client/Admin Task form changes, attachment hand-off proof, a real Timeline, Calendar week/agenda, server-side pagination changes, data-quality report. These change scoring or stored data and need their own migration plans.
