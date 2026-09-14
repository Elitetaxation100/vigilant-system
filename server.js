// The firm runs on the New Zealand calendar day. Pin the process TZ so every
// `new Date()` (and the date maths built on it) is NZ-local, not the server's
// UTC. Stored timestamps stay UTC — `.toISOString()` ignores this. Overridable
// for tests via the TZ env var.
if (!process.env.TZ) process.env.TZ = 'Pacific/Auckland';

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const cal = require('./calendar');

// ---------------------------------------------------------------------------
// WEB PUSH — browser notifications that fire even when the app isn't open.
// VAPID keys: from env if set, else generated once and persisted in the DB
// (same trust level as the JWT secret). Degrades quietly if the library or
// keys are unavailable.
// ---------------------------------------------------------------------------
let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.warn('[push] web-push not installed — desktop alerts disabled'); }
let PUSH_READY = false;
function initPush() {
  if (!webpush) return;
  const state = db.get();
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    if (!state._vapid || !state._vapid.publicKey) {
      state._vapid = webpush.generateVAPIDKeys();
      db.save();
      console.log('[push] generated a VAPID keypair (persisted)');
    }
    pub = state._vapid.publicKey; priv = state._vapid.privateKey;
  }
  try {
    webpush.setVapidDetails('mailto:info@elitetaxation.co.nz', pub, priv);
    PUSH_READY = true;
  } catch (e) { console.warn('[push] VAPID setup failed:', e.message); }
}
function vapidPublicKey() {
  if (process.env.VAPID_PUBLIC_KEY) return process.env.VAPID_PUBLIC_KEY;
  const v = db.get()._vapid;
  return v && v.publicKey ? v.publicKey : null;
}
// Fire a push to every device a person has registered. Prunes dead
// subscriptions (410/404). Never throws.
async function sendPush(state, empId, payload) {
  if (!PUSH_READY || !webpush || !empId) return;
  const subs = (state.pushSubs && state.pushSubs[empId]) || [];
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 86400, urgency: 'high' });
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(s.endpoint);
    }
  }));
  if (dead.length) {
    state.pushSubs[empId] = subs.filter(s => !dead.includes(s.endpoint));
    db.save();
  }
}

// ---------------------------------------------------------------------------
// HOLD REASON TAXONOMY (Query-Aware Delivery, Phase 1). Every hold picks one.
// `exempting` codes freeze the client commitment clock (Phase 2); the rest
// are internal and keep it running. `needsDetail` requires free text.
// ---------------------------------------------------------------------------
const HOLD_REASONS = {
  CLIENT_QUERY:    { label: 'Awaiting client answer to a query',        exempting: true,  needsDetail: false },
  CLIENT_DOCS:     { label: 'Awaiting documents / records from client', exempting: true,  needsDetail: false },
  THIRD_PARTY:     { label: 'Awaiting IRD / bank / third party',        exempting: true,  needsDetail: true  },
  INTERNAL_REVIEW: { label: 'Blocked on a reviewer or partner sign-off', exempting: false, needsDetail: false },
  CAPACITY:        { label: 'Re-prioritised — parked by manager',        exempting: false, needsDetail: false, managerOnly: true },
  BLOCKED_OTHER:   { label: 'Other',                                     exempting: false, needsDetail: true  },
};
const EXEMPTING_REASONS = new Set(Object.keys(HOLD_REASONS).filter(k => HOLD_REASONS[k].exempting));
// Working days between the internal due date and what the client is told.
const DISPATCH_BUFFER_WD = 3;

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
// Keep the raw request bytes around — the Slack connector (Phase 5) needs
// them to verify Slack's request signature (an HMAC over the exact body).
function rawBodySaver(req, res, buf) { if (buf && buf.length) req.rawBody = buf; }
app.use(express.json({ limit: '12mb', verify: rawBodySaver })); // pause screenshots are base64 images
// Slack interactivity posts as form-urlencoded (the payload is a JSON string
// in one field). No existing route sends this content type.
app.use(express.urlencoded({ extended: true, limit: '2mb', verify: rawBodySaver }));

// Throttle login attempts — without this, nothing stood between a guesser
// and unlimited attempts against an account, especially risky given how
// guessable the seeded default passwords are (see README). 20 attempts per
// 15 minutes per IP is generous for a real user who mistypes a password a
// few times, but stops fast automated guessing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT) || 20,
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
    // Persist it so tokens survive a restart. If the data dir doesn't exist
    // yet (fresh checkout) create it; if the write still fails (read-only FS,
    // CI sandbox) carry on with the in-memory secret rather than crashing —
    // set JWT_SECRET in the environment for a stable secret in production.
    try {
      fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
      fs.writeFileSync(SECRET_PATH, JWT_SECRET);
    } catch (err) {
      console.warn('[auth] could not persist jwt-secret (' + err.code + ') — using an in-memory secret for this run. Set JWT_SECRET to make it stable.');
    }
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

/**
 * A team is a `.team` name. Everyone who shares a name is on that team; the
 * admins on it are its managers. This is the single source of truth for
 * "whose team is this" — managesIds is legacy and no longer consulted for
 * scoping.
 */
function teamRoster(state, emp) {
  const team = emp && typeof emp.team === 'string' ? emp.team.trim() : '';
  if (!team) return [];
  return state.employees.filter(e => typeof e.team === 'string' && e.team.trim() === team);
}
// The admins on an employee's team — used to fan out notifications to
// "the manager(s)".
function managersOfEmployee(state, empId) {
  const emp = state.employees.find(e => e.id === empId);
  if (!emp) return [];
  return teamRoster(state, emp).filter(e => e.id !== empId && isAdminRole(e.accessRole));
}
/** Who can `actor` assign NEW work to? Mirrors the same rule everywhere. */
function assignableEmployees(state, actor) {
  if (actor.accessRole === 'superadmin') return state.employees;
  if (actor.accessRole === 'admin') return teamRoster(state, actor).filter(e => e.id !== actor.id);
  return [];
}
/**
 * Can `actor` act on a task that's currently assigned to `employeeId`?
 * Superadmins can act on anyone's task. An admin can only act on the work
 * of their own team — the same boundary assignableEmployees() enforces.
 */
function canManageEmployee(state, actor, employeeId) {
  if (actor.accessRole === 'superadmin') return true;
  if (actor.accessRole !== 'admin') return false;
  const target = state.employees.find(e => e.id === employeeId);
  const myTeam = typeof actor.team === 'string' ? actor.team.trim() : '';
  return !!target && !!myTeam && typeof target.team === 'string' &&
    target.team.trim() === myTeam && target.id !== actor.id;
}
// Time-boxed self-edit grant: while it's live, `emp` may change the estimate,
// internal due date AND the client commitment date on any task assigned to
// them — theirs to begin with or handed to them by someone else — as long as
// it isn't finished/in review yet.
function selfEditActive(emp) {
  return !!(emp && emp.selfEditUntil && Date.now() < Date.parse(emp.selfEditUntil));
}
function canSelfEditTask(emp, t) {
  return !!emp && !!t
    && t.assignedTo === emp.id
    && !['completed', 'pending_approval'].includes(t.status)
    && selfEditActive(emp);
}
/**
 * Can `actor` ACT on the review of task `t` (mark clean / error, decide
 * send-to-client)? The reviewer the assignee nominated on completion, OR a
 * manager/admin responsible for that person — but never the assignee
 * themselves. Peers are fine as long as they were the one picked.
 */
function canReviewWorkOf(state, actor, assigneeId, t) {
  if (!actor || actor.id === assigneeId) return false;
  if (t && t.reviewerId && t.reviewerId === actor.id) return true;
  return canManageEmployee(state, actor, assigneeId);
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
// ---------------------------------------------------------------------------
// QUERY-AWARE COMMITMENT (Phase 2). A client query freezes the commitment
// clock: the client date moves forward by the working days the file waited
// for the reply, minus any working days the processor then sat on it before
// restarting (one working day of grace). This is the ONLY thing that moves
// the client date after creation, other than a manager editing it.
// ---------------------------------------------------------------------------
function taskShiftDays(t) {
  const today = todayISO();
  let shift = 0;
  for (const q of (t.queries || [])) {
    if (!EXEMPTING_REASONS.has(q.reasonCode)) continue;
    shift += cal.queryShift(q, today).shift;
  }
  return shift;
}
function effectiveClientDate(t) {
  if (!t.clientDate) return null;
  const s = taskShiftDays(t);
  return s > 0 ? cal.addWorkingDays(t.clientDate, s) : t.clientDate;
}
function anyQueryOpen(t) {
  return (t.queries || []).some(q => EXEMPTING_REASONS.has(q.reasonCode) && !q.replyAt);
}
// met / missed / exempt / at-risk / on-track / rework / null(internal)
function commitmentOutcome(t) {
  if (!t.clientDate) return null;
  const eff = effectiveClientDate(t);
  if (t.status === 'completed' && t.completedAt) {
    return nzDay(t.completedAt) <= eff ? 'met' : 'missed';
  }
  if (t.reviewStatus === 'error') return 'rework';
  if (anyQueryOpen(t)) return 'exempt';
  const today = todayISO();
  if (today <= eff) return 'on-track';
  if (today <= cal.addWorkingDays(eff, 1)) return 'at-risk';
  return 'missed';
}

function taskForClient(t) {
  // The hold screenshot can be a megabyte of base64 — never ship it in the
  // task list (fetched every few seconds by every open tab). It's pulled on
  // demand via /api/tasks/:id/hold-screenshot when someone opens the detail.
  const { holdScreenshot, ...rest } = t;
  return {
    ...rest,
    hasHoldScreenshot: !!holdScreenshot,
    displayedLogged: liveElapsedHours(t),
    reworkElapsedHours: reworkElapsedHours(t),
    // query-aware commitment, computed server-side so the UI never re-derives it
    queryShiftDays: taskShiftDays(t),
    effectiveClientDate: effectiveClientDate(t),
    commitmentOutcome: commitmentOutcome(t),
    // A clean review still needs the report sent to the client by the
    // commitment date — this flags it once that date has passed and nobody
    // has recorded sending it yet (see /send-to-client, /report-owner).
    reportOverdue: !!(t.awaitingClientDecision && t.clientDate && todayISO() > t.clientDate),
    // The review itself needs to happen before the client commitment date
    // too — there's no time left to review AND send the report once that
    // date has passed. Flags a completed, not-yet-reviewed task the same way.
    reviewOverdue: !!(t.status === 'completed' && !t.reviewStatus && t.clientDate && todayISO() > t.clientDate),
    // P2 — how many times this task has been chased (manual nudge or auto).
    ...(() => {
      const r = db.remindersForTask(db.get(), t.id);
      return { reminderCount: r.length, lastRemindedAt: r.length ? r[r.length - 1].at : null };
    })(),
  };
}

// ---------------------------------------------------------------------------
// CAPACITY & COMMITMENT DATES (Phase 5). A person has an effective capacity
// — productive hours per working day. It's measured from their delivery
// history (median productive day over the last 8 weeks), never assumed, so
// the system never has to ask "do they work in parts or full days". A task
// consumes that capacity across as many working days as it needs, and the
// commitment date follows: internal due date, then + 3 working days for the
// firm's do-review-send buffer.
// ---------------------------------------------------------------------------
// The firm's working day is 9h with a 1h break = 8h of productive time.
const CAP_MIN = 3, CAP_MAX = 10, CAP_SEED = 8.0;

function estimateCapacity(state, empId) {
  // productive hours per working day over the last 8 weeks (56 days).
  const since = cal.addWorkingDays(todayISO(), 0); // today
  const from = new Date(Date.now() - 56 * 86400000).toISOString().slice(0, 10);
  const byDay = {};
  state.tasks.filter(t => t.assignedTo === empId && t.status === 'completed'
      && (t.completedAt || '').slice(0, 10) >= from && (t.completedAt || '').slice(0, 10) <= since)
    .forEach(t => { const d = t.completedAt.slice(0, 10); byDay[d] = (byDay[d] || 0) + taskHours(t); });
  const days = Object.values(byDay).filter(h => h > 0).sort((a, b) => a - b);
  if (days.length < 8) return null; // not enough history — keep the seed / manual value
  const mid = Math.floor(days.length / 2);
  const median = days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
  return Math.round(Math.min(CAP_MAX, Math.max(CAP_MIN, median)) * 10) / 10;
}
// Lazily refresh a person's capacity — at most once a day.
function refreshCapacity(state, emp) {
  const today = todayISO();
  if (emp.capacityEstimatedAt === today) return;
  const est = estimateCapacity(state, emp.id);
  if (est != null) { emp.effectiveCapacity = est; emp.capacityAuto = true; }
  emp.capacityEstimatedAt = today;
}
function capacityOf(emp) {
  return Number(emp && emp.effectiveCapacity) > 0 ? Number(emp.effectiveCapacity) : CAP_SEED;
}

// ---------------------------------------------------------------------------
// P1 — CAPACITY FROM ATTENDANCE. A person's capacity for one day is their
// base productive hours, scaled by whether they were actually available:
// a full day is the base, an approved half-day is half, an approved leave
// day or a non-working day is zero, and a day they punched a short shift is
// what they were on the clock for. Everything downstream — the planner,
// workload, the productivity denominator — sums dayCapacity() across the
// range instead of assuming a flat full day every working day.
//
// Absence is deliberately NOT inferred from a missing punch: with attendance
// tracking still patchy, an unknown past day counts as a normal PRESENT day.
// Only an approved leave request or an actually-recorded short shift pulls a
// day's capacity down.
// ---------------------------------------------------------------------------
const LEAVE_TYPES = ['ANNUAL', 'SICK', 'UNPAID', 'OTHER'];
function baseHoursOf(emp) {
  const b = Number(emp && emp.baseHoursPerDay);
  return b > 0 ? b : capacityOf(emp);
}
function approvedLeaveOn(state, empId, dateISO) {
  return (state.leaveRequests || []).find(l => l.employeeId === empId
    && l.status === 'approved' && dateISO >= l.from && dateISO <= l.to) || null;
}
// PRESENT · HALF · PARTIAL · LEAVE · HOLIDAY
function attendanceStatus(state, emp, dateISO) {
  if (!cal.isWorkingDay(dateISO)) return 'HOLIDAY';
  const leave = approvedLeaveOn(state, emp.id, dateISO);
  if (leave) return leave.halfDay ? 'HALF' : 'LEAVE';
  const rec = (state.attendance[emp.id] || {})[dateISO];
  if (dateISO < todayISO() && rec && rec.logoutAt && (rec.secondsWorked || 0) > 0) {
    const h = rec.secondsWorked / 3600;
    if (h >= 1 && h < baseHoursOf(emp) * 0.9) return 'PARTIAL';
  }
  return 'PRESENT';
}
function dayCapacity(state, emp, dateISO) {
  const base = baseHoursOf(emp);
  switch (attendanceStatus(state, emp, dateISO)) {
    case 'HOLIDAY': case 'LEAVE': return 0;
    case 'HALF': return Math.round((base / 2) * 100) / 100;
    case 'PARTIAL': {
      const rec = (state.attendance[emp.id] || {})[dateISO] || { secondsWorked: base * 3600 };
      return Math.round(Math.min(base, rec.secondsWorked / 3600) * 100) / 100;
    }
    default: return base;
  }
}
// Sum of dayCapacity across the working days in [fromISO, toISO] inclusive.
function capacityHoursBetween(state, emp, fromISO, toISO) {
  if (!fromISO || !toISO || toISO < fromISO) return 0;
  let total = 0;
  let cur = new Date(fromISO + 'T00:00:00Z');
  const end = new Date(toISO + 'T00:00:00Z').getTime();
  while (cur.getTime() <= end) {
    const iso = cur.toISOString().slice(0, 10);
    if (cal.isWorkingDay(iso)) total += dayCapacity(state, emp, iso);
    cur = new Date(cur.getTime() + 86400000);
  }
  return Math.round(total * 100) / 100;
}
// Capacity over the next `n` working days, counting from today.
function capacityNextWorkingDays(state, emp, n) {
  let total = 0, got = 0, guard = 0;
  let cur = todayISO();
  while (got < n && guard++ < 400) {
    if (cal.isWorkingDay(cur)) { total += dayCapacity(state, emp, cur); got += 1; }
    cur = new Date(new Date(cur + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  }
  return Math.round(total * 100) / 100;
}
// Approved leave inside a range, as full-day + half-day counts (working days only).
function leaveDaysBetween(state, empId, fromISO, toISO) {
  let full = 0, half = 0;
  (state.leaveRequests || []).filter(l => l.employeeId === empId && l.status === 'approved').forEach(l => {
    const start = l.from > fromISO ? l.from : fromISO;
    const stop = l.to < toISO ? l.to : toISO;
    if (stop < start) return;
    let cur = new Date(start + 'T00:00:00Z');
    const end = new Date(stop + 'T00:00:00Z').getTime();
    while (cur.getTime() <= end) {
      const iso = cur.toISOString().slice(0, 10);
      if (cal.isWorkingDay(iso)) { if (l.halfDay) half += 1; else full += 1; }
      cur = new Date(cur.getTime() + 86400000);
    }
  });
  return { full, half, equivalent: Math.round((full + half / 2) * 100) / 100 };
}
// Hours of work still ahead of a person: their active (non-completed,
// non-query-frozen) tasks' remaining effort. A task's remaining effort is
// its agreed hours minus what's already been logged, floored at 0.25h.
function remainingHours(t) {
  if (t.status === 'completed') return 0;
  if (t.status === 'on_hold' && anyQueryOpen(t)) return 0; // frozen — not consuming capacity
  const agreed = Number(t.tat) > 0 ? Number(t.tat) : 1;
  return Math.max(0.25, agreed - Math.max(0, Number(t.logged) || 0));
}
function queueHours(state, empId) {
  return state.tasks.filter(t => t.assignedTo === empId && !['completed'].includes(t.status))
    .reduce((s, t) => s + remainingHours(t), 0);
}
// The working day starts at 08:00 — the reference point for "busy until <time>".
const WORK_START_HOUR = 8;
// Walk forward from today over working days, burning down `backlog` at each
// day's REAL capacity — which is 0 on an approved-leave day or a public
// holiday, so leave pushes the finish out instead of being ignored. Returns
// the moment the queue is exhausted as { date, hour, minute } (finish time =
// 08:00 + hours worked on the final day), or null if nothing is queued.
function queueClearMoment(state, emp, backlog) {
  if (!(backlog > 0.01)) return null;
  let remaining = backlog;
  let cur = todayISO();
  for (let guard = 0; guard < 800; guard++) {
    const capThatDay = cal.isWorkingDay(cur) ? dayCapacity(state, emp, cur) : 0;
    if (capThatDay > 0) {
      if (remaining <= capThatDay + 1e-9) {
        const mins = Math.round((WORK_START_HOUR * 60) + (remaining * 60));
        return { date: cur, hour: Math.floor(mins / 60), minute: mins % 60 };
      }
      remaining -= capThatDay;
    }
    cur = cal.addWorkingDays(cur, 1);
  }
  return { date: cur, hour: WORK_START_HOUR, minute: 0 };
}
// When does this person's current queue clear, and how much slack do they
// have in the next 5 working days? The clear date is leave-aware.
function availabilityOf(state, emp) {
  const cap = capacityOf(emp);
  const backlog = queueHours(state, emp.id);
  const clearsAt = queueClearMoment(state, emp, backlog);
  const committedThrough = clearsAt ? clearsAt.date : todayISO();
  const cap5 = capacityNextWorkingDays(state, emp, 5);
  const freeNext5wd = Math.max(0, cap5 - backlog);
  return {
    effectiveCapacity: cap, capacityAuto: !!emp.capacityAuto,
    baseHoursPerDay: Number(emp.baseHoursPerDay) > 0 ? Number(emp.baseHoursPerDay) : null,
    backlogHours: Math.round(backlog * 100) / 100,
    committedThrough,
    clearsAt,
    capacityNext5wd: cap5,
    freeCapacityNext5wd: Math.round(freeNext5wd * 100) / 100,
    dayCapacityToday: dayCapacity(state, emp, todayISO()),
    onLeaveToday: !!approvedLeaveOn(state, emp.id, todayISO()),
  };
}
// The internal due date and client commitment date for a task of
// `allocatedHours` handed to `emp`, factoring their real queue + capacity.
function computeCommitmentDates(state, emp, allocatedHours, requestedStartISO) {
  const cap = capacityOf(emp);
  const backlog = queueHours(state, emp.id);
  const start = requestedStartISO && requestedStartISO > todayISO() ? requestedStartISO : todayISO();
  const startDay = cal.addWorkingDays(start, Math.ceil(backlog / cap)); // after the queue clears
  const taskDays = Math.max(1, Math.ceil((Number(allocatedHours) || 1) / cap));
  const internalDeadline = cal.addWorkingDays(startDay, taskDays);
  const clientDate = cal.addWorkingDays(internalDeadline, DISPATCH_BUFFER_WD);
  return { startDay, internalDeadline, clientDate, taskDays, backlogHours: Math.round(backlog * 100) / 100, effectiveCapacity: cap };
}
// Working hours `emp` can still absorb by `byISO` (inclusive) — their
// leave-aware capacity over [today, byISO] minus the remaining effort of the
// work already on their plate that's due on or before that date.
function allocationRoom(state, emp, byISO) {
  const today = todayISO();
  const to = byISO && byISO >= today ? byISO : today;
  const windowCapacity = capacityHoursBetween(state, emp, today, to);
  const committedLoad = state.tasks
    .filter(t => t.assignedTo === emp.id
      && !['completed', 'pending_approval'].includes(t.status)
      && t.internalDeadline && t.internalDeadline <= to)
    .reduce((s, t) => s + remainingHours(t), 0);
  return {
    windowCapacity: Math.round(windowCapacity * 100) / 100,
    committedLoad: Math.round(committedLoad * 100) / 100,
    room: Math.round(Math.max(0, windowCapacity - committedLoad) * 100) / 100,
  };
}
// Would a `hours`-hour task due `byISO` push `emp` past what they can fit?
function overloadCheck(state, emp, hours, byISO) {
  const r = allocationRoom(state, emp, byISO);
  const overBy = Math.round(Math.max(0, hours - r.room) * 100) / 100;
  const av = availabilityOf(state, emp);
  return {
    ...r, hours: Math.round(hours * 100) / 100, byDate: byISO, overBy,
    over: overBy > 0.24,
    busyUntil: av.committedThrough > todayISO() ? av.committedThrough : null,
    clearsAt: av.clearsAt,
  };
}

// ---------------------------------------------------------------------------
// WORKLOAD / AVAILABILITY — informational only. There is no capacity gate:
// work can always be assigned, whatever the day already holds. These helpers
// feed the Workload Blockers panel and the assign picker's "hours done today"
// heads-up, not any blocking check.
//
// employeeBusyUntil() is the "latest agreed date among active work" signal
// behind the panel's "occupied until" display — a heads-up, not a gate.
// ---------------------------------------------------------------------------
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
// Best available hours figure for a task: what it actually took (if that's
// more than a rounding blip), else its agreed hours, else its call/Slack
// estimate. A task that ran long only because it went on hold is capped at
// its agreed hours — the overrun is an external delay, counted once.
function taskHours(t) {
  let h = Number(t.logged) >= 0.05 ? Number(t.logged)
        : Number(t.tat) > 0 ? Number(t.tat)
        : Number(t.estMinutes) > 0 ? Number(t.estMinutes) / 60 : 0;
  if ((t.holdCount || 0) > 0 && Number(t.tat) > 0) h = Math.min(h, Number(t.tat));
  return h;
}
// Actual hours of work a person finished on `date` — the "how much did they
// get through today" figure the dashboards and the assign picker show. This
// is informational only; there is no cap on how much work can be assigned.
// Reviewing someone else's task is real work too, so time logged against a
// review (see /api/tasks/:id/review) counts on the reviewer's date, on top
// of whatever they closed out themselves.
function hoursDoneOnDate(state, employeeId, date) {
  const ownWork = state.tasks
    .filter(t => t.assignedTo === employeeId && t.status === 'completed'
      && nzDay(t.completedAt) === date)
    .reduce((sum, t) => sum + taskHours(t), 0);
  const reviewWork = state.tasks
    .filter(t => t.reviewedBy === employeeId && Number(t.reviewHours) > 0
      && nzDay(t.reviewedAt) === date)
    .reduce((sum, t) => sum + Number(t.reviewHours), 0);
  return ownWork + reviewWork;
}
function hoursDoneToday(state, employeeId) {
  return hoursDoneOnDate(state, employeeId, todayISO());
}

// ---------------------------------------------------------------------------
// RECURRING TASKS — a template for something someone does every (working)
// day, e.g. "review rideshare clients, 30 mins". Materialized into a normal
// task once per NZ calendar day so it just shows up on the To-Do list like
// anything else — no separate surface to remember to check. Idempotent per
// template per day via rt.lastGeneratedDate; state.recurringLastRun is a
// cheap top-level guard so a busy day of polling doesn't re-scan the list
// on every request.
// ---------------------------------------------------------------------------
function canManageRecurring(state, actor, rt) {
  if (!actor || !rt) return false;
  if (rt.assignedTo === actor.id || rt.assignedBy === actor.id) return true;
  return canManageEmployee(state, actor, rt.assignedTo);
}
function buildRecurringInstance(state, rt, dateISO) {
  state.taskSeq += 1;
  const assigneeEmp = findEmployee(state, rt.assignedTo);
  return {
    id: '#' + (100000000000 + state.taskSeq),
    name: rt.name, scope: rt.scope || '—',
    kind: rt.kind,
    team: (assigneeEmp || {}).team || null,
    clientId: rt.clientId || null,
    clientName: rt.clientName || (rt.kind === 'internal' ? 'Internal' : ''),
    internalRef: rt.internalRef || null,
    clientDate: null, clientDateOverride: false,
    internalDeadline: dateISO,
    points: 0, assignedTo: rt.assignedTo, assignedBy: rt.assignedBy,
    assignedAt: new Date().toISOString(), reassignHistory: [],
    // A recurring task is routine, agreed-to work — it lands straight in
    // 'accepted' every morning rather than sitting in an accept queue.
    status: 'accepted',
    logged: 0, tat: rt.tat,
    acceptedAt: new Date().toISOString(),
    timerStartedAt: null, startedAt: null,
    completedAt: null, reviewStatus: null, reviewedBy: null, reviewNote: null, reviewedAt: null, reviewHours: null, reworkCount: 0,
    reviewerId: null, closedBy: null, closedAt: null, awaitingClientDecision: false, sentToClient: null, sentToClientAt: null, sentToClientBy: null,
    reworkStartedAt: null, faultType: null, reworkHistory: [],
    holdReasonCode: null, dateHistory: [], tatHistory: [], queries: [], overAllocated: null,
    source: 'recurring', sourceRef: rt.id, recurringTemplateId: rt.id,
  };
}
function materializeRecurringTasks(state, opts = {}) {
  const today = todayISO();
  if (!opts.force && state.recurringLastRun === today) return;
  let changed = false;
  (state.recurringTasks || []).forEach(rt => {
    if (!rt.active || rt.lastGeneratedDate === today) return;
    if (rt.weekdaysOnly !== false && !cal.isWorkingDay(today)) { rt.lastGeneratedDate = today; return; }
    if (!findEmployee(state, rt.assignedTo)) return; // assignee gone — leave the template, generate nothing
    const leave = approvedLeaveOn(state, rt.assignedTo, today);
    if (leave && !leave.halfDay) { rt.lastGeneratedDate = today; return; } // full day off — skip today
    const already = state.tasks.some(t => t.recurringTemplateId === rt.id && t.internalDeadline === today);
    rt.lastGeneratedDate = today;
    if (already) return;
    state.tasks.unshift(buildRecurringInstance(state, rt, today));
    changed = true;
  });
  state.recurringLastRun = today;
  if (changed) db.save();
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

// In-app notification for one person. `text` is plain (no HTML). Deduped so a
// repeated event of the same type on the same task doesn't stack while still
// unread. Returns the row (or the existing unread one).
function notify(state, empId, type, text, taskId) {
  if (!empId) return null;
  if (!Array.isArray(state.notifications)) state.notifications = [];
  const dupe = state.notifications.find(n => n.empId === empId && n.type === type && n.taskId === (taskId || null) && !n.seenAt);
  if (dupe) { dupe.text = text; dupe.at = new Date().toISOString(); return dupe; }
  const row = {
    id: 'n-' + (state.notificationSeq = (state.notificationSeq || 0) + 1),
    empId, type, text: String(text).slice(0, 300), taskId: taskId || null,
    at: new Date().toISOString(), seenAt: null,
  };
  state.notifications.push(row);
  if (state.notifications.length > 4000) state.notifications.splice(0, state.notifications.length - 4000);
  // also push to the person's devices — even if the app isn't open. Fire and
  // forget; the in-app inbox is the source of truth.
  const emp = findEmployee(state, empId);
  const titles = { assigned: 'New task for you', nudge: 'You\'ve been nudged', review: 'Review requested',
    rework: 'Task sent back', due: 'Task due', window: 'Window decision' };
  setImmediate(() => sendPush(state, empId, {
    title: (titles[type] || 'Task alert') + (emp ? '' : ''),
    body: String(text).slice(0, 180),
    tag: taskId ? 'task-' + taskId : 'n-' + row.id,
    url: '/',
  }).catch(() => {}));
  return row;
}
// what a manager sees about whether a person has opened their alerts for a task
function taskNotifyStatus(state, taskId, empId) {
  const ns = (state.notifications || []).filter(n => n.taskId === taskId && n.empId === empId);
  if (!ns.length) return null;
  const latest = ns.reduce((a, b) => (a.at > b.at ? a : b));
  return { at: latest.at, seen: !!latest.seenAt, seenAt: latest.seenAt || null, unseen: ns.filter(n => !n.seenAt).length };
}

// The current New Zealand calendar day, YYYY-MM-DD. Explicit TZ so it's
// correct even if the process TZ isn't NZ (belt and braces with the top-of-
// file pin). `en-CA` formats as YYYY-MM-DD.
const _NZ_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });
function todayISO() { return _NZ_FMT.format(new Date()); }
// The NZ calendar day a stored UTC timestamp falls on — for "was this done
// today / on time" checks where the stored value is a full ISO timestamp.
function nzDay(ts) { return ts ? _NZ_FMT.format(new Date(ts)) : ''; }

// ---------------------------------------------------------------------------
// P2 — REMINDER LEDGER. Every chase — a manual manager nudge or a system
// auto-reminder — is appended to state.taskEvents as a 'reminded' event
// (db.logTaskEvent). The productivity score reads the count as "reminder
// discipline". The in-app auto-reminder here is separate from, and does not
// touch, the opt-in Slack escalation ladder in connector.js.
// ---------------------------------------------------------------------------
function remindersFor(state, taskId) { return db.remindersForTask(state, taskId); }
function taskIsOpen(t) { return !!t && !['completed', 'pending_approval'].includes(t.status); }
// The 3rd chase on a still-open task tells the assignee's manager they may be stuck.
function maybeEscalateChase(state, t) {
  if (remindersFor(state, t.id).length !== 3 || !taskIsOpen(t)) return;
  const who = (findEmployee(state, t.assignedTo) || {}).name || 'the assignee';
  for (const mgr of managersOfEmployee(state, t.assignedTo)) {
    logEvent(state, mgr.id, `"${escHtml(t.name)}" has needed chasing 3 times and still isn't done — ${escHtml(who)} may be stuck.`);
  }
}
// Any open, not-yet-started task within one working day of its internal
// deadline gets ONE auto-reminder per day — a ledger entry plus a line in the
// assignee's activity feed. Idempotency is per task per day (the `remindedToday`
// set), not a single once-a-day flag: a task that only becomes due later in the
// day still gets caught, and the sweep is safe to run on every /api/tasks call.
// It's cheap — a field-check filter over the task list, and it only touches the
// event log when there's actually a candidate to chase.
function sweepAutoReminders(state) {
  const today = todayISO();
  const soon = cal.addWorkingDays(today, 1);
  const candidates = state.tasks.filter(t =>
    taskIsOpen(t) && t.assignedTo &&
    !t.startedAt && !t.timerStartedAt && t.status !== 'on_hold' &&
    t.internalDeadline && t.internalDeadline <= soon);
  if (!candidates.length) return 0;
  const remindedToday = new Set(
    (state.taskEvents || [])
      .filter(e => e.type === 'reminded' && e.channel === 'auto' && nzDay(e.at) === today)
      .map(e => e.taskId));
  let n = 0;
  for (const t of candidates) {
    if (remindedToday.has(t.id)) continue;
    const why = t.internalDeadline < today ? 'overdue and not started' : 'due soon and not started';
    db.logTaskEvent(state, t.id, 'reminded', null, { channel: 'auto', note: why });
    logEvent(state, t.assignedTo, `Reminder — "${escHtml(t.name)}" is ${why}.`);
    notify(state, t.assignedTo, 'due', `"${t.name}" is ${why}.`, t.id);
    maybeEscalateChase(state, t);
    remindedToday.add(t.id);
    n += 1;
  }
  if (n) db.save();
  return n;
}

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
    materializeRecurringTasks(state); // once-a-day, cheap no-op after the first hit
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
// WhatsApp (Interakt) — a superadmin always has it; anyone else needs the
// grant a superadmin gave them (PATCH /api/employees/:id whatsappAccess),
// same shape as the self-edit grant: off by default, per person.
function requireWhatsappAccess(req, res, next) {
  if (req.employee.accessRole === 'superadmin' || req.employee.whatsappAccess) return next();
  return res.status(403).json({ error: "You don't have access to the WhatsApp dashboard — ask a superadmin to grant it." });
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
app.post('/api/employees', requireAuth, requireSuperAdmin, (req, res) => {
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

  // calls-into-tasks (Phase 1) — additive access fields, all optional. The
  // existing accessRole / managesIds above are untouched; these sit
  // alongside them and drive the new Admin space / membership dashboards.
  if (Array.isArray(req.body.memberships)) {
    emp.memberships = req.body.memberships
      .filter(m => m && typeof m.team === 'string' && m.team.trim())
      .map(m => ({ team: m.team.trim(), level: m.level === 'admin' ? 'admin' : 'member' }));
  }
  if (typeof req.body.isFounder === 'boolean') emp.isFounder = req.body.isFounder;
  // Read-only firm-wide Commitment Dashboard observer — no other powers.
  if (typeof req.body.dashObserver === 'boolean') emp.dashObserver = req.body.dashObserver;
  // Time-boxed self-edit grant (estimate, due date & client date on their own tasks).
  if (req.body.selfEditUntil !== undefined) {
    const v = req.body.selfEditUntil;
    emp.selfEditUntil = (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && Date.parse(v) > Date.now())
      ? new Date(v).toISOString() : null;
  }
  if (req.body.slackUserId !== undefined) emp.slackUserId = req.body.slackUserId ? String(req.body.slackUserId).trim() : null;
  if (req.body.aircallAgentId !== undefined) emp.aircallAgentId = req.body.aircallAgentId ? String(req.body.aircallAgentId).trim() : null;
  // WhatsApp (Interakt) dashboard — grantable to any specific employee,
  // independent of accessRole (a superadmin always has it regardless).
  if (typeof req.body.whatsappAccess === 'boolean') emp.whatsappAccess = req.body.whatsappAccess;

  db.save();
  res.json({ employee: publicEmployee(emp) });
});

// ---------------------------------------------------------------------------
// MY TEAM — a manager adds / removes their own team members. "My team" is
// simply the people in my managesIds. A person added by two managers is on
// two teams (they report to both). An admin can only touch their own list;
// a superadmin can do it for anyone via /api/employees/:id.
// ---------------------------------------------------------------------------
function teamMemberChange(req, res, op) {
  const state = db.get();
  const me = state.employees.find(e => e.id === req.employee.id);
  if (!me || !isAdminRole(me.accessRole)) {
    return res.status(403).json({ error: 'Only a manager can change team membership.' });
  }
  const myTeam = typeof me.team === 'string' ? me.team.trim() : '';
  if (!myTeam) return res.status(400).json({ error: 'Set your own team first (Employees → Manage access).' });
  const targetId = String((req.body || {}).employeeId || '');
  const target = findEmployee(state, targetId);
  if (!target) return res.status(404).json({ error: 'Employee not found.' });
  if (targetId === me.id) return res.status(400).json({ error: "You can't move yourself." });
  if (op === 'add') {
    target.team = myTeam;
    logEvent(state, targetId, `Moved to the <b>${escHtml(myTeam)}</b> team by <b>${escHtml(me.name)}</b>.`);
  } else {
    if (target.team && target.team.trim() === myTeam) target.team = 'Unassigned';
    logEvent(state, targetId, `Removed from the <b>${escHtml(myTeam)}</b> team by <b>${escHtml(me.name)}</b>.`);
  }
  // Keep the legacy managesIds field roughly in step for anything still reading it.
  me.managesIds = teamRoster(state, me).filter(e => e.id !== me.id).map(e => e.id);
  db.save();
  res.json({ team: teamRoster(state, me).filter(e => e.id !== me.id).map(publicEmployee) });
}
app.post('/api/team/add', requireAuth, (req, res) => teamMemberChange(req, res, 'add'));
app.post('/api/team/remove', requireAuth, (req, res) => teamMemberChange(req, res, 'remove'));

// ---------------------------------------------------------------------------
// TEAMS (calls-into-tasks, Phase 1) — the team registry the membership model
// and the Admin space read from. Additive: /api/employees/:id still owns the
// legacy `team` string; this just lists/adds the named teams.
// ---------------------------------------------------------------------------
app.get('/api/teams', requireAuth, (req, res) => {
  res.json({ teams: db.get().teams || [] });
});
app.post('/api/teams', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Team name is required.' });
  state.teams = state.teams || [];
  if (state.teams.some(t => t.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'That team already exists.' });
  }
  const team = { id: 't-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36), name, createdAt: Date.now() };
  state.teams.push(team);
  db.save();
  res.status(201).json({ team });
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
// Anyone can add a client — an employee adding their own contact defaults to
// owning it. Only an admin can hand ownership to someone else.
app.post('/api/clients', requireAuth, (req, res) => {
  const state = db.get();
  const { name, ownerId, type, email } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Client name is required.' });
  const cleanEmail = email ? String(email).trim() : '';
  if (!cleanEmail) return res.status(400).json({ error: 'A client email is required — it makes the client searchable by email.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address." });
  }
  let owner = ownerId || null;
  if (owner && owner !== req.employee.id && !isAdminRole(req.employee.accessRole)) {
    owner = req.employee.id; // an employee can only put a client under their own name
  }
  if (owner && !findEmployee(state, owner)) return res.status(400).json({ error: 'Owner not found.' });
  if (!owner) owner = req.employee.id; // default: the person adding it owns it
  const client = {
    id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    name: String(name).trim(), ownerId: owner,
    type: type ? String(type).trim() : null,
    email: cleanEmail || null,
    addedBy: req.employee.id,
  };
  state.clients.push(client);
  logEvent(state, req.employee.id, `Added client <b>${escHtml(client.name)}</b>${cleanEmail ? ' (' + escHtml(cleanEmail) + ')' : ''}.`);
  db.save();
  res.status(201).json({ client });
});
app.patch('/api/clients/:id', requireAuth, (req, res) => {
  const state = db.get();
  const client = state.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  // The owner can edit their own client's details; reassigning ownership or
  // touching someone else's client is admin-only.
  const mine = client.ownerId === req.employee.id || client.addedBy === req.employee.id;
  if (!mine && !isAdminRole(req.employee.accessRole)) {
    return res.status(403).json({ error: "You can only edit clients you own." });
  }
  const { name, ownerId, type, email } = req.body || {};
  if (name && String(name).trim()) client.name = String(name).trim();
  if (ownerId !== undefined) {
    if (!isAdminRole(req.employee.accessRole)) return res.status(403).json({ error: 'Only an admin can change who owns a client.' });
    if (ownerId && !findEmployee(state, ownerId)) return res.status(400).json({ error: 'Owner not found.' });
    client.ownerId = ownerId || null;
  }
  if (type !== undefined) client.type = type ? String(type).trim() : null;
  if (email !== undefined) {
    const cleanEmail = email ? String(email).trim() : '';
    if (!cleanEmail) return res.status(400).json({ error: 'A client email is required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: "That doesn't look like a valid email address." });
    }
    client.email = cleanEmail;
  }
  db.save();
  res.json({ client });
});
// Remove a client added by mistake. The person who added it, its owner, or
// an admin can. Blocked while any task still points at it. SOFT delete —
// the client moves to state.deletedClients and can be restored.
app.delete('/api/clients/:id', requireAuth, (req, res) => {
  const state = db.get();
  const client = state.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const mine = client.ownerId === req.employee.id || client.addedBy === req.employee.id;
  if (!mine && !isAdminRole(req.employee.accessRole)) {
    return res.status(403).json({ error: 'You can only remove a client you added or own.' });
  }
  const attached = state.tasks.filter(t => t.clientId === client.id).length;
  if (attached > 0) {
    return res.status(409).json({ error: `${client.name} has ${attached} task${attached > 1 ? 's' : ''} attached — remove or reassign ${attached > 1 ? 'them' : 'it'} first.` });
  }
  client.deletedAt = new Date().toISOString();
  client.deletedBy = req.employee.id;
  client.deletedByName = req.employee.name;
  state.clients = state.clients.filter(c => c.id !== client.id);
  state.deletedClients.unshift(client);
  if (state.deletedClients.length > 500) state.deletedClients.length = 500;
  logEvent(state, req.employee.id, `Removed client <b>${escHtml(client.name)}</b> — recoverable from Recently removed.`);
  db.save();
  res.json({ ok: true });
});
app.post('/api/clients/:id/restore', requireAuth, (req, res) => {
  const state = db.get();
  const client = (state.deletedClients || []).find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Not in Recently removed.' });
  const allowed = req.employee.accessRole === 'superadmin' || client.deletedBy === req.employee.id || isAdminRole(req.employee.accessRole);
  if (!allowed) return res.status(403).json({ error: "You can't restore this client." });
  if (state.clients.find(c => c.id === client.id)) return res.status(409).json({ error: 'A client with this id is already live.' });
  delete client.deletedAt; delete client.deletedBy; delete client.deletedByName;
  state.deletedClients = state.deletedClients.filter(c => c.id !== client.id);
  state.clients.push(client);
  logEvent(state, req.employee.id, `Client <b>${escHtml(client.name)}</b> was restored by <b>${escHtml(req.employee.name)}</b>.`);
  db.save();
  res.json({ client });
});
// Recently-removed tasks and clients, newest first. Any admin/superadmin.
app.get('/api/admin/trash', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const canSeeTask = t => me.accessRole === 'superadmin' || t.deletedBy === me.id || canManageEmployee(state, me, t.assignedTo);
  res.json({
    tasks: (state.deletedTasks || []).filter(canSeeTask).slice(0, 100).map(taskForClient),
    clients: (state.deletedClients || []).slice(0, 100),
  });
});

// Which tasks is `me` allowed to see? A superadmin sees the firm. Everyone
// else sees only tasks they're actually involved in: assigned to them or
// someone they manage, assigned BY them, sent to them for review (or that
// they reviewed), or that passed through their hands in a reassignment.
// An admin additionally sees unassigned work and their own team's tasks
// (the Admin/Slack space and their oversight views need that). This is the
// real boundary — the client-side filtering on top of it is just cosmetics.
function visibleTasks(state, me) {
  // superadmins, and read-only firm-wide dashboard observers, see everything
  // (the observer can't act on any of it — that's still gated per-action).
  if (me.accessRole === 'superadmin' || me.dashObserver) return state.tasks;
  const isAdmin = me.accessRole === 'admin';
  // An employee sees only their own work; an admin sees their whole team's.
  const scopeIds = new Set([me.id]);
  if (isAdmin) teamRoster(state, me).forEach(e => scopeIds.add(e.id));
  return state.tasks.filter(t =>
    scopeIds.has(t.assignedTo) ||
    t.assignedBy === me.id ||
    t.reviewerId === me.id ||
    t.reviewedBy === me.id ||
    t.reportSendOwner === me.id ||  // handed the "send this to the client" job, even if it isn't their task
    (t.reassignHistory || []).some(h => h.from === me.id || h.to === me.id || h.by === me.id) ||
    (isAdmin && !t.assignedTo)  // unassigned work is theirs to hand out
  );
}
app.get('/api/tasks', requireAuth, (req, res) => {
  const state = db.get();
  sweepAutoReminders(state); // chase due-soon tasks that never started (once/day per task)
  res.json({ tasks: visibleTasks(state, req.employee).map(taskForClient) });
});
// P2 — a manual "Nudge": whoever oversees a task records that they've chased
// the assignee. Appends to the reminder ledger and the assignee's activity
// feed; the 3rd chase on a still-open task pings the assignee's manager.
app.post('/api/tasks/:id/nudge', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if (!t.assignedTo) return res.status(400).json({ error: "That task isn't assigned to anyone." });
  if (t.assignedTo === me.id) return res.status(400).json({ error: "You can't nudge your own task." });
  if (!taskIsOpen(t)) return res.status(400).json({ error: 'That task is already done.' });
  const canChase = me.accessRole === 'superadmin'
    || canManageEmployee(state, me, t.assignedTo)
    || t.assignedBy === me.id || t.reviewerId === me.id || t.reviewedBy === me.id;
  if (!canChase) return res.status(403).json({ error: "You can only nudge work you assigned or oversee." });
  const note = (req.body && req.body.note ? String(req.body.note) : '').slice(0, 300);
  db.logTaskEvent(state, t.id, 'reminded', me.id, { channel: 'manual', note: note || null });
  logEvent(state, t.assignedTo, `${escHtml(me.name)} nudged you about "${escHtml(t.name)}"${note ? ' — ' + escHtml(note) : ''}.`);
  logEvent(state, me.id, `Nudged ${escHtml((findEmployee(state, t.assignedTo) || {}).name || 'the assignee')} about "${escHtml(t.name)}".`);
  notify(state, t.assignedTo, 'nudge', `${me.name} nudged you about "${t.name}"${note ? ' — ' + note : ''}.`, t.id);
  maybeEscalateChase(state, t);
  db.save();
  res.json({ task: taskForClient(t), reminderCount: remindersFor(state, t.id).length });
});
// Plan preview (Phase 5): what dates would a task of `hours` land on if
// handed to `assignee` now, given their real queue + measured capacity?
// Powers the "when will this land?" hint in the assign form.
app.get('/api/tasks/plan', requireAuth, (req, res) => {
  const state = db.get();
  const emp = findEmployee(state, req.query.assignee);
  if (!emp) return res.status(400).json({ error: 'Unknown assignee.' });
  if (!assignableEmployees(state, req.employee).some(e => e.id === emp.id) && emp.id !== req.employee.id) {
    return res.status(403).json({ error: "You can't plan work for this person." });
  }
  refreshCapacity(state, emp);
  const hours = Math.max(0.25, parseFloat(req.query.hours) || 3);
  const start = (typeof req.query.start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(req.query.start)) ? req.query.start.slice(0, 10) : null;
  const by = (typeof req.query.by === 'string' && /^\d{4}-\d{2}-\d{2}/.test(req.query.by)) ? req.query.by.slice(0, 10) : null;
  res.json({
    assignee: emp.name,
    ...computeCommitmentDates(state, emp, hours, start),
    ...availabilityOf(state, emp),
    overload: by ? overloadCheck(state, emp, hours, by) : null,
  });
});
// The client commitment date for a given manager (internal) due date: the
// dispatch buffer in working days on top, skipping Sundays, public holidays
// (the shared calendar) and any of the assignee's approved leave days.
app.get('/api/plan/dispatch-date', requireAuth, (req, res) => {
  const state = db.get();
  const internal = (typeof req.query.internal === 'string' && /^\d{4}-\d{2}-\d{2}/.test(req.query.internal)) ? req.query.internal.slice(0, 10) : null;
  if (!internal) return res.status(400).json({ error: 'internal (YYYY-MM-DD) is required.' });
  const emp = req.query.assignee ? findEmployee(state, req.query.assignee) : null;
  let d = internal, added = 0, guard = 0;
  while (added < DISPATCH_BUFFER_WD && guard++ < 200) {
    d = cal.addWorkingDays(d, 1);                       // next Mon–Sat, holidays skipped
    if (emp && approvedLeaveOn(state, emp.id, d)) continue; // an approved leave day doesn't count
    added += 1;
  }
  res.json({ internal, clientDate: d, bufferWorkingDays: DISPATCH_BUFFER_WD });
});
// The hold screenshot for one task — pulled only when the detail is opened.
// Visible to the assignee, whoever put it on hold, or a manager over them.
app.get('/api/tasks/:id/hold-screenshot', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t || !t.holdScreenshot) return res.status(404).json({ error: 'No screenshot.' });
  const allowed = t.assignedTo === req.employee.id ||
    isAdminRole(req.employee.accessRole) && (req.employee.accessRole === 'superadmin' || canManageEmployee(state, req.employee, t.assignedTo));
  if (!allowed) return res.status(403).json({ error: 'Not allowed.' });
  res.json({ screenshot: t.holdScreenshot });
});

// Has the assignee opened their in-app alerts for this task? For a manager
// checking whether a nudge / new assignment landed. Computed on demand.
app.get('/api/tasks/:id/notify-status', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const allowed = req.employee.accessRole === 'superadmin' || canManageEmployee(state, req.employee, t.assignedTo)
    || t.assignedBy === req.employee.id || t.assignedTo === req.employee.id;
  if (!allowed) return res.status(403).json({ error: 'Not allowed.' });
  res.json({ status: t.assignedTo ? taskNotifyStatus(state, t.id, t.assignedTo) : null, assignee: t.assignedTo });
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const state = db.get();
  const { mode, name, scope, assignedTo, clientId, clientDate, tat, points, team, kind, internalRef } = req.body || {};
  let { internalDeadline } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Task name is required.' });
  // Internal tasks (training, admin, meetings…) have no client. Everything
  // else must name one.
  const isInternal = kind === 'internal';
  let client = null;
  // an internal task can OPTIONALLY carry a client / group reference — e.g. a
  // "client payment follow-up". If it matches a real client, link it; else it
  // stays a free-text label (e.g. "Payroll").
  const iref = isInternal && internalRef ? String(internalRef).trim() : '';
  let internalClient = null;
  if (iref) internalClient = state.clients.find(c => c.name.toLowerCase() === iref.toLowerCase());
  if (!isInternal) {
    if (!clientId) return res.status(400).json({ error: 'A client is required — or switch to an internal task.' });
    client = state.clients.find(c => c.id === clientId);
    if (!client) return res.status(400).json({ error: 'Client not found.' });
  }
  let assignee = req.employee.id;
  if (mode === 'team') {
    assignee = assignedTo;
    const allowed = assignableEmployees(state, req.employee).some(e => e.id === assignee);
    if (!allowed) return res.status(403).json({ error: "You're not authorized to assign work to this person." });
  }
  // Every task — client or internal — needs an estimated time (hours) and a
  // due date. Those two drive planning, the dashboard, and every hours
  // figure; nothing is auto-planned any more.
  const numTat = parseFloat(tat);
  if (!(numTat > 0)) return res.status(400).json({ error: 'A task needs an estimated time in hours.' });
  if (!internalDeadline) return res.status(400).json({ error: 'A task needs a due date.' });

  // Capacity is not a hard server-side gate (never has been). But if the work
  // lands on someone already fully booked for that date, the task is stamped
  // over-allocated so its hours surface as extra work — and the assign modal
  // makes the assigner tick "assign anyway" before it gets here.
  let overAllocated = null;
  if (mode === 'team') {
    const oc = overloadCheck(state, findEmployee(state, assignee), numTat, internalDeadline);
    if (oc.over) {
      overAllocated = {
        overBy: oc.overBy, dueDate: internalDeadline, roomAtAssign: oc.room,
        at: new Date().toISOString(), byId: req.employee.id, byName: req.employee.name,
      };
    }
  }

  // No daily-hours cap and no self-assignment approval — anyone can hand
  // themselves (or someone they manage) work, whatever the day already holds.
  const status = mode === 'team' ? 'awaiting_acceptance' : 'accepted';
  state.taskSeq += 1;
  const task = {
    id: '#' + (100000000000 + state.taskSeq),
    name: String(name).trim(), scope: isInternal ? (scope ? String(scope).trim() : '—') : (scope || '—'),
    kind: isInternal ? 'internal' : 'client',
    team: team ? String(team).trim() : (findEmployee(state, assignee) || {}).team || null,
    clientId: client ? client.id : (internalClient ? internalClient.id : null),
    clientName: client ? client.name : (internalClient ? internalClient.name : (iref || (isInternal ? 'Internal' : ''))),
    internalRef: iref || null,
    // Client tasks get a commitment date: whatever was passed, or the internal
    // due date + the firm's 3-working-day dispatch buffer.
    clientDate: isInternal ? null
      : (clientDate || (internalDeadline ? cal.addWorkingDays(internalDeadline, DISPATCH_BUFFER_WD) : null)),
    clientDateOverride: !isInternal && !!clientDate,
    internalDeadline: internalDeadline || null,
    points: parseInt(points, 10) || 0, assignedTo: assignee, assignedBy: req.employee.id,
    assignedAt: new Date().toISOString(), reassignHistory: [], status,
    // logged accumulates ACTUAL delivery time — the wall-clock gap between
    // Accept and Complete (or, for a rework round, between the rework
    // Accept and Resubmit). There's no manual Start/Pause; the clock is
    // implicit in acceptedAt/reworkStartedAt. tat is the AGREED hours for
    // this task, set by whoever assigns it.
    logged: 0, tat: parseFloat(tat) || 3,
    // A self-assigned task ("Assign to Me") lands straight in 'accepted' —
    // no separate acceptance step — but it does NOT start running. It sits
    // as "Yet to start" until the person clicks Start (/resume), same as an
    // accepted team task. startedAt records the first time it was started.
    acceptedAt: status === 'accepted' ? new Date().toISOString() : null,
    timerStartedAt: null,
    startedAt: null,
    completedAt: null, reviewStatus: null, reviewedBy: null, reviewNote: null, reviewedAt: null, reworkCount: 0,
    reviewerId: null, closedBy: null, closedAt: null, awaitingClientDecision: false, sentToClient: null, sentToClientAt: null, sentToClientBy: null,
    reworkStartedAt: null, faultType: null, reworkHistory: [], // reworkHistory: [{ round, startedAt, endedAt, durationHours, reviewNote, faultType }]
    holdReasonCode: null, dateHistory: [], tatHistory: [], queries: [], overAllocated,
    // calls-into-tasks (Phase 0): where this task came from. Tasks made in the
    // app are 'manual'; the Slack connector will send 'call' / 'slack' later.
    source: 'manual', sourceRef: null,
  };
  state.tasks.unshift(task);
  if (mode === 'team') {
    const assigneeEmp = findEmployee(state, assignee);
    logEvent(state, assignee, `New task assigned — <b>${assigneeEmp ? escHtml(assigneeEmp.name) : '—'}</b>, awaiting acceptance.`, {
      client: task.clientName, clientDate: task.clientDate, internalDeadline: task.internalDeadline
    });
    const overNote = task.overAllocated ? ` This is ${task.overAllocated.overBy}h over your capacity for that date — it'll count as extra hours.` : '';
    notify(state, assignee, 'assigned', `${req.employee.name} assigned you "${task.name}" — accept it or propose a new window.${overNote}`, task.id);
  }
  db.save();
  res.status(201).json({ task: taskForClient(task) });
});

// Recurring daily tasks — see materializeRecurringTasks() above.
app.get('/api/recurring-tasks', requireAuth, (req, res) => {
  const state = db.get();
  const mine = (state.recurringTasks || []).filter(rt => canManageRecurring(state, req.employee, rt));
  res.json({ recurringTasks: mine });
});
app.post('/api/recurring-tasks', requireAuth, (req, res) => {
  const state = db.get();
  const { mode, name, scope, assignedTo, clientId, kind, tat, internalRef, weekdaysOnly } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Give this daily task a name.' });
  const numTat = parseFloat(tat);
  if (!(numTat > 0)) return res.status(400).json({ error: 'Give it an estimated time in hours (e.g. 0.5).' });
  const isInternal = kind !== 'client';
  let client = null;
  if (!isInternal) {
    client = state.clients.find(c => c.id === clientId);
    if (!client) return res.status(400).json({ error: 'Client not found.' });
  }
  let assignee = req.employee.id;
  if (mode === 'team') {
    assignee = assignedTo;
    const allowed = assignableEmployees(state, req.employee).some(e => e.id === assignee);
    if (!allowed) return res.status(403).json({ error: "You're not authorized to assign work to this person." });
  }
  if (!findEmployee(state, assignee)) return res.status(400).json({ error: 'Assignee not found.' });
  state.recurringSeq = (state.recurringSeq || 0) + 1;
  const rt = {
    id: 'rt' + (100000 + state.recurringSeq),
    name: String(name).trim(),
    scope: scope ? String(scope).trim() : '—',
    kind: isInternal ? 'internal' : 'client',
    clientId: client ? client.id : null,
    clientName: client ? client.name : (isInternal ? 'Internal' : ''),
    internalRef: internalRef ? String(internalRef).trim() : null,
    tat: numTat,
    assignedTo: assignee, assignedBy: req.employee.id,
    weekdaysOnly: weekdaysOnly !== false,
    active: true,
    createdAt: new Date().toISOString(),
    lastGeneratedDate: null,
  };
  state.recurringTasks.push(rt);
  logEvent(state, assignee, `Daily recurring task set up — <b>${escHtml(rt.name)}</b> (${rt.tat}h, every ${rt.weekdaysOnly ? 'working day' : 'day'}).`);
  db.save();
  materializeRecurringTasks(state, { force: true }); // don't make them wait until tomorrow for today's instance
  res.status(201).json({ recurringTask: rt });
});
app.patch('/api/recurring-tasks/:id', requireAuth, (req, res) => {
  const state = db.get();
  const rt = (state.recurringTasks || []).find(r => r.id === req.params.id);
  if (!rt) return res.status(404).json({ error: 'Not found.' });
  if (!canManageRecurring(state, req.employee, rt)) return res.status(403).json({ error: "You're not authorized to change this." });
  const body = req.body || {};
  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) return res.status(400).json({ error: 'Name cannot be empty.' });
    rt.name = n;
  }
  if (body.scope !== undefined) rt.scope = String(body.scope).trim() || '—';
  if (body.tat !== undefined) {
    const nt = parseFloat(body.tat);
    if (!(nt > 0)) return res.status(400).json({ error: 'The estimate must be a positive number of hours.' });
    rt.tat = nt;
  }
  if (body.weekdaysOnly !== undefined) rt.weekdaysOnly = !!body.weekdaysOnly;
  let reactivated = false;
  if (body.active !== undefined) {
    reactivated = !rt.active && !!body.active;
    rt.active = !!body.active;
  }
  db.save();
  if (reactivated) materializeRecurringTasks(state, { force: true });
  res.json({ recurringTask: rt });
});
app.delete('/api/recurring-tasks/:id', requireAuth, (req, res) => {
  const state = db.get();
  const rt = (state.recurringTasks || []).find(r => r.id === req.params.id);
  if (!rt) return res.status(404).json({ error: 'Not found.' });
  if (!canManageRecurring(state, req.employee, rt)) return res.status(403).json({ error: "You're not authorized to remove this." });
  state.recurringTasks = state.recurringTasks.filter(r => r.id !== rt.id);
  db.save();
  res.json({ ok: true });
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

  // Put a task on hold — blocked by a client, a query, missing info. Needs a
  // reason; a screenshot is optional. The clock is banked, the task stays on
  // the assignee's list as pending, and it stops counting toward any day's
  // capacity until it's resumed. Time only ever counts once: the hours
  // already logged stay logged, and when the task resumes the new day's work
  // adds on top — the agreed hours (tat) never change, so a task that ran
  // long because of a hold is visibly flagged rather than counted against
  // the person.
  app.post('/api/tasks/:id/hold', requireAuth, (req, res) => {
    const state = db.get();
    const t = findTask(state, req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const isMine = t.assignedTo === req.employee.id;
    if (!isMine && !canManageEmployee(state, req.employee, t.assignedTo)) {
      return res.status(403).json({ error: 'Only the assignee or a manager over them can put this on hold.' });
    }
    if (!['accepted', 'rework', 'awaiting_acceptance'].includes(t.status)) {
      return res.status(400).json({ error: 'Only active work can be put on hold.' });
    }
    const body = req.body || {};
    // reasonCode is the new taxonomy pick; `detail` is the free text (was `reason`).
    let reasonCode = String(body.reasonCode || '').trim().toUpperCase();
    const detail = String(body.detail != null ? body.detail : (body.reason || '')).trim();
    if (!reasonCode) reasonCode = 'BLOCKED_OTHER'; // tolerate old clients that only send `reason`
    const meta = HOLD_REASONS[reasonCode];
    if (!meta) return res.status(400).json({ error: 'Pick a valid hold reason.' });
    if (meta.managerOnly && isMine && !canManageEmployee(state, req.employee, t.assignedTo)) {
      return res.status(403).json({ error: 'Only a manager can park a task for capacity reasons.' });
    }
    if (meta.needsDetail && !detail) {
      return res.status(400).json({ error: 'This reason needs a short note — what exactly are you waiting on?' });
    }
    let shot = body.screenshot || null;
    if (shot && (typeof shot !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(shot) || shot.length > 6_000_000)) {
      shot = null; // ignore anything that isn't a reasonably-sized inline image
    }
    if (t.timerStartedAt) { t.logged += (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000; t.timerStartedAt = null; }
    t.preHoldStatus = t.status;
    t.status = 'on_hold';
    t.heldAt = new Date().toISOString();
    t.holdReasonCode = reasonCode;
    t.holdReason = detail || meta.label;      // human-readable, always populated
    t.holdScreenshot = shot;
    t.holdCount = (t.holdCount || 0) + 1;
    t.holdHistory = t.holdHistory || [];
    const hh = { heldAt: t.heldAt, reasonCode, reason: t.holdReason, hasShot: !!shot, resumedAt: null, by: req.employee.name, queryId: null };
    // An exempting reason opens a query record — this is what freezes the
    // client commitment clock (Phase 2). Only for tasks that HAVE a client date.
    if (EXEMPTING_REASONS.has(reasonCode) && t.clientDate) {
      const src = ['email', 'phone', 'whatsapp', 'in_person', 'manual'].includes(body.querySource) ? body.querySource : 'manual';
      const sentAt = (typeof body.querySentAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(body.querySentAt) && body.querySentAt.slice(0, 10) <= todayISO())
        ? body.querySentAt.slice(0, 10) : todayISO();
      const q = {
        id: crypto.randomUUID(), taskId: t.id, reasonCode, source: src,
        raisedBy: req.employee.id, sentAt, replyAt: null, resumedAt: null,
        emailThreadId: null, chaseLog: [], note: detail || null,
      };
      t.queries = t.queries || [];
      t.queries.push(q);
      hh.queryId = q.id;
    }
    t.holdHistory.push(hh);
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" put on hold${isMine ? '' : ' by <b>' + escHtml(req.employee.name) + '</b>'} — ${escHtml(meta.label)}${detail ? ': ' + escHtml(detail) : ''}${hh.queryId ? ' · client clock paused' : ''}`, { hold: true });
    db.save();
    res.json({ task: taskForClient(t) });
  });

  // Take a task off hold — back to whatever active state it was in, clock not
  // auto-started (the assignee presses play when they actually pick it up).
  app.post('/api/tasks/:id/unhold', requireAuth, (req, res) => {
    const state = db.get();
    const t = findTask(state, req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const isMine = t.assignedTo === req.employee.id;
    if (!isMine && !canManageEmployee(state, req.employee, t.assignedTo)) {
      return res.status(403).json({ error: 'Only the assignee or a manager over them can take this off hold.' });
    }
    if (t.status !== 'on_hold') return res.status(400).json({ error: 'This task is not on hold.' });
    t.status = ['accepted', 'rework', 'awaiting_acceptance'].includes(t.preHoldStatus) ? t.preHoldStatus : 'accepted';
    t.preHoldStatus = null;
    // `resumedAt` is a working-DAY marker (it feeds queryShift's resume-lag
    // calc), so store the NZ calendar day, not a UTC timestamp.
    const resumeDay = todayISO();
    const last = (t.holdHistory || [])[t.holdHistory.length - 1];
    if (last && !last.resumedAt) last.resumedAt = resumeDay;
    // Mark the query for this hold as resumed — this starts the resume-lag
    // clock that can forfeit part of the freeze (calendar.queryShift).
    if (last && last.queryId) {
      const q = (t.queries || []).find(x => x.id === last.queryId);
      if (q && !q.resumedAt) q.resumedAt = resumeDay;
    }
    t.heldAt = null;
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" taken off hold${isMine ? '' : ' by <b>' + escHtml(req.employee.name) + '</b>'} — back on the list.`);
    db.save();
    res.json({ task: taskForClient(t) });
  });

  // Log the client's reply to an open query (manual tick-box — phone /
  // WhatsApp / in person / email). Ends the freeze. The processor still has
  // to Resume the task; the gap between reply and resume is the "resume lag"
  // that forfeits part of the extension if it runs past one working day.
  app.post('/api/tasks/:id/query/:qid/reply', requireAuth, (req, res) => {
    const state = db.get();
    const t = findTask(state, req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    if (t.assignedTo !== req.employee.id && !canManageEmployee(state, req.employee, t.assignedTo)) {
      return res.status(403).json({ error: 'Only the assignee or a manager over them can log a reply.' });
    }
    const q = (t.queries || []).find(x => x.id === req.params.qid);
    if (!q) return res.status(404).json({ error: 'Query not found.' });
    if (q.replyAt) return res.status(400).json({ error: 'A reply is already logged for this query.' });
    const body = req.body || {};
    const replyAt = (typeof body.replyAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(body.replyAt) && body.replyAt.slice(0, 10) <= todayISO())
      ? body.replyAt.slice(0, 10) : todayISO();
    if (replyAt < q.sentAt.slice(0, 10)) return res.status(400).json({ error: "The reply can't be dated before the query was sent." });
    q.replyAt = replyAt;
    if (['email', 'phone', 'whatsapp', 'in_person'].includes(body.replySource)) q.replySource = body.replySource;
    const sh = cal.queryShift(q, todayISO());
    logEvent(state, t.assignedTo, `Client replied to the query on "${escHtml(t.name)}" (${escHtml(replyAt)}) — commitment date moves +${sh.shift} working day${sh.shift === 1 ? '' : 's'}. Resume the task to keep the full extension.`);
    db.save();
    res.json({ task: taskForClient(t) });
  });

  // Correct / remove a query raised by mistake (assignee or manager).
  app.post('/api/tasks/:id/query/:qid/update', requireAuth, (req, res) => {
    const state = db.get();
    const t = findTask(state, req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    if (t.assignedTo !== req.employee.id && !canManageEmployee(state, req.employee, t.assignedTo)) {
      return res.status(403).json({ error: 'Not allowed.' });
    }
    const q = (t.queries || []).find(x => x.id === req.params.qid);
    if (!q) return res.status(404).json({ error: 'Query not found.' });
    const body = req.body || {};
    if (body.remove === true) {
      t.queries = t.queries.filter(x => x.id !== q.id);
      (t.holdHistory || []).forEach(h => { if (h.queryId === q.id) h.queryId = null; });
      logEvent(state, t.assignedTo, `A query on "${escHtml(t.name)}" was removed by <b>${escHtml(req.employee.name)}</b> — its commitment-clock pause no longer applies.`);
    } else {
      if (typeof body.sentAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(body.sentAt) && body.sentAt.slice(0, 10) <= todayISO()) q.sentAt = body.sentAt.slice(0, 10);
      if (body.replyAt === null) { q.replyAt = null; q.resumedAt = null; }
      else if (typeof body.replyAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(body.replyAt) && body.replyAt >= q.sentAt.slice(0, 10) && body.replyAt.slice(0, 10) <= todayISO()) q.replyAt = body.replyAt.slice(0, 10);
      logEvent(state, t.assignedTo, `A query on "${escHtml(t.name)}" was corrected by <b>${escHtml(req.employee.name)}</b>.`);
    }
    db.save();
    res.json({ task: taskForClient(t) });
  });

  // Resuming one task auto-pauses whatever else the same employee currently
  // has running (see pauseOtherActiveTasks) — this is how "choose to pause
  // the current task and start working on another one" is implemented:
  // switching is just Resume on the new task.
  // Start / Resume — begins the running clock on this task and pauses
  // whatever else the person had running (only one task is ever "In
  // progress" at a time). First time it's called on a task, it also stamps
  // startedAt, which is what flips the badge from "Yet to start" to "In
  // progress" and, once paused, to "Paused" rather than back to "Yet to start".
  app.post('/api/tasks/:id/resume', requireAuth, (req, res) => {
    const state = db.get();
    const t = findTask(state, req.params.id);
    if (!taskActionGuard(req, res, t, { mustBeAssignee: true })) return;
    if (!['accepted', 'rework'].includes(t.status)) return res.status(400).json({ error: 'Only an accepted task can be started.' });
    if (t.timerStartedAt) return res.status(400).json({ error: 'This task is already running.' });
    const first = !t.startedAt;
    t.timerStartedAt = new Date().toISOString();
    if (first) t.startedAt = t.timerStartedAt;
    pauseOtherActiveTasks(state, t.assignedTo, t.id);
    logEvent(state, t.assignedTo, `${first ? 'Started' : 'Resumed'} "${escHtml(t.name)}".`);
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
// on AND opens the agreed-time-vs-actual-delivery window (acceptedAt /
// reworkStartedAt), which /complete and /resubmit read back later. It does
// NOT start the running clock — the task sits as "Yet to start" until the
// person clicks Start (/resume). So someone can accept ten days of work in
// one go and only one task is ever actively "In progress".
app.post('/api/tasks/:id/accept', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!taskActionGuard(req, res, t, { mustBeAssignee: true })) return;
  // Accept only applies to work that's actually been handed to you.
  if (t.status !== 'awaiting_acceptance') {
    return res.status(400).json({ error: 'This task is not awaiting your acceptance.' });
  }
  // A task flagged with an error (reviewStatus === 'error') routes through
  // this exact same Accept step as a brand-new or reassigned task — see
  // the comment on /review below.
  if (t.reviewStatus === 'error') {
    t.status = 'rework';
    t.reworkStartedAt = new Date().toISOString();
    logEvent(state, t.assignedTo, `Accepted rework for "${escHtml(t.name)}" — now due ${t.internalDeadline || 'as agreed'}.`);
  } else {
    t.status = 'accepted';
    t.acceptedAt = new Date().toISOString();
    logEvent(state, t.assignedTo, `Accepted "${escHtml(t.name)}" — now due ${t.internalDeadline || 'as agreed'}.`);
  }
  t.timerStartedAt = null; // not running — Start begins the clock

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
  // You can send your work to anyone for review — just not yourself.
  if (reviewerId === t.assignedTo) return res.status(400).json({ error: "You can't send your own work to yourself for review — pick someone else." });
    const elapsed = t.timerStartedAt ? (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000 : 0;
  t.logged += elapsed;
    t.timerStartedAt = null;
  t.status = 'completed';
  t.completedAt = new Date().toISOString();
  t.reviewerId = reviewerId;
  logEvent(state, t.assignedTo, `Marked "${escHtml(t.name)}" complete — ${t.logged.toFixed(2)} hrs actual vs ${t.tat} hrs agreed.`, { points: t.points });
  logEvent(state, reviewerId, `<b>${escHtml(findEmployee(state, t.assignedTo)?.name || 'Someone')}</b> asked you to review "${escHtml(t.name)}".`);
  notify(state, reviewerId, 'review', `${findEmployee(state, t.assignedTo)?.name || 'Someone'} asked you to review "${t.name}".`, t.id);
  db.save();
  res.json({ task: taskForClient(t) });
});

// Mark a task done WITHOUT the review step — for the many tasks that don't
// need a second person to check them (call / Slack follow-ups, and any
// manual task the assignee decides needs no review). The assignee or an
// admin over them can do it. "Mark Complete" + a reviewer is still there
// for anything that should be checked.
app.post('/api/tasks/:id/done', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const isMine = t.assignedTo === req.employee.id;
  const isAdminOver = isAdminRole(req.employee.accessRole) &&
    (req.employee.accessRole === 'superadmin' || canManageEmployee(state, req.employee, t.assignedTo) || !t.assignedTo);
  if (!isMine && !isAdminOver) {
    return res.status(403).json({ error: 'Only the assignee or an admin can mark this done.' });
  }
  if (t.status === 'completed') return res.status(400).json({ error: 'Already done.' });
  if (!['accepted', 'rework', 'on_hold', 'awaiting_acceptance', 'window_proposed', 'pending'].includes(t.status)) {
    return res.status(400).json({ error: 'This task can\'t be marked done from its current state.' });
  }
  if (t.timerStartedAt) { t.logged += (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000; t.timerStartedAt = null; }
  // Optional: a single "actual hours" figure entered on the Mark Done
  // dialog, for people who don't run the Start/Pause clock. It's
  // authoritative when given; blank leaves whatever the clock caught (0 →
  // the estimate is used downstream).
  const ah = Number((req.body || {}).actualHours);
  if (ah > 0) t.logged = Math.round(ah * 100) / 100;
  if (t.status === 'on_hold') { t.preHoldStatus = null; t.heldAt = null; }
  t.status = 'completed';
  t.completedAt = new Date().toISOString();
  // 'done' is a terminal review state meaning "closed, no formal review
  // needed" — so the task reads as done, not "sent for review".
  t.reviewStatus = 'done'; t.reviewerId = null; t.awaitingClientDecision = false;
  t.closedBy = req.employee.id; t.closedAt = t.completedAt;
  const kind = (t.source && t.source !== 'manual') ? (t.source === 'call' ? 'call' : 'Slack') + ' task' : 'no review needed';
  logEvent(state, t.assignedTo || req.employee.id, `"${escHtml(t.name)}" marked done by <b>${escHtml(req.employee.name)}</b> (${kind}).`);
  db.save();
  res.json({ task: taskForClient(t) });
});

// Re-open an already-closed task and send it for review. Covers the case
// where something was marked done (no review) or even signed off clean,
// and someone now wants a second pair of eyes on it. The assignee or an
// admin over them can; it goes back to "completed, awaiting review" with
// the chosen reviewer and a fresh review slate.
app.post('/api/tasks/:id/send-for-review', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const isMine = t.assignedTo === req.employee.id;
  const isAdminOver = isAdminRole(req.employee.accessRole) &&
    (req.employee.accessRole === 'superadmin' || canManageEmployee(state, req.employee, t.assignedTo) || !t.assignedTo);
  if (!isMine && !isAdminOver) {
    return res.status(403).json({ error: 'Only the assignee or an admin can send this for review.' });
  }
  if (t.status !== 'completed' || !['done', 'clean'].includes(t.reviewStatus)) {
    return res.status(400).json({ error: 'Only a closed task (marked done, or reviewed clean) can be re-sent for review.' });
  }
  const { reviewerId } = req.body || {};
  if (!reviewerId) return res.status(400).json({ error: 'Choose who should review this task.' });
  const reviewer = findEmployee(state, reviewerId);
  if (!reviewer) return res.status(400).json({ error: 'Reviewer not found.' });
  if (reviewerId === t.assignedTo) return res.status(400).json({ error: "You can't send a task to its own owner for review — pick someone else." });
  t.reviewStatus = null;
  t.reviewerId = reviewerId;
  t.reviewedBy = null; t.reviewedAt = null; t.reviewNote = null;
  t.closedBy = null; t.closedAt = null;
  t.awaitingClientDecision = false;
  logEvent(state, reviewerId, `<b>${escHtml(req.employee.name)}</b> asked you to review "${escHtml(t.name)}" — a task that had already been closed.`);
  if (t.assignedTo && t.assignedTo !== reviewerId) {
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" was re-opened and sent to <b>${escHtml(reviewer.name)}</b> for review by <b>${escHtml(req.employee.name)}</b>.`);
  }
  db.save();
  res.json({ task: taskForClient(t) });
});

// Remove a task added by mistake. The assignee, whoever assigned it, or an
// admin over the assignee can. It's a SOFT delete — the task moves to
// state.deletedTasks and a superadmin (or whoever removed it) can restore
// it from the Command Center's "Recently removed" list.
app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const mine = t.assignedTo === req.employee.id || t.assignedBy === req.employee.id;
  const adminOver = isAdminRole(req.employee.accessRole) &&
    (req.employee.accessRole === 'superadmin' || !t.assignedTo || canManageEmployee(state, req.employee, t.assignedTo));
  if (!mine && !adminOver) {
    return res.status(403).json({ error: 'Only the assignee, whoever assigned it, or an admin can remove this task.' });
  }
  t.deletedAt = new Date().toISOString();
  t.deletedBy = req.employee.id;
  t.deletedByName = req.employee.name;
  state.tasks = state.tasks.filter(x => x.id !== t.id);
  state.deletedTasks.unshift(t);
  if (state.deletedTasks.length > 500) state.deletedTasks.length = 500;
  logEvent(state, t.assignedTo || req.employee.id, `Task "${escHtml(t.name)}" was removed by <b>${escHtml(req.employee.name)}</b> — recoverable from Recently removed.`);
  db.save();
  res.json({ ok: true });
});
// Restore a soft-deleted task. Superadmin, or the person who removed it, or
// an admin over its (former) assignee.
app.post('/api/tasks/:id/restore', requireAuth, (req, res) => {
  const state = db.get();
  const t = (state.deletedTasks || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not in Recently removed.' });
  const allowed = req.employee.accessRole === 'superadmin' || t.deletedBy === req.employee.id ||
    (isAdminRole(req.employee.accessRole) && canManageEmployee(state, req.employee, t.assignedTo));
  if (!allowed) return res.status(403).json({ error: "You can't restore this task." });
  if (findTask(state, t.id)) return res.status(409).json({ error: 'A task with this id is already live.' });
  delete t.deletedAt; delete t.deletedBy; delete t.deletedByName;
  state.deletedTasks = state.deletedTasks.filter(x => x.id !== t.id);
  state.tasks.unshift(t);
  logEvent(state, t.assignedTo || req.employee.id, `Task "${escHtml(t.name)}" was restored by <b>${escHtml(req.employee.name)}</b>.`);
  db.save();
  res.json({ task: taskForClient(t) });
});

// Assign / reassign an integration task from the Admin space — a quick
// owner pick for tasks that arrived unassigned. Admin only.
app.post('/api/tasks/:id/set-owner', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if (!t.source || t.source === 'manual') {
    return res.status(400).json({ error: 'Use Reassign for workflow tasks.' });
  }
  const { assigneeId } = req.body || {};
  const emp = findEmployee(state, assigneeId);
  if (!emp) return res.status(400).json({ error: 'Person not found.' });
  t.assignedTo = emp.id;
  if (!t.assignedBy) t.assignedBy = req.employee.id;
  t.assignedAt = new Date().toISOString();
  logEvent(state, emp.id, `"${escHtml(t.name)}" assigned to you by <b>${escHtml(req.employee.name)}</b>.`, { source: t.source });
  notify(state, emp.id, 'assigned', `${req.employee.name} assigned you "${t.name}".`, t.id);
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
  // The nominated reviewer, or a manager/admin over the assignee — never
  // the assignee themselves.
  if (!canReviewWorkOf(state, req.employee, t.assignedTo, t)) {
    return res.status(403).json({ error: "You can't review this task — it wasn't sent to you, and it isn't your report's work." });
  }
if (t.status !== 'completed') return res.status(400).json({ error: 'Only completed tasks can be reviewed.' });
  if (t.reviewStatus === 'done') return res.status(400).json({ error: 'This task was closed without review.' });
  const { status, note, faultType, reviewHours } = req.body || {};
  if (!['clean', 'error'].includes(status)) return res.status(400).json({ error: 'Review status must be clean or error.' });
  if (status === 'error' && !['processor', 'sop'].includes(faultType)) {
    return res.status(400).json({ error: 'Choose whether this was a processor fault or an SOP/manager fault.' });
  }
  const rh = Number(reviewHours);
  t.reviewStatus = status;
  t.reviewedBy = req.employee.id;
  t.reviewNote = note || null;
  t.reviewedAt = new Date().toISOString();
  // Optional: how long the review itself took — real work, so it counts
  // toward the reviewer's own hours (see hoursDoneOnDate) and shows on the
  // task alongside the assignee's logged hours.
  t.reviewHours = rh > 0 ? Math.round(rh * 100) / 100 : null;
  if (status === 'error') {
    t.status = 'awaiting_acceptance';
    t.reworkCount = (t.reworkCount || 0) + 1;
    t.faultType = faultType;
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" sent back for rework — error found. Accept it (or propose a new window) to start fixing it. ${note ? 'Note: ' + escHtml(note) : ''}`);
    notify(state, t.assignedTo, 'rework', `"${t.name}" was sent back for rework${note ? ' — ' + note : ''}. Accept it to start fixing.`, t.id);
  } else {
    // A client task then asks "send it to the client?"; an internal task
    // (training, admin) has no client, so a clean review just closes it.
    t.awaitingClientDecision = t.kind !== 'internal';
    // Whoever actually dispatches the report defaults to the person who did
    // the work — they can hand it off (see /report-owner) if someone else
    // is sending it.
    if (t.awaitingClientDecision) t.reportSendOwner = t.assignedTo;
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" reviewed — error-free.`);
    const managers = managersOfEmployee(state, t.assignedTo);
    managers.forEach(m => {
      logEvent(state, m.id, `"${escHtml(t.name)}" for <b>${escHtml(findEmployee(state, t.assignedTo)?.name || '—')}</b> was reviewed clean by <b>${escHtml(req.employee.name)}</b>.`);
    });
  }
  db.save();
  res.json({ task: taskForClient(t) });
});

// Hand the "send this to the client" step to someone else — the reviewer
// or a manager over the assignee sets it, or the current owner can pass it
// on themselves ("if they want"). Defaults to the original assignee the
// moment a review goes clean (see /review).
app.post('/api/tasks/:id/report-owner', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if (!t.awaitingClientDecision) return res.status(400).json({ error: 'This task has no pending report to send.' });
  const canAssign = canReviewWorkOf(state, req.employee, t.assignedTo, t) || req.employee.id === t.reportSendOwner;
  if (!canAssign) return res.status(403).json({ error: "You're not authorized to change who sends this report." });
  const { ownerId } = req.body || {};
  const owner = findEmployee(state, ownerId);
  if (!owner) return res.status(400).json({ error: 'Choose a real employee.' });
  const before = t.reportSendOwner;
  t.reportSendOwner = owner.id;
  if (before !== owner.id) {
    logEvent(state, owner.id, `<b>${escHtml(req.employee.name)}</b> made you responsible for sending "${escHtml(t.name)}" to the client.`);
  }
  db.save();
  res.json({ task: taskForClient(t) });
});
// Send-to-client decision — asked once a task is reviewed clean. Logged
// for the assignee and their reporting manager(s) the same way every
// other task event is, so both see the same outcome. Allowed for the
// reviewer/a manager over the assignee, OR whoever the report-send job is
// currently assigned to (defaults to the original assignee).
app.post('/api/tasks/:id/send-to-client', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const allowed = canReviewWorkOf(state, req.employee, t.assignedTo, t) || req.employee.id === t.reportSendOwner;
  if (!allowed) {
    return res.status(403).json({ error: "You can't make this decision on someone else's review." });
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
  const managers = managersOfEmployee(state, t.assignedTo);
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
  if (!taskActionGuard(req, res, t, { mustBeAdmin: true })) return;
  if (!canManageEmployee(state, req.employee, t.assignedTo)) {
    return res.status(403).json({ error: "You're not authorized to approve a window for this employee's task." });
  }
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
  t.timerStartedAt = null; // not running — Start begins the clock

  logEvent(state, req.employee.id, `Approved the proposed window for "${escHtml(t.name)}" — now due ${t.internalDeadline}.`);
  notify(state, t.assignedTo, 'window', `${req.employee.name} approved your new window for "${t.name}" — now due ${t.internalDeadline}.`, t.id);
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
  t.timerStartedAt = null; // not running — Start begins the clock

  logEvent(state, req.employee.id, `Rejected the proposed window for "${escHtml(t.name)}" — original deadline stands.`);
  notify(state, t.assignedTo, 'window', `${req.employee.name} rejected your proposed window for "${t.name}" — the original deadline (${t.internalDeadline || 'as agreed'}) stands.`, t.id);
  db.save();
  res.json({ task: taskForClient(t) });
});

// Manager edits the dates directly — no propose/approve round trip (Phase 1).
// Sets the internal due date; the client commitment date recalculates as
// internal + 3 working days unless the manager passes an explicit clientDate
// (a date already promised), which is stored with an override flag so the
// buffer isn't silently re-applied later.
app.post('/api/tasks/:id/set-dates', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const asManager = isAdminRole(req.employee.accessRole) && canManageEmployee(state, req.employee, t.assignedTo);
  const asSelf = !asManager && canSelfEditTask(req.employee, t);
  if (!asManager && !asSelf) {
    const ownTask = t.assignedTo === req.employee.id && !['completed', 'pending_approval'].includes(t.status);
    return res.status(403).json({
      error: ownTask
        ? 'Self-edit access isn’t active — ask a manager to turn it on (or extend it).'
        : "You're not authorized to change this task's dates.",
      code: ownTask ? 'SELF_EDIT_OFF' : undefined,
    });
  }
  const body = req.body || {};
  const iso = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)) ? s.slice(0, 10) : null;
  const newInternal = iso(body.internalDeadline);
  if (!newInternal) return res.status(400).json({ error: 'Give a valid internal due date (YYYY-MM-DD).' });
  if (newInternal < todayISO() && newInternal !== t.internalDeadline) {
    return res.status(400).json({ error: "You can't set the due date in the past." });
  }
  const note = String(body.note || '').trim();

  // optional: adjust the agreed estimate (TAT) in the same edit
  const newTat = (body.tat !== undefined && body.tat !== null && body.tat !== '') ? Number(body.tat) : null;
  if (newTat !== null && !(newTat > 0)) {
    return res.status(400).json({ error: 'The estimate must be a positive number of hours.' });
  }
  const curTat = Number(t.tat) || 0;
  const tatChanged = newTat !== null && Math.abs(newTat - curTat) > 0.01;

  const wasEarlier = t.internalDeadline && newInternal < t.internalDeadline;
  const cutEstimate = tatChanged && newTat < curTat;
  if ((wasEarlier || cutEstimate) && !note) {
    return res.status(400).json({
      error: wasEarlier ? 'Pulling a deadline in needs a one-line reason.' : 'Cutting the estimate needs a one-line reason.',
    });
  }

  const before = { internal: t.internalDeadline, client: t.clientDate };
  t.internalDeadline = newInternal;

  const overrideClient = iso(body.clientDate);
  if (overrideClient) {
    t.clientDate = overrideClient;
    t.clientDateOverride = true;
  } else if (t.clientDate != null || body.recalcClient) {
    // recalc from the buffer (only when the task actually has a client date)
    t.clientDate = cal.addWorkingDays(newInternal, DISPATCH_BUFFER_WD);
    t.clientDateOverride = false;
  }

  const dateChanged = before.internal !== t.internalDeadline || before.client !== t.clientDate;
  if (dateChanged) {
    t.dateHistory = t.dateHistory || [];
    t.dateHistory.push({
      at: new Date().toISOString(), by: req.employee.name,
      from: before, to: { internal: t.internalDeadline, client: t.clientDate }, note: note || null,
    });
    logEvent(state, t.assignedTo, `Dates on "${escHtml(t.name)}" changed by <b>${escHtml(req.employee.name)}</b>${asSelf ? ' (self-edit)' : ''} — internal ${escHtml(t.internalDeadline)}${t.clientDate ? ', client ' + escHtml(t.clientDate) : ''}${note ? ' (' + escHtml(note) + ')' : ''}.`);
  }
  if (tatChanged) {
    t.tatHistory = t.tatHistory || [];
    t.tatHistory.push({
      at: new Date().toISOString(), by: req.employee.name,
      from: curTat, to: newTat, note: note || null, self: asSelf || undefined,
    });
    t.tat = newTat;
    logEvent(state, t.assignedTo, `Estimate on "${escHtml(t.name)}" changed by <b>${escHtml(req.employee.name)}</b>${asSelf ? ' (self-edit)' : ''} — ${curTat}h → ${newTat}h${note ? ' (' + escHtml(note) + ')' : ''}.`);
  }
  if (dateChanged || tatChanged) db.save();
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
  const { newAssigneeId, reason } = req.body || {};
  const newEmp = findEmployee(state, newAssigneeId);
  if (!newEmp) return res.status(400).json({ error: 'Employee not found.' });
  if (newAssigneeId === t.assignedTo) return res.status(400).json({ error: 'Task is already assigned to this person.' });
  const allowed = assignableEmployees(state, req.employee).some(e => e.id === newAssigneeId);
  if (!allowed) return res.status(403).json({ error: "You're not authorized to reassign to this person." });
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
  notify(state, newAssigneeId, 'assigned', `${req.employee.name} reassigned "${t.name}" to you — accept it or propose a new window.`, t.id);
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
    // On-time is judged only against delivered work that HAD a client date.
    const deliveredWithDate = delivered.filter(t => t.clientDate && t.completedAt);
    // On-time is judged against the QUERY-SHIFTED commitment date — a
    // client-caused wait moved the line, it isn't the processor's miss.
    const onTime = deliveredWithDate.filter(t => commitmentOutcome(t) === 'met');
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
    const onTimeRate = deliveredWithDate.length ? onTime.length / deliveredWithDate.length : null;
    const cleanRate = reviewedCount ? cleanDelivered.length / reviewedCount : null;
    // Rating = the average of whatever quality signals this person actually
    // has (on-time on client-dated work, clean-review rate), minus a small
    // penalty per rework round. No signals (e.g. only internal work, never
    // reviewed) → no rating rather than a misleading zero.
    let rating = null;
    if (delivered.length > 0) {
      const parts = [];
      if (onTimeRate !== null) parts.push(onTimeRate);
      if (cleanRate !== null) parts.push(cleanRate);
      if (parts.length) {
        let score = parts.reduce((a, b) => a + b, 0) / parts.length;
        score -= Math.min(reworkCount * 0.05, 0.3);
        rating = Math.round(Math.max(0, Math.min(1, score)) * 50) / 10; // 0–5, one decimal
      }
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
      delivered: delivered.length, onTime: onTime.length, deliveredWithDate: deliveredWithDate.length,
      cleanDelivered: cleanDelivered.length, errorDelivered: errorDelivered.length,
      reassignedAway, reassignedIn, reworkCount,
      reworkHoursTotal: Math.round(reworkHoursTotal * 100) / 100,
      avgReworkHours: avgReworkHours === null ? null : Math.round(avgReworkHours * 100) / 100,
      onTimeRate: onTimeRate === null ? null : Math.round(onTimeRate * 100),
      cleanRate: cleanRate === null ? null : Math.round(cleanRate * 100),
      totalLoggedHours: Math.round(totalLoggedHours * 100) / 100,
      activeLoggedHours: Math.round(activeLoggedHours * 100) / 100,
      deliveredLoggedHours: Math.round(deliveredLoggedHours * 100) / 100,
      deliveredTatHours: Math.round(deliveredTatHours * 100) / 100,
      avgHoursPerTask: avgHoursPerTask === null ? null : Math.round(avgHoursPerTask * 100) / 100,
      shiftHours, productivityPct,
      rating,
    };
  });
  const nameOf = id => (id ? (findEmployee(state, id) || {}).name || '—' : null);
  const assignments = state.tasks.map(t => ({
    id: t.id, name: t.name, clientName: t.clientName, kind: t.kind || 'client', source: t.source || 'manual',
    assignedBy: nameOf(t.assignedBy) || '—',
    assignedTo: nameOf(t.assignedTo) || '—',
    status: t.status, reassigned: (t.reassignHistory || []).length,
    // Review / close trail — who actually did what, not just the status word.
    reviewStatus: t.reviewStatus || null,
    reviewer: nameOf(t.reviewerId),           // nominated, not yet acted
    reviewedBy: nameOf(t.reviewedBy),         // who filed the review
    reviewedAt: t.reviewedAt || null, reviewNote: t.reviewNote || null, faultType: t.faultType || null,
    closedBy: nameOf(t.closedBy),             // who hit "Mark Done"
    sentToClient: t.sentToClient, sentToClientBy: nameOf(t.sentToClientBy), sentToClientAt: t.sentToClientAt || null,
    reworkCount: t.reworkCount || 0,
    reassignTrail: (t.reassignHistory || []).map(h => ({
      from: nameOf(h.from) || '—', to: nameOf(h.to) || '—', by: nameOf(h.by), at: h.at || null, reason: h.reason || null,
    })),
    delivered: t.status === 'completed', completedAt: t.completedAt, acceptedAt: t.acceptedAt || null,
    clientDate: t.clientDate, effectiveClientDate: effectiveClientDate(t), assignedAt: t.assignedAt,
    holdReasonCode: t.holdReasonCode || null,
    queryShiftDays: taskShiftDays(t), commitmentOutcome: commitmentOutcome(t),
    queries: (t.queries || []).map(q => ({
      reasonCode: q.reasonCode, source: q.source, sentAt: q.sentAt, replyAt: q.replyAt, resumedAt: q.resumedAt,
      ...cal.queryShift(q, todayISO()),
    })),
    loggedHours: Math.round(liveElapsedHours(t) * 100) / 100, tatHours: t.tat || 0,
  }));
  res.json({ rows, assignments });
});

// ---------------------------------------------------------------------------
// P3 — COMPOSITE PRODUCTIVITY SCORE. One number, 0–100, from five sub-scores
// that each answer a different question, weighted per department (weights
// sum to 1). A factor with no data in the range is dropped and the rest
// renormalised. Below a signal threshold (min tasks OR 10 working days) the
// score is withheld ("building").
//
//   E  Efficiency  100 × allocated / worked          (capped at 100)
//   T  Timeliness  100 × met / (met + missed)        (client-dated work only)
//   R  Rework      100 − min(40, 40 × processorReworkRounds / reviewedTasks)
//   N  Reminders   100 − min(30, 15 × chaseEvents / openTasks)
//   C  Coverage    100 × worked / allocated          (denominator is allocated,
//                                                     never capacity)
// ---------------------------------------------------------------------------
const DEFAULT_WEIGHTS = { E: 0.20, T: 0.30, R: 0.15, N: 0.10, C: 0.25, slackTolerancePct: 10, minTasksForScore: 5 };
const WEIGHT_KEYS = ['E', 'T', 'R', 'N', 'C'];
function weightsForTeam(state, team) {
  const store = (state.productivityWeights && typeof state.productivityWeights === 'object') ? state.productivityWeights : {};
  const base = { ...DEFAULT_WEIGHTS, ...(store._default || {}) };
  return { ...base, ...((team && store[team]) || {}) };
}
function compositeScore(f, weights) {
  // f: { E, T, R, N, C } each null (no data) or 0..100
  let wsum = 0, psum = 0;
  for (const k of WEIGHT_KEYS) {
    if (f[k] == null) continue;
    const w = Number(weights[k]) || 0;
    wsum += w; psum += w * f[k];
  }
  return wsum > 0 ? Math.round(psum / wsum) : null;
}

// The firm's fiscal year runs 1 April – 31 March. YTD figures count from
// the fiscal-year start that contains `refISO`, not calendar January.
function fiscalYearStart(refISO) {
  const s = (refISO || todayISO()).slice(0, 10);
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
}

// The system went live on Mon 7 Sept 2026. There is no real attendance,
// task, or capacity data before that date — anything earlier is seed. So
// every productivity window is floored here: capacity hours, working days
// and worked hours are all counted from go-live, never from the (much
// earlier) fiscal-year start. Without this floor a person shows ~1%
// utilisation purely because we'd be dividing by five months of capacity
// they were never being measured over.
const SYSTEM_GO_LIVE = /^\d{4}-\d{2}-\d{2}$/.test(process.env.SYSTEM_GO_LIVE || '')
  ? process.env.SYSTEM_GO_LIVE : '2026-09-07';
// Floor `fromISO` at go-live, but only when the window actually reaches
// into the live era — a purely historical range is left untouched (and
// will just show nothing, honestly).
function floorAtGoLive(fromISO, toISO) {
  if (toISO < SYSTEM_GO_LIVE) return fromISO;
  return fromISO < SYSTEM_GO_LIVE ? SYSTEM_GO_LIVE : fromISO;
}

function productivityFor(state, empIds, fromISO, toISO) {
  const from = fromISO, to = toISO;
  const inRange = d => d && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
  const workingDays = Math.max(0, cal.workingDaysBetween(cal.addWorkingDays(from, -1), to)); // inclusive of `to`
  // YTD counts from the fiscal-year start, but never earlier than go-live —
  // there's no real worked-hours data before then.
  const yearStart = floorAtGoLive(fiscalYearStart(to), to);

  return empIds.map(id => {
    const emp = findEmployee(state, id) || { id, name: '—' };
    const done = state.tasks.filter(t => t.assignedTo === id && t.status === 'completed' && inRange(t.completedAt));
    const allocated = done.reduce((s, t) => s + (Number(t.tat) || 0), 0);
    const worked = done.reduce((s, t) => s + taskHours(t), 0);
    const dated = done.filter(t => t.clientDate);
    const met = dated.filter(t => commitmentOutcome(t) === 'met').length;
    const missed = dated.filter(t => commitmentOutcome(t) === 'missed').length;
    const reworkRounds = done.reduce((s, t) => s + (t.reworkCount || 0), 0);
    // P2: how many times this person was DELIBERATELY chased in the range —
    // a manager's Nudge or a Slack escalation. The system's own once-a-day
    // "due soon / overdue" auto-reminder (channel 'auto') is excluded: it's
    // a helper, not a mark against the person, so it doesn't feed the score
    // or show in the Chased column.
    const myTaskIds = new Set(state.tasks.filter(t => t.assignedTo === id).map(t => t.id));
    const chaseEvents = (state.taskEvents || [])
      .filter(e => e.type === 'reminded' && e.channel !== 'auto' && myTaskIds.has(e.taskId) && inRange(e.at)).length;
    if (emp.id) refreshCapacity(state, emp);
    const cap = capacityOf(emp);
    // P1: capacity is the sum of each working day's real availability
    // (attendance + approved leave), not a flat full day every working day.
    const capacityHours = capacityHoursBetween(state, emp, from, to);
    const leave = leaveDaysBetween(state, id, from, to);
    // shift hours actually logged in the range (from the punch clock)
    const shiftSeconds = Object.entries(state.attendance[id] || {})
      .filter(([d]) => d >= from && d <= to).reduce((s, [, v]) => s + (v.secondsWorked || 0), 0);
    const shiftHours = Math.round((shiftSeconds / 3600) * 100) / 100;
    // year-to-date cumulative worked hours
    const ytdWorked = state.tasks.filter(t => t.assignedTo === id && t.status === 'completed'
      && (t.completedAt || '').slice(0, 10) >= yearStart && (t.completedAt || '').slice(0, 10) <= to)
      .reduce((s, t) => s + taskHours(t), 0);
    // monthly trend across the range (reporting is monthly / fiscal-year)
    const months = {};
    done.forEach(t => {
      const mk = t.completedAt.slice(0, 7) + '-01';       // YYYY-MM-01
      (months[mk] = months[mk] || { monthStart: mk, tasks: 0, worked: 0, allocated: 0 });
      months[mk].tasks += 1; months[mk].worked += taskHours(t); months[mk].allocated += Number(t.tat) || 0;
    });
    const r2 = n => Math.round(n * 100) / 100;

    // ---- P3 composite score ----
    const weights = weightsForTeam(state, emp.team);
    const reviewedDone = done.filter(t => t.reviewStatus === 'clean' || t.reviewStatus === 'error');
    const processorReworkRounds = done.reduce((s, t) => {
      const hist = (t.reworkHistory || []).filter(h => h && h.faultType === 'processor').length;
      if (hist) return s + hist;
      if (t.reviewStatus === 'error' && t.faultType === 'processor') return s + (t.reworkCount || 1);
      return s;
    }, 0);
    const openMine = state.tasks.filter(t => t.assignedTo === id && !['completed', 'pending_approval'].includes(t.status));
    const openTasks = done.length + openMine.length;
    // P4 — coverage is judged against fairTarget = min(assigned load, capacity):
    // hours the person could actually have delivered, never raw capacity, and
    // never the impossible slice of an over-allocated plate.
    const openDueInRange = openMine.reduce((s, t) => s + (t.internalDeadline && inRange(t.internalDeadline) ? (Number(t.tat) || 0) : 0), 0);
    const assignedLoad = allocated + openDueInRange;
    const fairTarget = Math.min(assignedLoad, capacityHours > 0 ? capacityHours : assignedLoad);
    const clampPct = n => Math.max(0, Math.min(100, Math.round(n)));
    const factors = {
      E: worked > 0 ? clampPct(100 * allocated / worked) : null,
      T: (met + missed) > 0 ? clampPct(100 * met / (met + missed)) : null,
      R: reviewedDone.length > 0 ? clampPct(100 - Math.min(40, 40 * processorReworkRounds / reviewedDone.length)) : null,
      N: openTasks > 0 ? clampPct(100 - Math.min(30, 15 * chaseEvents / openTasks)) : null,
      C: assignedLoad > 0 ? clampPct(100 * worked / Math.max(fairTarget, 0.01)) : null,
    };
    const rawScore = compositeScore(factors, weights);
    const minTasks = Number(weights.minTasksForScore) > 0 ? Number(weights.minTasksForScore) : 5;
    const enoughSignal = done.length >= minTasks || workingDays >= 10;
    const scoreStatus = rawScore == null ? 'no-data' : (enoughSignal ? 'ready' : 'building');

    // A SECOND score, measured against the person's FULL capacity instead of
    // fairTarget. Every factor is identical except coverage (C), which now
    // divides worked hours by capacity, not by what the manager actually
    // handed out. So capacityScore <= productivityScore, and the whole gap
    // between them is unallocated capacity — the manager's allocation gap,
    // not the person's. `allocationGapHours` is that gap in hours.
    // only meaningful once there's a delivery score to compare against.
    const capacityCoverage = (rawScore == null) ? null
      : (capacityHours > 0 ? clampPct(100 * worked / capacityHours) : factors.C);
    const capacityFactors = { ...factors, C: capacityCoverage };
    const capacityScore = (rawScore == null) ? null : compositeScore(capacityFactors, weights);
    const allocationGapHours = r2(Math.max(0, capacityHours - assignedLoad));
    const scoreGap = (rawScore != null && capacityScore != null) ? rawScore - capacityScore : null;

    return {
      id, name: emp.name, team: emp.team || '—', jobTitle: emp.jobTitle || '',
      tasks: done.length,
      allocatedHours: r2(allocated), workedHours: r2(worked),
      capacityHours: r2(capacityHours), effectiveCapacity: cap, capacityAuto: !!emp.capacityAuto, workingDays,
      leaveDays: leave.equivalent, baseHoursPerDay: Number(emp.baseHoursPerDay) > 0 ? Number(emp.baseHoursPerDay) : null,
      shiftHours,
      utilisationPct: capacityHours > 0 ? Math.round((worked / capacityHours) * 100) : null,
      efficiency: worked > 0 ? r2(allocated / worked) : null,
      throughput: workingDays > 0 ? r2(done.length / workingDays) : null,
      onTimeRate: (met + missed) > 0 ? Math.round((met / (met + missed)) * 100) : null,
      met, missed, reworkRounds, chaseEvents,
      // P3
      factors, productivityScore: rawScore, scoreStatus, reviewedTasks: reviewedDone.length,
      processorReworkRounds, openTasksInRange: openTasks,
      // second score — coverage measured against full capacity, and the gap
      capacityFactors, capacityScore, capacityCoverage,
      allocationGapHours, scoreGap,
      // P4 — the fairness denominator the score is measured against
      assignedLoad: r2(assignedLoad), fairTarget: r2(fairTarget),
      weightsApplied: { E: weights.E, T: weights.T, R: weights.R, N: weights.N, C: weights.C },
      cumulativeYtdWorked: r2(ytdWorked), fiscalYearStart: yearStart,
      monthly: Object.values(months).sort((a, b) => a.monthStart.localeCompare(b.monthStart))
        .map(m => ({ ...m, worked: r2(m.worked), allocated: r2(m.allocated) })),
    };
  });
}

// ---------------------------------------------------------------------------
// P4 — RESPONSIBILITY SPLIT. The manager owns filling each person's week to
// capacity; an under-filled week is theirs to explain (a tagged reason) or it
// counts against their allocation accuracy. The employee owns delivering the
// fill — measured against fairTarget = min(assigned load, capacity), so idle
// time the manager created never lands on the person doing the work. SOP /
// brief-unclear rework is the manager's; only processor-fault rework touches
// the employee's score (see the R factor above).
// ---------------------------------------------------------------------------
const UNDER_ALLOC_REASONS = {
  CLIENT_DELAY:      "Waiting on the client before work can be allocated",
  AWAITING_INPUT:    "Blocked on another team, a partner, or a third party",
  SCHEDULING_GAP:    "Didn't line up enough work for the week",
  DELIBERATE_BUFFER: "Capacity held back on purpose (crunch / training ahead)",
  LOW_SEASON:        "Genuine low workload across the team",
  ONBOARDING:        "New joiner still ramping up",
};
function isoWeekStart(dateISO) {
  const d = new Date(dateISO.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}
function weeksInRange(fromISO, toISO) {
  const weeks = [];
  let w = isoWeekStart(fromISO);
  const end = isoWeekStart(toISO);
  while (w <= end) {
    weeks.push(w);
    w = new Date(new Date(w + 'T00:00:00Z').getTime() + 7 * 86400000).toISOString().slice(0, 10);
  }
  return weeks;
}
// Σ tat of a person's work that was theirs to land in [fromISO, toISO] —
// anything they completed in it, plus anything still open whose internal
// deadline falls inside it.
function allocatedInWindow(state, empId, fromISO, toISO) {
  return state.tasks.filter(t => {
    if (t.assignedTo !== empId) return false;
    const dueIn = t.status !== 'completed' && t.internalDeadline && t.internalDeadline >= fromISO && t.internalDeadline <= toISO;
    const doneIn = t.status === 'completed' && (t.completedAt || '').slice(0, 10) >= fromISO && (t.completedAt || '').slice(0, 10) <= toISO;
    return dueIn || doneIn;
  }).reduce((s, t) => s + (Number(t.tat) || 0), 0);
}
function allocationScorecard(state, teamName, fromISO, toISO) {
  const r2 = n => Math.round(n * 100) / 100;
  const roster = state.employees.filter(e => (e.team || '').trim() === teamName);
  const reports = roster.filter(e => !isAdminRole(e.accessRole));
  const people = reports.length ? reports : roster;
  const slack = (Number(weightsForTeam(state, teamName).slackTolerancePct) || 10) / 100;
  const weeks = weeksInRange(fromISO, toISO);
  const notes = state.allocationNotes || [];
  let sumAbsGap = 0, sumCap = 0, underWeeks = 0, untaggedWeeks = 0, overWeeks = 0;

  const rows = people.map(e => {
    let rAlloc = 0, rCap = 0;
    const weekDetail = weeks.map(w => {
      const wEnd = new Date(new Date(w + 'T00:00:00Z').getTime() + 6 * 86400000).toISOString().slice(0, 10);
      const wf = w < fromISO ? fromISO : w;
      const wt = wEnd > toISO ? toISO : wEnd;
      const alloc = allocatedInWindow(state, e.id, wf, wt);
      const capH = capacityHoursBetween(state, e, wf, wt);
      rAlloc += alloc; rCap += capH;
      if (capH > 0) { sumAbsGap += Math.abs(alloc - capH); sumCap += capH; }
      const under = capH > 0 && alloc < capH * (1 - slack);
      const over = capH > 0 && alloc > capH;
      const note = notes.find(n => n.employeeId === e.id && n.weekStart === w) || null;
      if (under) { underWeeks += 1; if (!note) untaggedWeeks += 1; }
      if (over) overWeeks += 1;
      return {
        weekStart: w, allocated: r2(alloc), capacity: r2(capH),
        under, over, reasonCode: note ? note.reasonCode : null, note: note ? note.note : null,
      };
    });
    const sopReworkRounds = state.tasks.filter(t => t.assignedTo === e.id && t.status === 'completed'
      && (t.completedAt || '').slice(0, 10) >= fromISO && (t.completedAt || '').slice(0, 10) <= toISO)
      .reduce((s, t) => s + (t.reworkHistory || []).filter(h => h && h.faultType === 'sop').length, 0);
    return {
      id: e.id, name: e.name,
      allocatedHours: r2(rAlloc), capacityHours: r2(rCap),
      loadPct: rCap > 0 ? Math.round((rAlloc / rCap) * 100) : null,
      status: rCap === 0 ? 'na' : rAlloc > rCap ? 'over' : rAlloc < rCap * (1 - slack) ? 'light' : 'balanced',
      untaggedWeeks: weekDetail.filter(wd => wd.under && !wd.reasonCode).map(wd => wd.weekStart),
      weeks: weekDetail,
      sopReworkRounds,
    };
  });

  return {
    team: teamName,
    slackTolerancePct: Math.round(slack * 100),
    allocationAccuracy: sumCap > 0 ? Math.max(0, Math.round(100 - Math.min(100, (100 * sumAbsGap) / sumCap))) : null,
    underAllocatedWeeks: underWeeks,
    untaggedUnderAllocatedWeeks: untaggedWeeks,
    overAllocatedWeeks: overWeeks,
    sopReworkRounds: rows.reduce((s, r) => s + r.sopReworkRounds, 0),
    reasons: UNDER_ALLOC_REASONS,
    rows,
  };
}

app.get('/api/productivity', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const clamp = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)) ? s.slice(0, 10) : null;
  const to = clamp(req.query.to) || todayISO();
  const requestedFrom = clamp(req.query.from) || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  if (requestedFrom > to) return res.status(400).json({ error: 'from must be on or before to.' });
  // No real data before go-live — count capacity / working days / worked
  // hours from 7 Sept 2026 on, never from the fiscal-year start.
  const from = floorAtGoLive(requestedFrom, to);

  // scope: an employee sees only themselves; an admin their reports + self;
  // a superadmin the whole firm (or ?scope=me to narrow).
  let ids;
  if (req.query.scope === 'me' || me.accessRole === 'employee') ids = [me.id];
  else if (me.accessRole === 'admin') ids = [...new Set([me.id, ...teamRoster(state, me).map(e => e.id)])];
  else ids = state.employees.map(e => e.id);

  const people = productivityFor(state, ids, from, to);
  const sum = (k) => people.reduce((s, p) => s + (p[k] || 0), 0);
  const totalAlloc = sum('allocatedHours'), totalWorked = sum('workedHours'), totalCap = sum('capacityHours');

  // Roll-up composite: build each factor from the summed raw inputs, then
  // weight. When everyone in scope shares one team, use that team's weights;
  // otherwise the firm default. Compare within a department, not across.
  const teamsInScope = [...new Set(people.filter(p => p.tasks > 0).map(p => p.team))];
  const rollWeights = teamsInScope.length === 1 ? weightsForTeam(state, teamsInScope[0]) : weightsForTeam(state, null);
  const tMet = sum('met'), tMissed = sum('missed'), tReviewed = sum('reviewedTasks');
  const tProcRework = sum('processorReworkRounds'), tChase = sum('chaseEvents'), tOpen = sum('openTasksInRange');
  const tFairTarget = sum('fairTarget');
  const clampPct = n => Math.max(0, Math.min(100, Math.round(n)));
  const rollFactors = {
    E: totalWorked > 0 ? clampPct(100 * totalAlloc / totalWorked) : null,
    T: (tMet + tMissed) > 0 ? clampPct(100 * tMet / (tMet + tMissed)) : null,
    R: tReviewed > 0 ? clampPct(100 - Math.min(40, 40 * tProcRework / tReviewed)) : null,
    N: tOpen > 0 ? clampPct(100 - Math.min(30, 15 * tChase / tOpen)) : null,
    C: tFairTarget > 0 ? clampPct(100 * totalWorked / tFairTarget) : null,
  };
  // Roll-up second score — coverage against summed full capacity.
  const rollCapFactors = { ...rollFactors, C: totalCap > 0 ? clampPct(100 * totalWorked / totalCap) : rollFactors.C };
  const rollCapScore = compositeScore(rollCapFactors, rollWeights);
  const tAllocationGap = Math.round(Math.max(0, totalCap - sum('assignedLoad')) * 100) / 100;

  // P4 — the manager's allocation scorecard for their own team, shown when
  // the caller manages a team and isn't narrowed to a single person.
  const managesTeam = isAdminRole(me.accessRole) && me.team && me.team.trim() && me.team !== 'Unassigned';
  const allocation = (managesTeam && ids.length > 1) ? allocationScorecard(state, me.team.trim(), from, to) : null;

  res.json({
    from, to, requestedFrom, goLive: SYSTEM_GO_LIVE,
    goLiveApplied: from !== requestedFrom,
    fiscalYearStart: floorAtGoLive(fiscalYearStart(to), to),
    scope: ids.length === 1 ? 'me' : (me.accessRole === 'admin' ? 'team' : 'firm'),
    // The Productivity table hides people with no delivered work in the range
    // (noise). The Report Card picker asks for ?full=1 so a manager/founder can
    // pull up anyone on their roster, output or not.
    people: (req.query.full === '1') ? people : people.filter(p => p.tasks > 0 || ids.length === 1),
    weights: rollWeights,
    allocation,
    totals: {
      tasks: sum('tasks'),
      allocatedHours: Math.round(totalAlloc * 100) / 100,
      workedHours: Math.round(totalWorked * 100) / 100,
      capacityHours: Math.round(totalCap * 100) / 100,
      utilisationPct: totalCap > 0 ? Math.round((totalWorked / totalCap) * 100) : null,
      efficiency: totalWorked > 0 ? Math.round((totalAlloc / totalWorked) * 100) / 100 : null,
      chaseEvents: tChase,
      factors: rollFactors,
      productivityScore: compositeScore(rollFactors, rollWeights),
      capacityFactors: rollCapFactors,
      capacityScore: rollCapScore,
      allocationGapHours: tAllocationGap,
      cumulativeYtdWorked: Math.round(sum('cumulativeYtdWorked') * 100) / 100,
    },
  });
});

// P3 — per-department score weights. Any admin can read; only a superadmin
// sets them. E+T+R+N+C must sum to 1. `team: null` edits the firm default;
// `weights: null` clears a team's override (falls back to default).
app.get('/api/productivity/weights', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const store = state.productivityWeights || {};
  const teams = [...new Set(state.employees.map(e => e.team).filter(t => t && t !== 'Unassigned'))].sort();
  res.json({
    default: { ...DEFAULT_WEIGHTS, ...(store._default || {}) },
    byTeam: Object.fromEntries(teams.map(t => [t, store[t] ? { ...DEFAULT_WEIGHTS, ...(store._default || {}), ...store[t] } : null])),
    baseDefault: DEFAULT_WEIGHTS,
    teams,
  });
});
app.put('/api/productivity/weights', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const body = req.body || {};
  const team = body.team == null ? '_default' : String(body.team);
  if (!state.productivityWeights || typeof state.productivityWeights !== 'object') state.productivityWeights = {};
  if (body.weights === null && team !== '_default') {
    delete state.productivityWeights[team];
    db.save();
    return res.json({ ok: true, cleared: team });
  }
  const w = body.weights || {};
  const nums = {};
  for (const k of WEIGHT_KEYS) {
    const v = Number(w[k]);
    if (!(v >= 0 && v <= 1)) return res.status(400).json({ error: `Weight ${k} must be between 0 and 1.` });
    nums[k] = Math.round(v * 1000) / 1000;
  }
  const total = WEIGHT_KEYS.reduce((s, k) => s + nums[k], 0);
  if (Math.abs(total - 1) > 0.001) return res.status(400).json({ error: `The five weights must add up to 1 — they add up to ${total.toFixed(3)}.` });
  const slack = Number(w.slackTolerancePct);
  nums.slackTolerancePct = (slack >= 0 && slack <= 50) ? Math.round(slack) : DEFAULT_WEIGHTS.slackTolerancePct;
  const minT = Number(w.minTasksForScore);
  nums.minTasksForScore = (minT >= 1 && minT <= 50) ? Math.round(minT) : DEFAULT_WEIGHTS.minTasksForScore;
  state.productivityWeights[team] = nums;
  logEvent(state, req.employee.id, `Updated productivity weights for <b>${escHtml(team === '_default' ? 'the firm default' : team)}</b>.`);
  db.save();
  res.json({ ok: true, team, weights: nums });
});

// P4 — allocation notes. When a person's week comes in under capacity, the
// manager tags why: an honest reason (SCHEDULING_GAP) keeps the flag on
// their scorecard; a neutral one (CLIENT_DELAY, LOW_SEASON) clears it. One
// note per person per ISO week; a manager over that person, or a superadmin.
app.get('/api/allocation-notes', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const all = state.allocationNotes || [];
  const rows = me.accessRole === 'superadmin'
    ? all
    : all.filter(n => canManageEmployee(state, me, n.employeeId) || n.byId === me.id);
  res.json({ notes: rows, reasons: UNDER_ALLOC_REASONS });
});
app.post('/api/allocation-notes', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const b = req.body || {};
  if (!b.employeeId || !findEmployee(state, b.employeeId)) return res.status(400).json({ error: 'Which person?' });
  if (!canManageEmployee(state, me, b.employeeId)) return res.status(403).json({ error: 'Not your report.' });
  if (!UNDER_ALLOC_REASONS[b.reasonCode]) return res.status(400).json({ error: 'Pick a valid reason.' });
  if (typeof b.weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.weekStart)) return res.status(400).json({ error: 'Which week?' });
  const weekStart = isoWeekStart(b.weekStart);
  if (!Array.isArray(state.allocationNotes)) state.allocationNotes = [];
  if (typeof state.allocationNoteSeq !== 'number') state.allocationNoteSeq = 0;
  const now = new Date().toISOString();
  let note = state.allocationNotes.find(n => n.employeeId === b.employeeId && n.weekStart === weekStart);
  if (note) {
    note.reasonCode = b.reasonCode;
    note.note = (b.note == null ? '' : String(b.note)).slice(0, 300);
    note.byId = me.id; note.at = now;
  } else {
    note = {
      id: 'an-' + (++state.allocationNoteSeq),
      employeeId: b.employeeId, weekStart, reasonCode: b.reasonCode,
      note: (b.note == null ? '' : String(b.note)).slice(0, 300),
      byId: me.id, at: now,
    };
    state.allocationNotes.push(note);
  }
  db.save();
  res.json({ note });
});
app.delete('/api/allocation-notes/:id', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const i = (state.allocationNotes || []).findIndex(n => n.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Note not found.' });
  const n = state.allocationNotes[i];
  if (me.accessRole !== 'superadmin' && n.byId !== me.id && !canManageEmployee(state, me, n.employeeId)) {
    return res.status(403).json({ error: 'Not yours to remove.' });
  }
  state.allocationNotes.splice(i, 1);
  db.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WORKLOAD — who's occupied until when and how much they've cleared today,
// so an assigner has context before handing out a task. Informational only.
// Scoped to whoever the caller is allowed to assign to, same boundary as
// assignableEmployees().
// ---------------------------------------------------------------------------
app.get('/api/workload', requireAuth, (req, res) => {
  const state = db.get();
  const visible = assignableEmployees(state, req.employee);
  const rows = visible.map(e => {
    refreshCapacity(state, e);
    const busyUntil = employeeBusyUntil(state, e.id);
    const activeCount = state.tasks.filter(t => t.assignedTo === e.id && t.status !== 'completed').length;
    const avail = availabilityOf(state, e);
    const hoursDoneToday_ = Math.round(hoursDoneToday(state, e.id) * 100) / 100;
    const active = state.tasks.filter(t => t.assignedTo === e.id && !['completed', 'pending_approval', 'on_hold'].includes(t.status) && t.internalDeadline);
    const hrs = {};
    active.forEach(t => { hrs[t.internalDeadline] = (hrs[t.internalDeadline] || 0) + (Number(t.tat) || 0); });
    let peakDate = null, peakHours = 0;
    Object.entries(hrs).forEach(([d, h]) => { if (h > peakHours) { peakHours = h; peakDate = d; } });
    return {
      id: e.id, name: e.name, team: e.team,
      busyUntil, nextAvailable: nextAvailableDate(busyUntil), activeCount,
      hoursDoneToday: hoursDoneToday_, todayHours: hoursDoneToday_,
      peakHours: Math.round(peakHours * 100) / 100, peakDate,
      ...avail, // effectiveCapacity, capacityAuto, backlogHours, committedThrough, freeCapacityNext5wd
    };
  });
  db.save(); // persist any capacity re-estimates
  res.json({ workload: rows });
});

// ---------------------------------------------------------------------------
// BUSY BOARD — everyone's current load at a glance: hours still in their
// queue and the date that queue clears. A manager/superadmin coordination
// aid — not shown to plain employees.
// ---------------------------------------------------------------------------
app.get('/api/busy-board', requireAuth, (req, res) => {
  const state = db.get();
  if (!isAdminRole(req.employee.accessRole)) {
    return res.status(403).json({ error: 'Manager or superadmin access required.' });
  }
  const today = todayISO();
  const r2 = n => Math.round(n * 100) / 100;
  const rows = state.employees.map(e => {
    const open = state.tasks.filter(t => t.assignedTo === e.id && !['completed', 'pending_approval'].includes(t.status));
    const av = availabilityOf(state, e);
    return {
      id: e.id, name: e.name, team: e.team || '—',
      openTasks: open.length,
      queueHours: av.backlogHours,
      dayCapacity: dayCapacity(state, e, today),
      busyUntil: av.committedThrough && av.committedThrough > today ? av.committedThrough : null,
      busyUntilAt: av.clearsAt,
      onLeaveToday: !!approvedLeaveOn(state, e.id, today),
    };
  }).filter(r => r.openTasks > 0 || r.onLeaveToday)
    .sort((a, b) => (b.busyUntil || '').localeCompare(a.busyUntil || '') || b.queueHours - a.queueHours);
  res.json({
    date: today,
    board: rows,
    totalQueueHours: r2(rows.reduce((s, r) => s + r.queueHours, 0)),
  });
});

// ---------------------------------------------------------------------------
// P5 — "TO-DO TODAY". The caller's pending hours (remaining effort on work
// that's running or due today/overdue) against today's real capacity, and —
// for a manager — the same one line per report so they can see who's
// underwater before the day gets away. `?all=1` drops the due-today filter.
// ---------------------------------------------------------------------------
app.get('/api/today', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const today = todayISO();
  const showAll = req.query.all === '1' || req.query.all === 'true';
  const r2 = n => Math.round(n * 100) / 100;

  // ?as=<empId> — a manager / founder / dashboard-observer mirroring someone's dashboard.
  let subject = me, mirroring = false;
  if (req.query.as && req.query.as !== me.id) {
    if (!canManageEmployee(state, me, req.query.as) && !me.dashObserver) return res.status(403).json({ error: "You can't view this person's dashboard." });
    const sub = findEmployee(state, req.query.as);
    if (!sub) return res.status(404).json({ error: 'Employee not found.' });
    subject = sub; mirroring = true;
  }

  const pendingFor = (empId) => {
    const open = state.tasks.filter(t => t.assignedTo === empId
      && !['completed', 'pending_approval'].includes(t.status));
    const onPlate = open.filter(t => showAll
      || t.timerStartedAt
      || (t.internalDeadline && t.internalDeadline <= today)
      || ['awaiting_acceptance', 'rework', 'window_proposed'].includes(t.status));
    const active = onPlate.filter(t => t.status !== 'on_hold');
    const coming = open.filter(t => !onPlate.includes(t) && t.internalDeadline && t.internalDeadline > today);
    return {
      pendingHours: r2(active.reduce((s, t) => s + remainingHours(t), 0)),
      pendingCount: active.length,
      heldCount: onPlate.length - active.length,
      comingUpCount: coming.length,
      comingUpHours: r2(coming.reduce((s, t) => s + remainingHours(t), 0)),
    };
  };
  const statusOf = (pending, cap) => cap === 0 ? 'off' : pending > cap ? 'over' : pending < cap * 0.5 ? 'light' : 'balanced';

  const emp = findEmployee(state, subject.id) || subject;
  const capToday = dayCapacity(state, emp, today);
  const mine = pendingFor(subject.id);
  const avail = availabilityOf(state, emp);
  const out = {
    date: today, showAll, mirroring, subject: { id: subject.id, name: subject.name },
    me: {
      ...mine,
      capacityToday: capToday,
      doneToday: r2(hoursDoneOnDate(state, subject.id, today)),
      onLeaveToday: !!approvedLeaveOn(state, subject.id, today),
      status: statusOf(mine.pendingHours, capToday),
      busyUntil: avail.committedThrough && avail.committedThrough > today ? avail.committedThrough : null,
      busyUntilAt: avail.clearsAt,
      backlogHours: avail.backlogHours,
      dailyCapacity: avail.effectiveCapacity,
    },
  };

  if (!mirroring && isAdminRole(me.accessRole) && emp.team && String(emp.team).trim() && emp.team !== 'Unassigned') {
    out.team = teamRoster(state, emp).filter(e => e.id !== me.id).map(e => {
      const p = pendingFor(e.id);
      const cap = dayCapacity(state, e, today);
      const av = availabilityOf(state, e);
      return {
        id: e.id, name: e.name,
        pendingHours: p.pendingHours, pendingCount: p.pendingCount,
        capacityToday: cap, doneToday: r2(hoursDoneOnDate(state, e.id, today)),
        onLeaveToday: !!approvedLeaveOn(state, e.id, today),
        status: statusOf(p.pendingHours, cap),
        busyUntil: av.committedThrough && av.committedThrough > today ? av.committedThrough : null,
        busyUntilAt: av.clearsAt,
      };
    }).sort((a, b) => b.pendingHours - a.pendingHours);
    out.teamPendingHours = r2(out.team.reduce((s, x) => s + x.pendingHours, 0));
    out.teamCapacityToday = r2(out.team.reduce((s, x) => s + x.capacityToday, 0));
  }
  res.json(out);
});

// ---------------------------------------------------------------------------
// ACTIVITY FEED
// ---------------------------------------------------------------------------
app.get('/api/activity', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  // Everyone sees their own activity. A manager also sees their team's; a
  // superadmin sees the whole firm. Nobody gets pinged about a colleague's
  // task updates.
  let visible;
  if (me.accessRole === 'superadmin') {
    visible = state.activityLog;
  } else if (me.accessRole === 'admin') {
    const ids = new Set([me.id, ...teamRoster(state, me).map(e => e.id)]);
    visible = state.activityLog.filter(a => !a.empId || ids.has(a.empId));
  } else {
    visible = state.activityLog.filter(a => a.empId === me.id);
  }
  res.json({ activity: visible.slice(-60).reverse() });
});

// ---------------------------------------------------------------------------
// IN-APP NOTIFICATIONS — a persistent, read-tracked inbox per person. The
// point: a task alert can't be "missed" silently — delivery and whether it
// was opened are both on the record.
// ---------------------------------------------------------------------------
app.get('/api/notifications', requireAuth, (req, res) => {
  const state = db.get();
  const mine = (state.notifications || []).filter(n => n.empId === req.employee.id)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  res.json({
    notifications: mine.slice(0, 80),
    unread: mine.filter(n => !n.seenAt).length,
  });
});
app.post('/api/notifications/read', requireAuth, (req, res) => {
  const state = db.get();
  const id = (req.body || {}).id;
  const now = new Date().toISOString();
  let n = 0;
  (state.notifications || []).forEach(x => {
    if (x.empId !== req.employee.id || x.seenAt) return;
    if (id && x.id !== id) return;
    x.seenAt = now; n += 1;
  });
  if (n) db.save();
  res.json({ ok: true, marked: n });
});

// --- Web Push: browser desktop alerts (fire even when the app is closed) ---
app.get('/api/push/key', requireAuth, (req, res) => {
  const key = vapidPublicKey();
  res.json({ publicKey: key || null, enabled: !!(PUSH_READY && key) });
});
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Invalid push subscription.' });
  }
  const state = db.get();
  if (!state.pushSubs || typeof state.pushSubs !== 'object') state.pushSubs = {};
  const list = state.pushSubs[req.employee.id] || [];
  const without = list.filter(s => s.endpoint !== sub.endpoint);
  without.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ua: String(req.headers['user-agent'] || '').slice(0, 120), at: new Date().toISOString() });
  state.pushSubs[req.employee.id] = without.slice(-8); // cap devices per person
  db.save();
  res.json({ ok: true, devices: state.pushSubs[req.employee.id].length });
});
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const endpoint = (req.body || {}).endpoint;
  const state = db.get();
  const list = (state.pushSubs && state.pushSubs[req.employee.id]) || [];
  if (endpoint) state.pushSubs[req.employee.id] = list.filter(s => s.endpoint !== endpoint);
  else if (state.pushSubs) state.pushSubs[req.employee.id] = [];
  db.save();
  res.json({ ok: true });
});
// Send a test push to yourself — the "is it working?" button.
app.post('/api/push/test', requireAuth, async (req, res) => {
  const state = db.get();
  const subs = (state.pushSubs && state.pushSubs[req.employee.id]) || [];
  if (!subs.length) return res.status(400).json({ error: 'No device registered on this account.' });
  await sendPush(state, req.employee.id, { title: 'Desktop alerts are on ✓', body: 'This is how a task alert will look.', tag: 'push-test', url: '/' });
  res.json({ ok: true, devices: subs.length });
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
    // NON-NEGOTIABLE RULE: you can only punch out once every task is settled
    // — delivered, or explicitly put on hold with a reason. Anything left
    // awaiting acceptance, in rework, with a window proposed, or actively in
    // progress and due today/overdue must be dealt with first. Enforced here,
    // not just in the UI, so it can't be bypassed by calling the API direct.
    const today = todayISO();
    const mine = state.tasks.filter(t => t.assignedTo === req.employee.id);
    const unsettled = mine.filter(t =>
      ['awaiting_acceptance', 'rework', 'window_proposed'].includes(t.status) ||
      (t.status === 'accepted' && (!t.internalDeadline || t.internalDeadline <= today)));
    if (unsettled.length > 0) {
      const acc = unsettled.filter(t => t.status === 'awaiting_acceptance');
      const rw = unsettled.filter(t => t.status === 'rework');
      const wp = unsettled.filter(t => t.status === 'window_proposed');
      const ip = unsettled.filter(t => t.status === 'accepted');
      const parts = [];
      if (acc.length) parts.push(`${acc.length} awaiting your acceptance`);
      if (rw.length) parts.push(`${rw.length} in rework`);
      if (wp.length) parts.push(`${wp.length} with a window proposed`);
      if (ip.length) parts.push(`${ip.length} in progress due today`);
      return res.status(409).json({
        error: `You have ${parts.join(', ')}. Finish ${unsettled.length > 1 ? 'them' : 'it'}, or put ${unsettled.length > 1 ? 'them' : 'it'} on hold with a reason, before logging off.`,
        code: 'PENDING_ACCEPTANCE',
        pendingTasks: acc.map(t => ({ id: t.id, name: t.name, scope: t.scope, clientName: t.clientName, reviewStatus: t.reviewStatus, reviewNote: t.reviewNote, reworkCount: t.reworkCount, kind: 'acceptance' })),
        pendingRework: rw.map(t => ({ id: t.id, name: t.name, scope: t.scope, clientName: t.clientName, reviewNote: t.reviewNote, reworkCount: t.reworkCount, kind: 'rework' })),
        pendingActive: [...wp, ...ip].map(t => ({ id: t.id, name: t.name, scope: t.scope, clientName: t.clientName, status: t.status, kind: 'active' })),
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

// Undo an accidental punch-out. A punch-out locks someone for the rest of
// the day (see the toggle above); this reopens today's record so they can
// carry on. A superadmin can do it for anyone; a manager only for their
// own reports (canManageEmployee — the same boundary as everywhere else).
// resumeClock:true restarts their clock from where it stopped (the common
// case — punched out mid-day by mistake); otherwise they're simply
// unlocked and can Punch In again themselves. Banked seconds are kept
// either way, and the correction is written to the activity log.
app.post('/api/punch/reopen', requireAuth, (req, res) => {
  const state = db.get();
  const { employeeId, resumeClock } = req.body || {};
  if (!employeeId) return res.status(400).json({ error: 'Which person?' });
  const emp = findEmployee(state, employeeId);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  if (!canManageEmployee(state, req.employee, employeeId)) {
    return res.status(403).json({ error: "You can only reopen a punch-out for someone you manage." });
  }
  const st = getPunchState(state, employeeId);
  if (!st.punchedOut) {
    return res.status(400).json({ error: `${emp.name} isn't punched out today — nothing to reopen.` });
  }
  const day = getAttendanceDay(state, employeeId, todayISO());
  st.punchedOut = false;
  day.logoutAt = null;
  if (resumeClock) {
    st.punchedInAt = Date.now();
    if (!day.loginAt) day.loginAt = new Date().toISOString();
  } else {
    st.punchedInAt = null;
  }
  logEvent(state, employeeId,
    `Punch-out reopened by <b>${escHtml(req.employee.name)}</b> — ${resumeClock ? 'clock resumed' : 'can punch in again'}.`);
  if (req.employee.id !== employeeId) {
    logEvent(state, req.employee.id, `Reopened <b>${escHtml(emp.name)}</b>'s punch-out for today.`);
  }
  db.save();
  const liveSeconds = st.punchedInAt ? st.seconds + Math.floor((Date.now() - st.punchedInAt) / 1000) : st.seconds;
  res.json({ punch: { ...st, liveSeconds, punching: !!st.punchedInAt } });
});

// Login/logout history. A superadmin sees the whole firm; a manager sees
// themselves plus their own reports. This is what makes attendance visible
// instead of just enforced, and flags absence: any working day with no
// attendance record at all is a day that person never logged in — the
// signal the shiftHours calc in /api/reports/summary needs rather than
// silently assuming a full shift. `canReopen` per row drives the
// undo-an-accidental-punch-out control (POST /api/punch/reopen).
app.get('/api/attendance/all', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const today = todayISO();
  const me = req.employee;
  const scope = me.accessRole === 'superadmin'
    ? state.employees
    : [me, ...teamRoster(state, me).filter(e => e.id !== me.id)];
  const rows = scope.map(emp => {
    const hist = state.attendance[emp.id] || {};
    const live = getPunchState(state, emp.id);
    const dates = Object.keys(hist).sort().reverse().slice(0, 14);
    return {
      id: emp.id, name: emp.name, team: emp.team,
      loggedInNow: !!live.punchedInAt,
      loggedOutToday: !!live.punchedOut,
      canReopen: canManageEmployee(state, me, emp.id),
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
// P5 — BIOMETRIC / ATTENDANCE-API INGESTION. Shared-secret, not a user
// session — a device or an HR system pushes one person-day at a time.
// Idempotent upsert keyed on (resolved employee, date). An approved leave
// day wins: the reading is kept as a note for the manager, not applied.
// Set ATTENDANCE_INGEST_TOKEN to enable; unset → the endpoint is closed.
// ---------------------------------------------------------------------------
app.post('/api/attendance/ingest', (req, res) => {
  const secret = process.env.ATTENDANCE_INGEST_TOKEN || '';
  if (!secret) return res.status(503).json({ error: 'Attendance ingestion is not configured.' });
  const got = String((req.body && req.body.token) || req.headers['x-ingest-token'] || '');
  let match = false;
  try { match = got.length === secret.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret)); } catch (e) { match = false; }
  if (!match) return res.status(401).json({ error: 'Bad ingest token.' });

  const state = db.get();
  const b = req.body || {};
  const ref = String(b.employeeRef || '').trim();
  const date = (typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) ? b.date.slice(0, 10) : null;
  if (!ref || !date) return res.status(400).json({ error: 'employeeRef and date (YYYY-MM-DD) are required.' });
  const emp = state.employees.find(e => e.biometricId === ref || e.id === ref
    || String(e.email || '').toLowerCase() === ref.toLowerCase());
  if (!emp) return res.status(404).json({ error: `No employee matches "${ref}".` });

  const toIso = (hhmm) => {
    if (typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
    return new Date(date + 'T' + hhmm.padStart(5, '0') + ':00Z').toISOString();
  };
  let seconds = Number(b.secondsOnPremises);
  if (!(seconds >= 0)) {
    const a = toIso(b.firstIn), z = toIso(b.lastOut);
    seconds = (a && z) ? Math.max(0, (new Date(z) - new Date(a)) / 1000) : 0;
  }
  seconds = Math.min(seconds, 16 * 3600);

  state.attendance[emp.id] = state.attendance[emp.id] || {};
  const rec = state.attendance[emp.id][date] || { loginAt: null, logoutAt: null, secondsWorked: 0 };
  rec.deviceReading = {
    firstIn: b.firstIn || null, lastOut: b.lastOut || null,
    seconds: Math.round(seconds), source: b.source || 'device', at: new Date().toISOString(),
  };
  const leave = approvedLeaveOn(state, emp.id, date);
  if (leave) {
    rec.note = `Badge reading on an approved ${String(leave.type || 'leave').toLowerCase()} day — not applied to capacity.`;
    state.attendance[emp.id][date] = rec;
    logEvent(state, emp.id, `Attendance device recorded a shift on an approved leave day (${date}) — kept for review, not applied.`);
    db.save();
    return res.json({ applied: false, reason: 'approved-leave', employeeId: emp.id, name: emp.name, date });
  }
  rec.loginAt = toIso(b.firstIn) || rec.loginAt;
  rec.logoutAt = toIso(b.lastOut) || rec.logoutAt;
  rec.secondsWorked = Math.round(seconds);
  rec.source = b.source || 'device';
  state.attendance[emp.id][date] = rec;
  db.save();
  res.json({ applied: true, employeeId: emp.id, name: emp.name, date, hours: Math.round((seconds / 3600) * 100) / 100 });
});

// ---------------------------------------------------------------------------
// LEAVE / TIME OFF (P1). An approved leave request reshapes a person's
// capacity for every working day it covers — immediately, future weeks
// included, so the assign-time planning preview is already right. Anyone
// requests their own; a manager decides for their team (canManageEmployee),
// a superadmin for anyone. A manager filing on behalf of a report books it
// approved in one step. Nothing is ever hard-deleted — a withdrawn request
// goes to 'cancelled'.
// ---------------------------------------------------------------------------
function leaveVisibleTo(state, me) {
  if (me.accessRole === 'superadmin') return (state.leaveRequests || []).slice();
  // A plain employee sees only their own; a manager sees their whole team's
  // (same boundary as the attendance log).
  const ids = isAdminRole(me.accessRole)
    ? new Set([me.id, ...teamRoster(state, me).map(e => e.id)])
    : new Set([me.id]);
  return (state.leaveRequests || []).filter(l => ids.has(l.employeeId) || l.createdBy === me.id);
}
function publicLeave(state, l) {
  const emp = findEmployee(state, l.employeeId);
  return { ...l, employeeName: emp ? emp.name : '—', team: emp ? (emp.team || null) : null };
}
app.get('/api/leave', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const rows = leaveVisibleTo(state, me).sort((a, b) => b.from.localeCompare(a.from));
  const pendingApprovals = me.accessRole === 'employee' ? 0
    : rows.filter(l => l.status === 'pending' && l.employeeId !== me.id
        && canManageEmployee(state, me, l.employeeId)).length;
  res.json({ leave: rows.map(l => publicLeave(state, l)), pendingApprovals });
});
app.post('/api/leave', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const b = req.body || {};
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = isDate(b.from) ? b.from.slice(0, 10) : null;
  const to = isDate(b.to) ? b.to.slice(0, 10) : from;
  if (!from) return res.status(400).json({ error: 'Pick a start date.' });
  if (to < from) return res.status(400).json({ error: 'The end date is before the start date.' });
  if (cal.workingDaysBetween(cal.addWorkingDays(from, -1), to) > 60) {
    return res.status(400).json({ error: 'That range is too long — file it in parts.' });
  }
  const type = LEAVE_TYPES.includes(b.type) ? b.type : 'ANNUAL';
  const halfDay = (b.halfDay === 'AM' || b.halfDay === 'PM') ? b.halfDay : null;
  if (halfDay && from !== to) return res.status(400).json({ error: 'A half day must be a single date.' });
  const employeeId = b.employeeId || me.id;
  if (employeeId !== me.id && !canManageEmployee(state, me, employeeId)) {
    return res.status(403).json({ error: 'You can only request time off for yourself or your team.' });
  }
  const emp = findEmployee(state, employeeId);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  const clash = (state.leaveRequests || []).find(l => l.employeeId === employeeId
    && l.status !== 'rejected' && l.status !== 'cancelled'
    && !(to < l.from || from > l.to));
  if (clash) return res.status(409).json({ error: `That overlaps an existing ${clash.status} request (${clash.from}${clash.to !== clash.from ? '–' + clash.to : ''}).` });
  const selfApprove = employeeId !== me.id && canManageEmployee(state, me, employeeId);
  const now = new Date().toISOString();
  const l = {
    id: 'lv-' + (++state.leaveSeq),
    employeeId, from, to, type, halfDay,
    reason: (b.reason == null ? '' : String(b.reason)).slice(0, 400),
    status: selfApprove ? 'approved' : 'pending',
    createdBy: me.id, createdAt: now,
    decidedBy: selfApprove ? me.id : null, decidedAt: selfApprove ? now : null, decisionNote: null,
  };
  state.leaveRequests.push(l);
  logEvent(state, employeeId, `Time off ${selfApprove ? 'booked' : 'requested'} — ${from}${to !== from ? ' to ' + to : ''}${halfDay ? ' (half day)' : ''}${employeeId !== me.id ? ` by <b>${escHtml(me.name)}</b>` : ''}.`);
  db.save();
  res.status(201).json({ leave: publicLeave(state, l) });
});
app.post('/api/leave/:id/decision', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const l = (state.leaveRequests || []).find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'Request not found.' });
  if (l.status !== 'pending') return res.status(409).json({ error: `Already ${l.status}.` });
  if (l.employeeId === me.id && me.accessRole !== 'superadmin') {
    return res.status(403).json({ error: "You can't decide your own request — your manager does." });
  }
  if (!canManageEmployee(state, me, l.employeeId)) {
    return res.status(403).json({ error: 'Not your team.' });
  }
  const approve = !!(req.body && req.body.approve);
  l.status = approve ? 'approved' : 'rejected';
  l.decidedBy = me.id;
  l.decidedAt = new Date().toISOString();
  l.decisionNote = ((req.body && req.body.note) || '').toString().slice(0, 300) || null;
  logEvent(state, l.employeeId, `Time off ${l.from}${l.to !== l.from ? '–' + l.to : ''} <b>${approve ? 'approved' : 'declined'}</b> by ${escHtml(me.name)}.`);
  db.save();
  res.json({ leave: publicLeave(state, l) });
});
app.post('/api/leave/:id/cancel', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const l = (state.leaveRequests || []).find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'Request not found.' });
  if (['cancelled', 'rejected'].includes(l.status)) return res.status(409).json({ error: `Already ${l.status}.` });
  const mayCancel = l.employeeId === me.id || l.createdBy === me.id || canManageEmployee(state, me, l.employeeId);
  if (!mayCancel) return res.status(403).json({ error: 'Not yours to cancel.' });
  l.status = 'cancelled';
  l.decidedBy = me.id;
  l.decidedAt = new Date().toISOString();
  logEvent(state, l.employeeId, `Time off ${l.from}${l.to !== l.from ? '–' + l.to : ''} cancelled by ${escHtml(me.name)}.`);
  db.save();
  res.json({ leave: publicLeave(state, l) });
});

// ---------------------------------------------------------------------------
// INTEGRATION API (calls-into-tasks, Phase 1) — the endpoint the Slack
// connector calls when someone turns a call card or a message into a task.
// Authenticated with a single shared secret (INTEGRATION_SECRET env var),
// NOT a user session. Fails closed if the secret isn't configured. Nothing
// the app's own UI does touches these routes.
// ---------------------------------------------------------------------------
function requireIntegrationAuth(req, res, next) {
  const secret = process.env.INTEGRATION_SECRET;
  if (!secret) return res.status(503).json({ error: 'Integration API is not configured (no INTEGRATION_SECRET).' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || token !== secret) return res.status(401).json({ error: 'Invalid integration credentials.' });
  next();
}

// Create a task from Slack. Assignee and client are BOTH optional — an
// unassigned "needs an owner" task is a valid state here (unlike the app's
// own /api/tasks, which is the full commitment workflow). Lands as an active
// 'accepted' task with no timer and no workload check, so it just appears on
// the assignee's list and in the Admin space without ceremony.
app.post('/api/int/tasks', requireIntegrationAuth, (req, res) => {
  const state = db.get();
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required.' });
  const source = b.source === 'call' ? 'call' : 'slack_message';

  let assignee = null;
  if (b.assigneeId) assignee = findEmployee(state, b.assigneeId);
  if (!assignee && b.assigneeSlackId) assignee = state.employees.find(e => e.slackUserId && e.slackUserId === String(b.assigneeSlackId));
  if (!assignee && b.assigneeEmail) assignee = state.employees.find(e => e.email.toLowerCase() === String(b.assigneeEmail).toLowerCase());

  let client = null;
  if (b.clientId) client = state.clients.find(c => c.id === b.clientId);
  if (!client && b.clientName) client = state.clients.find(c => c.name.toLowerCase() === String(b.clientName).toLowerCase());

  state.taskSeq += 1;
  const now = new Date().toISOString();
  const task = {
    id: '#' + (100000000000 + state.taskSeq),
    name: title,
    scope: b.detail ? String(b.detail).trim() : '—',
    clientId: client ? client.id : null,
    clientName: client ? client.name : (b.clientName ? String(b.clientName).trim() : ''),
    clientDate: null,
    internalDeadline: b.dueDate || null,
    points: parseInt(b.points, 10) || 0,
    assignedTo: assignee ? assignee.id : null,
    assignedBy: assignee ? assignee.id : null,
    team: (b.team ? String(b.team).trim() : null) || (assignee ? assignee.team : null) || null,
    assignedAt: now, reassignHistory: [],
    status: 'accepted',
    logged: 0, tat: 0,
    acceptedAt: now, timerStartedAt: null,
    completedAt: null, reviewStatus: null, reviewedBy: null, reviewNote: null, reviewedAt: null, reworkCount: 0,
    reviewerId: null, closedBy: null, closedAt: null, awaitingClientDecision: false, sentToClient: null, sentToClientAt: null, sentToClientBy: null,
    reworkStartedAt: null, faultType: null, reworkHistory: [],
    source, sourceRef: b.sourceRef || null,
    estMinutes: b.estMinutes != null && !isNaN(Number(b.estMinutes)) ? Number(b.estMinutes) : null,
    priority: b.priority || null,
  };
  state.tasks.unshift(task);
  const logTargetId = assignee ? assignee.id : ((state.employees[0] || {}).id || null);
  logEvent(state, logTargetId,
    `Task from ${source === 'call' ? 'a call' : 'Slack'}: "${escHtml(task.name)}"${assignee ? ` — assigned to <b>${escHtml(assignee.name)}</b>` : ' — <b>unassigned</b>'}.`,
    { source, sourceRef: task.sourceRef });
  db.save();
  res.status(201).json({ ok: true, id: task.id, task: taskForClient(task) });
});

// Update a task from Slack — "mark done", and/or fill in details on a task
// that was created earlier as a stub (e.g. "I'll Handle This" then later
// "Log Outcome"). Every field is optional; only the ones present are touched.
app.patch('/api/int/tasks/:id', requireIntegrationAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const b = req.body || {};
  let changed = false;

  if (typeof b.title === 'string' && b.title.trim()) { t.name = b.title.trim(); changed = true; }
  if (typeof b.detail === 'string') { t.scope = b.detail.trim() || '—'; changed = true; }
  if (b.dueDate !== undefined) { t.internalDeadline = b.dueDate || null; changed = true; }
  if (b.estMinutes !== undefined) { t.estMinutes = (b.estMinutes != null && !isNaN(Number(b.estMinutes))) ? Number(b.estMinutes) : null; changed = true; }
  if (b.priority !== undefined) { t.priority = b.priority || null; changed = true; }

  if (b.assigneeId || b.assigneeSlackId || b.assigneeEmail) {
    let a = null;
    if (b.assigneeId) a = findEmployee(state, b.assigneeId);
    if (!a && b.assigneeSlackId) a = state.employees.find(e => e.slackUserId && e.slackUserId === String(b.assigneeSlackId));
    if (!a && b.assigneeEmail) a = state.employees.find(e => e.email.toLowerCase() === String(b.assigneeEmail).toLowerCase());
    if (a) { t.assignedTo = a.id; if (!t.assignedBy) t.assignedBy = a.id; changed = true; }
  }
  if (b.clientId || b.clientName) {
    let c = null;
    if (b.clientId) c = state.clients.find(x => x.id === b.clientId);
    if (!c && b.clientName) c = state.clients.find(x => x.name.toLowerCase() === String(b.clientName).toLowerCase());
    if (c) { t.clientId = c.id; t.clientName = c.name; changed = true; }
    else if (b.clientName) { t.clientName = String(b.clientName).trim(); changed = true; }
  }

  const status = String(b.status || '');
  const wantsDone = status === 'done' || status === 'completed';
  if (wantsDone && t.status !== 'completed') {
    if (t.timerStartedAt) { t.logged += (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000; t.timerStartedAt = null; }
    if (t.status === 'on_hold') { t.preHoldStatus = null; t.heldAt = null; }
    t.status = 'completed';
    t.completedAt = new Date().toISOString();
    // Only a fresh completion with nobody set to review it reads as 'done'.
    // If it was already sent for review (reviewerId set), leave that alone.
    if (!t.reviewStatus && !t.reviewerId) { t.reviewStatus = 'done'; t.closedBy = t.assignedTo || null; t.closedAt = t.completedAt; }
    logEvent(state, t.assignedTo || ((state.employees[0] || {}).id || null), `"${escHtml(t.name)}" marked done from Slack.`);
    changed = true;
  } else if (wantsDone && t.status === 'completed') {
    // Already done — a repeat Slack "done" click is a harmless no-op.
    return res.json({ ok: true, task: taskForClient(t) });
  } else if (status && status !== 'open') {
    return res.status(400).json({ error: 'Unsupported status: ' + status });
  }

  if (!changed) return res.status(400).json({ error: 'Nothing to update.' });
  db.save();
  res.json({ ok: true, task: taskForClient(t) });
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

// Clear out test tasks for a clean demo. Superadmin only, and the body must
// carry { confirm: "DELETE ALL TASKS" } so it can't fire by accident. Keeps
// employees, clients, teams and the org chart exactly as they are — only the
// task list, the task activity feed and the task counter are reset. A
// snapshot is written to the connector log first so it's recoverable via
// /api/admin/state-import if this was a mistake.
app.post('/api/admin/clear-tasks', requireAuth, requireSuperAdmin, (req, res) => {
  if ((req.body || {}).confirm !== 'DELETE ALL TASKS') {
    return res.status(400).json({ error: 'Send { "confirm": "DELETE ALL TASKS" } to proceed.' });
  }
  const state = db.get();
  const removed = (state.tasks || []).length;
  const backup = JSON.stringify({ at: new Date().toISOString(), tasks: state.tasks || [], taskSeq: state.taskSeq });
  state.tasks = [];
  state.activityLog = [];
  state.taskSeq = 100;
  if (!Array.isArray(state.connectorLog)) state.connectorLog = [];
  state.connectorLog.push({ at: new Date().toISOString(), level: 'warn', msg: 'clear-tasks: removed ' + removed + ' tasks', meta: { by: req.employee.name, backupBytes: backup.length } });
  logEvent(state, req.employee.id, `Cleared ${removed} task${removed === 1 ? '' : 's'} for a fresh start.`);
  db.save();
  res.json({ ok: true, removed, tasks: 0, employees: (state.employees || []).length, clients: (state.clients || []).length });
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
// WHATSAPP (Interakt) — the webhook that receives messages lives in
// connector.js (POST /webhooks/interakt); these are the in-app endpoints the
// "WhatsApp (Interakt)" sidebar view uses. Superadmin-only, like Command
// Center — this is firm-wide, not scoped to one team.
// ---------------------------------------------------------------------------
app.get('/api/whatsapp/contacts', requireAuth, requireWhatsappAccess, (req, res) => {
  const state = db.get();
  const now = Date.now();
  const { prettyWaText } = require('./connector');
  const list = Object.values(state.waContacts || {}).map(c => ({
    ...c,
    lastMessageText: prettyWaText(c.lastMessageText),
    waitingHours: (c.status === 'awaiting' && c.lastInboundAt) ? Math.round((now - Date.parse(c.lastInboundAt)) / 36000) / 100 : 0,
  })).sort((a, b) => {
    if (a.status === 'awaiting' && b.status !== 'awaiting') return -1;
    if (b.status === 'awaiting' && a.status !== 'awaiting') return 1;
    if (a.status === 'awaiting' && b.status === 'awaiting') return Date.parse(a.lastInboundAt || 0) - Date.parse(b.lastInboundAt || 0); // longest-waiting first
    return Date.parse(b.lastMessageAt || 0) - Date.parse(a.lastMessageAt || 0);
  });
  res.json({ contacts: list, awaitingCount: list.filter(c => c.status === 'awaiting').length });
});
app.get('/api/whatsapp/messages', requireAuth, requireWhatsappAccess, (req, res) => {
  const state = db.get();
  const phone = String(req.query.phone || '');
  if (!phone) return res.status(400).json({ error: 'phone is required.' });
  const { prettyWaText } = require('./connector');
  const list = (state.waMessages || []).filter(m => m.phone === phone).sort((a, b) => a.at.localeCompare(b.at))
    .map(m => ({ ...m, text: prettyWaText(m.text) }));
  res.json({ messages: list });
});
// Mark a contact handled without going through Interakt — e.g. the reply
// was sent by phone/in person, or the message needed no reply at all.
app.post('/api/whatsapp/contacts/:phone/handled', requireAuth, requireWhatsappAccess, (req, res) => {
  const state = db.get();
  const c = (state.waContacts || {})[req.params.phone];
  if (!c) return res.status(404).json({ error: 'Contact not found.' });
  c.status = 'handled';
  db.save();
  res.json({ contact: c });
});
// Choose who's messages relay into Slack — nobody's do by default. Turning
// it on immediately posts their latest message too, rather than waiting
// silently for their next one.
app.post('/api/whatsapp/contacts/:phone/relay', requireAuth, requireWhatsappAccess, (req, res) => {
  const state = db.get();
  const c = (state.waContacts || {})[req.params.phone];
  if (!c) return res.status(404).json({ error: 'Contact not found.' });
  const enabled = !!(req.body || {}).enabled;
  c.relayToSlack = enabled;
  db.save();
  if (enabled && c.lastMessageText) {
    require('./connector').relayWaToSlack(c, c.lastMessageText)
      .catch(e => console.error('[whatsapp] relay-on-enable failed:', e && e.message));
  }
  res.json({ contact: c });
});
// Turn a WhatsApp contact's open thread into a real task — same shape as a
// manual internal task, tagged source:'whatsapp' so it shows up in Admin
// alongside call/Slack-sourced tasks.
app.post('/api/whatsapp/contacts/:phone/task', requireAuth, requireWhatsappAccess, (req, res) => {
  const state = db.get();
  const c = (state.waContacts || {})[req.params.phone];
  if (!c) return res.status(404).json({ error: 'Contact not found.' });
  const { name, note, tat, internalDeadline, assignedTo } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Task name is required.' });
  const numTat = parseFloat(tat);
  if (!(numTat > 0)) return res.status(400).json({ error: 'A task needs an estimated time in hours.' });
  if (!internalDeadline) return res.status(400).json({ error: 'A task needs a due date.' });
  const assignee = findEmployee(state, assignedTo);
  if (!assignee) return res.status(400).json({ error: 'Choose who this should go to.' });
  const status = assignee.id === req.employee.id ? 'accepted' : 'awaiting_acceptance';
  state.taskSeq += 1;
  const now = new Date().toISOString();
  const task = {
    id: '#' + (100000000000 + state.taskSeq), name: String(name).trim(),
    scope: note ? String(note).trim() : (c.lastMessageText || '—'),
    kind: 'internal', team: assignee.team || null,
    clientId: null, clientName: 'WhatsApp · ' + c.name, internalRef: c.name,
    clientDate: null, clientDateOverride: false, internalDeadline,
    points: 0, assignedTo: assignee.id, assignedBy: req.employee.id,
    assignedAt: now, reassignHistory: [], status,
    logged: 0, tat: numTat, acceptedAt: status === 'accepted' ? now : null,
    timerStartedAt: null, startedAt: null, completedAt: null,
    reviewStatus: null, reviewedBy: null, reviewNote: null, reviewedAt: null, reviewHours: null, reworkCount: 0,
    reviewerId: null, closedBy: null, closedAt: null, awaitingClientDecision: false, sentToClient: null, sentToClientAt: null, sentToClientBy: null,
    reworkStartedAt: null, faultType: null, reworkHistory: [], holdReasonCode: null,
    dateHistory: [], tatHistory: [], queries: [], overAllocated: null,
    source: 'whatsapp', sourceRef: c.phone,
  };
  state.tasks.unshift(task);
  c.taskIds = c.taskIds || []; c.taskIds.push(task.id);
  logEvent(state, assignee.id, `Task created from a WhatsApp message — <b>${escHtml(c.name)}</b> — "${escHtml(task.name)}".`);
  if (status === 'awaiting_acceptance') notify(state, assignee.id, 'assigned', `${req.employee.name} assigned you "${task.name}" from a WhatsApp message — accept it or propose a new window.`, task.id);
  db.save();
  res.status(201).json({ task: taskForClient(task) });
});

// ---------------------------------------------------------------------------
// CONNECTOR (calls-into-tasks, Phase 5) — Aircall + Slack + Interakt
// (WhatsApp) webhooks, moving off Google Apps Script. Routes:
// /webhooks/aircall, /webhooks/interakt, /webhooks/slack/events,
// /webhooks/slack/interactivity, /webhooks/health.
// ---------------------------------------------------------------------------
require('./connector').mountConnector(app);

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
    initPush();
    app.listen(PORT, () => {
      console.log(`Elite Taxation Governance OS running at http://localhost:${PORT} — storage: ${db._mode()} — push: ${PUSH_READY ? 'on' : 'off'}`);
    });
  })
  .catch((err) => {
    console.error('Startup failed — could not initialise the database:', err);
    process.exit(1);
  });
