const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
// By default CORS is wide open (any origin) so the app works out of the box
// wherever it's deployed. Once you have a real deployed URL, set
// ALLOWED_ORIGIN=https://your-app-domain to restrict the API to just your
// own frontend — worth doing since the app is reachable over bearer tokens,
// not cookies, so a stricter origin check is defense-in-depth rather than
// the primary control.
if (process.env.ALLOWED_ORIGIN) {
  app.use(cors({ origin: process.env.ALLOWED_ORIGIN }));
} else {
  app.use(cors());
}
app.use(express.json({ limit: '12mb' })); // pause screenshots are base64 images

// Throttle login attempts — without this, nothing stood between a guesser
// and unlimited attempts against an account, especially risky given how
// guessable the seeded default passwords are (see README). 20 attempts per
// 15 minutes per IP is generous for a real user who mistypes a password a
// few times, but stops fast automated guessing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
});

// Minimum password bar for accounts created/reset through the API — the
// UI already tells people to change the seeded defaults, but nothing used
// to stop a 1-character password from being set here.
function isPasswordAcceptable(pw) {
  return typeof pw === 'string' && pw.length >= 8;
}
const WEAK_PASSWORD_ERROR = 'Password must be at least 8 characters.';

// ---------------------------------------------------------------------------
// JWT secret — generated once and stored on disk so tokens survive a
// server restart. Set JWT_SECRET yourself as an environment variable in
// production if you'd rather not have it sitting in a file.
// ---------------------------------------------------------------------------
const SECRET_PATH = path.join(__dirname, 'data', 'jwt-secret.txt');
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (fs.existsSync(SECRET_PATH)) {
    JWT_SECRET = fs.readFileSync(SECRET_PATH, 'utf8').trim();
  } else {
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_PATH, JWT_SECRET);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function publicEmployee(e) {
  const { passwordHash, ...rest } = e;
  return rest;
}
function findEmployee(state, id) { return state.employees.find(e => e.id === id); }
function findTask(state, id) { return state.tasks.find(t => t.id === id); }
function isAdminRole(role) { return role === 'admin' || role === 'superadmin'; }

/** Who can `actor` assign NEW work to? Mirrors the same rule everywhere. */
function assignableEmployees(state, actor) {
  if (actor.accessRole === 'superadmin') return state.employees;
  if (actor.accessRole === 'admin') return state.employees.filter(e => (actor.managesIds || []).includes(e.id));
  return [];
}
/**
 * Can `actor` act on a task that's currently assigned to `employeeId`?
 * Superadmins can act on anyone's task. An admin can only act on tasks
 * belonging to people in their own managesIds — the same boundary
 * assignableEmployees() already enforces for handing out NEW work. Without
 * this, review/reassign/approve-window/reject-window let any admin reach
 * into any other manager's team, which contradicts that boundary.
 */
function canManageEmployee(state, actor, employeeId) {
  if (actor.accessRole === 'superadmin') return true;
  if (actor.accessRole === 'admin') return (actor.managesIds || []).includes(employeeId);
  return false;
}

// ---------------------------------------------------------------------------
// TIME — there is no manual Start/Pause clock anymore. Once a task is
  // TIME — a task now has a real Start/Pause clock. t.timerStartedAt holds
  // the wall-clock moment the assignee's timer was last started for this
  // task, or null when it's paused. Only one task per employee can run at
  // once — starting or resuming one auto-pauses any other active task for
  // that employee (see pauseOtherActiveTasks below). "Actual delivery time"
  // is t.logged (hours already banked from past running stretches) plus
  // whatever has accrued since timerStartedAt, if the clock is running.
  // ---------------------------------------------------------------------
  function liveElapsedHours(t) {
    if (t.status === 'completed') return t.logged;
    if (!t.timerStartedAt) return t.logged;
    return t.logged + (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000;
  }
  /** Starting or resuming one task auto-pauses any other task that same
   *  employee currently has running, banking whatever time had accrued. */
  function pauseOtherActiveTasks(state, assigneeId, exceptId) {
    const now = Date.now();
    state.tasks.forEach(other => {
      if (other.id !== exceptId && other.assignedTo === assigneeId && other.timerStartedAt) {
        other.logged += (now - new Date(other.timerStartedAt).getTime()) / 3600000;
        other.timerStartedAt = null;
      }
    });
  }

/** Live elapsed time (wall-clock) since a task currently in rework was sent back — null once it's resubmitted. */
function reworkElapsedHours(t) {
  if (t.status !== 'rework' || !t.reworkStartedAt) return null;
  return (Date.now() - new Date(t.reworkStartedAt).getTime()) / 3600000;
}
function taskForClient(t) {
  return { ...t, displayedLogged: liveElapsedHours(t), reworkElapsedHours: reworkElapsedHours(t) };
}

// ---------------------------------------------------------------------------
// WORKLOAD / AVAILABILITY — capacity-based. An employee has a fixed daily
// capacity (DAILY_CAPACITY_HOURS); a new task is only blocked if handing
// it to them would push their ALREADY-COMMITTED hours on that specific
// agreed date over that capacity. Simply already having one other task
// due the same day is not by itself a conflict — only the actual hours
// total is. Completed tasks don't count (they're excluded here), and
// excludeTaskId lets a task check against an employee's OTHER work
// without tripping over itself (reassignment, window approval).
//
// employeeBusyUntil() stays as a lighter-weight, informational "latest
// agreed date among active work" signal — it feeds the Workload Blockers
// panel's "occupied until" display, which is just a heads-up, not a gate.
// ---------------------------------------------------------------------------
const DAILY_CAPACITY_HOURS = 9;
function employeeBusyUntil(state, employeeId, excludeTaskId) {
  const active = state.tasks.filter(t => t.assignedTo === employeeId && t.status !== 'completed' && t.internalDeadline && t.id !== excludeTaskId);
  if (active.length === 0) return null;
  return active.reduce((max, t) => (t.internalDeadline > max ? t.internalDeadline : max), active[0].internalDeadline);
}
function nextAvailableDate(busyUntil) {
  if (!busyUntil) return todayISO();
  const d = new Date(busyUntil + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  const iso = d.toISOString().slice(0, 10);
  return iso > todayISO() ? iso : todayISO();
}
// Sum of agreed hours (tat) for this employee's active tasks that are
// already due on `date` — the actual committed workload for that day.
function hoursCommittedOnDate(state, employeeId, date, excludeTaskId) {
  return state.tasks
    .filter(t => t.assignedTo === employeeId && t.status !== 'completed' && t.internalDeadline === date && t.id !== excludeTaskId)
    .reduce((sum, t) => sum + (Number(t.tat) || 0), 0);
}
function workloadConflict(state, employeeId, deadline, excludeTaskId, newTaskHours) {
  if (!deadline) return null;
  const committedHours = hoursCommittedOnDate(state, employeeId, deadline, excludeTaskId);
  const incomingHours = Number(newTaskHours) || 0;
  const projectedHours = Math.round((committedHours + incomingHours) * 100) / 100;
  if (projectedHours > DAILY_CAPACITY_HOURS) {
    return {
      busyUntil: deadline, nextAvailable: nextAvailableDate(deadline),
      committedHours: Math.round(committedHours * 100) / 100, projectedHours, capacityHours: DAILY_CAPACITY_HOURS,
    };
  }
  return null;
}

// Escapes user-controlled text (names, task titles, notes) before it's
// embedded in an activity-log entry that already carries deliberate HTML
// (the <b> tags below) — the log text itself is a mix of trusted markup
// and untrusted data, so only the data half needs escaping.
function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function logEvent(state, empId, text, meta) {
  state.activityLog.push({ id: crypto.randomUUID(), empId, text, meta: meta || null, ts: new Date().toISOString() });
  if (state.activityLog.length > 300) state.activityLog.shift();
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const state = db.get();
    const emp = findEmployee(state, payload.id);
    if (!emp) return res.status(401).json({ error: 'Account no longer exists.' });
    req.employee = emp;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired — please sign in again.' });
  }
}
function requireAdmin(req, res, next) {
  if (!isAdminRole(req.employee.accessRole)) return res.status(403).json({ error: 'Admin access required.' });
  next();
}
function requireSuperAdmin(req, res, next) {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  next();
}

// ---------------------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { email, password, expectedTab } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const state = db.get();
  const emp = state.employees.find(e => e.email.toLowerCase() === String(email).toLowerCase());
  if (!emp || !bcrypt.compareSync(password, emp.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const isAdminAcct = isAdminRole(emp.accessRole);
  // Two separate login "pages" on the frontend — Employee vs Admin/Superadmin.
  // Enforced here too, not just hidden in the UI: an employee's password
  // simply doesn't work on the admin tab and vice versa.
  if (expectedTab === 'admin' && !isAdminAcct) {
    return res.status(403).json({ error: 'This account is an Employee account — use the Employee tab.' });
  }
  if (expectedTab === 'employee' && isAdminAcct) {
    return res.status(403).json({ error: `This account has ${emp.accessRole} access — use the Admin / Superadmin tab.` });
  }
  const token = jwt.sign({ id: emp.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, employee: publicEmployee(emp) });
});
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ employee: publicEmployee(req.employee) });
});

// ---------------------------------------------------------------------------
// EMPLOYEES
// ---------------------------------------------------------------------------
app.get('/api/employees', requireAuth, (req, res) => {
  const state = db.get();
  res.json({ employees: state.employees.map(publicEmployee) });
});
app.post('/api/employees', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const { name, email, password, jobTitle, team } = req.body || {};
  let { accessRole } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
  if (!isPasswordAcceptable(password)) return res.status(400).json({ error: WEAK_PASSWORD_ERROR });
  if (state.employees.some(e => e.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  // Only a superadmin can grant admin/superadmin access when creating a login.
  if (req.employee.accessRole !== 'superadmin') accessRole = 'employee';
  if (!['employee', 'admin', 'superadmin'].includes(accessRole)) accessRole = 'employee';
  const id = 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  const emp = {
    id, name, email, passwordHash: bcrypt.hashSync(password, 10),
    jobTitle: jobTitle || 'Team Member', team: team || 'Unassigned',
    accessRole, managesIds: []
  };
  state.employees.push(emp);
  db.save();
  res.status(201).json({ employee: publicEmployee(emp) });
});
app.patch('/api/employees/:id', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const emp = findEmployee(state, req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  const { accessRole, managesIds, password, jobTitle, team } = req.body || {};
  if (accessRole && ['employee', 'admin', 'superadmin'].includes(accessRole)) emp.accessRole = accessRole;
  emp.managesIds = emp.accessRole === 'admin' ? (Array.isArray(managesIds) ? managesIds : []) : [];
  if (password) {
    if (!isPasswordAcceptable(password)) return res.status(400).json({ error: WEAK_PASSWORD_ERROR });
    emp.passwordHash = bcrypt.hashSync(password, 10);
  }
  if (jobTitle) emp.jobTitle = jobTitle;
  if (team) emp.team = team;
  db.save();
  res.json({ employee: publicEmployee(emp) });
});

// Remove an employee entirely — Superadmin only. Blocked while they still
// hold active (non-completed) work, so removing someone can't silently
// orphan a task; reassign it first, then remove. Also unwinds any trace
// of them elsewhere in the data model: other admins' managesIds grants,
// and client ownership (an owner-less client is a visible, flagged state
// already — see /api/clients — rather than a dangling reference).
app.delete('/api/employees/:id', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const emp = findEmployee(state, req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  if (emp.id === req.employee.id) return res.status(400).json({ error: "You can't remove your own account." });
  const activeTasks = state.tasks.filter(t => t.assignedTo === emp.id && t.status !== 'completed');
  if (activeTasks.length > 0) {
    return res.status(409).json({ error: `${emp.name} still has ${activeTasks.length} active task${activeTasks.length > 1 ? 's' : ''} — reassign ${activeTasks.length > 1 ? 'them' : 'it'} before removing this account.` });
  }
  state.employees = state.employees.filter(e => e.id !== emp.id);
  state.employees.forEach(e => { if (e.managesIds) e.managesIds = e.managesIds.filter(id => id !== emp.id); });
  state.clients.forEach(c => { if (c.ownerId === emp.id) c.ownerId = null; });
  delete state.punchLog[emp.id];
  delete state.attendance[emp.id];
  logEvent(state, req.employee.id, `Removed <b>${escHtml(emp.name)}</b> from the team.`, { removedEmployee: emp.name });
  db.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// TASKS
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CLIENTS — every client has a named owner. This is what "no client falls
// through the cracks" actually means in the data model: a client without
// an owner is a visible, flagged state, not just a missing field.
// ---------------------------------------------------------------------------
app.get('/api/clients', requireAuth, (req, res) => {
  const state = db.get();
  res.json({ clients: state.clients });
});
app.post('/api/clients', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const { name, ownerId, type } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Client name is required.' });
  if (ownerId && !findEmployee(state, ownerId)) return res.status(400).json({ error: 'Owner not found.' });
  const client = { id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000), name: String(name).trim(), ownerId: ownerId || null, type: type ? String(type).trim() : null };
  state.clients.push(client);
  db.save();
  res.status(201).json({ client });
});
app.patch('/api/clients/:id', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const client = state.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const { name, ownerId, type } = req.body || {};
  if (name && String(name).trim()) client.name = String(name).trim();
  if (ownerId !== undefined) {
    if (ownerId && !findEmployee(state, ownerId)) return res.status(400).json({ error: 'Owner not found.' });
    client.ownerId = ownerId || null;
  }
  if (type !== undefined) client.type = type ? String(type).trim() : null;
  db.save();
  res.json({ client });
});

app.get('/api/tasks', requireAuth, (req, res) => {
  const state = db.get();
  res.json({ tasks: state.tasks.map(taskForClient) });
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const state = db.get();
  const { mode, name, scope, assignedTo, clientId, clientDate, internalDeadline, tat, points, force } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Task name is required.' });
  if (!clientId) return res.status(400).json({ error: 'A client is required — every task needs a clear client owner.' });
  const client = state.clients.find(c => c.id === clientId);
  if (!client) return res.status(400).json({ error: 'Client not found.' });
  // The whole workload/blocker model runs off the agreed delivery date, so
  // it's mandatory now rather than a nice-to-have — a task with no agreed
  // date can't be checked for overlap against anything else.
  if (!internalDeadline) return res.status(400).json({ error: 'Agreed delivery date is required.' });

  let assignee = req.employee.id;
  if (mode === 'team') {
    assignee = assignedTo;
    const allowed = assignableEmployees(state, req.employee).some(e => e.id === assignee);
    if (!allowed) return res.status(403).json({ error: "You're not authorized to assign work to this person." });
  }
  // Workload blocker — refuse to schedule this employee into a day whose
  // committed hours would exceed daily capacity. See workloadConflict() above.
  const conflict = workloadConflict(state, assignee, internalDeadline, undefined, tat);
  if (conflict && !force) {
    const who = (findEmployee(state, assignee) || {}).name || 'This employee';
    return res.status(409).json({
      error: `${who} already has ${conflict.committedHours} hrs of agreed work due ${conflict.busyUntil} — adding this ${tat || 0}hr task would push them to ${conflict.projectedHours} hrs, over the ${conflict.capacityHours}hr daily capacity. Next available date: ${conflict.nextAvailable}.`,
      code: 'WORKLOAD_CONFLICT', busyUntil: conflict.busyUntil, nextAvailable: conflict.nextAvailable,
    });
  }
  if (conflict && force) { logEvent(state, assignee, `Emergency override used — assigned despite workload conflict (${conflict.projectedHours}h projected vs ${conflict.capacityHours}h capacity) by <b>${escHtml(req.employee.name)}</b>.`); }
  const status = mode === 'team' ? 'awaiting_acceptance' : 'accepted';
  state.taskSeq += 1;
  const task = {
    id: '#' + (100000000000 + state.taskSeq),
    name: String(name).trim(), scope: scope || '—',
    clientId: client.id, clientName: client.name, clientDate: clientDate || null, internalDeadline: internalDeadline || null,
    points: parseInt(points, 10) || 0, assignedTo: assignee, assignedBy: req.employee.id,
    assignedAt: new Date().toISOString(), reassignHistory: [], status,
    // logged accumulates ACTUAL delivery time — the wall-clock gap between
    // Accept and Complete (or, for a rework round, between the rework
    // Accept and Resubmit). There's no manual Start/Pause; the clock is
    // implicit in acceptedAt/reworkStartedAt. tat is the AGREED hours for
    // this task, set by whoever assigns it.
    logged: 0, tat: parseFloat(tat) || 3,
    // Even a self-assigned task ("Assign to Me") lands straight in
    // 'accepted' with no separate acceptance step, so its clock starts
    // immediately too.
    acceptedAt: status === 'accepted' ? new Date().toISOString() : null,
            timerStartedAt: status === 'accepted' ? new Date().toISOString() : null,
    completedAt: null, reviewStatus: null, reviewedBy: null, reviewNote: null, reviewedAt: null, reworkCount: 0,
    reviewerId: null, awaitingClientDecision: false, sentToClient: null, sentToClientAt: null, sentToClientBy: null,
    reworkStartedAt: null, faultType: null, reworkHistory: [], // reworkHistory: [{ round, startedAt, endedAt, durationHours, reviewNote, faultType }]
    // calls-into-tasks (Phase 0): where this task came from. Tasks made in the
    // app are 'manual'; the Slack connector will send 'call' / 'slack' later.
    source: 'manual', sourceRef: null,
  };
  state.tasks.unshift(task);
        if (task.status === 'accepted') pauseOtherActiveTasks(state, task.assignedTo, task.id);
  if (mode === 'team') {
    const assigneeEmp = findEmployee(state, assignee);
    logEvent(state, assignee, `New task assigned — <b>${assigneeEmp ? escHtml(assigneeEmp.name) : '—'}</b>, awaiting acceptance.`, {
      client: task.clientName, clientDate: task.clientDate, internalDeadline: task.internalDeadline
    });
  }
  db.save();
  res.status(201).json({ task: taskForClient(task) });
});
  app.post('/api/tasks/:id/pause', requireAuth, (req, res) => {
    const state = db.get();
    const t = findTask(state, req.params.id);
    if (!taskActionGuard(req, res, t, { mustBeAssignee: true })) return;
    if (!['accepted', 'rework'].includes(t.status)) return res.status(400).json({ error: 'Only an active task can be paused.' });
    if (!t.timerStartedAt) return res.status(400).json({ error: "This task isn't running." });
    t.logged += (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000;
    t.timerStartedAt = null;
    logEvent(state, t.assignedTo, `Paused "${escHtml(t.name)}".`);
    db.save();
    res.json({ task: taskForClient(t) });
  });

  // Resuming one task auto-pauses whatever else the same employee currently
  // has running (see pauseOtherActiveTasks) — this is how "choose to pause
  // the current task and start working on another one" is implemented:
  // switching is just Resume on the new task.
  app.post('/api/tasks/:id/resume', requireAuth, (req, res) => {
    const state = db.get();
    const t = findTask(state, req.params.id);
    if (!taskActionGuard(req, res, t, { mustBeAssignee: true })) return;
    if (!['accepted', 'rework'].includes(t.status)) return res.status(400).json({ error: 'Only an active task can be resumed.' });
    if (t.timerStartedAt) return res.status(400).json({ error: 'This task is already running.' });
    t.timerStartedAt = new Date().toISOString();
    pauseOtherActiveTasks(state, t.assignedTo, t.id);
    logEvent(state, t.assignedTo, `Resumed "${escHtml(t.name)}".`);
    db.save();
    res.json({ task: taskForClient(t) });
  });


function taskActionGuard(req, res, t, { mustBeAssignee = false, mustBeAdmin = false } = {}) {
  if (!t) { res.status(404).json({ error: 'Task not found.' }); return false; }
  if (mustBeAssignee && t.assignedTo !== req.employee.id) { res.status(403).json({ error: 'Only the assigned employee can do this.' }); return false; }
  if (mustBeAdmin && !isAdminRole(req.employee.accessRole)) { res.status(403).json({ error: 'Admin access required.' }); return false; }
  return true;
}


// Accept — the ONLY acknowledgement step. There's no separate Start/Pause
// clock anymore: accepting a task both confirms the employee has taken it
// on AND starts the agreed-time-vs-actual-delivery clock (acceptedAt /
// reworkStartedAt), which /complete and /resubmit read back later to work
// out actual delivery time. Nothing else for the employee to click.
app.post('/api/tasks/:id/accept', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!taskActionGuard(req, res, t, { mustBeAssignee: true })) return;
  // A task flagged with an error (reviewStatus === 'error') routes through
  // this exact same Accept step as a brand-new or reassigned task — see
  // the comment on /review below. Accepting it puts the rework clock in
  // motion (reworkStartedAt) and hands ownership to the assignee.
  if (t.reviewStatus === 'error') {
    t.status = 'rework';
    t.reworkStartedAt = new Date().toISOString();
    logEvent(state, t.assignedTo, `Accepted rework for "${escHtml(t.name)}" — now due ${t.internalDeadline || 'as agreed'}.`);
  } else {
    t.status = 'accepted';
    t.acceptedAt = new Date().toISOString();
    logEvent(state, t.assignedTo, `Accepted "${escHtml(t.name)}" — now due ${t.internalDeadline || 'as agreed'}.`);
  }
        t.timerStartedAt = new Date().toISOString();
      pauseOtherActiveTasks(state, t.assignedTo, t.id);

  db.save();
  res.json({ task: taskForClient(t) });
});

app.post('/api/tasks/:id/complete', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!taskActionGuard(req, res, t, { mustBeAssignee: true })) return;
  if (t.status !== 'accepted') return res.status(400).json({ error: 'Only an accepted task can be marked complete.' });
  const { reviewerId } = req.body || {};
  if (!reviewerId) return res.status(400).json({ error: 'Choose who should review this task.' });
  const reviewer = findEmployee(state, reviewerId);
  if (!reviewer) return res.status(400).json({ error: 'Reviewer not found.' });
  if (reviewerId === t.assignedTo) return res.status(400).json({ error: "You can't review your own work." });
    const elapsed = t.timerStartedAt ? (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000 : 0;
  t.logged += elapsed;
    t.timerStartedAt = null;
  t.status = 'completed';
  t.completedAt = new Date().toISOString();
  t.reviewerId = reviewerId;
  logEvent(state, t.assignedTo, `Marked "${escHtml(t.name)}" complete — ${t.logged.toFixed(2)} hrs actual vs ${t.tat} hrs agreed.`, { points: t.points });
  logEvent(state, reviewerId, `<b>${escHtml(findEmployee(state, t.assignedTo)?.name || 'Someone')}</b> asked you to review "${escHtml(t.name)}".`);
  db.save();
  res.json({ task: taskForClient(t) });
});

// Review & Accuracy — a completed return gets checked off as clean or
// flagged with an error. Only Admin/Superadmin review (separation of duties
// between who files the return and who checks it).
//
// An error flag is not just a label: it actively sends the task back to
// the assignee — but not straight into an active "fix it now" state.
// It drops into 'awaiting_acceptance', the SAME gate a brand-new or
// reassigned task uses: the assignee has to Accept it (which is what
// starts the rework clock and resumes the timer — see /accept) or Propose
// a New Window, exactly like any other incoming work. Flipping status
// away from 'completed' here also fixes commitment tracking automatically:
// a task sitting in this pipeline no longer satisfies status==='completed',
// so it can't be counted as "commitment met" until it's genuinely
// redelivered.
app.post('/api/tasks/:id/review', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
const isAssignedReviewer = t.reviewerId && t.reviewerId === req.employee.id;
  const isSelfReview = req.employee.id === t.assignedTo;
  if (!isAssignedReviewer && (isSelfReview || !canManageEmployee(state, req.employee, t.assignedTo))) {
    return res.status(403).json({ error: "You're not authorized to review this task." });
  }
if (t.status !== 'completed') return res.status(400).json({ error: 'Only completed tasks can be reviewed.' });
  const { status, note, faultType } = req.body || {};
  if (!['clean', 'error'].includes(status)) return res.status(400).json({ error: 'Review status must be clean or error.' });
  if (status === 'error' && !['processor', 'sop'].includes(faultType)) {
    return res.status(400).json({ error: 'Choose whether this was a processor fault or an SOP/manager fault.' });
  }
  t.reviewStatus = status;
  t.reviewedBy = req.employee.id;
  t.reviewNote = note || null;
  t.reviewedAt = new Date().toISOString();
  if (status === 'error') {
    t.status = 'awaiting_acceptance';
    t.reworkCount = (t.reworkCount || 0) + 1;
    t.faultType = faultType;
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" sent back for rework — error found. Accept it (or propose a new window) to start fixing it. ${note ? 'Note: ' + escHtml(note) : ''}`);
  } else {
    t.awaitingClientDecision = true;
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" reviewed — error-free.`);
    const managers = state.employees.filter(e => (e.managesIds || []).includes(t.assignedTo));
    managers.forEach(m => {
      logEvent(state, m.id, `"${escHtml(t.name)}" for <b>${escHtml(findEmployee(state, t.assignedTo)?.name || '—')}</b> was reviewed clean by <b>${escHtml(req.employee.name)}</b>.`);
    });
  }
  db.save();
  res.json({ task: taskForClient(t) });
});

// Send-to-client decision — asked once a task is reviewed clean. Logged
// for the assignee and their reporting manager(s) the same way every
// other task event is, so both see the same outcome.
app.post('/api/tasks/:id/send-to-client', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const isAssignedReviewer = t.reviewerId && t.reviewerId === req.employee.id;
  if (!isAssignedReviewer && !canManageEmployee(state, req.employee, t.assignedTo)) {
    return res.status(403).json({ error: "You're not authorized to do this." });
  }
  if (t.reviewStatus !== 'clean' || !t.awaitingClientDecision) {
    return res.status(400).json({ error: 'This task has no pending client-send decision.' });
  }
  const { decision } = req.body || {};
  if (!['yes', 'no'].includes(decision)) return res.status(400).json({ error: 'Decision must be yes or no.' });
  t.sentToClient = decision === 'yes';
  t.sentToClientAt = new Date().toISOString();
  t.sentToClientBy = req.employee.id;
  t.awaitingClientDecision = false;
  const outcome = decision === 'yes' ? 'sent directly to the client' : 'held back — not sent to the client';
  logEvent(state, t.assignedTo, `"${escHtml(t.name)}" was ${outcome} by <b>${escHtml(req.employee.name)}</b>.`);
  const managers = state.employees.filter(e => (e.managesIds || []).includes(t.assignedTo));
  managers.forEach(m => {
    logEvent(state, m.id, `"${escHtml(t.name)}" for <b>${escHtml(findEmployee(state, t.assignedTo)?.name || '—')}</b> was ${outcome}.`);
  });
  db.save();
  res.json({ task: taskForClient(t) });
});

// Resubmit — the assignee fixes a task they've already accepted the
// rework on (status 'rework' — see /accept) and sends it back. This
// re-completes the task (fresh completedAt, so commitment is judged
// against the actual redelivery date) and clears the review outcome so it
// lands back in "Awaiting Review" for a fresh look. reworkStartedAt is
// stamped at acceptance time, not when the error was originally flagged,
// so this duration measures actual working time, not time spent sitting
// unaccepted in the queue.
app.post('/api/tasks/:id/resubmit', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!taskActionGuard(req, res, t, { mustBeAssignee: true })) return;
  if (t.status !== 'rework') return res.status(400).json({ error: 'Only tasks in rework can be resubmitted.' });
  const endedAt = new Date().toISOString();
  const startedAt = t.reworkStartedAt;
  const durationHours = startedAt ? Math.round(((new Date(endedAt) - new Date(startedAt)) / 3600000) * 100) / 100 : null;
  t.logged += durationHours || 0; // actual time spent on this rework round, added to the task's total
  t.reworkHistory = t.reworkHistory || [];
  t.reworkHistory.push({ round: t.reworkCount, startedAt, endedAt, durationHours, reviewNote: t.reviewNote || null, faultType: t.faultType || null });
  t.reworkStartedAt = null;
  t.status = 'completed';
  t.completedAt = endedAt;
  t.reviewStatus = null;
  t.reviewedBy = null;
  t.reviewedAt = null;
  logEvent(state, t.assignedTo, `"${escHtml(t.name)}" resubmitted after rework — awaiting re-review.${durationHours !== null ? ` In rework for ${durationHours.toFixed(2)} hrs.` : ''}`);
  db.save();
  res.json({ task: taskForClient(t) });
});


app.post('/api/tasks/:id/propose-window', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!taskActionGuard(req, res, t, { mustBeAssignee: true })) return;
  const { date, reason } = req.body || {};
  t.proposedDate = date;
  t.proposedReason = reason;
  t.status = 'window_proposed';
  logEvent(state, t.assignedTo, `Proposed a new window for "${escHtml(t.name)}" — ${escHtml(date)}. Reason: ${escHtml(reason) || 'not specified'}.`);
  db.save();
  res.json({ task: taskForClient(t) });
});

app.post('/api/tasks/:id/approve-window', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  const { force } = req.body || {};
  if (!taskActionGuard(req, res, t, { mustBeAdmin: true })) return;
  if (!canManageEmployee(state, req.employee, t.assignedTo)) {
    return res.status(403).json({ error: "You're not authorized to approve a window for this employee's task." });
  }
  // The new date still has to clear the same workload-blocker check a
  // brand-new assignment does — approving a proposal is still handing
  // this employee an agreed deadline, and it shouldn't be able to land
  // inside a window they're already occupied for on other work.
  const conflict = workloadConflict(state, t.assignedTo, t.proposedDate, t.id, t.tat);
  if (conflict && !force) {
    const who = (findEmployee(state, t.assignedTo) || {}).name || 'This employee';
    return res.status(409).json({
      error: `${who} already has ${conflict.committedHours} hrs of agreed work due ${conflict.busyUntil} — this would push them to ${conflict.projectedHours} hrs, over the ${conflict.capacityHours}hr daily capacity. Next available date: ${conflict.nextAvailable}.`,
      code: 'WORKLOAD_CONFLICT', busyUntil: conflict.busyUntil, nextAvailable: conflict.nextAvailable,
    });
  }
  if (conflict && force) { logEvent(state, req.employee.id, `Emergency override used — approved window for "${escHtml(t.name)}" despite workload conflict (${conflict.projectedHours}h projected vs ${conflict.capacityHours}h capacity) by <b>${escHtml(req.employee.name)}</b>.`); }
  t.internalDeadline = t.proposedDate;
  // A proposed window on a rework-flagged task (reviewStatus === 'error')
  // goes back into active 'rework' when approved, not 'accepted' — same
  // rule as /accept: this puts the rework clock in motion (reworkStartedAt).
  if (t.reviewStatus === 'error') {
    t.status = 'rework';
    t.reworkStartedAt = new Date().toISOString();
  } else {
    t.status = 'accepted';
    t.acceptedAt = new Date().toISOString();
  }
        t.timerStartedAt = new Date().toISOString();
      pauseOtherActiveTasks(state, t.assignedTo, t.id);

  logEvent(state, req.employee.id, `Approved the proposed window for "${escHtml(t.name)}" — now due ${t.internalDeadline}.`);
  db.save();
  res.json({ task: taskForClient(t) });
});

app.post('/api/tasks/:id/reject-window', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!taskActionGuard(req, res, t, { mustBeAdmin: true })) return;
  if (!canManageEmployee(state, req.employee, t.assignedTo)) {
    return res.status(403).json({ error: "You're not authorized to reject a window for this employee's task." });
  }
  // Same rework-vs-normal branch as approve-window above — rejecting the
  // proposal means the original deadline stands.
  if (t.reviewStatus === 'error') {
    t.status = 'rework';
    t.reworkStartedAt = new Date().toISOString();
  } else {
    t.status = 'accepted';
    t.acceptedAt = new Date().toISOString();
  }
        t.timerStartedAt = new Date().toISOString();
      pauseOtherActiveTasks(state, t.assignedTo, t.id);

  logEvent(state, req.employee.id, `Rejected the proposed window for "${escHtml(t.name)}" — original deadline stands.`);
  db.save();
  res.json({ task: taskForClient(t) });
});

// Reassignment — an Admin/Superadmin hands a task to a different employee.
// It deliberately routes through the SAME "awaiting_acceptance" state a
// brand-new assignment uses, so the new assignee gets the exact same
// Accept / Propose New Window step — nothing skips that check just because
// the task already existed. This endpoint doesn't touch reviewStatus or
// reviewNote, so if the task was mid-rework (flagged, awaiting acceptance,
// or a proposed window on a flagged task), that context carries over
// intact: the new assignee lands in the same Accept / Propose Window gate
// and sees why it was sent back, same as the original assignee would have.
// Full history is kept on the task itself so oversight (Command Center,
// Excel report) can always show who reassigned what, from whom, to whom,
// and why.
app.post('/api/tasks/:id/reassign', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if (t.status === 'completed') return res.status(400).json({ error: 'Completed tasks cannot be reassigned.' });
  // Both ends of a reassignment go through the same managesIds boundary
  // assignableEmployees() already enforces for brand-new assignments: the
  // acting admin must manage the CURRENT assignee (or be superadmin) as
  // well as the new one — otherwise any admin could pull a task out of a
  // team they have no authority over just because the destination is on
  // their own team.
  if (!canManageEmployee(state, req.employee, t.assignedTo)) {
    return res.status(403).json({ error: "You're not authorized to reassign this employee's task." });
  }
  const { newAssigneeId, reason, force } = req.body || {};
  const newEmp = findEmployee(state, newAssigneeId);
  if (!newEmp) return res.status(400).json({ error: 'Employee not found.' });
  if (newAssigneeId === t.assignedTo) return res.status(400).json({ error: 'Task is already assigned to this person.' });
  const allowed = assignableEmployees(state, req.employee).some(e => e.id === newAssigneeId);
  if (!allowed) return res.status(403).json({ error: "You're not authorized to reassign to this person." });
  // The new assignee has to clear the same workload-blocker check a
  // brand-new assignment would — moving a task to someone shouldn't be
  // able to double-book them either.
  const conflict = workloadConflict(state, newAssigneeId, t.internalDeadline, t.id, t.tat);
  if (conflict && !force) {
    return res.status(409).json({
      error: `${newEmp.name} already has ${conflict.committedHours} hrs of agreed work due ${conflict.busyUntil} — this would push them to ${conflict.projectedHours} hrs, over the ${conflict.capacityHours}hr daily capacity. Next available date: ${conflict.nextAvailable}.`,
      code: 'WORKLOAD_CONFLICT', busyUntil: conflict.busyUntil, nextAvailable: conflict.nextAvailable,
    });
  }
  if (conflict && force) { logEvent(state, req.employee.id, `Emergency override used — reassigned "${escHtml(t.name)}" despite workload conflict (${conflict.projectedHours}h projected vs ${conflict.capacityHours}h capacity) by <b>${escHtml(req.employee.name)}</b>.`); }
  const fromEmp = findEmployee(state, t.assignedTo);
  // Any actual delivery time already run up under the PREVIOUS assignee
  // is flushed into t.logged before handing the task off, same idea as
  // the old stopTimer() — the new owner's clock starts clean from their
  // own Accept.
    if (t.timerStartedAt) {
    t.logged += (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000;
  }
  t.reassignHistory = t.reassignHistory || [];
  t.reassignHistory.push({ from: t.assignedTo, to: newAssigneeId, by: req.employee.id, at: new Date().toISOString(), reason: reason || null });
  t.assignedTo = newAssigneeId;
  t.assignedBy = req.employee.id;
  t.assignedAt = new Date().toISOString();
  t.status = 'awaiting_acceptance';
  t.proposedDate = null;
  t.proposedReason = null;
  t.acceptedAt = null;
  // Whatever rework clock was running belonged to the PREVIOUS assignee's
  // ownership window — clear it so a stale timestamp can't leak through.
  // If reviewStatus is still 'error', the new assignee's own Accept (or
  // an approved/rejected window) will set a fresh reworkStartedAt.
  t.reworkStartedAt = null;
  t.timerStartedAt = null;
  const reworkNote = t.reviewStatus === 'error' ? ' This task is flagged for rework — the new assignee will see the reviewer\'s note.' : '';
  logEvent(state, newAssigneeId, `Task "${escHtml(t.name)}" reassigned from <b>${fromEmp ? escHtml(fromEmp.name) : '—'}</b> to <b>${escHtml(newEmp.name)}</b> — approval needed before the clock starts.${reworkNote}${reason ? ' Reason: ' + escHtml(reason) : ''}`, {
    client: t.clientName, clientDate: t.clientDate, internalDeadline: t.internalDeadline, reassignReason: reason || null
  });
  db.save();
  res.json({ task: taskForClient(t) });
});

// ---------------------------------------------------------------------------
// REPORTS — superadmin-only oversight: who assigned what to whom, delivered
// vs reassigned counts, and a computed rating per employee. Backs both the
// Command Center's ratings table and the Excel report-card export.
// ---------------------------------------------------------------------------
app.get('/api/reports/summary', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  // Optional ?days=N scopes delivered work and shift hours to a rolling
  // window (used by the Founder View's 30-day snapshot). Omitted, this
  // stays the all-time view the Command Center has always shown.
  const days = parseInt(req.query.days, 10);
  const sinceISO = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : null;
  const rows = state.employees.map(emp => {
    const assignedToMe = state.tasks.filter(t => t.assignedTo === emp.id);
    const assignedByMe = state.tasks.filter(t => t.assignedBy === emp.id);
    const delivered = assignedToMe.filter(t => t.status === 'completed' && (!sinceISO || (t.completedAt || '').slice(0, 10) >= sinceISO));
    const cleanDelivered = delivered.filter(t => t.reviewStatus === 'clean');
    const errorDelivered = delivered.filter(t => t.reviewStatus === 'error');
    const reviewedCount = cleanDelivered.length + errorDelivered.length;
    const onTime = delivered.filter(t => t.clientDate && t.completedAt && t.completedAt.slice(0, 10) <= t.clientDate);
    const reassignedAway = state.tasks.reduce((n, t) => n + (t.reassignHistory || []).filter(h => h.from === emp.id).length, 0);
    const reassignedIn = state.tasks.reduce((n, t) => n + (t.reassignHistory || []).filter(h => h.to === emp.id).length, 0);
    const reworkCount = assignedToMe.reduce((s, t) => s + (t.reworkCount || 0), 0);
    const reworkRoundsClosed = assignedToMe.reduce((s, t) => s + (t.reworkHistory || []).length, 0);
    const reworkHoursTotal = assignedToMe.reduce((s, t) => s + (t.reworkHistory || []).reduce((s2, r) => s2 + (r.durationHours || 0), 0), 0);
    const avgReworkHours = reworkRoundsClosed ? reworkHoursTotal / reworkRoundsClosed : null;
    const totalLoggedHours = assignedToMe.reduce((s, t) => s + liveElapsedHours(t), 0);
    const activeLoggedHours = assignedToMe.filter(t => t.status !== 'completed').reduce((s, t) => s + liveElapsedHours(t), 0);
    const deliveredLoggedHours = delivered.reduce((s, t) => s + t.logged, 0);
    const deliveredTatHours = delivered.reduce((s, t) => s + (t.tat || 0), 0);
    const avgHoursPerTask = delivered.length ? deliveredLoggedHours / delivered.length : null;
    const onTimeRate = delivered.length ? onTime.length / delivered.length : 0;
    const cleanRate = reviewedCount ? cleanDelivered.length / reviewedCount : 0;
    let rating = null;
    if (delivered.length > 0) {
      let score = reviewedCount ? (0.5 * onTimeRate + 0.5 * cleanRate) : onTimeRate;
      score -= Math.min(reworkCount * 0.05, 0.3);
      rating = Math.round(Math.max(0, Math.min(1, score)) * 50) / 10; // 0–5, one decimal
    }
    // Productivity = actual delivery time on completed work against total
    // shift hours actually logged in (from the daily login/logout clock).
    // A day nobody logged in for contributes 0 shift hours, so absence
    // pulls the denominator down rather than being silently ignored.
    const shiftSeconds = Object.entries(state.attendance[emp.id] || {}).filter(([d]) => !sinceISO || d >= sinceISO).reduce((s, [, d]) => s + (d.secondsWorked || 0), 0);
    const shiftHours = Math.round((shiftSeconds / 3600) * 100) / 100;
    const productivityPct = shiftHours > 0 ? Math.round((deliveredLoggedHours / shiftHours) * 100) : null;
    return {
      id: emp.id, name: emp.name, jobTitle: emp.jobTitle, team: emp.team, accessRole: emp.accessRole,
      assigned: assignedToMe.length, assignedByThem: assignedByMe.length,
      delivered: delivered.length, onTime: onTime.length,
      cleanDelivered: cleanDelivered.length, errorDelivered: errorDelivered.length,
      reassignedAway, reassignedIn, reworkCount,
      reworkHoursTotal: Math.round(reworkHoursTotal * 100) / 100,
      avgReworkHours: avgReworkHours === null ? null : Math.round(avgReworkHours * 100) / 100,
      onTimeRate: Math.round(onTimeRate * 100), cleanRate: Math.round(cleanRate * 100),
      totalLoggedHours: Math.round(totalLoggedHours * 100) / 100,
      activeLoggedHours: Math.round(activeLoggedHours * 100) / 100,
      deliveredLoggedHours: Math.round(deliveredLoggedHours * 100) / 100,
      deliveredTatHours: Math.round(deliveredTatHours * 100) / 100,
      avgHoursPerTask: avgHoursPerTask === null ? null : Math.round(avgHoursPerTask * 100) / 100,
      shiftHours, productivityPct,
      rating,
    };
  });
  const assignments = state.tasks.map(t => ({
    id: t.id, name: t.name, clientName: t.clientName,
    assignedBy: (findEmployee(state, t.assignedBy) || {}).name || '—',
    assignedTo: (findEmployee(state, t.assignedTo) || {}).name || '—',
    status: t.status, reassigned: (t.reassignHistory || []).length,
    delivered: t.status === 'completed', completedAt: t.completedAt, clientDate: t.clientDate, assignedAt: t.assignedAt,
    loggedHours: Math.round(liveElapsedHours(t) * 100) / 100, tatHours: t.tat || 0,
  }));
  res.json({ rows, assignments });
});

// ---------------------------------------------------------------------------
// WORKLOAD — who's occupied until when, so an assigner can see actual
// availability before they try to hand out a task (the server still
// enforces the block for real at /api/tasks and /api/tasks/:id/reassign —
// this just lets the UI show it up front). Scoped to whoever the caller
// is allowed to assign to, same boundary as assignableEmployees().
// ---------------------------------------------------------------------------
app.get('/api/workload', requireAuth, (req, res) => {
  const state = db.get();
  const visible = assignableEmployees(state, req.employee);
  const rows = visible.map(e => {
    const busyUntil = employeeBusyUntil(state, e.id);
    const activeCount = state.tasks.filter(t => t.assignedTo === e.id && t.status !== 'completed').length;
    return (()=>{ const active=state.tasks.filter(t=>t.assignedTo===e.id&&t.status!=='completed'&&t.internalDeadline); const hrs={}; active.forEach(t=>{hrs[t.internalDeadline]=(hrs[t.internalDeadline]||0)+(Number(t.tat)||0);}); let peakDate=null,peakHours=0; Object.entries(hrs).forEach(([d,h])=>{ if(h>peakHours){ peakHours=h; peakDate=d; } }); return { id: e.id, name: e.name, team: e.team, busyUntil, nextAvailable: nextAvailableDate(busyUntil), activeCount, peakHours: Math.round(peakHours*100)/100, peakDate, overloaded: peakHours > DAILY_CAPACITY_HOURS, capacityHours: DAILY_CAPACITY_HOURS }; })();
  });
  res.json({ workload: rows });
});

// ---------------------------------------------------------------------------
// ACTIVITY FEED
// ---------------------------------------------------------------------------
app.get('/api/activity', requireAuth, (req, res) => {
  const state = db.get();
  res.json({ activity: state.activityLog.slice(-60).reverse() });
});

// ---------------------------------------------------------------------------
// TIME CLOCK / DAILY ATTENDANCE — server-authoritative. The server owns
// "now", not the browser, so punch times can't be faked or drift across
// machines/timezones. Every employee is required to log in (Punch In) and
// log out (Punch Out) once per working day; this is also literally the
// only way to open the login/logout gate, so it can't be skipped. Today's
// live state lives in state.punchLog (ticking seconds while punched in);
// each day's result is additionally written into state.attendance, which
// keeps a full history per employee so a Superadmin can see login/logout
// times over time — and so productivity can be judged against actual
// shift hours worked, not just an assumed full day.
// ---------------------------------------------------------------------------
function getPunchState(state, empId) {
  const existing = state.punchLog[empId];
  if (!existing || existing.date !== todayISO()) {
    state.punchLog[empId] = { date: todayISO(), punchedOut: false, punchedInAt: null, seconds: 0 };
  }
  return state.punchLog[empId];
}
function getAttendanceDay(state, empId, date) {
  state.attendance[empId] = state.attendance[empId] || {};
  if (!state.attendance[empId][date]) {
    state.attendance[empId][date] = { loginAt: null, logoutAt: null, secondsWorked: 0 };
  }
  return state.attendance[empId][date];
}
app.get('/api/punch/me', requireAuth, (req, res) => {
  const state = db.get();
  const st = getPunchState(state, req.employee.id);
  const liveSeconds = st.punchedInAt ? st.seconds + Math.floor((Date.now() - st.punchedInAt) / 1000) : st.seconds;
  res.json({ punch: { ...st, liveSeconds, punching: !!st.punchedInAt } });
});
app.post('/api/punch/toggle', requireAuth, (req, res) => {
  const state = db.get();
  const st = getPunchState(state, req.employee.id);
  if (st.punchedOut) return res.status(409).json({ error: 'Already punched out for today.' });
  const day = getAttendanceDay(state, req.employee.id, todayISO());
  if (!st.punchedInAt) {
    st.punchedInAt = Date.now();
    if (!day.loginAt) day.loginAt = new Date().toISOString();
  } else {
    // NON-NEGOTIABLE RULE: nothing carries over unacknowledged. An employee
    // cannot punch out while they have tasks still sitting in
    // "awaiting_acceptance" (must Accept or Propose a New Window — this
    // now includes tasks a reviewer flagged with an error, since those
    // route through this same gate rather than an immediate "fix it now"
    // state) or "rework" (must fix and resubmit — only reached once
    // they've actually accepted the rework) — both are enforced here, not
    // just in the UI, so they can't be bypassed by calling the API
    // directly.
    const pendingAcceptance = state.tasks.filter(t => t.assignedTo === req.employee.id && t.status === 'awaiting_acceptance');
    const pendingRework = state.tasks.filter(t => t.assignedTo === req.employee.id && t.status === 'rework');
    if (pendingAcceptance.length > 0 || pendingRework.length > 0) {
      const parts = [];
      if (pendingAcceptance.length > 0) parts.push(`${pendingAcceptance.length} task${pendingAcceptance.length > 1 ? 's' : ''} awaiting your acceptance`);
      if (pendingRework.length > 0) parts.push(`${pendingRework.length} task${pendingRework.length > 1 ? 's' : ''} still in rework`);
      return res.status(409).json({
        error: `You have ${parts.join(' and ')}. Handle ${(pendingAcceptance.length + pendingRework.length) > 1 ? 'each of them' : 'it'} before logging off.`,
        code: 'PENDING_ACCEPTANCE',
        // reviewStatus/reviewNote/reworkCount included so the client can
        // flag which of these are rework items (reviewStatus === 'error')
        // and show the reviewer's note, not just treat them as plain new
        // assignments.
        pendingTasks: pendingAcceptance.map(t => ({ id: t.id, name: t.name, scope: t.scope, clientName: t.clientName, reviewStatus: t.reviewStatus, reviewNote: t.reviewNote, reworkCount: t.reworkCount, kind: 'acceptance' })),
        pendingRework: pendingRework.map(t => ({ id: t.id, name: t.name, scope: t.scope, clientName: t.clientName, reviewNote: t.reviewNote, reworkCount: t.reworkCount, kind: 'rework' }))
      });
    }
    st.seconds += Math.floor((Date.now() - st.punchedInAt) / 1000);
    st.punchedInAt = null;
    st.punchedOut = true; // one punch in/out cycle per day, then locked
    day.logoutAt = new Date().toISOString();
    day.secondsWorked = st.seconds;
  }
  db.save();
  const liveSeconds = st.punchedInAt ? st.seconds + Math.floor((Date.now() - st.punchedInAt) / 1000) : st.seconds;
  res.json({ punch: { ...st, liveSeconds, punching: !!st.punchedInAt } });
});

// Superadmin-only view of everyone's login/logout history — this is what
// makes attendance visible instead of just enforced. Also flags absence:
// any working day with no attendance record at all for an employee is a
// day they never logged in, which is exactly the signal productivity
// figures need to account for (see the shiftHours calc in
// /api/reports/summary) rather than silently assuming a full shift.
app.get('/api/attendance/all', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const today = todayISO();
  const rows = state.employees.map(emp => {
    const hist = state.attendance[emp.id] || {};
    const live = getPunchState(state, emp.id);
    const dates = Object.keys(hist).sort().reverse().slice(0, 14);
    return {
      id: emp.id, name: emp.name, team: emp.team,
      loggedInNow: !!live.punchedInAt,
      loggedOutToday: !!live.punchedOut,
      todayLoginAt: hist[today] ? hist[today].loginAt : null,
      todayLogoutAt: hist[today] ? hist[today].logoutAt : null,
      history: dates.map(d => ({
        date: d, loginAt: hist[d].loginAt, logoutAt: hist[d].logoutAt,
        hours: Math.round(((hist[d].secondsWorked || 0) / 3600) * 100) / 100,
      })),
    };
  });
  db.save(); // getPunchState may have created today's record for someone who's never punched
  res.json({ rows, today });
});

// ---------------------------------------------------------------------------
// STORAGE ADMIN (Superadmin) — backup, disaster recovery, and the migration
// safety net for moving onto Postgres. All additive; nothing else uses these.
// ---------------------------------------------------------------------------

// Which store is live and how much is in it — quick post-deploy check.
app.get('/api/admin/storage-health', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  res.json({
    mode: db._mode(),
    rev: db._rev(),
    employees: (state.employees || []).length,
    tasks: (state.tasks || []).length,
    clients: (state.clients || []).length,
    teams: (state.teams || []).length,
  });
});

// Full state snapshot — download it before any risky change, or to seed
// Postgres from the currently-running instance.
app.get('/api/admin/state-export', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  res.setHeader('Content-Disposition', `attachment; filename="governance-os-state-${todayISO()}.json"`);
  res.json(state);
});

// Replace the entire state with an uploaded snapshot. Guarded, Superadmin
// only, and it logs itself. Used once when Postgres comes online if the
// local db.json didn't survive the deploy — export from the old instance,
// import here.
app.post('/api/admin/state-import', requireAuth, requireSuperAdmin, (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.employees) || !Array.isArray(incoming.tasks)) {
    return res.status(400).json({ error: 'That does not look like a valid state export — it needs employees[] and tasks[] at least.' });
  }
  try {
    db.replace(incoming);
  } catch (e) {
    return res.status(400).json({ error: 'Import rejected: ' + e.message });
  }
  const state = db.get();
  logEvent(state, req.employee.id, `Imported a full state snapshot — ${(state.tasks || []).length} tasks, ${(state.employees || []).length} employees.`);
  db.save();
  res.json({ ok: true, mode: db._mode(), employees: state.employees.length, tasks: state.tasks.length });
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
// db.init() loads the store (Postgres when DATABASE_URL is set, otherwise the
// JSON file) and runs migrations before the first request can arrive.
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Elite Taxation Governance OS running at http://localhost:${PORT} — storage: ${db._mode()}`);
    });
  })
  .catch((err) => {
    console.error('Startup failed — could not initialise the database:', err);
    process.exit(1);
  });
