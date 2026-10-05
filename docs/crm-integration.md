# CRM ↔ Task Manager — setup for the CRM team

The CRM stays the CRM. The Task Manager only **listens** to it: when something
changes in the CRM, a Supabase Database Webhook tells the Task Manager, which
updates itself. Nothing here changes how the CRM works.

| In the CRM | What happens in the Task Manager |
|---|---|
| A **user** is added / changed | The person gets (or keeps) a login. New people arrive as a plain *employee*; their temporary password is sent on Slack if the CRM user has a Slack id. People who have left the firm are never re-created. |
| A **customer** is added / changed | The client appears (or is updated). If the CRM says who looks after them and the Task Manager has no owner yet, that person becomes the owner. We write our client id back to the contact (`task_manager_client_id`) when `CRM_API_KEY` is set. |
| A **task** is created | A task appears for the assignee as **"needs acceptance"** — they accept it or propose another date, like any task a colleague assigns. Tasks already done in the CRM are not brought across. Once someone has accepted a task, later CRM edits no longer rewrite it. |
| **Attendance** is recorded | The day's in/out and hours go into the Task Manager's attendance log, which drives capacity, leave and the report card. A day that is an approved leave day is kept as a note, not applied. |

Deleting something in the CRM never deletes it in the Task Manager.

## What the CRM team sets up

Four Database Webhooks (Supabase → Database → Webhooks), method **POST**, one per table,
all with the HTTP header `X-CRM-Webhook-Secret: <the shared secret>`:

| Table | URL |
|---|---|
| customers / contacts | `https://<task-manager-host>/webhooks/crm-customer` |
| users / staff | `https://<task-manager-host>/webhooks/crm-user` |
| tasks | `https://<task-manager-host>/webhooks/crm-task` |
| attendance | `https://<task-manager-host>/webhooks/crm-attendance` |

Events: **INSERT** and **UPDATE** (DELETE is accepted and ignored).
The exact addresses are shown in the Task Manager under **Admin → CRM connection**.

The shared secret is the `CRM_WEBHOOK_SECRET` value on Railway. Hand it over directly
(password manager / in person) — never in chat or email.

## Columns we read

We have not seen the CRM's schema, so each field is read from the first of these that is present.
If the CRM uses a different name, tell us — it is a one-line change. Admin → CRM connection lists the
field **names** (never the values) of every event received, so a mismatch is visible straight away.

**User:** `id`, `name` / `full_name`, `email`, `slack_user_id`
**Customer:** `id`, `name` / `full_name` / `company_name`, `email`, `phone`, `category`,
owner = `owner_id` / `assigned_to` / `account_manager_id` (or `owner_email`)
**Task:** `id`, title = `title` / `name` / `subject`, `description` / `notes`,
assignee = `assigned_to` / `assignee_id` / `owner_id` (or `assigned_to_email` / `assignee_email`),
creator = `created_by` (optional), client = `customer_id` / `contact_id` / `client_id`,
due = `due_date` / `due_at` / `deadline`, estimate = `estimated_hours` or `estimated_minutes`, `status`
**Attendance:** `id`, person = `user_id` / `employee_id` (or `email`), `date`,
in = `check_in` / `clock_in`, out = `check_out` / `clock_out` (full timestamps or plain `HH:MM` NZ time),
optional `hours_worked` / `total_hours` (otherwise out − in)

The `id` of a user row must match what is stored against the person in the Task Manager
(Manage Access → CRM user id). Until the person is linked — by that id, or by the same work email —
their tasks and attendance are **skipped**, and Admin → CRM connection says so.

## Defaults when the CRM leaves something out

- No estimate → **1 hour**; no due date → **next working day**; due date already passed → **today**.
  The task's description says so ("From the CRM — …. Adjust when you accept."), so nobody is surprised.
- No creator / creator is the assignee → a task you create for yourself is already accepted.
- No matching client → the task is created without a client (internal).

## Checking it works

1. Admin → CRM connection should show the shared secret as set and the four addresses.
2. Create a test task in the CRM for a linked person. Within seconds the panel shows **Tasks · INSERT · ok**,
   and the person sees it under "Needs acceptance".
3. If the panel shows **failed** with `rejected: bad secret`, the header on the Supabase webhook is wrong.
   If it shows **skipped … not linked**, link that person's CRM user id (or make sure the emails match).
