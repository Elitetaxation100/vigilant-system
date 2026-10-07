# Productivity V3 and capacity breakdown — migration plan

## The rule
`Productivity % = qualifying allocated hours ÷ eligible capacity hours × 100`, with a 7 h working day.

- Only the task's **allocated hours** are counted — never online / punch / timer / actual hours.
- **Report Sent and profit confirmation never gate Productivity.** Report Sent stays its own measure (5 points per eligible report).
- Internal Commitment, Client Delivery, Report Sent, Quality and Reviewer performance stay separate and are not blended.

## What changed (and what did not)
| | Before | After |
|---|---|---|
| Credit date of a reviewed-clean task | the **dispatch date** if the report was sent, else the review date | always the **review date** (`rule: v3`, `qualifyingEventType: clean_review`) |
| Report not sent yet | credited at review | credited at review (unchanged) |
| Closed with no review ("Mark Done") | credited | credited (unchanged — see "Decision for you") |
| Shared / test logins in Productivity | included | excluded (`isNonProductiveAccount`) |
| Capacity card | `N working days − leave − workshop` (holidays not shown) | scheduled days − public holidays − leave − workshop − reduced hours = eligible days × 7 h; a deduction is shown only if made |
| Capacity not converted | open + "truly unallocated" could exceed the total | open → completed-not-qualifying → unallocated, always summing to the total; if it ever did not, the split is not shown |
| Page wording | "a task counts only once … sent to the client" | "Productivity measures reviewed-clean completed output … dispatch is measured separately under Report Sent" |

## Migration — nothing is rewritten
- **Prospective only.** The V3 rule applies to work *completed on/after* `PRODUCTIVITY_V3_EFFECTIVE_AT` (**8 Oct 2026 00:00 NZDT**, a fixed literal like V2). Work completed earlier keeps the rule it was counted under — old tasks are not recalculated.
- **Finalised months are stored snapshots** (`/api/productivity/finalize-month`) and are never touched.
- No task, review, file, history or audit record is modified or deleted. No existing productivity value changes unless it is a *new* completion after the cutoff.
- **Audit:** on first start the server writes `state.productivityV3History` (when introduced, effective date, what changed). `GET /api/productivity` returns `v3EffectiveAt`.
- Excluding shared logins changes **team and firm totals** for any period that included them (their capacity and output leave the sums). Individual people's numbers are unchanged. Re-include a login with `countsInProductivity: true` on that employee.

## Rollback
Revert the merge and redeploy. Because nothing stored was changed, a revert restores the previous numbers exactly. To switch only the new credit rule off without a revert, set `state.productivityV3EffectiveAt` to a far-future date.

## Verification
`productivity-rules.test.js` (six days − 1 leave − 1 workshop = 4 days = 28 h; a Saturday outside the period is never deducted; not-converted parts always sum to the total, including the 121.9 h case), `productivity-v3.e2e.test.js` (sent and unsent reports both credit at the clean review; old work keeps the old rule; shared logins excluded; breakdowns reconcile), and the full suite.

## Decision for you
Spec section 8 says a task qualifies when it was *reviewed clean*. Today an **Admin Task or no-review "Mark Done"** also earns its allocated hours (an existing, explicit V2 rule: "plenty of work doesn't need a second pair of eyes"). I left that as is, because removing it would cut people's scores for work they did correctly. If you want only reviewed-clean work to count, say so and I will make it effective-dated the same way.
