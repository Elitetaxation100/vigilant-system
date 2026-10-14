# Time ledger — release pack (DRAFT)

Branch `feat/time-ledger` (off `main`). **Not on `main`, not deployed.**

## What you asked for

"How much time an employee worked on which task on a specific day" — e.g. an 8-hour client-processing task: 5 h yesterday, 3 h today — so you can see where their time goes and how long any task really took.

## What it does

Every time the work clock stops (Pause, Hold, Mark Complete, Mark Done, Reassign, Punch Out, Resubmit, the forgotten-clock auto-pause, and the Slack/call-task close) the time it ran is **split at New Zealand midnight and written to the task as dated entries** — who, which day, how many hours, how it was recorded. Entries are only ever added, never edited. `logged` (the number everything else uses) is unchanged.

**Time ledger** (⏱ in the menu, for everyone):
- **By day** — each day with the hours worked (bar against the 7 h day, "day off" on days off) and the tasks, client and hours inside it. Quiet days show 0.
- **By task** — task, client, allocated hours, hours worked in the range, days worked, total logged.
- **By client** — where the time went per client, with share.
- **Whole team** (managers) — everyone's total for the range and their top clients; click a person to open theirs.
- Range: Today · Yesterday · Last 7 days · This month · any custom dates (up to 3 months). **Download CSV** gives the same rows.
- A clock that is running right now counts for today straight away.

**Task history** now has a "Time on this task" block: each day and person, the hours, how it was recorded, and the total against the allocated hours.

Who sees what: a person sees their own time, a manager their team's, the founder everyone's. The ledger is not sent with the normal task list (fetched only when opened), so nothing gets slower.

## Added after your screenshot (manager view + employee logging)

**Manager — My team (Today dashboard):** each person's row now shows **⏱ X h worked** for the range you have selected (Today, Yesterday, this week, custom…), and **in front of every task** it shows how long was recorded on that task in that range ("⏱ 3 h worked"; hover shows the task's total logged). Click a person's worked hours to open their full time ledger on the same dates.

**Employee — Log my work** (menu, the ✎ button on the Today strip, and inside the Time ledger): put the work you did on any of your tasks, so it lands on the right client even if the clock was not used.
- Choose the day (today, yesterday or the day before), then one or more tasks (grouped by client, showing allocated and logged hours), the hours, and optionally what you did.
- It shows what is already recorded for that day so nothing is entered twice. A task whose clock is running is refused until it is paused. One line is 0.1–16 h and a day cannot go above 20 h. Everything is checked first — if any line is wrong, nothing is saved.
- Entries show as "Logged by the employee", add to the task's logged hours (so "hours actual vs agreed" and Extra Hours include them) and appear in the task's history.
- **Continue on <day>** (optional, per task): the task stays open and is marked "Continue on 15 Oct". That morning the person gets one notification, the task shows as "Continue today" and sits in their Due Today list. Starting the clock again clears the plan; it can also be changed or taken back.

## Things to know before approving

1. **Nothing is invented for the past.** Hours logged before this goes live have no day recorded. They stay in the task total and show as **"Before day-by-day tracking"** on the task — they are never spread over days. Day-by-day figures therefore start the day this is published and fill in from then on.
2. **Hours with no clock** are recorded as they are: time added while on hold, "actual hours" typed on Mark Done and a superadmin's correction of logged hours are dated **today** (a correction can be negative). Hours typed when starting a task ("I started this before today") have no day, so they are listed apart as "entered without a day", never placed on a day.
3. **Reassigning** keeps the time already run with the person who did it; the new owner starts clean.
4. **Per-day target** shows the standard 7 h on working days and "day off" on Sundays and holidays; it does not subtract part-day leave.
5. **`fix/logged-audit`** (still unpublished) changes logged hours without a date. After both are live its corrections would show on a task as "earlier corrections". It still works; if you want its corrections dated too, that is a small follow-up when it is published.

6. **Logged work is on trust, with a trail.** The manager sees who logged what and when (task history and the ledger say "Logged by the employee"). Days older than two days back cannot be logged from this screen.

## Files

`time-ledger.js` (new — the rules) · `server.js` (every place the clock stops or hours change now goes through it; `/api/time-ledger`, `/api/time-ledger/team`, `/api/tasks/:id/time`) · `connector.js` (call/Slack task close) · `public/index.html` (Time ledger, task-history block) · `workflow.js` (the Continue badge and Due Today) · tests `time-ledger.test.js` (10) and `time-ledger.e2e.test.js` (14).

## Rollback

Revert the merge. The only stored addition is `timeLedger` on tasks; leaving it in place does no harm. No existing hours, task or review record is changed.

## Not done / limits

- No earlier days can be reconstructed (see point 1).
- Checked in the local preview with example numbers, not production data.

## Update: choose any dates in Log my work (draft `feat/log-range`)

Log my work now has **From** and **To** date pickers (plus Today / Yesterday / This week so far) instead of only today and yesterday.
- **One date:** any day in the last **60 days** (a day off is allowed — people do work on one).
- **A range (up to 31 days):** the hours you enter are **per working day**; Sundays and holidays in the range are skipped. The screen shows the maths ("6 working days × 2.5 h = 15 h") before you save, and what is already recorded for those dates.
- Entries for days more than **two days ago** are labelled **"Logged later by the employee"** in the ledger so a manager can tell them from same-week entries. Everything else is unchanged: all-or-nothing checks, 16 h per line per day, 20 h per day, no logging while the clock runs, no future dates.
