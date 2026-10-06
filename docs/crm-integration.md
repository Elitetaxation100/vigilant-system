# ET-CRM ↔ Task Manager — production integration contract

Who owns what:

| ET-CRM is authoritative for | The Task Manager is authoritative for |
|---|---|
| Employees / users | **Tasks** and their status / workflow |
| Customers (contacts) | Productivity and the capacity formula |
| Attendance | Workshop Saturdays |
| Leave | Task review, timers, report sending |
| HR policy compliance | |

**There is no CRM task sync.** ET-CRM's own task management is decommissioned; the Task Manager is the permanent
source of truth for tasks. The old `POST /webhooks/crm-task` is disabled (it answers `410`) and nothing is ever
imported from it.

## The five live webhooks (ET-CRM → Task Manager)

All are Supabase Database Webhooks: method **POST**, events **Insert + Update + Delete**, JSON body
`{ "type": "INSERT|UPDATE|DELETE", "table": "...", "record": { ... }, "old_record": { ... } }`, and the header

```
X-CRM-Webhook-Secret: <the shared secret>
```

The secret is compared in constant time. Missing or wrong → `401` and nothing is processed.

| ET-CRM table | URL | Becomes |
|---|---|---|
| `crm_users` | `https://<task-manager>/webhooks/crm-user` | employee |
| `contacts` | `https://<task-manager>/webhooks/crm-customer` | client |
| `attendance_daily` | `https://<task-manager>/webhooks/crm-attendance` | attendance log |
| leave requests | `https://<task-manager>/webhooks/crm-leave` | leave (capacity) |
| policy compliance | `https://<task-manager>/webhooks/crm-policy-compliance` | compliance lock |

Do **not** create a webhook for ET-CRM tasks.

### Response codes (every webhook)

| Code | Meaning |
|---|---|
| `200` | applied (`created` / `updated`) |
| `202` | safely skipped, or waiting for a person to be linked (`skipped` / `unlinked`) |
| `400` | invalid payload (a required identity field is missing or malformed) |
| `401` | missing / wrong secret |
| `409` | identity conflict (`conflict` / `ambiguous`) — nothing was changed |
| `500` | a real processing failure |

A success is never returned when processing failed. The body is `{ "ok": bool, "outcome": "...", "note": "..." }`.

### A DELETE never deletes history

A DELETE in ET-CRM never hard-deletes an employee, client, attendance day or leave record here. Employees and clients
are marked (`crmDeletedAt`) and kept; a deleted **leave** is set to `cancelled` (so it stops reducing capacity) and kept;
attendance history is kept. To end someone's access, mark them inactive in ET-CRM (below).

## Employees — `/webhooks/crm-user`

```json
{ "crm_user_id": "uuid", "full_name": "Ann Lee", "email": "ann@elitetaxation.co.nz", "is_active": true,
  "department": "Tax", "designation": "Accountant", "employment_type": "full_time",
  "employment_status": "active", "slack_user_id": "U0123", "manager_id": "uuid" }
```

* **Required:** `crm_user_id`. To *create* someone, `email` is also required.
* **Matching:** `crm_user_id` first, then a **unique** work email. Never a name. When the email matches, `crm_user_id` is
  saved on the employee. An email already linked to a *different* CRM user → `409 conflict`. Two employees with that email
  → `409 ambiguous`. No duplicate `crm_user_id` is ever created.
* **Idempotent:** the same user again updates the same employee. An unchanged repeat is a `202 skipped`.
* **New people** start as a plain `employee` on team `Unassigned` with a forced first-login password change; the temporary
  password is sent on Slack when `slack_user_id` is given (otherwise handed over by hand). Passwords/credentials from
  ET-CRM are never imported. People on the retired list are never re-created.
* **Existing people:** name, `department` → `crmDepartment`, `designation` (→ job title only when it is still the default),
  employment type/status, `manager_id` → `crmManagerId`. **Role, team, managesIds and the org chart are never overwritten.**
* **Access:** `is_active = false`, or `employment_status` of `inactive`, `terminated` or `resigned`, switches the login off
  (new sessions *and* existing ones). Their tasks and history are kept and **open work is not reassigned** — superadmins are
  notified to review it. `on_leave` never disables anything. Active again → access is restored. The last active
  superadmin is never locked out (`409`).

## Customers — `/webhooks/crm-customer`

```json
{ "id": "uuid", "name": "Kiwi Plumbing Ltd", "email": "k@kp.nz", "phone": "021 555 0001", "category": "Business",
  "assigned_to": "<crm_user_id>", "authority_signed": true, "pbq_done_at": "2026-09-01T00:00:00Z",
  "task_manager_client_id": null }
```

* **Required:** `id` (stored as `crmContactId`).
* **Matching order:** (1) `crmContactId`; (2) ET-CRM's `task_manager_client_id`; (3) a unique **non-company** email;
  (4) a unique normalised phone; (5) an exact **multi-word** full name, last. The firm's own `@elitetaxation.co.nz` addresses
  are never identity proof. Ambiguous → `409`, never merged. A contact whose `task_manager_client_id` points at a client
  that belongs to a different contact → `409 conflict`.
* **Who counts as a client (configurable, Admin → ET-CRM connection):** by default **authority signed AND PBQ done**.
  A contact that does not meet the rule and has no existing client is `202 skipped` with the reason; an already-linked
  client keeps updating regardless. An existing client is linked (blanks filled, name kept) without needing the rule.
* **Link-back:** after a client is created or linked, the Task Manager calls ET-CRM's `link-task-manager-client` with
  `{ id: <crmContactId>, task_manager_client_id: <client.id> }`. ET-CRM's own conflict protection is respected — a *different*
  existing id is reported as a **conflict** and never overwritten or retried. It runs after the webhook answer, so a slow
  call never delays it, and its result is shown in the panel.

## Attendance — `/webhooks/crm-attendance`

```json
{ "crm_attendance_id": "uuid", "crm_user_id": "uuid", "date": "2026-10-05",
  "check_in_at": "2026-10-04T20:00:00Z", "check_out_at": "2026-10-05T04:30:00Z", "net_minutes": 480, "status": "present" }
```

* **Required:** `crm_user_id` (or a unique `email`) and `date` (or `check_in_at`, from which the **Pacific/Auckland** day is taken).
* ET-CRM's own daily table identifies the person as `team_member_id`; that is accepted as the CRM user id (it must be the same value as `crm_users.id`). The same goes for leave rows. The Task Manager does not depend on the table's name — only on the URL the webhook posts to.
* **Idempotent** on `crm_attendance_id`; fallback `crm_user_id` + date. A correction updates the same day; if the row moves
  to another date the old day is cleared. Hours come from `net_minutes` (else check-out minus check-in, capped at 16h).
* ET-CRM is authoritative: the Task Manager **never writes attendance back**. Actual hours are **not** used as productivity capacity.

## Leave — `/webhooks/crm-leave`

```json
{ "crm_leave_request_id": "uuid", "crm_user_id": "uuid", "start_date": "2026-10-14", "end_date": "2026-10-14",
  "days_count": 1, "is_half_day": false, "half_day_period": "morning", "status": "approved" }
```

* **Required:** `crm_leave_request_id`, `crm_user_id` (or unique `email`), `start_date`; `status` ∈ `pending | approved | rejected | cancelled`.
  A half day must be a single date (`half_day_period`: morning/AM or afternoon/PM).
* **Only `approved` reduces capacity:** a full day removes **7 h**, a half day **3.5 h** (base ÷ 2). `pending` and `rejected`
  reduce nothing; an approved leave that becomes `cancelled` restores the capacity. **Task allocated hours are never touched.**
* **Idempotent** on `crm_leave_request_id` (`crmLeaveRequestId`): repeats update the same record. Leave that ET-CRM owns cannot
  be approved, cancelled or edited inside the Task Manager.

### Productivity (unchanged)

`Productivity % = allocated hours of qualifying delivered tasks ÷ available capacity hours × 100`, where capacity is
working days × 7 h minus approved ET-CRM leave, weekly off and Workshop Saturdays. No partial WIP credit. **Workshop
Saturdays stay local** — the Task Manager owns them; ET-CRM does not send them.

## HR policy compliance — `/webhooks/crm-policy-compliance`

```json
{ "version": 1, "event": "policy.compliance.updated",
  "employee": { "crm_user_id": "uuid", "email": "ann@elitetaxation.co.nz" },
  "compliance": { "pending_count": 1, "compliant": false },
  "policy": { "version_id": "v3", "name": "Code of conduct" } }
```

Only the compliance **state** is stored (never policy documents). A normal employee with a pending required policy is
blocked from Task Manager work (`423 policy_acknowledgement_required`); admins/superadmins keep emergency access. The webhook is
the real-time path; as a fallback the Task Manager can call ET-CRM `get-policy-compliance` (`{ crm_user_id }` →
`{ compliant, pending_count, checked_at }`) to recover from a missed or stale event (a stale state is re-checked on next sign-in).
An unknown CRM user is `202 unlinked`.

## Unknown / unlinked users

Attendance, leave and policy events for a CRM user the Task Manager cannot match are **never guessed by name**. Only a
unique work email, if the payload carries one, is tried. Otherwise the event is skipped safely and the person appears under
**Waiting to be linked** in Admin → ET-CRM connection. An admin picks the employee and presses **Link**; the waiting
attendance and leave are then applied. (Manage Access → CRM user id does the same for one person.)

## ET-CRM API actions the Task Manager calls (API key scopes)

| Action | Used for | Needed |
|---|---|---|
| `link-task-manager-client` | link-back after a client is created/linked | **yes** |
| `get-policy-compliance` | policy fallback / reconciliation | **yes** |
| `list-pipeline` | Reconcile customers (repair only) | only if customer reconciliation is used |
| `list-users`, `list-attendance`, `list-leave` | *optional* remote halves of Reconcile employees / attendance / leave | only if ET-CRM offers them |

The broad `update-contact` permission is **not** used any more. Everything else flows by webhook.

## Reconciliation (Admin → ET-CRM connection)

The webhooks are real-time; reconciliation repairs drift. Each button is idempotent, safe to repeat, and **Preview** changes
nothing. *Employees / Attendance / Leave:* a local audit (duplicate CRM ids, unlinked people, what is waiting) plus replay of
what became resolvable, and — only if ET-CRM offers the list action — the same apply rules over ET-CRM's list (otherwise the
panel says "ET-CRM does not offer … yet — local checks only"). *Customers:* reads `list-pipeline` and runs every contact through
the same rule as the webhook. *Policy:* re-checks every linked employee with `get-policy-compliance`.

## Admin connection health

Admin → ET-CRM connection is intentionally an operations view, not a second integration engine.

It shows:

- explicit ownership: Employees, Customers, Attendance, Leave and Policy Compliance are sourced from **ET-CRM**; Tasks are sourced from **Task Manager**;
- linked, unlinked and inactive-linked employees, plus duplicate-email conflicts;
- linked clients, locally unlinked clients, ambiguous matches and the last reconciliation's eligible-unlinked count;
- last successful / failed webhook activity per area;
- whether `CRM_WEBHOOK_SECRET`, `CRM_API_KEY` and an explicit `CRM_API_URL` are configured (the secret/key values are never exposed);
- the legacy CRM task sync as **Disabled**.

The **Run CRM Connection Check** action is read-only. It does not reconcile, link records, change attendance/leave cut-over switches or write anything to ET-CRM. It checks configuration, employee/client link health, attendance/leave sync evidence, a read-only `get-policy-compliance` probe when credentials and a linked employee are available, and confirms that the legacy CRM task import remains disabled.

Reconciliation buttons are named **Preview Reconciliation** and **Apply Reconciliation**. Preview never mutates data.

## Railway environment variables

| Variable | Needed for |
|---|---|
| `CRM_WEBHOOK_SECRET` | every ET-CRM webhook (shared secret) |
| `CRM_API_KEY` | link-back, policy fallback, customer reconciliation (an ET-CRM key with the scopes above) |
| `CRM_API_URL` | optional — defaults to the ET-CRM `crm-api` function |

## Setting it up on the ET-CRM side

1. Create the five webhooks above (Insert/Update/Delete), each with the `X-CRM-Webhook-Secret` header.
2. Add the action `link-task-manager-client` (conflict-protected: refuse to overwrite a different id) and make sure
   `get-policy-compliance` exists; give the Task Manager's API key exactly those scopes (plus `list-pipeline` for reconciliation).
3. Make sure each `crm_users` row carries the work email the Task Manager already knows, or link people from Admin.
4. Send one test event per webhook; Admin → ET-CRM connection shows each area's last successful sync, last failure and counts.

The panel stores **safe metadata only**: time, entity, event type, CRM id, outcome, a reason and the payload's field *names* —
never payload values, passwords or the secret.
