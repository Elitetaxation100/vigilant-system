# Commitment watch + new mark amounts — release pack (DRAFT)

Branch `feat/commitment-watch` (off `main`, independent of `feat/performance-v2`). **Not on `main`, not deployed.**

## What the six points became

| # | You asked for | What it does now |
|---|---|---|
| 1 | Flag by itself: call/email not acknowledged, late callback, work submitted late = **−50** | Acknowledgement: **−50** per call or email not acknowledged (was −10). **Late callback (new): −50.** **Work submitted late (new): −50.** All automatic, all voidable by a superadmin, all adjustable in Recognition → Marks. |
| 2 | Commitment breach of client = **−250** | The existing "report not sent by the committed date" mark is now **−250** and is called *client commitment breach*. It is now charged at **any stage** (not just once the report is waiting), once per task, to whoever owns the next step. |
| 3 | Stage timestamps | Task history now opens with the five stage times: **Submitted · Reviewed · Sent back · Marked ready for report · Report sent**, each with who and when. "Ready for report" is a new stamp (`readyForReportAt`); the others were already recorded and are now shown together. |
| 4 | Notifications | Reviewer told on submit and on resubmit (already existed). Processor told when work is **sent back** (existed) and when it is **ready** — for client work "send the report" (existed), and now also **"approved and finished"** for admin work and work that needs no report (the one gap). |
| 5 | Late / at-risk flags | Three flags: **not submitted by the due date**, **review not done before the commitment date**, **no update one working day before the commitment date**. Shown per task, on the Commitment watch list, and raised as ONE notification per problem to the right people (auto-clears when fixed). |
| 6 | Commitment breach list | **Commitment watch → Commitment breaches**: commitment date passed, report not sent. Longest overdue first, with the stage, who owns the next step, the five stage times, and a CSV that matches the list row for row. |

Commitment watch is in the menu (⚑) for everyone. Each person sees their own work, managers their team's, the founder everyone's.

## Decisions I made — please confirm or change

1. **"Late callback" had no definition in the system.** I defined it: an inbound call nobody picked up (or that went to voicemail) must be called back **the same working day before 6:45 pm NZ** (next working day if it came in later or on a day off). A later **outbound call** to that number, or an **answered call** from it, counts as the callback. A callback made after the deadline is still late. Calls already handled (outcome logged, made a task, no action needed), recovered calls, and numbers not routed to anyone never count. Leave days push the deadline on. Charged to **each person the call was routed to**, once per call. Say if you want a different time limit.
2. **Who gets the −250.** Whoever owns the next step on the workflow card at the time: the processor if the work was never handed in or was sent back, the **reviewer** if it is sitting in review, the report sender if the report is waiting. It is once per task, so a rework round or a late send afterwards never adds a second −250.
3. **Work submitted late:** the **first** hand-in after the (client-query-adjusted) internal due date, or a correction handed back after its correction date **when the correction was the employee's own responsibility** (a manager / reviewer / client fault is not their miss). Once per hand-in. Admin tasks with an internal due date count too.
4. **"No update" means** any recorded sign of life on the task: a hand-in, review step, hold / query / date change, report step, or a running timer. Raised from the working day before the commitment date, cleared by any update on or after that day.
5. **Nothing is retroactive.** The new −50 / −250 amounts and the two new rules start **the day this is published**. A commitment breach whose date was before that is still *listed* but never charged. Report-stage breaches keep their existing start date, so nothing already charged is charged again.
6. **One-time reset of amounts.** Because settings are stored in the live database, publishing sets acknowledgement to −50 and the commitment breach to −250 **once** — if you had changed either amount by hand, that change is overwritten once. After that, anything you set in Recognition → Marks sticks.

## Files

`commitment-watch.js` (new, pure rules) · `auto-marks.js` (new amounts, one-time reset, callback rule) · `connector.js` (callback check runs with the 15-minute marks job) · `server.js` (stage stamps, notification, late-submission + breach marks, `/api/commitment-watch` + CSV, `/api/tasks/:id/watch`, alerts) · `public/index.html` (Commitment watch, stage block in task history, settings for the new rules) · tests `commitment-watch.test.js` (12), `commitment-watch.e2e.test.js` (10); the existing mark tests were updated to the new amounts (10 → 50, 10 → 250).

## Rollback

Switch any rule off in Recognition → Marks (each new rule has its own tick box and amount), or revert the merge. No task, review, hold, leave or report record is rewritten; the only new stored fields are `readyForReportAt` on a task and `scale` / `scaleFrom` / `ruleFrom` in the marks settings. Wrongly-given marks can be voided one by one.

## Not done / limits

- The late-callback check could not be exercised against real Aircall data here; it is covered by unit tests on the rule itself.
- Screens were checked in the local preview with example data, not production.
