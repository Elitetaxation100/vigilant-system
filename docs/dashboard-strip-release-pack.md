# Dashboard strip — release pack (DRAFT)

Branch `feat/dashboard-watch-strip` (off `main`). **Not published.**

## What changed

The new features are now on **every dashboard**, in one shared strip at the top, with the same numbers for everyone and scoped to who is looking:

| Tile | What it shows | Click opens |
|---|---|---|
| Commitment breaches | Commitment date passed and report not sent (red when > 0, with the −250 marks) | Commitment watch → Breaches |
| Late or at risk | Not submitted by the due date · review not done before the commitment date · no update before the commitment date (late / at-risk split) | Commitment watch → Late & at risk |
| Worked today | Time recorded today against the 7 h day, plus the week so far | Your time ledger |
| Team worked today (managers / founder) | Total hours recorded today and how many people logged time | Time ledger → Whole team |
| Tasks to continue today | Tasks you planned to pick up again today | My Tasks |
| ✎ Log my work | — | Log my work |

**Where:** the older "My Dashboard" (all employees and managers), the newer Today page (every mode) and the Founder view. Each person sees their own work; a manager their team's; the founder the firm's. It is hidden while a manager is viewing someone else's dashboard (read-only mirror). The tile counts equal the lists they open (tested).

One small endpoint, `/api/dashboard-strip`, feeds all of it (cached for 45 s in the page and refreshed after you log time).

## Nothing was removed

**Recurring / daily tasks are untouched.** The 🔁 Daily tasks buttons on the older dashboards (the To-do panel and the My work tab) and the 🔁 Daily / recurring tasks entry on the Tasks page are all still there, with the server routes behind them. A test now fails if any of those are removed.

## Files and tests

`server.js` (`/api/dashboard-strip`, shared `timePeopleFor`) · `public/index.html` (the strip on the three dashboards) · `dashboard-strip.e2e.test.js` (3) · `dashboard-strip.static.test.js` (2, including the recurring-tasks guard).

## Not included

The five-metric performance cards (`feat/performance-v2`) are still unpublished, so they are not on any dashboard yet; they would join this strip when that is published.
