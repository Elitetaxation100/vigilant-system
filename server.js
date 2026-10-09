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
const fileStore = require('./files');
fileStore.init(db);
const archive = require('./archive');
const spaceWatch = require('./space-watch');
const prodRules = require('./productivity-rules');
const dataQuality = require('./data-quality');
const workflow = require('./workflow');
const mgr = require('./manager-views');
const crmHealth = require('./crm-health');
const cal = require('./calendar');
const policyCompliance = require('./policy-compliance');
const crmSync = require('./crm-sync');
const crmApply = require('./crm-apply');
const autoMarks = require('./auto-marks');

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

// Productivity historical/V2 cutover — a FIXED literal, never derived from
// deploy/migration/restart time (see db.js's one-time seed of
// state.productivityV2EffectiveAt). NZ local: 28 Sept 2026, 00:00:00 NZDT
// (UTC+13) — chosen just past NZ's DST transition (last Sunday of Sept) to
// avoid an ambiguous local time, and inclusive of every task completed
// through 27 Sept. A task completed before this counts under the lenient
// historical rule; on/after it, the new Clean-review rule applies.
const PRODUCTIVITY_V2_EFFECTIVE_AT_DEFAULT = '2026-09-27T11:00:00.000Z';
// V3 (prospective only): for work completed on/after this moment, Productivity credits a reviewed-clean task at the day it was
// REVIEWED CLEAN — whether or not, and whenever, the report is later sent. Before V3 a dispatched report moved its credit to the
// dispatch date, which let Report Sent steer WHEN hours counted. A FIXED literal like V2: 8 Oct 2026 00:00 NZDT (UTC+13). Nothing
// completed before it is recalculated, and finalised months are stored snapshots that this never touches.
const PRODUCTIVITY_V3_EFFECTIVE_AT_DEFAULT = (process.env.NODE_ENV === 'test' && process.env.PRODUCTIVITY_V3_AT_TEST) || '2026-10-07T11:00:00.000Z';   // the override exists for the test suite only

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
const SECRET_PATH = path.join(process.env.TM_DATA_DIR || path.join(__dirname, 'data'), 'jwt-secret.txt');
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
// The CRM User ID (and its edit history) is only for whoever administers
// the CRM link — omitted for an ordinary employee's own view or anyone
// else's, unless the viewer is an admin/superadmin.
function publicEmployee(e, viewerIsAdmin) {
  const { passwordHash, crmUserId, crmUserIdHistory, ...rest } = e;
  if (viewerIsAdmin) { rest.crmUserId = crmUserId; rest.crmUserIdHistory = crmUserIdHistory; }
  rest.isProfitConfirmer = isProfitConfirmer(db.get(), e);
  rest.canDirectProfitConfirm = canDirectProfitConfirm(e);
  return rest;
}
function findEmployee(state, id) { return state.employees.find(e => e.id === id); }
// Which productivity model someone is measured by. Processors (the default),
// Marketing and Management are hours-based; Admin staff are measured by calls and
// emails acknowledged instead. Set by a superadmin from the Productivity tab.
const PROD_GROUPS = ['processor', 'admin', 'marketing', 'management'];
function prodGroupOf(emp) { return emp && PROD_GROUPS.includes(emp.prodGroup) ? emp.prodGroup : 'processor'; }
function findTask(state, id) { return state.tasks.find(t => t.id === id); }
function isAdminRole(role) { return role === 'admin' || role === 'superadmin'; }

/**
 * A team is a `.team` name. Everyone who shares a name is on that team; the
 * admins on it are its managers. This is the single source of truth for
 * "whose team is this" — managesIds is legacy and no longer consulted for
 * scoping.
 *
 * A person can be on MORE THAN ONE team: their primary `.team` plus any
 * `.extraTeams`. Two people "share a team" when ANY of their teams match, so a
 * manager sees, assigns to and reviews everyone on any of their teams, and a
 * person with two teams is managed by the admins of both.
 */
function teamsOf(emp) {
  if (!emp) return [];
  const out = [];
  const primary = typeof emp.team === 'string' ? emp.team.trim() : '';
  if (primary) out.push(primary); // 'Unassigned' counts as a primary team, exactly as before
  (Array.isArray(emp.extraTeams) ? emp.extraTeams : []).forEach(t => {
    const x = typeof t === 'string' ? t.trim() : '';
    if (x && x !== 'Unassigned' && !out.includes(x)) out.push(x);
  });
  return out;
}
const sharesTeam = (a, b) => { const mine = teamsOf(a); return mine.length > 0 && teamsOf(b).some(t => mine.includes(t)); };
function teamRoster(state, emp) {
  const mine = teamsOf(emp);
  if (!mine.length) return [];
  return state.employees.filter(e => teamsOf(e).some(t => mine.includes(t)));
}
// The admins on an employee's team — used to fan out notifications to
// "the manager(s)".
function managersOfEmployee(state, empId) {
  const emp = state.employees.find(e => e.id === empId);
  if (!emp) return [];
  return teamRoster(state, emp).filter(e => e.id !== empId && isAdminRole(e.accessRole));
}
// Inactive employees remain in state forever so historical tasks, reviews and
// audit trails keep their original identity. They must not receive new work.
// Placeholder / test / generic accounts are not people: never an escalation recipient, never counted in capacity or Productivity.
function isSystemAccount(emp) {
  const n = String((emp && emp.name) || '').trim().toLowerCase(), em = String((emp && emp.email) || '').toLowerCase();
  return !!(emp && (emp.isSystem || emp.isTest || n === 'admin' || n === 'test user' || /^test(\b|[._-])/i.test(n) || /^(admin|test|noreply|no-reply)@/.test(em)));
}
function canReceiveNewWork(emp) {
  return !!emp && !emp.accessDisabled && emp.crmActive !== false
    && !['inactive', 'terminated', 'resigned'].includes(String(emp.employmentStatus || '').toLowerCase());
}
/**
 * Whose team roster/workload does `actor` see (Manager Dashboard, Team
 * Board, the workload panel)? This is a VISIBILITY boundary, separate from
 * who they can hand brand-new work to (see anyEmployeeInFirm below) — an
 * admin's team-scoped dashboard shouldn't suddenly show the whole firm just
 * because everyone can now assign each other tasks.
 */
function assignableEmployees(state, actor) {
  if (actor.accessRole === 'superadmin') return state.employees.filter(canReceiveNewWork);
  if (actor.accessRole === 'admin') return teamRoster(state, actor).filter(e => e.id !== actor.id && canReceiveNewWork(e));
  return [];
}
/** Who can `actor` hand a brand-new task to? Everyone — any role — can
 * assign work to anyone else in the firm. */
function anyEmployeeInFirm(state) {
  return state.employees.filter(canReceiveNewWork);
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
  return !!target && target.id !== actor.id && sharesTeam(actor, target);
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

// Google Sheet / Cashbook links attached at send-for-review time — optional,
// but when given must actually be a link so it's safe to render as a
// clickable href (never javascript:, data:, etc).
function normalizeLink(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const s = String(raw).trim();
  if (!s) return { ok: true, value: null };
  if (s.length > 1000 || !/^https?:\/\//i.test(s)) {
    return { ok: false };
  }
  return { ok: true, value: s };
}
// A link a person typed is checked properly: a real web address with a host, no embedded password, and — only when the founder has
// switched the policy on — on an approved site. (Default OFF so existing data and habits keep working.)
function workflowSettings(state) { return state.workflowSettings || {}; }
function checkLink(state, raw, label) {
  const n = normalizeLink(raw);
  if (!n.ok) return { ok: false, error: label + ' must be a valid URL starting with http:// or https://' };
  if (!n.value) return n;
  let u; try { u = new URL(n.value); } catch (e) { return { ok: false, error: label + ' is not a valid link.' }; }
  if (u.username || u.password) return { ok: false, error: label + ' must not contain a username or password.' };
  if (!u.hostname.includes('.')) return { ok: false, error: label + ' needs a real website address.' };
  const ws = workflowSettings(state);
  if (ws.linkDomainsEnforced && !mgr.domainAllowed(n.value, ws.linkDomains)) return { ok: false, error: label + ' must be on an approved site (' + (ws.linkDomains || mgr.clientLinkDomains).join(', ') + ').' };
  return n;
}
// Every change to a task's Sheet / Cashbook link is kept: who, when, from what, to what, and through which door.
function snapLinks(t) { return { sheet: t.sheetLink || null, cashbook: t.cashbookLink || null }; }
function recordLinkChange(t, actor, before, via) {
  const now = snapLinks(t);
  [['sheet', 'Google Sheet'], ['cashbook', 'Cashbook']].forEach(([k, label]) => {
    if (before[k] === now[k]) return;
    t.linkHistory = t.linkHistory || [];
    t.linkHistory.push({ at: new Date().toISOString(), by: actor.name, byId: actor.id, slot: k, label, from: before[k], to: now[k], via: via || null });
  });
}
// Profit confirmation always routes to Shubam Sharma — same "one named
// person" pattern as FOUNDER_EMAILS in db.js.
const PROFIT_CONFIRM_EMAIL = 'shubham@elitetaxation.co.nz';
// Named people who can send their OWN job straight to profit confirmation,
// skipping the separate review step (the "Profit confirm" toggle on Mark
// Complete / Reopen for re-review). Extend via DIRECT_PROFIT_CONFIRM_EMAILS
// (comma-separated) without a code change.
const DIRECT_PROFIT_CONFIRM_EMAILS = (process.env.DIRECT_PROFIT_CONFIRM_EMAILS ||
  'parvinder@elitetaxation.co.nz,simran@elitetaxation.co.nz').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
// A task stored as "internal" that nevertheless names a client (or has a Sheet/Cashbook link) is
// really client work (it was set up with the wrong type) — it can be profit-
// confirmed, and is converted to a client task when it is.
function hasClient(t) {
  if (!t) return false;
  const name = String(t.clientName || '').trim();
  return !!(t.clientId || (name && name.toLowerCase() !== 'internal') || t.sheetLink || t.cashbookLink);
}
function canDirectProfitConfirm(emp) {
  return !!(emp && emp.email && DIRECT_PROFIT_CONFIRM_EMAILS.includes(String(emp.email).toLowerCase()));
}
// Review skipped: record a system "clean" review and route the task to
// Shubam. Returns an error message, or null when it was routed. Call AFTER
// the task's links have been saved onto it.
function startDirectProfitConfirm(state, t, actor) {
  if (t.kind === 'internal' && !hasClient(t)) return 'Admin Tasks have no client, so there is nothing to profit-confirm.';
  if (!hasSheetOrCashbook(t)) return 'Attach a Google Sheet or Cashbook link, or a file, before sending for profit confirmation.';
  const owner = profitConfirmOwner(state, t);
  if (!owner) return 'Profit confirmation is not set up — nobody is configured to confirm profit.';
  const now = new Date().toISOString();
  if (t.kind === 'internal') {
    t.kind = 'client';
    logEvent(state, t.assignedTo || actor.id, `"${escHtml(t.name)}" has a client attached, so it was switched from an internal task to client work by <b>${escHtml(actor.name)}</b>.`);
  }
  t.reviewerId = null;
  t.reviewStatus = 'clean'; t.reviewSkipped = true;
  t.reviewedBy = null; t.reviewedAt = now;
  t.reviewNote = 'Sent directly for profit confirmation — separate review skipped.';
  t.awaitingClientDecision = false;
  t.profitConfirmStatus = 'pending'; t.profitConfirmRequestedAt = now; t.profitConfirmRequestedBy = actor.id; t.profitConfirmerAssignedId = owner.id;
  t.profitConfirmAt = null; t.profitConfirmBy = null;
  logEvent(state, owner.id, `<b>${escHtml(actor.name)}</b> sent "${escHtml(t.name)}" for profit confirmation (no separate review).`);
  if (t.assignedTo && t.assignedTo !== actor.id) logEvent(state, t.assignedTo, `"${escHtml(t.name)}" was sent to <b>${escHtml(owner.name)}</b> for profit confirmation.`);
  notify(state, owner.id, 'profit_confirm', `${actor.name} sent "${t.name}" for profit confirmation.`, t.id);
  return null;
}
// Who confirms profit for a task. Nothing is hard-coded to one person any more: a task-specific override wins, then the team's
// confirmer, then the company default, then (only if none is configured) the original legacy default. If the chosen person can
// no longer receive work, the configured backup steps in. Settings live in workflowSettings.profitConfirmers:
//   { default: employeeId, teams: { "<team name>": employeeId }, backup: employeeId }
function profitConfirmerInfo(state, t) {
  const cfg = workflowSettings(state).profitConfirmers || {};
  const live = id => id ? (state.employees || []).find(e => e.id === id && canReceiveNewWork(e)) : null;
  const legacy = (state.employees || []).find(e => (e.email || '').toLowerCase() === PROFIT_CONFIRM_EMAIL);
  let owner = null, source = null;
  if (t && t.profitConfirmStatus === 'pending' && live(t.profitConfirmerAssignedId)) { owner = live(t.profitConfirmerAssignedId); source = 'assigned'; }   // a request already sent stays with the person it was sent to
  else if (t && live(t.profitConfirmerId)) { owner = live(t.profitConfirmerId); source = 'task'; }
  else if (t && t.team && live((cfg.teams || {})[t.team])) { owner = live(cfg.teams[t.team]); source = 'team'; }
  else if (live(cfg.default)) { owner = live(cfg.default); source = 'default'; }
  else if (legacy && canReceiveNewWork(legacy)) { owner = legacy; source = 'legacy'; }
  if (!owner && live(cfg.backup)) { owner = live(cfg.backup); source = 'backup'; }
  return { owner: owner || null, source, backupId: live(cfg.backup) ? cfg.backup : null };
}
function profitConfirmOwner(state, t) { return profitConfirmerInfo(state, t).owner; }
// Everyone who is the profit confirmer for SOME task — the default, any team's, and the backup. Drives who sees the confirmation queue.
function isProfitConfirmer(state, emp) {
  if (!emp) return false;
  const cfg = workflowSettings(state).profitConfirmers || {};
  const ids = new Set([cfg.default, cfg.backup, ...Object.values(cfg.teams || {})].filter(Boolean));
  const legacy = (state.employees || []).find(e => (e.email || '').toLowerCase() === PROFIT_CONFIRM_EMAIL);
  if (!cfg.default && legacy) ids.add(legacy.id);
  return ids.has(emp.id);
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
    if (q.dismissedAt || !EXEMPTING_REASONS.has(q.reasonCode)) continue;
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
  return (t.queries || []).some(q => !q.dismissedAt && EXEMPTING_REASONS.has(q.reasonCode) && !q.replyAt);
}
// A client query — and the freeze of the client commitment date that comes with it — is only ever recorded by the task's owner (or their
// manager), on purpose, with the real date AND time it was sent. A hold alone never opens one, and nothing is stamped at midnight.
// "09:30" on a given New Zealand day → the exact instant (null if that is not a real NZ time).
function nzLocalToIso(day, hhmm) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) || !/^\d{2}:\d{2}$/.test(String(hhmm || ''))) return null;
  const base = Date.parse(day + 'T' + hhmm + ':00Z');
  if (isNaN(base)) return null;
  for (const off of [13, 12]) {
    const c = base - off * 3600000;
    if (nzDay(c) === day && new Date(c).toLocaleTimeString('en-GB', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) === hhmm) return new Date(c).toISOString();
  }
  return null;
}
// Validate what the owner typed for a client query. Returns { error } or { source, sentAt, sentTs }.
function parseQueryInput(body, reasonCode) {
  const source = reasonCode === 'THIRD_PARTY' ? 'manual' : String(body.querySource || '');
  if (reasonCode !== 'THIRD_PARTY' && !['email', 'phone', 'whatsapp', 'in_person'].includes(source)) return { error: 'Say how you asked the client — email, phone, WhatsApp or in person.' };
  const day = String(body.querySentAt || '').slice(0, 10), time = String(body.querySentTime || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !time) return { error: 'Say the date and the time the query was sent — it is never filled in for you.' };
  if (day > todayISO()) return { error: "The query can't be dated in the future." };
  const ts = nzLocalToIso(day, time);
  if (!ts) return { error: 'That is not a valid New Zealand date and time.' };
  if (Date.parse(ts) > Date.now() + 5 * 60000) return { error: "The query can't be timed in the future." };
  return { source, sentAt: day, sentTs: ts };
}
// Every time a task is handed in (sent for review, marked done, resubmitted after a correction, re-opened) is kept with its exact time and the
// dates in force at that moment. The employee's OWN commitment is judged on the FIRST hand-in — a reviewer sending it back, or a later
// resubmission, never turns an on-time submission into a miss.
function recordSubmission(t, byEmp, kind, at) {
  at = at || new Date().toISOString();
  t.submissions = t.submissions || [];
  t.submissions.push({ at, byId: byEmp ? byEmp.id : (t.assignedTo || null), kind, round: t.reworkCount || 0, reviewerId: t.reviewerId || null, internalDue: t.internalDeadline || null, clientDue: t.clientDate || null });
  if (!t.firstSubmittedAt) t.firstSubmittedAt = at;
  return at;
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
  if (t.status === 'on_hold') return 'on_hold';       // on hold, whatever the reason: not counted as missed or at risk
  const today = todayISO();
  if (today <= eff) return 'on-track';
  if (today <= cal.addWorkingDays(eff, 1)) return 'at-risk';
  return 'missed';
}

// Human-readable reason a not-yet-completed task earns no productivity
// credit — used by the Exceptions/Open Work section and the drill-down's
// excluded-task table (spec §6/§13).
const OPEN_STATUS_REASONS = {
  awaiting_acceptance: 'Awaiting acceptance',
  accepted: 'In progress',
  on_hold: 'On hold',
  rework: 'Needs rework',
  window_proposed: 'Window proposed',
};

// ---------------------------------------------------------------------------
// PRODUCTIVITY — historical/V2 split (correction #2). Client report dispatch
// NEVER gates Productivity — Report Sent (reportSentFor, below) is fully
// separate and untouched; its outcome only rides along here informationally
// as stages.sender. Deliberately separate from commitmentOutcome() above:
// that function keeps its existing contract (task-list at-risk/on-track
// badges) untouched.
//
// A task completed before state.productivityV2EffectiveAt (v2At) credits on
// the same "sent for review or marked done" event the app already used,
// full stop — no review outcome or dispatch required (retroactively
// requiring one would be unfair to work done under different expectations).
// On/after v2At, full credit requires a genuinely Clean review, or the task
// being closed with no review at all ("Mark Done" — plenty of work doesn't
// need a second pair of eyes, so that counts without anyone's approval).
//
// Three independently-reported stages (never blended into one verdict):
//   processor — t.completedAt (refreshed by /resubmit on every rework
//     round, so a corrected resubmission is judged on ITS OWN timestamp)
//     vs t.internalDeadline.
//   reviewer  — clean / done / error / pending.
//   sender    — informational only, from reportSentFor; never affects qualifies.
// `reportInfo` is reportSentFor(t), computed once by the caller and passed
// in so this never re-derives Report Sent logic itself (no duplicate rules).
// ---------------------------------------------------------------------------
// An employee "holds reviewer authority" if they manage people (admin/
// superadmin) or have ever been nominated as the reviewer on someone
// else's task — evidence they're genuinely trusted to check others' work,
// not just a role flag. Used only to let a V2-rule "marked done" task
// self-certify without a separate manager authorisation (see below) —
// ordinary staff with no such track record still need it, so the
// self-certification loophole stays closed for everyone else.
function isReviewerCapable(state, employeeId) {
  const emp = findEmployee(state, employeeId);
  if (emp && isAdminRole(emp.accessRole)) return true;
  return state.tasks.some(t => t.reviewerId === employeeId && t.assignedTo !== employeeId);
}
function productivityQualifies(state, t, v2At, reportInfo) {
  const isInternal = t.kind === 'internal';
  const submissionMet = (t.completedAt && t.internalDeadline)
    ? nzDay(t.completedAt) <= t.internalDeadline : null;
  const stages = {
    processor: submissionMet == null ? null : (submissionMet ? 'met' : 'missed'),
    reviewer: t.reviewStatus === 'clean' ? 'clean' : t.reviewStatus === 'done' ? 'done'
             : t.reviewStatus === 'error' ? 'error' : (t.status === 'completed' ? 'pending' : null),
    sender: isInternal ? 'sending_not_required'
           : (reportInfo ? (reportInfo.eligible ? reportInfo.outcome : reportInfo.reason) : null),
  };
  const base = { stages };
  const exclude = (reason, extra) => ({
    ...base, qualifies: false, creditedHours: 0, exclusionReason: reason, dataException: false,
    rule: null, qualifyingEventType: null, qualifyingEventAt: null, periodDate: null, ...extra,
  });

  if (t.status !== 'completed') {
    return exclude(OPEN_STATUS_REASONS[t.status] || 'Not yet delivered');
  }

  // Missing/invalid allocated-hours snapshot is a data exception, never a
  // silent zero-hour "qualify" — a genuinely zero-hour task (snapshot === 0,
  // explicitly valid) still qualifies, just credits nothing (zeroHourTask).
  const rawSnapshot = t.productivityAllocatedHoursSnapshot;
  const snapshotNum = Number(rawSnapshot);
  const snapshotValid = rawSnapshot !== null && rawSnapshot !== undefined && Number.isFinite(snapshotNum) && snapshotNum >= 0;
  if (!snapshotValid) return exclude('Missing allocated-hours snapshot', { dataException: true });
  // If this task was on hold through one or more manual month-closes (see
  // closeMonthOnHoldCredits), those already paid out actual-hours credit to
  // earlier periods — subtract that back out here so the task's completion
  // period doesn't ALSO get its full original estimate, which would double
  // -count the same work. What's left over is what completion actually
  // still earns.
  const bankedHours = (t.monthCloseCredits || []).reduce((s, c) => s + (Number(c.hours) || 0), 0);
  const creditHours = Math.max(0, Math.round((snapshotNum - bankedHours) * 100) / 100);

  const completedMs = Date.parse(t.completedAt);
  const cutoffMs = Date.parse(v2At);
  if (!Number.isFinite(completedMs)) return exclude('Invalid completion timestamp', { dataException: true });

  const qualify = (rule, eventType, eventAt) => ({
    ...base, qualifies: true, creditedHours: creditHours, exclusionReason: null, dataException: false,
    rule, qualifyingEventType: eventType, qualifyingEventAt: eventAt, periodDate: eventAt,
    zeroHourTask: creditHours === 0,
  });

  if (completedMs < cutoffMs) {
    // Historical rule — unconditional on review outcome or dispatch.
    const type = t.reviewStatus === 'done' ? 'marked_done' : 'sent_for_review';
    return qualify('historical', type, t.completedAt);
  }

  // V2 rule — genuinely Clean, closed with no review needed (see below), or
  // the report actually reaching the client (real-world proof of
  // completion, independent of whether it was formally reviewed first).
  if (t.reviewStatus === 'error') return exclude('Review contains errors');
  // V3: reviewed clean is THE event; Report Sent neither unlocks nor moves it.
  if (prodRules.v3Applies(completedMs, state.productivityV3EffectiveAt || PRODUCTIVITY_V3_EFFECTIVE_AT_DEFAULT) && t.reviewStatus === 'clean') {
    return qualify('v3', 'clean_review', t.reviewedAt);
  }
  if (t.sentToClient === true) return qualify('v2', 'report_dispatched', t.sentToClientAt);
  if (t.reviewStatus === 'clean') return qualify('v2', 'clean_review', t.reviewedAt);
  if (t.reviewStatus === 'done') {
    // Closed with no review: counts, no manager approval required. A task
    // that was already authorised under the old rule keeps the AUTHORISATION
    // timestamp as its period (so already-reported periods don't move);
    // everything else counts on the day it was closed.
    if (t.noReviewAuthorizedAt) return qualify('v2', 'no_review_authorized', t.noReviewAuthorizedAt);
    if (isReviewerCapable(state, t.assignedTo)) return qualify('v2', 'self_certified_reviewer', t.completedAt);
    return qualify('v2', 'no_review_needed', t.completedAt);
  }
  return exclude('Review pending'); // sent for review, not yet actioned (covers rework-resubmitted-not-yet-reviewed too)
}
// The date a completed task counts against for reporting-period purposes —
// the day its qualifying event actually happened (see qualifyingEventAt
// above), not the day it was marked complete. Excluded/incomplete tasks
// still need a bucket for display purposes, so fall back to completedAt.
function productivityPeriodDate(state, t, v2At, reportInfo) {
  const r = productivityQualifies(state, t, v2At, reportInfo);
  return r.periodDate || t.completedAt;
}
// Report Sent scoring — 5 points per eligible client report, scored against
// the same population as Productivity (the assignee), not the report-sender.
// Completely independent of productivityQualifies — dispatch never gates
// Productivity, and this never reads the V2 cutoff.
function reportSentFor(t) {
  if (t.kind === 'internal' || t.status !== 'completed' || !['clean', 'done'].includes(t.reviewStatus)) return null; // not eligible to be scored at all
  if (!t.clientDate) return { eligible: false, reason: 'no_external_date' };
  if (t.reportDeliveryStatus === 'sending_not_required') return { eligible: false, reason: 'sending_not_required' };
  if (!t.sentToClient || !t.sentToClientAt) return { eligible: true, points: 0, outcome: 'not_sent' };
  const onTime = nzDay(t.sentToClientAt) <= effectiveClientDate(t);
  return { eligible: true, points: onTime ? 5 : 0, outcome: onTime ? 'sent_on_time' : 'sent_late' };
}

function taskForClient(t) {
  // The hold screenshot can be a megabyte of base64 — never ship it in the
  // task list (fetched every few seconds by every open tab). It's pulled on
  // demand via /api/tasks/:id/hold-screenshot when someone opens the detail.
  // Same story for a review's error screenshot (/review-screenshot).
  const { holdScreenshot, reviewScreenshot, holdScreenshotFile, reviewScreenshotFile, ...rest } = t;
  return {
    ...rest,
    hasHoldScreenshot: !!(holdScreenshot || holdScreenshotFile),
    hasReviewScreenshot: !!(reviewScreenshot || reviewScreenshotFile),
    displayedLogged: liveElapsedHours(t),
    reworkElapsedHours: reworkElapsedHours(t),
    // query-aware commitment, computed server-side so the UI never re-derives it
    queryShiftDays: taskShiftDays(t),
    effectiveClientDate: effectiveClientDate(t),
    effectiveInternalDate: (t.internalDeadline && taskShiftDays(t) > 0) ? cal.addWorkingDays(t.internalDeadline, taskShiftDays(t)) : (t.internalDeadline || null),
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
// — productive hours per working day. A task consumes that capacity across
// as many working days as it needs, and the commitment date follows:
// internal due date, then + 3 working days for the firm's do-review-send
// buffer.
//
// This used to be auto-estimated per person from their own delivery history
// (median productive day over the last 8 weeks). Dropped in favor of a flat
// firm-wide default — even measured off real post-go-live data, a person's
// early median skewed low on days they were mostly working something that
// hadn't shipped yet (only *completed*-task hours count toward a day), which
// made the auto figure read as broken rather than accurate. A flat number
// everyone understands beats a measured one nobody trusts.
// ---------------------------------------------------------------------------
// Productivity rebuild: the firm's working day is 8h, with 30 min reserved
// for meetings and 30 min as a general operational buffer — 7h of
// productivity capacity. Fixed, not measured (see the note above this block
// on why a flat number beats an auto-estimated one).
const CAP_SEED = 7.0;
function capacityOf(emp) {
  return CAP_SEED;
}

// ---------------------------------------------------------------------------
// CAPACITY FROM APPROVED ADJUSTMENTS ONLY. A person's capacity for one day
// is their base productive hours, scaled only by an APPROVED leave/workshop
// request or a non-working day: a full day is the base, an approved half-day
// is half, an approved custom-hours request deducts exactly that many hours,
// an approved leave/workshop day or a non-working day is zero. Everything
// downstream — the planner, workload, the productivity denominator — sums
// dayCapacity() across the range instead of assuming a flat full day.
//
// Deliberately NEVER derived from Punch In/Punch Out or any other attendance
// clock reading — the productivity spec explicitly forbids it. Absence is
// never inferred from a missing punch either: an unrecorded day is a normal
// full-capacity day unless there's an approved leave request covering it.
// ---------------------------------------------------------------------------
// WORKSHOP — a Saturday training/workshop day: approved the same way as any
// other leave (same audit trail), but conceptually different (it's firm
// work, just not productivity-capacity work) — kept as its own type rather
// than folded into OTHER so it reports separately. See dayCapacity() below.
const LEAVE_TYPES = ['ANNUAL', 'SICK', 'UNPAID', 'WORKSHOP', 'OTHER'];
function baseHoursOf(emp) {
  const b = Number(emp && emp.baseHoursPerDay);
  return b > 0 ? b : capacityOf(emp);
}
function approvedLeaveOn(state, empId, dateISO) {
  return (state.leaveRequests || []).find(l => l.employeeId === empId
    && l.status === 'approved' && dateISO >= l.from && dateISO <= l.to) || null;
}
// Firm-wide Superadmin-managed Workshop Saturdays (state.capacityCalendarAdjustments)
// — deliberately separate from personal leave and from state.holidays[]:
// a holiday makes calendar.js's isWorkingDay() false (removed from the
// working-day COUNT itself), but a workshop Saturday must stay a counted
// working day while contributing zero capacity, so it can't reuse either
// existing mechanism. See /api/capacity-calendar below.
function isFirmWorkshopDay(state, dateISO) {
  return (state.capacityCalendarAdjustments || []).some(a => a.active && a.type === 'WORKSHOP' && a.date === dateISO);
}
// A dated pre-reading workshop (see /api/workshops) decides its own day person
// by person: someone who confirmed the reading attends the workshop, so that
// day isn't a working day for them (zero capacity, nothing counted against
// them); everyone else — including anyone who said they haven't read it —
// has a normal, full working day.
function workshopOnDate(state, dateISO) {
  return (state.workshops || []).find(w => w.date === dateISO) || null;
}
// Is this a workshop day FOR THIS PERSON? With a dated pre-reading workshop it
// depends on whether they confirmed the reading; otherwise it's the firm calendar.
function isWorkshopDayFor(state, empId, dateISO) {
  const ws = workshopOnDate(state, dateISO);
  return ws ? !!(ws.reads || {})[empId] : isFirmWorkshopDay(state, dateISO);
}
// PRESENT · HALF · CUSTOM · LEAVE · WORKSHOP · HOLIDAY
function attendanceStatus(state, emp, dateISO) {
  if (!cal.isWorkingDay(dateISO)) return 'HOLIDAY';
  // Firm-wide workshop takes precedence over personal leave so a day is
  // only ever deducted once, however the two happen to overlap.
  if (isWorkshopDayFor(state, emp.id, dateISO)) return 'WORKSHOP';
  const leave = approvedLeaveOn(state, emp.id, dateISO);
  if (leave) {
    if (leave.type === 'WORKSHOP') return 'WORKSHOP';
    if (leave.hours > 0) return 'CUSTOM';
    return leave.halfDay ? 'HALF' : 'LEAVE';
  }
  return 'PRESENT';
}
function dayCapacity(state, emp, dateISO) {
  const base = baseHoursOf(emp);
  const status = attendanceStatus(state, emp, dateISO);
  switch (status) {
    case 'HOLIDAY': case 'LEAVE': case 'WORKSHOP': return 0;
    case 'HALF': return Math.round((base / 2) * 100) / 100;
    case 'CUSTOM': {
      const leave = approvedLeaveOn(state, emp.id, dateISO);
      return Math.round(Math.max(0, base - Number(leave.hours || 0)) * 100) / 100;
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
// Working days in [from, to] that are a workshop day for this person.
function workshopDaysBetween(state, empId, fromISO, toISO) {
  if (!fromISO || !toISO || toISO < fromISO) return 0;
  let n = 0;
  let cur = new Date(fromISO + 'T00:00:00Z');
  const end = new Date(toISO + 'T00:00:00Z').getTime();
  while (cur.getTime() <= end) {
    const iso = cur.toISOString().slice(0, 10);
    if (cal.isWorkingDay(iso) && isWorkshopDayFor(state, empId, iso)) n += 1;
    cur = new Date(cur.getTime() + 86400000);
  }
  return n;
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
      // A firm workshop day takes precedence over personal leave for capacity
      // (see attendanceStatus) — skip it here too, or an overlapping day gets
      // counted against both leaveDays and workshopDays at once, and the
      // capacity card's "N leave − M workshop" breakdown stops summing to
      // the actual capacityHours figure.
      if (cal.isWorkingDay(iso) && !isWorkshopDayFor(state, empId, iso)) { if (l.halfDay) half += 1; else full += 1; }
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
    effectiveCapacity: cap, capacityAuto: false,
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
// Below this, an overage is normal day-to-day slack (someone's plate
// running 20-40 minutes over on a given day is routine) and gets the old
// soft, informational treatment — only a real conflict blocks assignment.
const MEANINGFUL_OVERAGE_HOURS = 1;
// The fuller picture behind an overload check, for the assign form:
// - `impossible` — the due date doesn't leave enough raw capacity for this
//   many hours even with a completely empty schedule. No override makes
//   sense here; the date or the hours has to change.
// - otherwise, if over capacity because of EXISTING work, `conflicts` lists
//   exactly which open tasks are in the way and what their dates would
//   become if the manager pushes them out to make room — shown before they
//   confirm, and applied for real only if they do (see POST /api/tasks
//   pushConflictIds).
function assignImpactPreview(state, emp, hours, byISO) {
  const cap = capacityOf(emp);
  const windowCapacity = capacityHoursBetween(state, emp, todayISO(), byISO);
  const impossible = windowCapacity + 1e-9 < hours;
  const oc0 = overloadCheck(state, emp, hours, byISO);
  // Re-derive `over` at the meaningful-conflict bar — oc0.over (>0.24h) is
  // still exposed for the existing informational overAllocated stamp.
  const oc = { ...oc0, over: oc0.overBy > MEANINGFUL_OVERAGE_HOURS };
  let conflicts = [];
  let pushDays = 0;
  if (!impossible && oc.over) {
    pushDays = Math.max(1, Math.ceil(oc.overBy / cap));
    conflicts = state.tasks
      .filter(t => t.assignedTo === emp.id && !['completed', 'pending_approval'].includes(t.status)
        && t.internalDeadline && t.internalDeadline <= byISO)
      .sort((a, b) => (a.internalDeadline || '').localeCompare(b.internalDeadline || ''))
      .map(t => ({
        id: t.id, name: t.name, clientName: t.clientName,
        currentInternal: t.internalDeadline, newInternal: cal.addWorkingDays(t.internalDeadline, pushDays),
        currentClient: t.clientDate || null, newClient: t.clientDate ? cal.addWorkingDays(t.clientDate, pushDays) : null,
      }));
  }
  return { ...oc, impossible, windowCapacity: Math.round(windowCapacity * 100) / 100, conflicts, pushDays };
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
    sheetLink: null, cashbookLink: null, profitConfirmStatus: null, profitConfirmRequestedAt: null, profitConfirmRequestedBy: null, profitConfirmAt: null, profitConfirmBy: null,
    productivityAllocatedHoursSnapshot: Number(rt.tat) || null, // accepted immediately — snapshot now
    reportDeliveryStatus: null, reportDeliveryChannel: null, reportDeliveryReference: null,
    reportDeliveryWaivedReason: null, reportDeliveryWaivedBy: null, reportDeliveryWaivedAt: null,
    noReviewAuthorizedBy: null, noReviewAuthorizedAt: null, noReviewAuthorizedReason: null,
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
function notify(state, empId, type, text, taskId, opts) {
  if (!empId) return null;
  if (!Array.isArray(state.notifications)) state.notifications = [];
  // opts.noDedupe: for events not tied to a task (e.g. marks) where two
  // different ones in a row must both show, not overwrite each other.
  const dupe = !(opts && opts.noDedupe) && state.notifications.find(n => n.empId === empId && n.type === type && n.taskId === (taskId || null) && !n.seenAt);
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
    rework: 'Task sent back', due: 'Task due', window: 'New date decision', profit_confirm: 'Profit confirmation',
    kudos: 'You got Kudos!', points: 'You got Points!', mark: 'Performance mark', comment: 'New comment', card: 'Monthly card ready', workshop: 'Workshop pre-reading', send_report: 'Report ready to send', system: 'System alert', escalation: 'Decision requested', attention: 'Needs your attention' };
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
// Minutes since midnight, New Zealand time.
function nzMinutesOfDay(ts) {
  const p = new Date(ts).toLocaleTimeString('en-GB', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hour12: false }).split(':');
  return (Number(p[0]) % 24) * 60 + Number(p[1]);
}

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

// A task's "logged" hours accumulate as raw wall-clock time between Start
// and Pause/Complete, with no cap — so a timer left running by accident
// (someone starts it, goes home, and doesn't notice for days) silently
// racks up real production found this at 115h logged on an 8h task,
// because the clock ran unpaused across 8 calendar days including nights
// and a weekend. Auto-pause any timer that's been running continuously
// past this many hours: bank exactly that many (discard whatever ran
// past it — almost certainly not real work) and stop the clock, so a
// forgotten timer can never inflate past a bounded, sane amount.
const RUNAWAY_TIMER_HOURS = 10;
function sweepRunawayTimers(state) {
  const now = Date.now();
  let n = 0;
  state.tasks.forEach(t => {
    if (!t.timerStartedAt) return;
    const elapsedH = (now - new Date(t.timerStartedAt).getTime()) / 3600000;
    if (elapsedH <= RUNAWAY_TIMER_HOURS) return;
    t.logged = (Number(t.logged) || 0) + RUNAWAY_TIMER_HOURS;
    t.timerStartedAt = null;
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}"'s timer had been running for over ${RUNAWAY_TIMER_HOURS}h straight and looked forgotten, so it was auto-paused — ${RUNAWAY_TIMER_HOURS}h banked, the clock stopped. Resume it if you're still working on it.`);
    notify(state, t.assignedTo, 'timer_autopaused', `"${t.name}"'s timer ran for over ${RUNAWAY_TIMER_HOURS}h straight and was auto-paused. Resume it if you're still on it.`, t.id);
    n += 1;
  });
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
    if (emp.accessDisabled) return res.status(403).json({ error: 'account_deactivated', message: 'This account has been deactivated. Please contact HR or an admin.' });
    req.employee = emp;
    const policyAllowed = ['/api/auth/me', '/api/auth/change-password', '/api/policy-compliance'].includes(req.path);
    const policyLock = !policyAllowed && policyCompliance.lockResponse(emp);
    if (policyLock) return res.status(policyLock.status).json(policyLock.body);
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
  if (emp.accessDisabled) return res.status(403).json({ error: 'This account has been deactivated. Please contact HR or an admin.' });
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
  res.json({ token, employee: publicEmployee(emp, isAdminRole(emp.accessRole)) });
});
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ employee: publicEmployee(req.employee, isAdminRole(req.employee.accessRole)) });
});

app.get('/api/policy-compliance', requireAuth, async (req, res) => {
  const state = db.get();
  const employee = findEmployee(state, req.employee.id);
  let reconciled = false;
  if (policyCompliance.isStale(employee)) {
    try {
      const result = await policyCompliance.reconcileEmployee(employee);
      if (result.ok) { db.save(); reconciled = true; }
    } catch (error) { console.error('[policy-compliance] fallback failed:', error && error.message); }
  }
  res.json({ policyCompliance: employee.policyCompliance || { compliant: true, pendingCount: 0, lastSyncedAt: null },
    emergencyAdminAccess: isAdminRole(employee.accessRole), reconciled });
});
// Self-service password change. Used for the mandatory first-login reset
// (mustChangePassword — set when an account is auto-created, e.g. by the
// CRM sync creating a brand-new employee with a temp password), but works
// for anyone changing their own password at any time.
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(String(currentPassword || ''), req.employee.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!isPasswordAcceptable(newPassword)) return res.status(400).json({ error: WEAK_PASSWORD_ERROR });
  const state = db.get();
  const emp = findEmployee(state, req.employee.id);
  emp.passwordHash = bcrypt.hashSync(newPassword, 10);
  emp.mustChangePassword = false;
  db.save();
  res.json({ employee: publicEmployee(emp, isAdminRole(emp.accessRole)) });
});

// ---------------------------------------------------------------------------
// EMPLOYEES
// ---------------------------------------------------------------------------
app.get('/api/employees', requireAuth, (req, res) => {
  const state = db.get();
  const viewerIsAdmin = isAdminRole(req.employee.accessRole);
  res.json({ employees: state.employees.map(e => publicEmployee(e, viewerIsAdmin)) });
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
  res.status(201).json({ employee: publicEmployee(emp, true) });
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
  // Extra teams — a person can be on more than one team at a time. Cleaned: no
  // blanks, duplicates, the primary team or 'Unassigned'; at most 6.
  if (req.body.extraTeams !== undefined) {
    const raw = Array.isArray(req.body.extraTeams) ? req.body.extraTeams : String(req.body.extraTeams || '').split(',');
    emp.extraTeams = cleanExtraTeams(raw, emp.team);
  } else if (Array.isArray(emp.extraTeams)) {
    emp.extraTeams = cleanExtraTeams(emp.extraTeams, emp.team); // the primary team may have changed
  }

  // calls-into-tasks (Phase 1) — additive access fields, all optional. The
  // existing accessRole / managesIds above are untouched; these sit
  // alongside them and drive the new Admin space / membership dashboards.
  if (Array.isArray(req.body.memberships)) {
    emp.memberships = req.body.memberships
      .filter(m => m && typeof m.team === 'string' && m.team.trim())
      .map(m => ({ team: m.team.trim(), level: m.level === 'admin' ? 'admin' : 'member' }));
  }
  if (typeof req.body.isFounder === 'boolean') emp.isFounder = req.body.isFounder;
  if (typeof req.body.isHr === 'boolean' && emp.email !== 'hr@elitetaxation.co.nz') emp.isHr = req.body.isHr;
  // Read-only firm-wide Commitment Dashboard observer — no other powers.
  if (typeof req.body.dashObserver === 'boolean') emp.dashObserver = req.body.dashObserver;
  // The new Today dashboard (master-detail, combined Manager + Review actions). Off unless switched on for that person.
  if (typeof req.body.dashboardV2 === 'boolean') emp.dashboardV2 = req.body.dashboardV2;
  // Time-boxed self-edit grant (estimate, due date & client date on their own tasks).
  if (req.body.selfEditUntil !== undefined) {
    const v = req.body.selfEditUntil;
    emp.selfEditUntil = (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && Date.parse(v) > Date.now())
      ? new Date(v).toISOString() : null;
  }
  // "Mark done" delegate — lets one other employee close THIS person's own
  // tasks (no-review /done only, not review/reassign/etc) when they're too
  // busy to do it themselves. Standing grant, not time-boxed; an admin
  // revokes it the same way by clearing the field.
  if (req.body.doneDelegateId !== undefined) {
    const v = req.body.doneDelegateId;
    emp.doneDelegateId = (v && v !== emp.id && state.employees.some(x => x.id === v)) ? String(v) : null;
  }
  if (req.body.slackUserId !== undefined) emp.slackUserId = req.body.slackUserId ? String(req.body.slackUserId).trim() : null;
  if (req.body.aircallAgentId !== undefined) emp.aircallAgentId = req.body.aircallAgentId ? String(req.body.aircallAgentId).trim() : null;
  // gmailAddresses — an array: one employee can own more than one mailbox
  // (e.g. Khushi runs both Rideshare and Property).
  if (req.body.gmailAddresses !== undefined) {
    const arr = Array.isArray(req.body.gmailAddresses) ? req.body.gmailAddresses : [];
    emp.gmailAddresses = arr.map(a => String(a || '').trim().toLowerCase()).filter(Boolean);
  }
  // WhatsApp (Interakt) dashboard — grantable to any specific employee,
  // independent of accessRole (a superadmin always has it regardless).
  if (typeof req.body.whatsappAccess === 'boolean') emp.whatsappAccess = req.body.whatsappAccess;

  // CRM User ID — the permanent cross-system identity link to ET-CRM (a
  // Supabase-generated UUID, visible there under Settings > User Management).
  // Manual only: an admin pastes it in on THIS employee's own Manage Access
  // screen, having already confirmed by eye that the email here matches the
  // CRM record — never matched or assigned automatically by name. Doesn't
  // touch auth, roles, or the employee's own id; it's purely a reference.
  if (req.body.crmUserId !== undefined) {
    const raw = req.body.crmUserId;
    if (raw === null || raw === '') {
      if (emp.crmUserId) {
        emp.crmUserIdHistory = emp.crmUserIdHistory || [];
        emp.crmUserIdHistory.push({ at: new Date().toISOString(), by: req.employee.name, from: emp.crmUserId, to: null });
        logEvent(state, emp.id, `CRM User ID unlinked by <b>${escHtml(req.employee.name)}</b>.`);
        emp.crmUserId = null;
      }
    } else {
      const uuid = String(raw).trim().toLowerCase();
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      if (!UUID_RE.test(uuid)) return res.status(400).json({ error: "That doesn't look like a valid CRM User ID — it should be a UUID, e.g. 12345678-1234-1234-1234-123456789abc." });
      const clash = state.employees.find(x => x.id !== emp.id && x.crmUserId === uuid);
      if (clash) return res.status(409).json({ error: `That CRM User ID is already linked to ${clash.name}.` });
      if (emp.crmUserId !== uuid) {
        emp.crmUserIdHistory = emp.crmUserIdHistory || [];
        emp.crmUserIdHistory.push({ at: new Date().toISOString(), by: req.employee.name, from: emp.crmUserId || null, to: uuid });
        logEvent(state, emp.id, `CRM User ID linked by <b>${escHtml(req.employee.name)}</b>.`);
        emp.crmUserId = uuid;
      }
    }
  }

  db.save();
  res.json({ employee: publicEmployee(emp, true) });
});

// ---------------------------------------------------------------------------
// MY TEAM — a manager adds / removes their own team members. "My team" is
// simply the people in my managesIds. A person added by two managers is on
// two teams (they report to both). An admin can only touch their own list;
// a superadmin can do it for anyone via /api/employees/:id.
// ---------------------------------------------------------------------------
function cleanExtraTeams(list, primary) {
  const p = typeof primary === 'string' ? primary.trim() : '';
  const out = [];
  (list || []).forEach(t => {
    const x = typeof t === 'string' ? t.trim().slice(0, 60) : '';
    if (x && x !== 'Unassigned' && x !== p && !out.includes(x)) out.push(x);
  });
  return out.slice(0, 6);
}
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
  let mode = null;
  const cur = typeof target.team === 'string' ? target.team.trim() : '';
  if (op === 'add') {
    if (teamsOf(target).includes(myTeam)) {
      mode = 'already';
    } else if (!cur || cur === 'Unassigned') {
      target.team = myTeam; mode = 'moved'; // nobody else has them: they simply join
      logEvent(state, targetId, `Moved to the <b>${escHtml(myTeam)}</b> team by <b>${escHtml(me.name)}</b>.`);
    } else {
      // They already belong to another team — they STAY there and are on this one too.
      target.extraTeams = cleanExtraTeams([...(target.extraTeams || []), myTeam], target.team);
      mode = 'also';
      logEvent(state, targetId, `Also added to the <b>${escHtml(myTeam)}</b> team by <b>${escHtml(me.name)}</b> (they stay on <b>${escHtml(cur)}</b>).`);
    }
  } else {
    const extras = Array.isArray(target.extraTeams) ? target.extraTeams : [];
    if (cur === myTeam) {
      // leaving their primary team: another team they are on becomes primary, else Unassigned
      if (extras.length) { target.team = extras[0]; target.extraTeams = cleanExtraTeams(extras.slice(1), extras[0]); }
      else target.team = 'Unassigned';
      mode = 'removed';
    } else if (extras.includes(myTeam)) {
      target.extraTeams = extras.filter(t => t !== myTeam); mode = 'removed';
    } else mode = 'not-on-team';
    if (mode === 'removed') logEvent(state, targetId, `Removed from the <b>${escHtml(myTeam)}</b> team by <b>${escHtml(me.name)}</b>.`);
  }
  // Keep the legacy managesIds field roughly in step for anything still reading it.
  me.managesIds = teamRoster(state, me).filter(e => e.id !== me.id).map(e => e.id);
  db.save();
  res.json({ mode, alsoOn: teamsOf(target).filter(t => t !== myTeam), team: teamRoster(state, me).filter(e => e.id !== me.id).map(publicEmployee) });
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

// IA Phase 6 — canonical Department -> Service taxonomy. Separate from
// /api/teams: `team` stays the free-text field the rest of the app already
// keys off; department/service are the new controlled categories tasks can
// optionally carry alongside it (see POST /api/tasks below). "Other" is
// always implicitly available client-side and never appears in this list.
app.get('/api/taxonomy', requireAuth, (req, res) => {
  res.json({ departments: db.get().taxonomy.departments });
});
app.put('/api/taxonomy', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const input = (req.body || {}).departments;
  if (!Array.isArray(input) || !input.length) return res.status(400).json({ error: 'At least one department is required.' });
  const seenDept = new Set();
  const departments = [];
  for (const d of input) {
    const name = String((d || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Every department needs a name.' });
    if (name.toLowerCase() === 'other') return res.status(400).json({ error: '"Other" is reserved — it\'s always available automatically.' });
    const key = name.toLowerCase();
    if (seenDept.has(key)) return res.status(409).json({ error: `Duplicate department: "${name}".` });
    seenDept.add(key);
    const seenSvc = new Set();
    const services = [];
    for (const raw of (Array.isArray(d.services) ? d.services : [])) {
      const svc = String(raw || '').trim();
      if (!svc) continue;
      const svcKey = svc.toLowerCase();
      if (seenSvc.has(svcKey)) return res.status(409).json({ error: `Duplicate service "${svc}" under "${name}".` });
      seenSvc.add(svcKey);
      services.push(svc);
    }
    departments.push({ name, services });
  }
  state.taxonomy = { departments };
  db.save();
  res.json({ departments });
});
// Scans task names/scopes for what looks like a phone number or email —
// read-only, changes nothing. The point is a list a superadmin can review
// and decide what (if anything) to redact; see POST /api/tasks/:id/correct-
// name for the one place a title is ever actually edited, and that still
// takes a human doing it deliberately, never this endpoint.
app.get('/api/admin/pii-report', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const flagged = (state.tasks || []).filter(t => !t.deletedAt).map(t => {
    const hay = `${t.name || ''} ${t.scope || ''}`;
    const hasEmail = db.PII_EMAIL_RE.test(hay);
    const hasPhone = db.PII_PHONE_RE.test(hay);
    if (!hasEmail && !hasPhone) return null;
    return {
      id: t.id, name: t.name, scope: t.scope, clientName: t.clientName,
      assignedTo: t.assignedTo, status: t.status,
      matched: [hasEmail && 'email', hasPhone && 'phone'].filter(Boolean),
    };
  }).filter(Boolean);
  res.json({ total: (state.tasks || []).length, flaggedCount: flagged.length, flagged });
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

// HR policy compliance (ET-CRM → here). Same secret + real statuses as the other
// ET-CRM webhooks: 401 bad secret · 400 invalid · 202 person not linked (queued
// for an admin) · 200 applied. Only the compliance STATE is stored — never the
// policy documents. Normal employees with a pending policy are blocked from
// work (423); admins/superadmins keep emergency access (see policy-compliance.js).
app.post('/webhooks/crm-policy-compliance', (req, res) => {
  const configuredSecret = process.env.CRM_WEBHOOK_SECRET;
  if (!configuredSecret) return res.status(503).json({ error: 'CRM policy compliance sync is not configured.' });
  const state = db.get();
  if (!policyCompliance.secretsEqual(req.headers['x-crm-webhook-secret'], configuredSecret)) {
    crmSync.record(state, 'policy', '—', 'error', 'rejected: bad secret', null, null); db.save();
    return res.status(401).json({ error: 'Invalid CRM webhook credentials.' });
  }
  const keys = Object.keys(req.body && typeof req.body === 'object' ? req.body : {});
  const validated = policyCompliance.validatePayload(req.body);
  if (!validated.ok) {
    crmSync.record(state, 'policy', '—', 'invalid', validated.error, null, keys); db.save();
    return res.status(400).json({ error: validated.error });
  }
  const result = policyCompliance.applyCompliance(state, validated, new Date().toISOString(), req.body.policy || {});
  if (!result.ok) {
    crmSync.noteUnlinked(state, 'policy', { crmUserId: validated.crmUserId, email: validated.email }, null);
    crmSync.record(state, 'policy', 'UPDATE', 'unlinked', 'CRM user ' + validated.crmUserId + ' is not linked to an employee (or the work email is ambiguous)', validated.crmUserId, keys); db.save();
    return res.status(202).json({ ok: false, skipped: true, outcome: 'unlinked', error: result.error });
  }
  crmSync.record(state, 'policy', 'UPDATE', 'updated', result.employee.id + ': ' + (validated.compliant ? 'compliant' : validated.pendingCount + ' pending') + (result.linkedByEmail ? ' (linked by work email)' : ''), validated.crmUserId, keys);
  db.save();
  res.json({ ok: true, employee_id: result.employee.id, linked_by_email: result.linkedByEmail,
    compliant: result.employee.policyCompliance.compliant, pending_count: result.employee.policyCompliance.pendingCount });
});

// ---------------------------------------------------------------------------
// Admin → CRM connection (superadmin). Health per area, the client rule, what is
// waiting to be linked, and the reconciliation actions. Safe metadata only:
// field NAMES from ET-CRM payloads, never their values.
// ---------------------------------------------------------------------------
function crmSection(state, kinds, extra) {
  const counts = (state.crmSync && state.crmSync.counts) || {};
  const out = { created: 0, updated: 0, skipped: 0, errors: 0, conflicts: 0, ambiguous: 0, unlinkedEvents: 0, lastSuccess: null, lastFailure: null, lastEvent: null };
  kinds.forEach(k => {
    const c = counts[k]; if (!c) return;
    out.created += c.created || 0; out.updated += (c.updated || 0) + (c.ok || 0); out.skipped += c.skipped || 0;
    out.errors += (c.error || 0) + (c.invalid || 0); out.conflicts += c.conflict || 0; out.ambiguous += c.ambiguous || 0; out.unlinkedEvents += c.unlinked || 0;
    if (c.lastOk && (!out.lastSuccess || c.lastOk > out.lastSuccess)) out.lastSuccess = c.lastOk;
    if (c.lastFail && (!out.lastFailure || c.lastFail.at > out.lastFailure.at)) out.lastFailure = c.lastFail;
    if (c.last && (!out.lastEvent || c.last.at > out.lastEvent.at)) out.lastEvent = c.last;
  });
  return { ...out, ...(extra || {}) };
}
app.get('/api/admin/crm-sync', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const sync = state.crmSync || { events: [], counts: {} };
  // Behind Railway's proxy req.protocol is "http"; the public address is https.
  const host = req.get('host') || '';
  const proto = /^(localhost|127\.|\[::1\])/.test(host) ? req.protocol : 'https';
  const base = (process.env.APP_BASE_URL || (proto + '://' + host)).replace(/\/$/, '');
  const emps = state.employees || [];
  const clients = state.clients || [];
  const secret = !!process.env.CRM_WEBHOOK_SECRET, apiKey = !!process.env.CRM_API_KEY;
  const waiting = kind => Object.values(sync.unlinked || {}).reduce((n, e) => n + ((e.pending || []).filter(p => p.kind === kind).length), 0);
  res.json({
    configured: { webhookSecret: secret, apiKey },
    endpoints: ['user', 'customer', 'attendance', 'leave', 'policy-compliance'].map(k => ({ kind: k, url: base + '/webhooks/crm-' + k })),
    sections: {
      employees: crmSection(state, ['user'], { configured: secret, unlinked: emps.filter(e => !e.crmUserId).length, linked: emps.filter(e => e.crmUserId).length, total: emps.length, disabledByCrm: emps.filter(e => e.accessDisabled && e.accessDisabled.by === 'crm').length }),
      customers: crmSection(state, ['customer', 'pull'], { configured: secret, linkBackConfigured: apiKey, unlinked: clients.filter(c => !c.crmContactId).length, linked: clients.filter(c => c.crmContactId).length, total: clients.length, linkBack: crmSection(state, ['linkback']) }),
      attendance: crmSection(state, ['attendance'], { configured: secret, unlinked: waiting('attendance') }),
      leave: crmSection(state, ['leave'], { configured: secret, unlinked: waiting('leave') }),
      policy: crmSection(state, ['policy'], { configured: secret, reconcileConfigured: apiKey, unlinked: emps.filter(e => !e.crmUserId).length, blockedNow: emps.filter(e => e.accessRole === 'employee' && policyCompliance.isBlocked(e)).length }),
    },
    legacyTask: { disabled: true, url: base + '/webhooks/crm-task', refused: ((sync.counts || {}).task || {}).skipped || 0, last: ((sync.counts || {}).task || {}).last || null },
    eligibility: { rule: { ...crmSync.DEFAULT_ELIGIBILITY, ...(sync.eligibility || {}) }, description: crmSync.describeEligibility(sync.eligibility) },
    unlinkedUsers: crmSync.unlinkedList(state),
    employeesToLink: emps.filter(e => !e.crmUserId).map(e => ({ id: e.id, name: e.name, email: e.email })),
    events: sync.events || [],
    pull: sync.pull || null, autoPull: !!sync.autoPull,
    cutover: crmCutoverStatus(state),
    // ---- hardening: link health, staleness, the API picture, who owns what (all read-only) ----
    ownership: crmHealth.OWNERSHIP,
    health: {
      employees: crmHealth.employeeHealth(state),
      customers: crmHealth.customerHealth(state),
      staleness: crmHealth.staleness(state, Date.now()),
      secret: { configured: secret, recentRefused24h: crmHealth.authFailures(state, Date.now(), 86400000) },
      api: { urlConfigured: !!process.env.CRM_API_URL, keyConfigured: apiKey, actions: ['link-task-manager-client', 'get-policy-compliance', 'list-pipeline'] },
      policy: { lastEventAt: (((sync.counts || {}).policy || {}).lastOk) || null, pendingLinked: emps.filter(e => e.crmUserId && e.policyCompliance && !e.policyCompliance.compliant).length,
        blockedNow: emps.filter(e => e.accessRole === 'employee' && policyCompliance.isBlocked(e)).length, lastReconcile: (sync.lastReconcile || {}).policy || null },
      lastReconcile: sync.lastReconcile || {},
    },
  });
});
// One-click CRM connection check — READ-ONLY. It reads our own state, and asks ET-CRM two read actions to see that the
// key works; it never writes our data, never calls link-task-manager-client (that one writes) and never shows a secret.
app.post('/api/admin/crm-sync/check', requireAuth, async (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const probes = { policy: null, pipeline: null };
  if (process.env.CRM_API_KEY && (req.body || {}).probeApi !== false) {
    try {
      const { probeCrmApi } = require('./connector');
      const linked = (state.employees || []).find(e => e.crmUserId);
      if (linked) probes.policy = await probeCrmApi('get-policy-compliance', { crm_user_id: linked.crmUserId });
      probes.pipeline = await probeCrmApi('list-pipeline', {});
    } catch (e) { /* a probe that throws is reported as not run */ }
  }
  res.json(crmHealth.buildCheck(state, { nowMs: Date.now(), secretConfigured: !!process.env.CRM_WEBHOOK_SECRET, apiUrlConfigured: !!process.env.CRM_API_URL, apiKeyConfigured: !!process.env.CRM_API_KEY, probes }));
});
// Customers — preview (changes nothing) or apply. Same rule as the webhook.
app.post('/api/admin/crm-sync/pull-clients', requireAuth, async (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  try {
    const { pullCrmClients } = require('./connector');
    res.json({ result: await pullCrmClients({ apply: !!(req.body && req.body.apply) }) });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});
// Reconcile one area. Idempotent; apply:false previews.
app.post('/api/admin/crm-sync/reconcile', requireAuth, async (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const kind = String((req.body && req.body.kind) || '');
  if (!['employees', 'customers', 'attendance', 'leave', 'policy'].includes(kind)) return res.status(400).json({ error: 'kind must be employees, customers, attendance, leave or policy.' });
  try {
    const { reconcileCrm } = require('./connector');
    const apply = !!(req.body && req.body.apply);
    const result = await reconcileCrm(kind, { apply });
    if (apply) { const sync = db.get().crmSync = db.get().crmSync || { events: [], counts: {} }; sync.lastReconcile = { ...(sync.lastReconcile || {}), [kind === 'employees' ? 'user' : kind]: new Date().toISOString() }; sync.lastReconcile.policy = sync.lastReconcile.policy || null; db.save(); }
    res.json({ result });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});
app.post('/api/admin/crm-sync/settings', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const sync = state.crmSync = state.crmSync || { events: [], counts: {} };
  const b = req.body || {};
  if (b.autoPull !== undefined) sync.autoPull = !!b.autoPull;
  if (b.eligibility && typeof b.eligibility === 'object') {
    sync.eligibility = { ...crmSync.DEFAULT_ELIGIBILITY, ...(sync.eligibility || {}) };
    ['requireAuthoritySigned', 'requirePbqDone'].forEach(k => { if (typeof b.eligibility[k] === 'boolean') sync.eligibility[k] = b.eligibility[k]; });
    logEvent(state, req.employee.id, `Changed the ET-CRM client rule to: <b>${escHtml(crmSync.describeEligibility(sync.eligibility))}</b>.`);
  }
  db.save();
  res.json({ autoPull: !!sync.autoPull, eligibility: { ...crmSync.DEFAULT_ELIGIBILITY, ...(sync.eligibility || {}) }, description: crmSync.describeEligibility(sync.eligibility) });
});
// Link a CRM user that arrived unmatched to an employee, then replay what waited.
app.post('/api/admin/crm-sync/link-user', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const r = crmApply.linkUser(state, String((req.body && req.body.crmUserId) || '').trim(), req.body && req.body.employeeId, req.employee.name);
  if (!r.ok) return res.status(r.http).json({ error: r.error });
  crmSync.record(state, 'user', 'LINK', 'updated', r.employee.id + ' linked by an admin; replayed ' + r.replayed.attendance + ' attendance, ' + r.replayed.leave + ' leave', r.employee.crmUserId, null);
  logEvent(state, req.employee.id, `Linked <b>${escHtml(r.employee.name)}</b> to an ET-CRM user.`);
  db.save();
  res.json({ ok: true, employeeId: r.employee.id, replayed: r.replayed });
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
// Recently-removed tasks and clients, newest first. Any admin/superadmin —
// this used to be requireSuperAdmin while POST /api/tasks/:id/restore
// already let a plain team admin restore their own team's deleted tasks;
// they just had no way to see what was in the trash to find the id. The
// task list below already scopes to the same boundary the restore endpoint
// checks, so widening who can call this doesn't hand out any new capability.
app.get('/api/admin/trash', requireAuth, requireAdmin, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const canSeeTask = t => me.accessRole === 'superadmin' || t.deletedBy === me.id || canManageEmployee(state, me, t.assignedTo);
  // Client restore (POST /api/clients/:id/restore) has always been open to
  // any admin/superadmin regardless of team — the list here matches that
  // existing rule rather than introducing a narrower one of its own.
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
  // A "mark done" delegate (see doneDelegateId below) needs to see the
  // tasks they're covering for — e.g. a founder who's too busy to close
  // their own tasks hands that job to one employee. Read visibility only;
  // the /done endpoint itself is what actually gates the write.
  state.employees.forEach(e => { if (e.doneDelegateId === me.id) scopeIds.add(e.id); });
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
  sweepRunawayTimers(state); // auto-pause a timer left running too long (see RUNAWAY_TIMER_HOURS)
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
  if (!anyEmployeeInFirm(state).some(e => e.id === emp.id) && emp.id !== req.employee.id) {
    return res.status(403).json({ error: "You can't plan work for this person." });
  }
  const hours = Math.max(0.25, parseFloat(req.query.hours) || 3);
  const start = (typeof req.query.start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(req.query.start)) ? req.query.start.slice(0, 10) : null;
  const by = (typeof req.query.by === 'string' && /^\d{4}-\d{2}-\d{2}/.test(req.query.by)) ? req.query.by.slice(0, 10) : null;
  res.json({
    assignee: emp.name,
    ...computeCommitmentDates(state, emp, hours, start),
    ...availabilityOf(state, emp),
    overload: by ? assignImpactPreview(state, emp, hours, by) : null,
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
// An image is either still inline (just uploaded, or not yet moved) or already in the file store.
async function loadScreenshot(inline, fileId) {
  if (inline) return inline;
  if (!fileId) return null;
  const f = await fileStore.get(fileId);
  return f ? 'data:' + f.meta.mime + ';base64,' + f.data.toString('base64') : null;
}
app.get('/api/tasks/:id/hold-screenshot', requireAuth, async (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t || !(t.holdScreenshot || t.holdScreenshotFile)) return res.status(404).json({ error: 'No screenshot.' });
  const allowed = t.assignedTo === req.employee.id ||
    isAdminRole(req.employee.accessRole) && (req.employee.accessRole === 'superadmin' || canManageEmployee(state, req.employee, t.assignedTo));
  if (!allowed) return res.status(403).json({ error: 'Not allowed.' });
  const shot = await loadScreenshot(t.holdScreenshot, t.holdScreenshotFile);
  if (!shot) return res.status(404).json({ error: 'No screenshot.' });
  res.json({ screenshot: shot });
});
// The evidence screenshot a reviewer attached when flagging an error —
// pulled only when the assignee (or a manager over them) opens the detail.
app.get('/api/tasks/:id/review-screenshot', requireAuth, async (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t || !(t.reviewScreenshot || t.reviewScreenshotFile)) return res.status(404).json({ error: 'No screenshot.' });
  if (!canSeeTaskFiles(state, req.employee, t)) return res.status(403).json({ error: 'Not allowed.' });
  const shot = await loadScreenshot(t.reviewScreenshot, t.reviewScreenshotFile);
  if (!shot) return res.status(404).json({ error: 'No screenshot.' });
  res.json({ screenshot: shot });
});

// ---------------------------------------------------------------------------
// FILE ATTACHMENTS — PDFs, images, Excel, Word… (see files.js). The bytes live in their own table,
// never in the state. Upload first (it is private to the uploader), then attach it to a rework;
// from then on the task's people can download it:
//   the assignee, the reviewer, a manager/admin over the assignee, and a superadmin.
// ---------------------------------------------------------------------------
function canSeeTaskFiles(state, me, t) {
  if (!t) return false;
  if (t.assignedTo === me.id || t.reviewedBy === me.id || t.reviewerId === me.id || t.reportSendOwner === me.id) return true;
  if (t.escalation && t.escalation.toId === me.id) return true;
  if (me.accessRole === 'superadmin') return true;
  const po = profitConfirmOwner(state, t); // the profit confirmer needs the files to confirm profit
  if (po && po.id === me.id && t.profitConfirmStatus) return true;
  return isAdminRole(me.accessRole) && canManageEmployee(state, me, t.assignedTo);
}
const fileRef = m => ({ id: m.id, name: m.name, mime: m.mime, size: m.size });
// Files attached in the "Sheet" / "Cashbook" slots, as an alternative to (or as well as) a link. They count as that slot
// being filled for every "needs a Sheet / Cashbook link" rule. Runs BEFORE the handler: it checks that each file is one the
// caller uploaded and ties it to the task; the handler then records the references with applySlotFiles().
async function takeSlotFiles(req, res, next) {
  try {
    const b = req.body || {};
    const sIds = Array.isArray(b.sheetFileIds) ? b.sheetFileIds : [], cIds = Array.isArray(b.cashbookFileIds) ? b.cashbookFileIds : [];
    req.slotFiles = { sheet: [], cashbook: [] };
    if (!sIds.length && !cIds.length) return next();
    const t = findTask(db.get(), req.params.id);
    if (!t) return next();
    const take = async (ids, slot, have) => {
      have = have || [];
      const out = [];
      for (const fid of [...new Set(ids.map(String))]) {
        const m = await fileStore.meta(fid);
        if (!m || m.createdBy !== req.employee.id || (m.taskId && m.taskId !== t.id)) throw new Error('One of the attached files is no longer available — please attach it again.');
        if (have.some(x => x.id === m.id)) continue;
        out.push(fileRef(m));
      }
      if (have.length + out.length > fileStore.MAX_PER_REVIEW) throw new Error(`At most ${fileStore.MAX_PER_REVIEW} files can be attached here — ${have.length} already are.`);
      for (const m of out) await fileStore.attach(m.id, t.id, slot);
      return out;
    };
    req.slotFiles.sheet = await take(sIds, 'sheet', t.sheetFiles);
    req.slotFiles.cashbook = await take(cIds, 'cashbook', t.cashbookFiles);
    next();
  } catch (e) {
    res.status(400).json({ error: (e && e.message) || 'Could not attach the files.' });
  }
}
function applySlotFiles(t, req) {
  const sf = req.slotFiles || {};
  if ((sf.sheet || []).length) t.sheetFiles = [...(t.sheetFiles || []), ...sf.sheet];
  if ((sf.cashbook || []).length) t.cashbookFiles = [...(t.cashbookFiles || []), ...sf.cashbook];
}
// is something in the Sheet or Cashbook slot — a link or a file (counting files the caller is adding right now)?
const hasSheetOrCashbook = (t, req) => !!(t.sheetLink || t.cashbookLink || (t.sheetFiles || []).length || (t.cashbookFiles || []).length
  || ((req && req.slotFiles && ((req.slotFiles.sheet || []).length + (req.slotFiles.cashbook || []).length)) || 0));
app.post('/api/files', requireAuth, express.raw({ type: () => true, limit: '16mb' }), async (req, res) => {
  try {
    let name = String(req.get('x-file-name') || '');
    try { name = decodeURIComponent(name); } catch (e) { /* keep as sent */ }
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    const v = fileStore.validate(name, buf);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const meta = await fileStore.put(buf, { name: v.name, mime: v.mime, createdBy: req.employee.id });
    res.status(201).json({ file: fileRef(meta) });
  } catch (e) {
    console.error('[files] upload failed:', e && e.message);
    res.status(500).json({ error: 'Could not save that file — please try again.' });
  }
});
app.get('/api/files/:id', requireAuth, async (req, res) => {
  try {
    const state = db.get();
    const m = await fileStore.meta(req.params.id);
    if (!m) return res.status(404).json({ error: 'File not found.' });
    const allowed = m.taskId ? canSeeTaskFiles(state, req.employee, findTask(state, m.taskId))
                             : (m.createdBy === req.employee.id || req.employee.accessRole === 'superadmin');
    if (!allowed) return res.status(403).json({ error: 'Not allowed.' });
    const f = await fileStore.get(req.params.id);
    if (!f) return res.status(404).json({ error: 'File not found.' });
    const ascii = m.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.setHeader('Content-Type', m.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(m.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(f.data);
  } catch (e) {
    console.error('[files] download failed:', e && e.message);
    res.status(500).json({ error: 'Could not read that file.' });
  }
});

// The reviewer (or a manager over the assignee, or a superadmin) adds files to a review that was
// ALREADY sent back — no need to redo the review (which would count as another rework round).
app.post('/api/tasks/:id/review-files', requireAuth, async (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if (!(canReviewWorkOf(state, req.employee, t.assignedTo, t) || req.employee.accessRole === 'superadmin')) {
    return res.status(403).json({ error: "Only the reviewer, or a manager over this person, can add files." });
  }
  if (t.reviewStatus !== 'error') return res.status(400).json({ error: 'Files can only be added to a task that was sent back for rework.' });
  const ids = [...new Set(((req.body || {}).attachments || []).map(String))];
  if (!ids.length) return res.status(400).json({ error: 'Choose at least one file.' });
  const existing = t.reviewAttachments || [];
  if (existing.length + ids.length > fileStore.MAX_PER_REVIEW) {
    return res.status(400).json({ error: `A rework can have at most ${fileStore.MAX_PER_REVIEW} files — ${existing.length} already attached.` });
  }
  const metas = [];
  try {
    for (const fid of ids) {
      const m = await fileStore.meta(fid);
      if (!m || m.createdBy !== req.employee.id || (m.taskId && m.taskId !== t.id) || existing.some(x => x.id === m.id)) {
        return res.status(400).json({ error: 'One of the files is no longer available — please attach it again.' });
      }
      metas.push(fileRef(m));
    }
    for (const m of metas) await fileStore.attach(m.id, t.id, 'review');
  } catch (e) {
    console.error('[files] adding to a rework failed:', e && e.message);
    return res.status(500).json({ error: 'Could not attach the files — please try again.' });
  }
  if (t.reviewStatus !== 'error') return res.status(409).json({ error: 'This task changed while you were attaching — reload and try again.' });
  t.reviewAttachments = [...(t.reviewAttachments || []), ...metas.map(m => ({ ...m, eventId: null, uploaderId: req.employee.id, uploaderRole: req.employee.accessRole, uploadedAt: new Date().toISOString(), stage: 'review_return', cycle: t.reworkCount || 0 }))];
  const what = metas.length === 1 ? '1 file' : metas.length + ' files';
  logEvent(state, t.assignedTo, `<b>${escHtml(req.employee.name)}</b> attached ${what} to the rework of "${escHtml(t.name)}".`);
  notify(state, t.assignedTo, 'rework', `${req.employee.name} attached ${what} to "${t.name}" — open it to see and download.`, t.id);
  db.save();
  res.json({ task: taskForClient(t) });
});

// Move any image still stored inline in the state (older screenshots, and new ones as they arrive)
// out into the file store, so the state stays small. Safe by construction: the file is written
// FIRST and the inline copy is only dropped once that succeeded and nothing changed meanwhile;
// anything that can't be moved simply stays where it is. Idempotent — it only touches inline images.
let _externalizing = false;
async function externalizeInlineImages() {
  if (_externalizing) return 0;
  _externalizing = true;
  let moved = 0;
  try {
    const state = db.get();
    const jobs = [];
    for (const t of [...(state.tasks || []), ...(state.deletedTasks || [])]) {
      if (typeof t.holdScreenshot === 'string' && t.holdScreenshot) jobs.push({ o: t, f: 'holdScreenshot', ff: 'holdScreenshotFile', kind: 'hold', taskId: t.id });
      if (typeof t.reviewScreenshot === 'string' && t.reviewScreenshot) jobs.push({ o: t, f: 'reviewScreenshot', ff: 'reviewScreenshotFile', kind: 'review', taskId: t.id });
    }
    for (const m of state.marks || []) {
      if (typeof m.screenshot === 'string' && m.screenshot) jobs.push({ o: m, f: 'screenshot', ff: 'screenshotFile', kind: 'mark', taskId: null });
    }
    for (const j of jobs) {
      const original = j.o[j.f];
      const parsed = fileStore.dataUrlToBuffer(original);
      if (!parsed) continue;
      let meta;
      try { meta = await fileStore.put(parsed.buf, { name: 'screenshot.' + (parsed.mime.split('/')[1] === 'jpeg' ? 'jpg' : parsed.mime.split('/')[1]), mime: parsed.mime, createdBy: null, taskId: j.taskId, kind: j.kind }); }
      catch (e) { console.error('[files] could not move an image out of the state:', e && e.message); continue; }
      if (j.o[j.f] === original) { j.o[j.ff] = meta.id; j.o[j.f] = null; moved++; }
      else { await fileStore.remove(meta.id).catch(() => {}); }
    }
    if (moved) { db.save(); console.log('[files] moved ' + moved + ' inline image(s) out of the state into the file store.'); }
  } catch (e) {
    console.error('[files] externalize failed:', e && e.message);
  } finally { _externalizing = false; }
  return moved;
}

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
  const { mode, name, scope, assignedTo, clientId, clientDate, tat, points, team, internalRef, department, departmentOther, service } = req.body || {};
  let { internalDeadline } = req.body || {};
  // The new form says Client Task / Admin Task (taskKind); older callers still send kind. "Admin" is the same as the stored "internal".
  const body0 = req.body || {};
  const kind = body0.taskKind === 'admin' ? 'internal' : body0.taskKind === 'client' ? 'client' : body0.kind;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Task name is required.' });
  // Optional, controlled department + service (IA Phase 6) — free-text
  // `team` above is untouched either way. "Other" always requires a
  // one-line reason. Service is only checked against the chosen
  // department's own list — picking a department is not required to name
  // a service (a department-less "Other" task can still note a service).
  let deptName = null, deptOtherNote = null, svcName = null;
  if (department !== undefined && department !== null && department !== '') {
    const depts = (state.taxonomy && state.taxonomy.departments) || [];
    const knownDepts = depts.map(d => d.name);
    if (department === 'Other') {
      const note = String(departmentOther || '').trim();
      if (!note) return res.status(400).json({ error: 'Say why this is "Other" before saving.' });
      deptName = 'Other'; deptOtherNote = note;
    } else if (knownDepts.includes(department)) {
      deptName = department;
      if (service) {
        const dept = depts.find(d => d.name === department);
        if (!dept.services.includes(service)) return res.status(400).json({ error: 'Pick a real service under that department.' });
        svcName = service;
      }
    } else {
      return res.status(400).json({ error: 'Pick a real department, or "Other" with a reason.' });
    }
  }
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
    const allowed = anyEmployeeInFirm(state).some(e => e.id === assignee);
    if (!allowed) return res.status(403).json({ error: "You're not authorized to assign work to this person." });
  }
  // Every task — client or internal — needs an estimated time (hours) and a
  // due date. Those two drive planning, the dashboard, and every hours
  // figure; nothing is auto-planned any more.
  const numTat = parseFloat(tat);
  if (!(numTat > 0)) return res.status(400).json({ error: 'A task needs an estimated time in hours.' });
  if (!internalDeadline) return res.status(400).json({ error: 'A task needs a due date.' });
  if (numTat > 100) return res.status(400).json({ error: "That's more than 100 hours — split it into smaller tasks." });
  if (/^\d{4}-\d{2}-\d{2}/.test(String(internalDeadline)) && String(internalDeadline).slice(0, 10) < todayISO()) {
    return res.status(400).json({ error: "The due date can't be in the past — pick today or a later day." });
  }

  // Two capacity checks for a team assignment:
  //  - impossible: the due date itself doesn't leave enough raw capacity for
  //    this many hours, even with a completely empty schedule. Hard block —
  //    no override, because there's nothing to override; the date or the
  //    hours has to change.
  //  - conflict: there IS enough raw capacity, but existing open work is
  //    eating into it. Blocked unless the assigner explicitly confirms
  //    pushConflicts, in which case the specific tasks in the way get their
  //    dates moved out by the same amount this task overloads the window by
  //    (computed fresh here, never trusted from the client).
  let overAllocated = null;
  if (mode === 'team') {
    const assigneeEmp = findEmployee(state, assignee);
    const impact = assignImpactPreview(state, assigneeEmp, numTat, internalDeadline);
    if (impact.impossible) {
      return res.status(422).json({
        error: `${assigneeEmp.name}'s due date only allows ${impact.windowCapacity}h of capacity — a ${numTat}h task can't fit by ${internalDeadline} no matter what else is on their plate. Push the due date out or cut the hours.`,
        code: 'DUE_DATE_TOO_TIGHT', windowCapacity: impact.windowCapacity, hours: numTat,
      });
    }
    if (impact.over) {
      if (req.body.pushConflicts !== true) {
        return res.status(409).json({
          error: `${assigneeEmp.name} is already booked with ${impact.conflicts.length} task${impact.conflicts.length === 1 ? '' : 's'} through this due date — only ${impact.room}h is free. Confirm to push ${impact.conflicts.length === 1 ? 'it' : 'them'} out by ${impact.pushDays} working day${impact.pushDays === 1 ? '' : 's'} and assign anyway.`,
          code: 'ALREADY_BOOKED', conflicts: impact.conflicts, pushDays: impact.pushDays, overBy: impact.overBy, room: impact.room,
        });
      }
      // Confirmed — actually push the conflicting tasks' dates out.
      impact.conflicts.forEach(c => {
        const ct = findTask(state, c.id);
        if (!ct) return;
        const before = { internal: ct.internalDeadline, client: ct.clientDate };
        ct.internalDeadline = c.newInternal;
        if (ct.clientDate) ct.clientDate = c.newClient;
        ct.dateHistory = ct.dateHistory || [];
        ct.dateHistory.push({
          at: new Date().toISOString(), by: req.employee.name,
          from: before, to: { internal: ct.internalDeadline, client: ct.clientDate },
          note: `Pushed out ${impact.pushDays} working day${impact.pushDays === 1 ? '' : 's'} to make room for a new ${numTat}h task due ${internalDeadline}.`,
        });
        logEvent(state, ct.assignedTo, `"${escHtml(ct.name)}" pushed out to <b>${escHtml(ct.internalDeadline)}</b> by <b>${escHtml(req.employee.name)}</b> — new work took priority for ${escHtml(internalDeadline)}.`);
      });
    }
    if (impact.over) {
      overAllocated = {
        overBy: impact.overBy, dueDate: internalDeadline, roomAtAssign: impact.room,
        at: new Date().toISOString(), byId: req.employee.id, byName: req.employee.name,
        pushedConflicts: impact.conflicts.map(c => c.id),
      };
    }
  }

  // ---- V2 form extras: the reviewer chosen up front, whether review is required, and links typed at creation
  const v2Form = body0.taskKind === 'client' || body0.taskKind === 'admin';
  let assignedReviewerId = null, reviewRequired = null, noReviewAuth = null, reviewerLater = null, priority = null, instructions = null, reportRequired = null, reportSenderId = null, profitRequiredDefault = false;
  if (v2Form) {
    if (body0.reviewerId) {
      const rv = findEmployee(state, body0.reviewerId);
      if (!rv || !isAdminRole(rv.accessRole)) return res.status(400).json({ error: 'The reviewer must be a manager or the founder.' });
      if (rv.id === assignee) return res.status(400).json({ error: 'The reviewer cannot be the person doing the work.' });
      assignedReviewerId = rv.id;
    }
    reviewRequired = isInternal ? body0.reviewRequired === true : body0.reviewRequired !== false;   // client work is reviewed unless a manager says otherwise
    if (!isInternal && body0.reviewRequired === false) {
      if (!isAdminRole(req.employee.accessRole)) return res.status(403).json({ error: 'Only a manager or the founder can waive the review on client work.', code: 'REVIEW_REQUIRED' });
      const why = String(body0.noReviewReason || '').trim();
      if (why.length < 5) return res.status(400).json({ error: 'Say why this client task needs no review — it is kept on the record.', code: 'REVIEW_REASON' });
      noReviewAuth = { by: req.employee.id, at: new Date().toISOString(), reason: why };
    }
    // A task that needs review must name its reviewer now — or say, with a reason, that it will be assigned later. Never silently left blank.
    if (reviewRequired && !assignedReviewerId) {
      if (body0.reviewerLater === true) {
        const why = String(body0.reviewerLaterReason || '').trim();
        if (why.length < 5) return res.status(400).json({ error: 'Say why the reviewer will be assigned later — it is kept on the record.', code: 'REVIEWER_LATER_REASON' });
        reviewerLater = { reason: why.slice(0, 500), by: req.employee.id, at: new Date().toISOString() };
      } else {
        return res.status(400).json({ error: 'Choose the reviewer — or tick "Assign reviewer later" and give a reason.', code: 'REVIEWER_REQUIRED' });
      }
    }
    const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
    if (body0.priority !== undefined && body0.priority !== null && body0.priority !== '') {
      if (!PRIORITIES.includes(String(body0.priority))) return res.status(400).json({ error: 'Priority must be low, normal, high or urgent.' });
      priority = String(body0.priority);
    }
    if (body0.instructions !== undefined && body0.instructions !== null) instructions = String(body0.instructions).trim().slice(0, 4000) || null;
    if (!isInternal) {
      reportRequired = body0.reportRequired !== false;
      if (body0.reportSenderId) {
        const rs = findEmployee(state, body0.reportSenderId);
        if (!rs || !canReceiveNewWork(rs)) return res.status(400).json({ error: 'The report sender must be an active person.' });
        reportSenderId = rs.id;
      }
      profitRequiredDefault = reportRequired && body0.profitRequired === true;
    }
  }
  const linkSheet = checkLink(state, body0.sheetLink, 'Google Sheet link'), linkCash = checkLink(state, body0.cashbookLink, 'Cashbook link');
  if (!linkSheet.ok) return res.status(400).json({ error: linkSheet.error });
  if (!linkCash.ok) return res.status(400).json({ error: linkCash.error });

  // No daily-hours cap and no self-assignment approval — anyone can hand
  // themselves (or someone they manage) work, whatever the day already holds.
  const status = mode === 'team' ? 'awaiting_acceptance' : 'accepted';
  state.taskSeq += 1;
  const task = {
    id: '#' + (100000000000 + state.taskSeq),
    name: String(name).trim(), scope: isInternal ? (scope ? String(scope).trim() : '—') : (scope || '—'),
    kind: isInternal ? 'internal' : 'client',
    team: team ? String(team).trim() : (findEmployee(state, assignee) || {}).team || null,
    department: deptName, departmentOther: deptOtherNote, service: svcName,
    clientId: client ? client.id : (internalClient ? internalClient.id : null),
    clientName: client ? client.name : (internalClient ? internalClient.name : (iref || (isInternal ? 'Internal' : ''))),
    internalRef: iref || null,
    // Client tasks get a commitment date: whatever was passed, or the internal
    // due date + the firm's 3-working-day dispatch buffer.
    clientDate: isInternal ? null
      : (clientDate || (internalDeadline ? cal.addWorkingDays(internalDeadline, DISPATCH_BUFFER_WD) : null)),
    clientDateOverride: !isInternal && !!clientDate,
    internalDeadline: internalDeadline || null,
    // the dates the task STARTED with are kept forever; every later change is a dateHistory row
    originalInternalDeadline: internalDeadline || null,
    originalClientDate: isInternal ? null : (clientDate || (internalDeadline ? cal.addWorkingDays(internalDeadline, DISPATCH_BUFFER_WD) : null)),
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
    sheetLink: null, cashbookLink: null, profitConfirmStatus: null, profitConfirmRequestedAt: null, profitConfirmRequestedBy: null, profitConfirmAt: null, profitConfirmBy: null,
    productivityAllocatedHoursSnapshot: status === 'accepted' ? (parseFloat(tat) || 3) : null,
    reportDeliveryStatus: null, reportDeliveryChannel: null, reportDeliveryReference: null,
    reportDeliveryWaivedReason: null, reportDeliveryWaivedBy: null, reportDeliveryWaivedAt: null,
    noReviewAuthorizedBy: null, noReviewAuthorizedAt: null, noReviewAuthorizedReason: null,
    reworkStartedAt: null, faultType: null, reworkHistory: [], // reworkHistory: [{ round, startedAt, endedAt, durationHours, reviewNote, faultType }]
    holdReasonCode: null, dateHistory: [], tatHistory: [], queries: [], overAllocated,
    // calls-into-tasks (Phase 0): where this task came from. Tasks made in the
    // app are 'manual'; the Slack connector will send 'call' / 'slack' later.
    source: 'manual', sourceRef: null,
  };
  if (v2Form) {
    task.assignedReviewerId = assignedReviewerId; task.reviewRequired = reviewRequired; task.reviewerLater = reviewerLater;
    task.priority = priority; task.instructions = instructions;
    if (!isInternal) { task.reportRequired = reportRequired; task.reportSenderId = reportSenderId; task.profitRequiredDefault = profitRequiredDefault; }
    if (noReviewAuth) { task.noReviewAuthorizedBy = noReviewAuth.by; task.noReviewAuthorizedAt = noReviewAuth.at; task.noReviewAuthorizedReason = noReviewAuth.reason; }
  }
  if (linkSheet.value) task.sheetLink = linkSheet.value;
  if (linkCash.value) task.cashbookLink = linkCash.value;
  recordLinkChange(task, req.employee, { sheet: null, cashbook: null }, 'created');
  state.tasks.unshift(task);
  if (noReviewAuth) logEvent(state, assignee, '<b>' + escHtml(req.employee.name) + '</b> waived the review on "' + escHtml(task.name) + '" — ' + escHtml(noReviewAuth.reason));
  if (mode === 'team') {
    const assigneeEmp = findEmployee(state, assignee);
    logEvent(state, assignee, `New task assigned — <b>${assigneeEmp ? escHtml(assigneeEmp.name) : '—'}</b>, awaiting acceptance.`, {
      client: task.clientName, clientDate: task.clientDate, internalDeadline: task.internalDeadline
    });
    const overNote = task.overAllocated ? ` This is ${task.overAllocated.overBy}h over your capacity for that date — it'll count as extra hours.` : '';
    notify(state, assignee, 'assigned', `${req.employee.name} assigned you "${task.name}" — accept it or propose a new date.${overNote}`, task.id);
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
    const allowed = anyEmployeeInFirm(state).some(e => e.id === assignee);
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
    // Hold record: WHO is responsible for the next step, WHEN to follow up, and exactly which clocks stopped.
    const HOLD_RESP = ['client', 'employee', 'reviewer', 'manager', 'third_party', 'capacity'];
    const respDefault = { CLIENT_QUERY: 'client', CLIENT_DOCS: 'client', THIRD_PARTY: 'third_party', INTERNAL_REVIEW: 'reviewer', CAPACITY: 'manager', BLOCKED_OTHER: 'employee' }[reasonCode];
    const responsibility = body.responsibility ? String(body.responsibility) : respDefault;
    if (!HOLD_RESP.includes(responsibility)) return res.status(400).json({ error: 'Say who is responsible for the next step.' });
    let followUp = null;
    if (body.followUpDate || body.responsibility) {
      followUp = /^\d{4}-\d{2}-\d{2}/.test(String(body.followUpDate || '')) ? String(body.followUpDate).slice(0, 10) : null;
      if (!followUp) return res.status(400).json({ error: 'Pick the date you will follow this up.' });
      if (followUp < todayISO()) return res.status(400).json({ error: "The follow-up date can't be in the past." });
    }
    // A client wait only freezes the commitment date if the owner records the query on purpose (queryConfirmed + real date and time).
    const wantsQuery = EXEMPTING_REASONS.has(reasonCode) && !!t.clientDate && body.queryConfirmed === true;
    const qIn = wantsQuery ? parseQueryInput(body, reasonCode) : null;
    if (qIn && qIn.error) return res.status(400).json({ error: qIn.error });
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
    if (qIn) {
      const q = {
        id: crypto.randomUUID(), taskId: t.id, reasonCode, source: qIn.source,
        raisedBy: req.employee.id, sentAt: qIn.sentAt, sentTs: qIn.sentTs, replyAt: null, replyTs: null, resumedAt: null, resumedTs: null,
        emailThreadId: null, chaseLog: [], note: detail || null,
      };
      t.queries = t.queries || [];
      t.queries.push(q);
      hh.queryId = q.id;
    }
    t.holdResponsibility = responsibility; t.holdFollowUp = followUp;
    hh.responsibility = responsibility; hh.followUp = followUp;
    hh.clocksStopped = { workTimer: true, clientCommitment: !!hh.queryId };   // the work timer always stops; the client's clock only for a client wait
    t.holdHistory.push(hh);
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" put on hold${isMine ? '' : ' by <b>' + escHtml(req.employee.name) + '</b>'} — ${escHtml(meta.label)}${detail ? ': ' + escHtml(detail) : ''}${hh.queryId ? ' · client commitment date paused (query recorded)' : ''}`, { hold: true });
    db.save();
    res.json({ task: taskForClient(t) });
  });

  // Record the client query for a task that is already on hold — the owner (or their manager) does this on purpose, with the real date and time.
  app.post('/api/tasks/:id/query', requireAuth, (req, res) => {
    const state = db.get();
    const t = findTask(state, req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    if (t.assignedTo !== req.employee.id && !canManageEmployee(state, req.employee, t.assignedTo)) return res.status(403).json({ error: 'Only the assignee or a manager over them can record a client query.' });
    if (t.status !== 'on_hold' || !EXEMPTING_REASONS.has(t.holdReasonCode)) return res.status(400).json({ error: 'A client query can only be recorded on a task that is on hold waiting for the client (or a third party).' });
    if (!t.clientDate) return res.status(400).json({ error: 'This task has no client date, so there is nothing to pause.' });
    const last = (t.holdHistory || [])[(t.holdHistory || []).length - 1];
    if (!last) return res.status(400).json({ error: 'No hold found for this task.' });
    if (last.queryId && (t.queries || []).some(q => q.id === last.queryId && !q.dismissedAt)) return res.status(400).json({ error: 'A query is already recorded for this hold.' });
    const qIn = parseQueryInput(req.body || {}, t.holdReasonCode);
    if (qIn.error) return res.status(400).json({ error: qIn.error });
    const q = { id: crypto.randomUUID(), taskId: t.id, reasonCode: t.holdReasonCode, source: qIn.source, raisedBy: req.employee.id, sentAt: qIn.sentAt, sentTs: qIn.sentTs, replyAt: null, replyTs: null, resumedAt: null, resumedTs: null, emailThreadId: null, chaseLog: [], note: String((req.body || {}).note || '').trim().slice(0, 500) || null };
    t.queries = t.queries || []; t.queries.push(q);
    last.queryId = q.id; last.clocksStopped = { ...(last.clocksStopped || {}), clientCommitment: true };
    logEvent(state, t.assignedTo, `<b>${escHtml(req.employee.name)}</b> recorded a client query on "${escHtml(t.name)}" (sent ${escHtml(qIn.sentAt)}) — client commitment date paused.`);
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
    const resumeTs = new Date().toISOString();
    if (last && !last.resumedAt) { last.resumedAt = resumeDay; last.resumedTs = resumeTs; }
    // Mark the query for this hold as resumed — this starts the resume-lag
    // clock that can forfeit part of the freeze (calendar.queryShift).
    if (last && last.queryId) {
      const q = (t.queries || []).find(x => x.id === last.queryId);
      if (q && !q.resumedAt) { q.resumedAt = resumeDay; q.resumedTs = resumeTs; }
    }
    t.heldAt = null; t.holdFollowUp = null; t.holdResponsibility = null;
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
    q.replyAt = replyAt; q.replyTs = replyAt === todayISO() ? new Date().toISOString() : null;
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
      if (typeof body.sentAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(body.sentAt) && body.sentAt.slice(0, 10) <= todayISO()) { q.sentAt = body.sentAt.slice(0, 10); q.sentTs = null; }
      if (body.replyAt === null) { q.replyAt = null; q.replyTs = null; q.resumedAt = null; q.resumedTs = null; }
      else if (typeof body.replyAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(body.replyAt) && body.replyAt >= q.sentAt.slice(0, 10) && body.replyAt.slice(0, 10) <= todayISO()) { q.replyAt = body.replyAt.slice(0, 10); q.replyTs = null; }
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
  // Core logic shared with the Slack "Start Work" quick-action button
  // (connector.js) — one place for the actual state transition, so the two
  // entry points can never drift apart. Returns { error, status } or { task }.
  function resumeTaskCore(state, t, byEmployee, { backdatedHours } = {}) {
    if (t.assignedTo !== byEmployee.id) return { error: 'Only the assigned employee can do this.', status: 403 };
    if (!['accepted', 'rework'].includes(t.status)) return { error: 'Only an accepted task can be started.', status: 400 };
    if (t.timerStartedAt) return { error: 'This task is already running.', status: 400 };
    const first = !t.startedAt;
    // Backdated hours — only meaningful the first time a task is picked up:
    // "I actually started this before today" adds that time as already
    // banked, on top of whatever the live clock accrues from now on. Capped
    // at the agreed hours so a typo can't silently inflate worked time.
    if (first && backdatedHours != null) {
      const bh = Number(backdatedHours);
      if (bh > 0) t.logged += Math.min(bh, Number(t.tat) > 0 ? Number(t.tat) : bh);
    }
    t.timerStartedAt = new Date().toISOString();
    if (first) t.startedAt = t.timerStartedAt;
    pauseOtherActiveTasks(state, t.assignedTo, t.id);
    logEvent(state, t.assignedTo, `${first ? 'Started' : 'Resumed'} "${escHtml(t.name)}".${first && Number(backdatedHours) > 0 ? ` (${Math.min(Number(backdatedHours), Number(t.tat)||Number(backdatedHours)).toFixed(1)}h already logged from before today)` : ''}`);
    db.save();
    return { task: taskForClient(t) };
  }
  app.post('/api/tasks/:id/resume', requireAuth, (req, res) => {
    const state = db.get();
    const t = findTask(state, req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    const result = resumeTaskCore(state, t, req.employee, { backdatedHours: req.body && req.body.backdatedHours });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
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
    // Productivity rebuild — freeze the allocated-hours value Productivity
    // scores against, once, at first acceptance. A later authorised tat
    // change (see /set-dates) is still recorded in tatHistory but never
    // moves this snapshot, so historical productivity can't be rewritten.
    // `|| null` is deliberately not used — tat can be a genuine 0 (e.g. a
    // Slack/call task with no estimate attached), and `0 || null` would
    // wrongly store that as "missing" instead of a real zero-hour snapshot.
    if (t.productivityAllocatedHoursSnapshot == null) {
      const tatNum = Number(t.tat);
      t.productivityAllocatedHoursSnapshot = Number.isFinite(tatNum) ? tatNum : null;
    }
    logEvent(state, t.assignedTo, `Accepted "${escHtml(t.name)}" — now due ${t.internalDeadline || 'as agreed'}.`);
  }
  t.timerStartedAt = null; // not running — Start begins the clock

  db.save();
  res.json({ task: taskForClient(t) });
});


app.post('/api/tasks/:id/complete', requireAuth, takeSlotFiles, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!taskActionGuard(req, res, t, { mustBeAssignee: true })) return;
  if (t.status !== 'accepted') return res.status(400).json({ error: 'Only an accepted task can be marked complete.' });
  const { sheetLink, cashbookLink, directProfitConfirm } = req.body || {};
  // A task created with "Assign reviewer later" cannot be submitted until a manager has assigned one.
  if (t.reviewerLater && !t.assignedReviewerId && (req.body || {}).directProfitConfirm !== true) {
    return res.status(409).json({ error: 'This task has no reviewer yet — ask your manager to assign one before you submit it.', code: 'REVIEWER_MISSING' });
  }
  const reviewerId = (t.reviewerLater ? t.assignedReviewerId : ((req.body || {}).reviewerId || t.assignedReviewerId)) || null;   // the reviewer picked when the task was created is the default
  const direct = directProfitConfirm === true;
  if (direct && !canDirectProfitConfirm(req.employee)) return res.status(403).json({ error: "You can't send a job straight to profit confirmation." });
  if (!direct && !reviewerId) return res.status(400).json({ error: 'Choose who should review this task.' });
  const reviewer = direct ? null : findEmployee(state, reviewerId);
  if (!direct && !reviewer) return res.status(400).json({ error: 'Reviewer not found.' });
  if (!direct && !canReceiveNewWork(reviewer)) return res.status(400).json({ error: 'That person is no longer active — pick someone else to review.' });
  // You can send your work to anyone for review — just not yourself.
  if (!direct && reviewerId === t.assignedTo) return res.status(400).json({ error: "You can't send your own work to yourself for review — pick someone else." });
  const sheetLinkN = checkLink(state, sheetLink, 'Google Sheet link');
  const cashbookLinkN = checkLink(state, cashbookLink, 'Cashbook link');
  if (!sheetLinkN.ok) return res.status(400).json({ error: sheetLinkN.error });
  if (!cashbookLinkN.ok) return res.status(400).json({ error: cashbookLinkN.error });
  if (direct && t.kind === 'internal' && !hasClient(t)) return res.status(400).json({ error: 'Admin Tasks have no client, so there is nothing to profit-confirm.' });
  if (direct && !profitConfirmOwner(state, t)) return res.status(500).json({ error: 'Profit confirmation is not set up — nobody is configured to confirm profit.' });
  if (direct && !(sheetLinkN.value || (sheetLinkN.value === undefined && t.sheetLink) || cashbookLinkN.value || (cashbookLinkN.value === undefined && t.cashbookLink) || hasSheetOrCashbook(t, req))) {
    return res.status(400).json({ error: 'Attach a Google Sheet or Cashbook link, or a file, before sending for profit confirmation.' });
  }
    const elapsed = t.timerStartedAt ? (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000 : 0;
  t.logged += elapsed;
    t.timerStartedAt = null;
  t.status = 'completed';
  t.reviewerId = direct ? null : reviewerId;
  t.completedAt = recordSubmission(t, req.employee, direct ? 'direct_profit' : 'review');
  const linksBefore = snapLinks(t);
  if (sheetLinkN.value !== undefined) t.sheetLink = sheetLinkN.value;
  if (cashbookLinkN.value !== undefined) t.cashbookLink = cashbookLinkN.value;
  recordLinkChange(t, req.employee, linksBefore, 'complete');
  applySlotFiles(t, req);
  giveLinkMarks(state, t, 'processor'); // client work needs both links (internal never does)
  logEvent(state, t.assignedTo, `Marked "${escHtml(t.name)}" complete — ${t.logged.toFixed(2)} hrs actual vs ${t.tat} hrs agreed.`, { points: t.points });
  if (direct) {
    const derr = startDirectProfitConfirm(state, t, req.employee);
    if (derr) return res.status(400).json({ error: derr });
    db.save();
    return res.json({ task: taskForClient(t) });
  }
  logEvent(state, reviewerId, `<b>${escHtml(findEmployee(state, t.assignedTo)?.name || 'Someone')}</b> asked you to review "${escHtml(t.name)}".`);
  notify(state, reviewerId, 'review', `${findEmployee(state, t.assignedTo)?.name || 'Someone'} asked you to review "${t.name}".`, t.id);
  db.save();
  res.json({ task: taskForClient(t) });
});

// Mark a task done WITHOUT the review step — for the many tasks that don't
// need a second person to check them (call / Slack follow-ups, and any
// manual task the assignee decides needs no review). The assignee, an
// admin over them, or their designated "mark done" delegate (doneDelegateId
// — set from Manage Access, for people too busy to close their own tasks)
// can do it. "Mark Complete" + a reviewer is still there for anything that
// should be checked.
app.post('/api/tasks/:id/done', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const isMine = t.assignedTo === req.employee.id;
  const isAdminOver = isAdminRole(req.employee.accessRole) &&
    (req.employee.accessRole === 'superadmin' || canManageEmployee(state, req.employee, t.assignedTo) || !t.assignedTo);
  const assignee = t.assignedTo ? findEmployee(state, t.assignedTo) : null;
  const isDelegate = !!(assignee && assignee.doneDelegateId === req.employee.id);
  if (!isMine && !isAdminOver && !isDelegate) {
    return res.status(403).json({ error: 'Only the assignee or an admin can mark this done.' });
  }
  if (t.status === 'completed') return res.status(400).json({ error: 'Already done.' });
  // Review rule (new-form client tasks): finishing without a review is a manager/founder decision, with a reason, kept on the record.
  if (t.reviewRequired === true && workflow.isClientTask(t) && !t.noReviewAuthorizedAt) {
    const why = String((req.body || {}).noReviewReason || '').trim();
    if (isAdminOver && why.length >= 5) {
      t.noReviewAuthorizedBy = req.employee.id; t.noReviewAuthorizedAt = new Date().toISOString(); t.noReviewAuthorizedReason = why; t.reviewRequired = false;
      logEvent(state, t.assignedTo || req.employee.id, '<b>' + escHtml(req.employee.name) + '</b> waived the review on "' + escHtml(t.name) + '" — ' + escHtml(why));
    } else {
      t.noReviewAttempts = t.noReviewAttempts || [];
      t.noReviewAttempts.push({ at: new Date().toISOString(), by: req.employee.id, byName: req.employee.name, reasonGiven: why || null });
      raiseAlert(state, 'no_review_attempt', t, req.employee.name + ' tried to close client task "' + t.name + '" without a review.', alertRecipients(state, 'no_review_attempt', t, req.employee.id));
      db.save();
      return res.status(403).json({ error: isAdminOver ? 'Client work needs a review. To close it without one, give the reason (at least a few words) — it is kept on the record.' : 'Client work must be reviewed. Send it for review — only a manager or the founder can waive that, with a reason.', code: 'REVIEW_REQUIRED' });
    }
  }
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
  t.completedAt = recordSubmission(t, req.employee, 'done');
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
app.post('/api/tasks/:id/send-for-review', requireAuth, takeSlotFiles, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const isMine = t.assignedTo === req.employee.id;
  const isAdminOver = isAdminRole(req.employee.accessRole) &&
    (req.employee.accessRole === 'superadmin' || canManageEmployee(state, req.employee, t.assignedTo) || !t.assignedTo);
  const isReviewer = t.reviewStatus === 'clean' && (t.reviewedBy === req.employee.id || canReviewWorkOf(state, req.employee, t.assignedTo, t));
  if (!isMine && !isAdminOver && !isReviewer) {
    return res.status(403).json({ error: 'Only the assignee, the reviewer or an admin can send this for review.' });
  }
  if (t.status !== 'completed' || !['done', 'clean'].includes(t.reviewStatus)) {
    return res.status(400).json({ error: 'Only a closed task (marked done, or reviewed clean) can be re-sent for review.' });
  }
  const { reviewerId, sheetLink, cashbookLink, directProfitConfirm } = req.body || {};
  const direct = directProfitConfirm === true;
  if (direct && !canDirectProfitConfirm(req.employee)) return res.status(403).json({ error: "You can't send a job straight to profit confirmation." });
  if (!direct && !reviewerId) return res.status(400).json({ error: 'Choose who should review this task.' });
  const reviewer = direct ? null : findEmployee(state, reviewerId);
  if (!direct && !reviewer) return res.status(400).json({ error: 'Reviewer not found.' });
  if (!direct && !canReceiveNewWork(reviewer)) return res.status(400).json({ error: 'That person is no longer active — pick someone else to review.' });
  if (!direct && reviewerId === t.assignedTo) return res.status(400).json({ error: "You can't send a task to its own owner for review — pick someone else." });
  const sheetLinkN = checkLink(state, sheetLink, 'Google Sheet link');
  const cashbookLinkN = checkLink(state, cashbookLink, 'Cashbook link');
  if (!sheetLinkN.ok) return res.status(400).json({ error: sheetLinkN.error });
  if (!cashbookLinkN.ok) return res.status(400).json({ error: cashbookLinkN.error });
  if (direct && t.kind === 'internal' && !hasClient(t)) return res.status(400).json({ error: 'Admin Tasks have no client, so there is nothing to profit-confirm.' });
  if (direct && !profitConfirmOwner(state, t)) return res.status(500).json({ error: 'Profit confirmation is not set up — nobody is configured to confirm profit.' });
  if (direct && !(sheetLinkN.value || (sheetLinkN.value === undefined && t.sheetLink) || cashbookLinkN.value || (cashbookLinkN.value === undefined && t.cashbookLink) || hasSheetOrCashbook(t, req))) {
    return res.status(400).json({ error: 'Attach a Google Sheet or Cashbook link, or a file, before sending for profit confirmation.' });
  }
  if (sheetLinkN.value !== undefined) t.sheetLink = sheetLinkN.value;
  if (cashbookLinkN.value !== undefined) t.cashbookLink = cashbookLinkN.value;
  applySlotFiles(t, req);
  t.reviewStatus = null;
  t.reviewerId = reviewerId;
  recordSubmission(t, req.employee, 'reopened');
  t.reviewedBy = null; t.reviewedAt = null; t.reviewNote = null;
  t.closedBy = null; t.closedAt = null;
  t.awaitingClientDecision = false;
  // Re-review starts the post-review pipeline over (profit confirmation /
  // report send), so a mistaken close doesn't leave stale decisions behind.
  t.profitConfirmStatus = null; t.profitConfirmRequestedAt = null; t.profitConfirmRequestedBy = null;
  t.profitConfirmAt = null; t.profitConfirmBy = null;
  t.reportSendOwner = null; t.reportReturnedAt = null; t.reportReturnedBy = null;
  t.reviewSkipped = false;
  if (direct) {
    const derr = startDirectProfitConfirm(state, t, req.employee);
    if (derr) return res.status(400).json({ error: derr });
    db.save();
    return res.json({ task: taskForClient(t) });
  }
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
app.post('/api/tasks/:id/review', requireAuth, async (req, res) => {
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
  const { status, note, faultType, reviewHours, screenshot, score, marks, marksReason, attachments } = req.body || {};
  if (!['clean', 'error'].includes(status)) return res.status(400).json({ error: 'Review status must be clean or error.' });
  if (status === 'error' && !['processor', 'sop', 'other'].includes(faultType)) {
    return res.status(400).json({ error: 'Choose the cause: a processor fault, an SOP/manager fault, or other.' });
  }
  if (score != null && (!(Number(score) >= 0) || Number(score) > 100)) {
    return res.status(400).json({ error: 'Score must be between 0 and 100.' });
  }
  // Optional marks for the processor — positive rewards, negative deducts. Works
  // the same on a clean review and on a rework. Checked BEFORE anything changes,
  // so a bad number never leaves a half-recorded review.
  let markPts = 0;
  const assigneeForMarks = findEmployee(state, t.assignedTo);
  if (marks != null && marks !== '' && Number(marks) !== 0) {
    markPts = Math.round(Number(marks));
    if (!Number.isFinite(markPts) || markPts === 0) return res.status(400).json({ error: 'Marks must be a whole number — negative to deduct.' });
    if (Math.abs(markPts) > 10000) return res.status(400).json({ error: 'That is too large — marks are limited to ±10,000 each.' });
    if (!assigneeForMarks) return res.status(400).json({ error: 'This task has no assignee to give marks to.' });
    if (assigneeForMarks.id === req.employee.id) return res.status(400).json({ error: "You can't give marks to yourself." });
  }
  // Files the reviewer attached to a rework (PDF, image, Excel…). Each must be one THEY uploaded and
  // not yet used elsewhere; checked and tied to this task before anything about the review changes.
  let attachMetas = [];
  if (status === 'error' && Array.isArray(attachments) && attachments.length) {
    if (attachments.length > fileStore.MAX_PER_REVIEW) return res.status(400).json({ error: `Attach at most ${fileStore.MAX_PER_REVIEW} files.` });
    try {
      for (const fid of [...new Set(attachments.map(String))]) {
        const m = await fileStore.meta(fid);
        if (!m || m.createdBy !== req.employee.id || (m.taskId && m.taskId !== t.id)) {
          return res.status(400).json({ error: 'One of the attached files is no longer available — please attach it again.' });
        }
        attachMetas.push(fileRef(m));
      }
      for (const m of attachMetas) await fileStore.attach(m.id, t.id, 'review');
    } catch (e) {
      console.error('[files] attaching to review failed:', e && e.message);
      return res.status(500).json({ error: 'Could not attach the files — please try again.' });
    }
    if (t.status !== 'completed' || t.reviewStatus === 'done') return res.status(409).json({ error: 'This task changed while you were reviewing it — reload and try again.' });
  }
  const rh = Number(reviewHours);
  t.reviewStatus = status;
  t.reviewedBy = req.employee.id;
  t.reviewNote = note || null;
  t.reviewedAt = new Date().toISOString();
  // The reviewer's own rating of the work (0-100), separate from the fixed
  // assignment `points` set at task creation — this reflects how the
  // delivered work actually held up, not what was planned for it.
  t.reviewScore = score != null ? Math.round(Number(score)) : null;
  // Optional: how long the review itself took — real work, so it counts
  // toward the reviewer's own hours (see hoursDoneOnDate) and shows on the
  // task alongside the assignee's logged hours.
  t.reviewHours = rh > 0 ? Math.round(rh * 100) / 100 : null;
  // Optional: evidence of the error, so the assignee can see exactly what
  // was flagged rather than just reading a note about it.
  if (status === 'error' && typeof screenshot === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(screenshot) && screenshot.length <= 6_000_000) {
    t.reviewScreenshot = screenshot;
  } else if (status === 'clean') {
    t.reviewScreenshot = null; t.reviewScreenshotFile = null;
  }
  // this round's files (earlier rounds stay on the task's rework history)
  // every round's files are kept (earlier rounds stay visible after a resubmission), each tagged with who / when / which stage
  const tagged = attachMetas.map(m => ({ ...m, eventId: null, uploaderId: req.employee.id, uploaderRole: req.employee.accessRole, uploadedAt: t.reviewedAt, stage: 'review_return', cycle: (t.reworkCount || 0) + 1 }));
  if (status === 'error') t.reviewAttachments = [...(t.reviewAttachments || []), ...tagged];
  else if (!Array.isArray(t.reviewAttachments)) t.reviewAttachments = [];
  if (status === 'error') {
    if (t.reviewScreenshot) t.reviewScreenshotFile = null; // a fresh inline screenshot replaces an older stored one
    t.status = 'awaiting_acceptance';
    t.reworkCount = (t.reworkCount || 0) + 1;
    t.faultType = faultType;
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" sent back for rework — error found. Accept it (or propose a new date) to start fixing it. ${note ? 'Note: ' + escHtml(note) : ''}`);
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
  if (markPts) {
    const why = (String(marksReason || '').trim() || (note ? 'Review: ' + String(note).trim() : 'Review of "' + t.name + '"' + (status === 'error' ? ' — rework needed' : ''))).slice(0, 300);
    addMark(state, req.employee, assigneeForMarks, markPts, why, null, null, t.id);
    t.reviewMarks = markPts;
  } else {
    t.reviewMarks = null;
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
// Attach/edit the Sheet or Cashbook link at any point after review — not
// just at Mark Complete. Same standing as everyone else in the send-to-
// client flow: the reviewer, a manager over the assignee, the report-send
// owner, or the assignee themselves (they're the one who'd actually know
// the link if it was missed the first time).
app.patch('/api/tasks/:id/links', requireAuth, takeSlotFiles, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const allowed = canReviewWorkOf(state, req.employee, t.assignedTo, t) || req.employee.id === t.reportSendOwner ||
    req.employee.id === t.assignedTo || req.employee.accessRole === 'superadmin';
  if (!allowed) return res.status(403).json({ error: "You can't edit this task's links." });
  const { sheetLink, cashbookLink } = req.body || {};
  const sheetLinkN = checkLink(state, sheetLink, 'Google Sheet link');
  const cashbookLinkN = checkLink(state, cashbookLink, 'Cashbook link');
  if (!sheetLinkN.ok) return res.status(400).json({ error: sheetLinkN.error });
  if (!cashbookLinkN.ok) return res.status(400).json({ error: cashbookLinkN.error });
  const linksBefore = snapLinks(t);
  if (sheetLinkN.value !== undefined) t.sheetLink = sheetLinkN.value;
  if (cashbookLinkN.value !== undefined) t.cashbookLink = cashbookLinkN.value;
  recordLinkChange(t, req.employee, linksBefore, 'links');
  applySlotFiles(t, req);
  db.save();
  res.json({ task: taskForClient(t) });
});
// Send-to-client decision — asked once a task is reviewed clean. Logged
// for the assignee and their reporting manager(s) the same way every
// other task event is, so both see the same outcome. Allowed for the
// reviewer/a manager over the assignee, OR whoever the report-send job is
// currently assigned to (defaults to the original assignee).
// Fixed reasons for waiving a client report's send requirement (spec §6) —
// deliberately a closed list, not free text, so "sending not required"
// can't become a vague catch-all for "didn't get to it."
const REPORT_WAIVE_REASONS = {
  client_cancelled: 'Client cancelled the engagement',
  duplicate_task: 'Duplicate task',
  incorporated: 'Work incorporated into another approved report',
  client_instruction: 'Written client instruction not to proceed',
  admin_correction: 'Administrator-approved correction',
};
app.post('/api/tasks/:id/send-to-client', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if (t.reviewStatus !== 'clean' || !t.awaitingClientDecision) {
    return res.status(400).json({ error: 'This task has no pending client-send decision.' });
  }
  const { decision } = req.body || {};
  if (!['yes', 'no'].includes(decision)) return res.status(400).json({ error: 'Decision must be yes or no.' });

  if (decision === 'yes') {
    // Confirming it was actually sent stays open to the same people who
    // could always make this call — reviewer/manager, or whoever the report-
    // send job belongs to (often the assignee themselves, which is fine
    // here: this is evidence of real work done, not a self-granted waiver).
    const allowed = canReviewWorkOf(state, req.employee, t.assignedTo, t) || req.employee.id === t.reportSendOwner;
    if (!allowed) return res.status(403).json({ error: "You can't make this decision on someone else's review." });
    // Channel/reference are optional context, not a requirement to confirm
    // sending — a one-click "sent" shouldn't be blocked on providing proof.
    const channel = ['email', 'whatsapp', 'portal', 'physical', 'other'].includes((req.body || {}).channel) ? req.body.channel : null;
    const reference = ((req.body || {}).reference == null ? '' : String(req.body.reference)).trim().slice(0, 300) || null;
    t.sentToClient = true;
    t.sentToClientAt = new Date().toISOString();
    t.sentToClientBy = req.employee.id;
    t.reportDeliveryChannel = channel;
    t.reportDeliveryReference = reference;
    t.reportDeliveryStatus = null; // superseded by the sentToClient fact itself
    t.awaitingClientDecision = false;
    giveLinkMarks(state, t, 'reviewer', t.reviewedBy || req.employee.id);
    giveReportMarks(state, t, req.employee.id);
    logEvent(state, t.assignedTo, `"${escHtml(t.name)}" was sent directly to the client by <b>${escHtml(req.employee.name)}</b>${channel ? ' (' + channel + ')' : ''}.`);
    managersOfEmployee(state, t.assignedTo).forEach(m => {
      logEvent(state, m.id, `"${escHtml(t.name)}" for <b>${escHtml(findEmployee(state, t.assignedTo)?.name || '—')}</b> was sent directly to the client.`);
    });
    db.save();
    return res.json({ task: taskForClient(t) });
  }

  // decision === 'no' — a WAIVER, not a shrug. Verified during the
  // productivity rebuild audit: the old version of this endpoint let the
  // bare report-send-owner (which defaults to the assignee themselves) mark
  // their own client task "not sent" with zero friction — a processor could
  // quietly exclude their own failed delivery from scoring. Now requires an
  // actual reviewer/manager (or superadmin), never a self-match on
  // reportSendOwner alone, plus one of the fixed reasons above.
  const allowedWaive = canReviewWorkOf(state, req.employee, t.assignedTo, t) || req.employee.accessRole === 'superadmin';
  if (!allowedWaive) {
    return res.status(403).json({ error: "Only a reviewer, manager or superadmin can mark a report as not needing to be sent." });
  }
  const reasonKey = (req.body || {}).waivedReason;
  if (!REPORT_WAIVE_REASONS[reasonKey]) {
    return res.status(400).json({ error: 'Pick a reason: ' + Object.values(REPORT_WAIVE_REASONS).join(', ') + '.' });
  }
  t.sentToClient = false;
  t.sentToClientAt = new Date().toISOString();
  t.sentToClientBy = req.employee.id;
  t.reportDeliveryStatus = 'sending_not_required';
  t.reportDeliveryWaivedReason = reasonKey;
  t.reportDeliveryWaivedBy = req.employee.id;
  t.reportDeliveryWaivedAt = new Date().toISOString();
  t.awaitingClientDecision = false;
  const outcome = `held back — not sent to the client (${REPORT_WAIVE_REASONS[reasonKey]})`;
  logEvent(state, t.assignedTo, `"${escHtml(t.name)}" was ${outcome}, by <b>${escHtml(req.employee.name)}</b>.`);
  managersOfEmployee(state, t.assignedTo).forEach(m => {
    logEvent(state, m.id, `"${escHtml(t.name)}" for <b>${escHtml(findEmployee(state, t.assignedTo)?.name || '—')}</b> was ${outcome}.`);
  });
  db.save();
  res.json({ task: taskForClient(t) });
});

// Profit confirmation — an extra gate a reviewer/report-owner can route a
// clean client task through instead of sending it straight to the client.
// It always goes to Shubam Sharma with whatever sheet/cashbook links were
// attached at send-for-review time; once he confirms it comes back to
// whoever the report-send job belongs to, exactly where /send-to-client
// picks up.
app.post('/api/tasks/:id/profit-confirm', requireAuth, (req, res) => {
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
  if (!hasSheetOrCashbook(t)) {
    return res.status(400).json({ error: 'Attach a Google Sheet or Cashbook link, or a file (from Send for Review), before requesting profit confirmation.' });
  }
  const owner = profitConfirmOwner(state, t);
  if (!owner) return res.status(500).json({ error: 'Profit confirmation is not set up — nobody is configured to confirm profit.' });
  applyProfitRequest(state, t, req.employee, owner);
  db.save();
  res.json({ task: taskForClient(t) });
});
// Clean, and profit confirmation is required: it goes to Shubam. Shared by /profit-confirm and Approve.
function applyProfitRequest(state, t, actor, owner) {
  t.profitConfirmerAssignedId = owner.id;
  t.profitConfirmStatus = 'pending';
  t.profitConfirmRequestedAt = new Date().toISOString();
  t.profitConfirmRequestedBy = actor.id;
  t.awaitingClientDecision = false;
  giveLinkMarks(state, t, 'reviewer', t.reviewedBy || actor.id);
  logEvent(state, owner.id, `<b>${escHtml(actor.name)}</b> sent "${escHtml(t.name)}" for profit confirmation.`);
  logEvent(state, t.assignedTo, `"${escHtml(t.name)}" was sent to <b>${escHtml(owner.name)}</b> for profit confirmation.`);
  notify(state, owner.id, 'profit_confirm', `${actor.name} sent "${t.name}" for profit confirmation.`, t.id);
}
// Shubam confirms the profit — hands the report-send job back to whoever it
// belonged to (unchanged throughout: the original assignee, unless
// reassigned via /report-owner). Superadmin can also confirm, as a backup.
app.post('/api/tasks/:id/profit-confirm/done', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const owner = profitConfirmOwner(state, t);
  const info = profitConfirmerInfo(state, t);
  const isBackup = (req.employee.accessRole === 'superadmin' || req.employee.id === info.backupId) && t.profitConfirmRequestedBy !== req.employee.id; // backup for the confirmer — never for your own request
  const allowed = (owner && req.employee.id === owner.id) || isBackup;
  if (!allowed) return res.status(403).json({ error: 'Only ' + (owner ? owner.name : 'the profit confirmer') + ' can confirm this.' });
  if (t.profitConfirmStatus !== 'pending') return res.status(400).json({ error: 'This task has no pending profit confirmation.' });
  t.profitConfirmStatus = 'confirmed';
  t.profitConfirmAt = new Date().toISOString();
  t.profitConfirmBy = req.employee.id;
  t.awaitingClientDecision = true;
  const sendTo = t.reportSendOwner || t.assignedTo;
  if (sendTo) {
    logEvent(state, sendTo, `<b>${escHtml(req.employee.name)}</b> confirmed profit on "${escHtml(t.name)}" — go ahead and send the report.`);
    notify(state, sendTo, 'profit_confirm', `${req.employee.name} confirmed profit on "${t.name}" — send the report.`, t.id);
  }
  // Whoever asked for the confirmation (the reviewer) is told too — before this they heard nothing.
  const sender = sendTo ? findEmployee(state, sendTo) : null;
  [t.profitConfirmRequestedBy, t.reviewedBy].filter((id, i, a) => id && a.indexOf(id) === i && id !== req.employee.id && id !== sendTo).forEach(id => {
    logEvent(state, id, `<b>${escHtml(req.employee.name)}</b> confirmed profit on "${escHtml(t.name)}"${sender ? ' — <b>' + escHtml(sender.name) + '</b> will send the report' : ''}.`);
    notify(state, id, 'profit_confirm', `${req.employee.name} confirmed profit on "${t.name}"${sender ? ' — ' + sender.name + ' will send the report' : ''}.`, t.id, { noDedupe: true });
  });
  db.save();
  res.json({ task: taskForClient(t) });
});

// How many profit confirmations Shubam (the named owner) has done, how long they take, what is waiting.
// Superadmins and Shubam himself only.
app.get('/api/profit-confirmations/stats', requireAuth, (req, res) => {
  const state = db.get();
  const owner = profitConfirmOwner(state);
  const isOwner = isProfitConfirmer(state, req.employee);
  if (req.employee.accessRole !== 'superadmin' && !isOwner) return res.status(403).json({ error: 'Only a founder, or a profit confirmer, can see this.' });
  const today = todayISO();
  const d0 = new Date(today + 'T00:00:00Z');
  const weekStart = new Date(d0.getTime() - ((d0.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10); // Monday
  const monthStart = today.slice(0, 8) + '01';
  const done = (state.tasks || []).filter(t => t.profitConfirmStatus === 'confirmed' && t.profitConfirmAt);
  const byOwner = done.filter(t => owner && t.profitConfirmBy === owner.id);
  const byBackup = done.filter(t => !owner || t.profitConfirmBy !== owner.id);
  const since = (list, from) => list.filter(t => nzDay(t.profitConfirmAt) >= from).length;
  const hours = t => t.profitConfirmRequestedAt ? Math.max(0, (new Date(t.profitConfirmAt) - new Date(t.profitConfirmRequestedAt)) / 3600000) : null;
  const hs = byOwner.map(hours).filter(h => h != null);
  const nameOf = id => (findEmployee(state, id) || {}).name || '—';
  const pending = (state.tasks || []).filter(t => t.profitConfirmStatus === 'pending')
    .sort((a, b) => (a.profitConfirmRequestedAt || '').localeCompare(b.profitConfirmRequestedAt || ''));
  res.json({
    owner: owner ? { id: owner.id, name: owner.name } : null,
    confirmedByOwner: { today: since(byOwner, today), week: since(byOwner, weekStart), month: since(byOwner, monthStart), total: byOwner.length },
    confirmedByBackup: { total: byBackup.length },
    avgTurnaroundHours: hs.length ? Math.round(hs.reduce((a, b) => a + b, 0) / hs.length * 10) / 10 : null,
    pending: { count: pending.length, oldestDays: pending.length && pending[0].profitConfirmRequestedAt ? Math.floor((Date.now() - new Date(pending[0].profitConfirmRequestedAt).getTime()) / 86400000) : 0 },
    recent: done.slice().sort((a, b) => b.profitConfirmAt.localeCompare(a.profitConfirmAt)).slice(0, 25).map(t => ({
      id: t.id, name: t.name, clientName: t.clientName || null, requestedBy: nameOf(t.profitConfirmRequestedBy), requestedAt: t.profitConfirmRequestedAt || null,
      confirmedBy: nameOf(t.profitConfirmBy), confirmedAt: t.profitConfirmAt, hours: hours(t) != null ? Math.round(hours(t) * 10) / 10 : null,
    })),
  });
});

// The reviewer is happy and this client doesn't need a profit confirmation —
// the finished report goes straight back to the processor to send. It lands on
// the processor's dashboard (Reviews → reports to send, a notification and the
// Reviews badge) and is off the reviewer's lists: reportSendOwner is the one
// field those lists key on. Safe to repeat.
app.post('/api/tasks/:id/return-to-processor', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const allowed = canReviewWorkOf(state, req.employee, t.assignedTo, t) || req.employee.accessRole === 'superadmin';
  if (!allowed) return res.status(403).json({ error: "You can't make this decision on someone else's review." });
  if (t.reviewStatus !== 'clean' || !t.awaitingClientDecision) {
    return res.status(400).json({ error: 'This task has no pending client-send decision.' });
  }
  const processor = findEmployee(state, t.assignedTo);
  if (!processor) return res.status(400).json({ error: 'The processor for this task no longer exists.' });
  applyReturnToProcessor(state, t, req.employee, processor);
  db.save();
  res.json({ task: taskForClient(t) });
});
// Clean and needs no profit confirmation: the report goes to the processor to send. Shared by /return-to-processor and Approve.
function applyReturnToProcessor(state, t, actor, processor) {
  const sender = (t.reportSenderId && findEmployee(state, t.reportSenderId)) || processor;   // the sender chosen when the task was created, else the processor
  processor = sender;
  t.reportSendOwner = processor.id;
  t.reportReturnedAt = new Date().toISOString();
  t.reportReturnedBy = actor.id;
  giveLinkMarks(state, t, 'reviewer', t.reviewedBy || actor.id);
  logEvent(state, processor.id, `<b>${escHtml(actor.name)}</b> reviewed "${escHtml(t.name)}" — it's clean and needs no profit confirmation. Please send the report to the client.`);
  notify(state, processor.id, 'send_report', `${actor.name} reviewed "${t.name}" — send the report to the client.`, t.id);
}

// ---------------------------------------------------------------------------
// REVIEW DECISIONS — the simple review screen: Approve, Return for Correction, or Escalate. One endpoint, one atomic step, and
// safe to double-click (a repeated requestId — or a task that is no longer awaiting review — never creates a second event).
// Everything is written to t.reviewEvents, an append-only ledger; earlier notes, reasons and files are never overwritten or removed.
// ---------------------------------------------------------------------------
const CORRECTION_CATEGORIES = ['Calculation error', 'Missing information', 'Incorrect classification', 'Missing supporting document', 'Formatting or presentation issue', 'Client requirement not followed', 'Other'];
const RESPONSIBILITY_CATEGORIES = ['Employee', 'Reviewer', 'Manager', 'Client dependency', 'System/data issue', 'Shared responsibility'];
const FAULT_FOR_RESPONSIBILITY = { Employee: 'processor', Manager: 'sop' };   // everything else is "other" for the existing quality reports
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && d >= todayISO();
function newReviewEvent(t, actor, type, extra) {
  return { id: 'rv-' + ((t.reviewEvents || []).length + 1), type, at: new Date().toISOString(), byId: actor.id, byRole: actor.accessRole, cycle: t.reworkCount || 0, ...(extra || {}) };
}
// The reviewer's files for one decision: each must be one THEY uploaded; each is tied to the task and carries who / when / which stage.
async function claimReviewFiles(actor, t, ids, ev, stage) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (list.length > fileStore.MAX_PER_REVIEW) return { ok: false, error: `Attach at most ${fileStore.MAX_PER_REVIEW} files.` };
  const refs = [];
  for (const fid of list) {
    const m = await fileStore.meta(fid);
    if (!m || m.createdBy !== actor.id || (m.taskId && m.taskId !== t.id)) return { ok: false, error: 'One of the attached files is no longer available — please attach it again.' };
    refs.push({ ...fileRef(m), eventId: ev.id, uploaderId: actor.id, uploaderRole: actor.accessRole, uploadedAt: new Date().toISOString(), stage, cycle: ev.cycle });
  }
  for (const r of refs) await fileStore.attach(r.id, t.id, 'review');
  return { ok: true, refs };
}
const openEscalation = t => (t.escalation && t.escalation.status === 'open') ? t.escalation : null;
app.post('/api/tasks/:id/review-decision', requireAuth, async (req, res) => {
  try {
    const state = db.get(), me = req.employee;
    const t = findTask(state, req.params.id);
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    if (!canReviewWorkOf(state, me, t.assignedTo, t)) return res.status(403).json({ error: "You can't review this task — it wasn't sent to you, and it isn't your report's work." });
    const b = req.body || {};
    const decision = String(b.decision || '');
    if (!['approve', 'return', 'escalate'].includes(decision)) return res.status(400).json({ error: 'Choose Approve, Return for Correction or Escalate.' });
    // double-click / retry: the same requestId has already been recorded → say so, change nothing
    const requestId = b.requestId ? String(b.requestId).slice(0, 64) : null;
    if (requestId && (t.reviewEvents || []).some(e => e.requestId === requestId)) return res.json({ task: taskForClient(t), duplicate: true });
    if (t.status !== 'completed') return res.status(400).json({ error: 'Only work that has been submitted for review can be reviewed.' });
    if (t.reviewStatus === 'done') return res.status(400).json({ error: 'This task was closed without review.' });
    if (t.reviewStatus) return res.status(409).json({ error: 'This task has already been reviewed — reload to see its current state.', code: 'ALREADY_DECIDED' });
    if (openEscalation(t)) return res.status(409).json({ error: 'This task is waiting on an escalated decision. It returns to you once that is made.', code: 'ESCALATED' });
    const note = String(b.note == null ? '' : b.note).trim().slice(0, 2000);
    const assignee = findEmployee(state, t.assignedTo);
    const isClient = t.kind !== 'internal' || !!t.clientId;

    // ---------- validate EVERYTHING first, so a refused decision changes nothing ----------
    let owner = null, to = null;
    if (decision === 'approve') {
      if (b.clean === false) return res.status(400).json({ error: 'If the work is not clean and ready, use Return for Correction.' });
      if (b.profitRequired === true && isClient) {
        if (!hasSheetOrCashbook(t)) return res.status(400).json({ error: 'Attach a Google Sheet or Cashbook link, or a file, before asking for profit confirmation.' });
        owner = profitConfirmOwner(state, t);
        if (!owner) return res.status(500).json({ error: 'Profit confirmation is not set up — nobody is configured to confirm profit.' });
      }
      if (isClient && b.profitRequired !== true && !assignee) return res.status(400).json({ error: 'The processor for this task no longer exists.' });
    } else if (decision === 'return') {
      // the category is OPTIONAL; if one is given it must be a real one
      if (b.category !== undefined && b.category !== null && b.category !== '' && !CORRECTION_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'That is not a correction category.' });
      b.category = b.category || null;
      if (!RESPONSIBILITY_CATEGORIES.includes(b.responsibility)) return res.status(400).json({ error: 'Choose who is responsible for the correction.' });
      if (note.length < 3) return res.status(400).json({ error: 'Write a correction note so the employee knows what to fix.' });
      if (!validDay(b.dueDate)) return res.status(400).json({ error: 'Choose a correction due date (today or later).' });
      if (!assignee) return res.status(400).json({ error: 'This task has no assignee to send the correction to.' });
    } else {
      const reason = String(b.reason || '').trim();
      if (reason.length < 3) return res.status(400).json({ error: 'Give the reason for escalating.' });
      to = findEmployee(state, b.assignTo);
      if (!to || !isAdminRole(to.accessRole) || !canReceiveNewWork(to) || isSystemAccount(to)) return res.status(400).json({ error: 'Choose an active manager or founder to decide.' });
      if (to.id === me.id) return res.status(400).json({ error: 'Escalate to someone other than yourself.' });
      if (!validDay(b.decisionDate)) return res.status(400).json({ error: 'Choose the date a decision is needed by (today or later).' });
    }
    const ev = newReviewEvent(t, me, decision === 'approve' ? 'approved' : decision === 'return' ? 'returned' : 'escalated', { requestId, note: note || null });
    if (decision === 'return') ev.cycle = (t.reworkCount || 0) + 1;
    let files = [];
    if (decision !== 'approve') {
      const c = await claimReviewFiles(me, t, b.attachments, ev, decision === 'return' ? 'review_return' : 'review_escalation');
      if (!c.ok) return res.status(400).json({ error: c.error });
      files = c.refs;
      if (requestId && (t.reviewEvents || []).some(e => e.requestId === requestId)) return res.json({ task: taskForClient(t), duplicate: true }); // the same click, answered twice
      if (t.status !== 'completed' || t.reviewStatus || openEscalation(t)) return res.status(409).json({ error: 'This task changed while you were deciding — reload and try again.' });
    }

    // ---------- apply (synchronous from here) ----------
    const now = ev.at;
    if (decision === 'approve') {
      t.reviewStatus = 'clean'; t.reviewedBy = me.id; t.reviewedAt = now; t.reviewNote = note || null;
      t.reviewScore = null; t.reviewHours = null; t.reviewMarks = null;
      ev.profitRequired = !!owner;
      t.awaitingClientDecision = isClient;
      if (isClient) t.reportSendOwner = t.reportSenderId || t.assignedTo;
      logEvent(state, t.assignedTo, `"${escHtml(t.name)}" reviewed — error-free.`);
      managersOfEmployee(state, t.assignedTo).forEach(m => logEvent(state, m.id, `"${escHtml(t.name)}" for <b>${escHtml((assignee || {}).name || '—')}</b> was reviewed clean by <b>${escHtml(me.name)}</b>.`));
      if (isClient && t.reportRequired === false) {
        // "No report needed" was decided when the task was created — it is closed, not left waiting to be sent.
        t.awaitingClientDecision = false; t.sentToClient = false; t.sentToClientAt = now; t.sentToClientBy = me.id;
        t.reportDeliveryStatus = 'sending_not_required'; t.reportDeliveryWaivedReason = 'not_required_at_creation'; t.reportDeliveryWaivedBy = t.assignedBy || me.id; t.reportDeliveryWaivedAt = now;
      } else if (isClient) { if (owner) applyProfitRequest(state, t, me, owner); else applyReturnToProcessor(state, t, me, assignee); }
    } else if (decision === 'return') {
      t.reviewStatus = 'error'; t.reviewedBy = me.id; t.reviewedAt = now; t.reviewNote = note;
      t.reviewScore = null; t.reviewHours = null; t.reviewMarks = null;
      t.faultType = FAULT_FOR_RESPONSIBILITY[b.responsibility] || 'other';
      t.status = 'awaiting_acceptance';                      // "Correction required — waiting for your correction", never "not started"
      t.reworkCount = (t.reworkCount || 0) + 1;
      t.correction = { category: b.category, responsibility: b.responsibility, dueDate: b.dueDate, eventId: ev.id, cycle: t.reworkCount };
      Object.assign(ev, { category: b.category, responsibility: b.responsibility, dueDate: b.dueDate, attachmentIds: files.map(f => f.id) });
      t.reviewAttachments = [...(t.reviewAttachments || []), ...files];   // earlier files are kept; this round's are added
      logEvent(state, t.assignedTo, `"${escHtml(t.name)}" sent back for correction${b.category ? ' (' + escHtml(b.category) + ')' : ''} — due ${escHtml(b.dueDate)}. Note: ${escHtml(note)}`);
      notify(state, t.assignedTo, 'rework', `"${t.name}" needs a correction${b.category ? ': ' + b.category : ''} — due ${b.dueDate}${files.length ? ' · ' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' attached' : ''}. ${note}`, t.id);
    } else {
      const reason = String(b.reason).trim().slice(0, 1000);
      t.escalation = { id: ev.id, status: 'open', byId: me.id, toId: to.id, reason, note: note || null, decisionDate: b.decisionDate, at: now, attachments: files };
      Object.assign(ev, { reason, toId: to.id, decisionDate: b.decisionDate, attachmentIds: files.map(f => f.id) });
      t.reviewAttachments = [...(t.reviewAttachments || []), ...files];
      logEvent(state, to.id, `<b>${escHtml(me.name)}</b> escalated "${escHtml(t.name)}" to you — decision needed by ${escHtml(b.decisionDate)}: ${escHtml(reason)}`);
      logEvent(state, t.assignedTo, `"${escHtml(t.name)}" was escalated by <b>${escHtml(me.name)}</b> to <b>${escHtml(to.name)}</b> for a decision.`);
      notify(state, to.id, 'escalation', `${me.name} escalated "${t.name}" to you — decision needed by ${b.decisionDate}: ${reason}`, t.id);
    }
    t.reviewEvents = [...(t.reviewEvents || []), ev];
    db.save();
    res.json({ task: taskForClient(t) });
  } catch (e) {
    console.error('[review-decision] failed:', e && e.stack || e);
    res.status(500).json({ error: 'Could not record that decision — please try again.' });
  }
});
// The person it was escalated to makes the call; the task goes straight back to its reviewer.
app.post('/api/tasks/:id/escalation/resolve', requireAuth, (req, res) => {
  const state = db.get(), me = req.employee;
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const requestId = (req.body || {}).requestId ? String(req.body.requestId).slice(0, 64) : null;
  if (requestId && (t.reviewEvents || []).some(e => e.requestId === requestId)) return res.json({ task: taskForClient(t), duplicate: true });   // the same click twice
  const esc = openEscalation(t);
  if (!esc) return res.status(409).json({ error: 'There is no open escalation on this task.' });
  if (esc.toId !== me.id && me.accessRole !== 'superadmin') return res.status(403).json({ error: 'Only the person it was escalated to can decide.' });
  const decision = String((req.body || {}).decision || '').trim().slice(0, 2000);
  if (decision.length < 3) return res.status(400).json({ error: 'Write the decision so the reviewer knows what to do.' });
  esc.status = 'resolved'; esc.resolvedAt = new Date().toISOString(); esc.resolvedBy = me.id; esc.decision = decision;
  t.reviewEvents = [...(t.reviewEvents || []), newReviewEvent(t, me, 'escalation_resolved', { requestId, note: decision, escalationId: esc.id })];
  logEvent(state, esc.byId, `<b>${escHtml(me.name)}</b> decided on "${escHtml(t.name)}": ${escHtml(decision)}`);
  notify(state, esc.byId, 'escalation', `${me.name} made a decision on "${t.name}": ${decision} — it is back in your review queue.`, t.id);
  db.save();
  res.json({ task: taskForClient(t) });
});

// ---------------------------------------------------------------------------
// KUDOS — firm-wide, star-leveled recognition (see connector.js
// KUDOS_LEVELS / canAwardKudosTo). Not tied to a specific task or review
// any more. Awarding is gated by the recipient's team (or superadmin /
// Shubam firm-wide); recommending is open to anyone but themselves. The
// actual state changes live in connector.js so the Slack App Home buttons
// use exactly the same logic as these HTTP routes.
// ---------------------------------------------------------------------------
app.get('/api/kudos', requireAuth, (req, res) => {
  const state = db.get();
  const list = (state.kudos || []).slice().sort((a, b) => (b.awardedAt || '').localeCompare(a.awardedAt || ''));
  res.json({ kudos: list });
});
app.post('/api/kudos', requireAuth, async (req, res) => {
  const state = db.get();
  const { awardKudos } = require('./connector');
  const r = await awardKudos(state, { toId: (req.body || {}).toId, byId: req.employee.id, level: (req.body || {}).level, note: (req.body || {}).note });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ kudos: r.kudos });
});
app.get('/api/kudos/recommendations', requireAuth, (req, res) => {
  const state = db.get();
  const list = (state.kudosRecommendations || []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ recommendations: list });
});
app.post('/api/kudos/recommend', requireAuth, async (req, res) => {
  const state = db.get();
  const { recommendKudos } = require('./connector');
  const r = await recommendKudos(state, { toId: (req.body || {}).toId, byId: req.employee.id, note: (req.body || {}).note });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ recommendation: r.recommendation });
});
app.post('/api/kudos/recommendations/:id/award', requireAuth, async (req, res) => {
  const state = db.get();
  const { resolveKudosRecommendation } = require('./connector');
  const r = await resolveKudosRecommendation(state, { recId: req.params.id, byId: req.employee.id, action: 'award', level: (req.body || {}).level, note: (req.body || {}).note });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ recommendation: r.recommendation, kudos: r.kudos });
});
app.post('/api/kudos/recommendations/:id/dismiss', requireAuth, async (req, res) => {
  const state = db.get();
  const { resolveKudosRecommendation } = require('./connector');
  const r = await resolveKudosRecommendation(state, { recId: req.params.id, byId: req.employee.id, action: 'dismiss' });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ recommendation: r.recommendation });
});
// Founder-only cleanup — e.g. a test/mistaken entry. See connector.js deleteKudos.
app.delete('/api/kudos/:id', requireAuth, (req, res) => {
  const { deleteKudos } = require('./connector');
  const r = deleteKudos(db.get(), { kudosId: req.params.id, byId: req.employee.id });
  if (!r.ok) return res.status(r.error.includes('not found') ? 404 : 403).json({ error: r.error });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POINTS — a separate, simpler award from Kudos: any admin/founder can give
// an arbitrary positive amount, visible firm-wide (not just to the
// recipient) with reactions. See connector.js awardPoints/reactToPoints.
// ---------------------------------------------------------------------------
app.get('/api/points', requireAuth, (req, res) => {
  const list = (db.get().points || []).slice().sort((a, b) => (b.awardedAt || '').localeCompare(a.awardedAt || ''));
  res.json({ points: list });
});
app.post('/api/points', requireAuth, async (req, res) => {
  const { awardPoints } = require('./connector');
  const r = await awardPoints(db.get(), { toId: (req.body || {}).toId, byId: req.employee.id, amount: (req.body || {}).amount, note: (req.body || {}).note });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ points: r.points });
});
app.post('/api/points/:id/react', requireAuth, (req, res) => {
  const { reactToPoints } = require('./connector');
  const r = reactToPoints(db.get(), { pointsId: req.params.id, empId: req.employee.id, emoji: String((req.body || {}).emoji || '👏').slice(0, 8) });
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ points: r.points });
});
// Founder-only cleanup — e.g. a test/mistaken entry. See connector.js deletePoints.
app.delete('/api/points/:id', requireAuth, (req, res) => {
  const { deletePoints } = require('./connector');
  const r = deletePoints(db.get(), { pointsId: req.params.id, byId: req.employee.id });
  if (!r.ok) return res.status(r.error.includes('not found') ? 404 : 403).json({ error: r.error });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WALL REACTIONS + COMMENTS — any signed-in employee can react to or comment
// on a Kudos or Points award (the wall is firm-wide and public). Comments
// live on the award row itself; the author or a superadmin can remove one.
// (Points reactions pre-date this and live in connector.js reactToPoints.)
// ---------------------------------------------------------------------------
const WALL_LISTS = { kudos: s => s.kudos, points: s => s.points };
function wallRow(state, kind, id) {
  const list = WALL_LISTS[kind] && WALL_LISTS[kind](state);
  return Array.isArray(list) ? list.find(r => r.id === id) : null;
}
app.post('/api/kudos/:id/react', requireAuth, (req, res) => {
  const state = db.get();
  const row = wallRow(state, 'kudos', req.params.id);
  if (!row) return res.status(404).json({ error: 'Kudos award not found.' });
  const emoji = String((req.body || {}).emoji || '👍').slice(0, 8);
  row.reactions = row.reactions || [];
  const mine = row.reactions.find(r => r.empId === req.employee.id);
  if (mine && mine.emoji === emoji) row.reactions = row.reactions.filter(r => r.empId !== req.employee.id);
  else if (mine) { mine.emoji = emoji; mine.at = new Date().toISOString(); }
  else row.reactions.push({ empId: req.employee.id, emoji, at: new Date().toISOString() });
  db.save();
  res.json({ kudos: row });
});
app.post('/api/:kind(kudos|points)/:id/comments', requireAuth, (req, res) => {
  const state = db.get();
  const kind = req.params.kind;
  const row = wallRow(state, kind, req.params.id);
  if (!row) return res.status(404).json({ error: 'Award not found.' });
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Write something first.' });
  row.comments = row.comments || [];
  if (row.comments.length >= 200) return res.status(400).json({ error: 'This thread is full.' });
  state.wallCommentSeq = (state.wallCommentSeq || 0) + 1;
  row.comments.push({ id: 'wc' + state.wallCommentSeq, empId: req.employee.id, text, at: new Date().toISOString() });
  // tell the recipient and the giver (not the commenter themselves)
  const to = findEmployee(state, row.toId);
  new Set([row.toId, row.byId]).forEach(id => {
    if (id && id !== req.employee.id) notify(state, id, 'comment',
      `${req.employee.name} commented on ${to ? to.name + "'s" : 'a'} ${kind === 'kudos' ? 'kudos' : 'points'}: "${text.slice(0, 80)}"`, null, { noDedupe: true });
  });
  db.save();
  res.status(201).json({ [kind]: row });
});
app.delete('/api/:kind(kudos|points)/:id/comments/:cid', requireAuth, (req, res) => {
  const state = db.get();
  const kind = req.params.kind;
  const row = wallRow(state, kind, req.params.id);
  const c = row && (row.comments || []).find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  if (c.empId !== req.employee.id && req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Only the author or a superadmin can remove a comment.' });
  row.comments = row.comments.filter(x => x.id !== c.id);
  db.save();
  res.json({ [kind]: row });
});

// ---------------------------------------------------------------------------
// MARKS — signed performance marks (positive or negative) a manager gives
// an employee, each with a reason and/or a screenshot. Same authority boundary as
// acting on someone's work (canManageEmployee): a superadmin can mark
// anyone, an admin only their own team; nobody can mark themselves.
// Visibility: an employee sees only their own, an admin their team's, a
// superadmin everyone's. A mark is never deleted — voiding keeps it on
// record (struck through in the UI, excluded from totals). Standalone for
// now: nothing here feeds Productivity or the Report Card yet.
// ---------------------------------------------------------------------------
// A mark can carry a screenshot ("snip") as its evidence instead of — or as
// well as — a typed reason. The image stays out of the list payload (heavy,
// like a review's error screenshot) and is fetched on demand from
// /api/marks/:id/screenshot, which only the giver, the receiver, the
// receiver's team admin and superadmins may read — i.e. everyone who can
// see the mark itself.
function markVisibleTo(state, me, m) {
  if (me.accessRole === 'superadmin') return true;
  if (m.toId === me.id || m.byId === me.id) return true;
  return me.accessRole === 'admin' && teamRoster(state, me).some(e => e.id === m.toId);
}
function markForClient(m) {
  const { screenshot, screenshotFile, ...rest } = m;
  return { ...rest, hasScreenshot: !!(screenshot || screenshotFile) };
}
app.get('/api/marks', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const list = (state.marks || []).filter(m => markVisibleTo(state, me, m));
  res.json({ marks: list.map(markForClient).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) });
});
app.get('/api/marks/:id/screenshot', requireAuth, async (req, res) => {
  const state = db.get();
  const m = (state.marks || []).find(x => x.id === req.params.id);
  if (!m || !(m.screenshot || m.screenshotFile) || !markVisibleTo(state, req.employee, m)) return res.status(404).json({ error: 'No screenshot.' });
  const shot = await loadScreenshot(m.screenshot, m.screenshotFile);
  if (!shot) return res.status(404).json({ error: 'No screenshot.' });
  res.json({ screenshot: shot });
});

// ---------------------------------------------------------------------------
// AUTOMATIC MARKS (see auto-marks.js for the rules). The system deducts marks by
// itself for unacknowledged emails/calls (a daily job in connector.js) and for
// missing Sheet/Cashbook links on client work (right here, at the moment it
// happens). Each one is a normal mark — tagged "automatic", visible to the person
// and their manager, counted in the totals — and a superadmin can void it.
// ---------------------------------------------------------------------------
function announceAutoMark(state, row) {
  const to = findEmployee(state, row.toId);
  if (!to) return;
  logEvent(state, to.id, `<b>Automatic marks</b>: <b>${row.points} marks</b> — ${escHtml(row.reason)}.`);
  notify(state, to.id, 'mark', `${row.points} marks (automatic) — ${row.reason}`, row.taskId || null, { noDedupe: true });
}
// who: 'processor' (they sent it for review) or 'reviewer' (they passed it on).
// Once per task per rework round, whichever path gets there first.
function giveLinkMarks(state, t, who, reviewerId) {
  const s = autoMarks.settingsOf(state, todayISO());
  if (!s.enabled.links || !autoMarks.linksRequired(t)) return null;
  const missing = autoMarks.missingLinks(t);
  if (!missing.length) return null;
  const isProc = who === 'processor';
  const toId = isProc ? t.assignedTo : reviewerId;
  if (!toId || (!isProc && toId === t.assignedTo)) return null;
  const marks = autoMarks.linkMarks(missing, isProc ? s.points.processorLinks : s.points.reviewerLinks);
  if (!marks) return null;
  const what = missing.join(' and ') + (missing.length > 1 ? ' links' : ' link');
  const reason = isProc
    ? `Automatic: "${t.name}" was sent for review without the ${what}`
    : `Automatic: "${t.name}" was passed on after review while the ${what} ${missing.length > 1 ? 'were' : 'was'} still missing`;
  const row = autoMarks.createAutoMark(state, { toId, points: marks, reason, type: isProc ? 'auto_links_processor' : 'auto_links_reviewer', key: `links:${isProc ? 'p' : 'r'}:${t.id}:${t.reworkCount || 0}`, taskId: t.id });
  if (row) announceAutoMark(state, row);
  return row;
}
// A client report that has not gone out by the committed date (query-aware, so a
// client query that froze the clock is respected) costs whoever is sending it.
function giveReportMarks(state, t, toId) {
  const s = autoMarks.settingsOf(state, todayISO());
  if (!s.enabled.reports || !toId) return null;
  const committed = effectiveClientDate(t);
  if (!autoMarks.reportIsLate(committed, todayISO(), s.activeFrom)) return null;
  const row = autoMarks.createAutoMark(state, {
    toId, points: s.points.reportLate, type: 'auto_report_late', key: `report:${t.id}:${t.reworkCount || 0}`, taskId: t.id,
    reason: `Automatic: the report for "${t.name}" was not sent to the client by the committed date (${committed})`,
  });
  if (row) announceAutoMark(state, row);
  return row;
}
// Run by the daily job: every report still waiting to be sent, past its date.
function sweepReportDeadlines(state) {
  let n = 0;
  (state.tasks || []).forEach(t => {
    if (t.awaitingClientDecision && t.kind !== 'internal' && giveReportMarks(state, t, t.reportSendOwner || t.assignedTo)) n++;
  });
  return n;
}
// What everyone is told up front (the Mark Complete and review screens quote these numbers).
app.get('/api/auto-marks/rules', requireAuth, (req, res) => {
  const s = autoMarks.settingsOf(db.get(), todayISO());
  res.json({ links: { enabled: s.enabled.links, processor: s.points.processorLinks, reviewer: s.points.reviewerLinks }, acknowledgement: { enabled: s.enabled.acknowledgement, perItem: s.points.ackPerItem }, reports: { enabled: s.enabled.reports, late: s.points.reportLate }, mailReply: { enabled: s.enabled.mailReply, late: s.points.mailReplyLate } });
});
app.get('/api/admin/auto-marks', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const s = autoMarks.settingsOf(state, todayISO());
  const recent = (state.marks || []).filter(m => m.auto).slice(-40).reverse().map(m => ({
    id: m.id, toId: m.toId, toName: (findEmployee(state, m.toId) || {}).name || '—', points: m.points, reason: m.reason, type: m.type, createdAt: m.createdAt, voidedAt: m.voidedAt || null,
  }));
  db.save();
  res.json({ settings: s, lastRun: (state.autoMarks || {}).lastRun || null, lastEvaluated: (state.autoMarks || {}).lastEvaluated || null, recent });
});
app.post('/api/admin/auto-marks/settings', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const s = autoMarks.updateSettings(state, req.body, todayISO());
  logEvent(state, req.employee.id, `Changed the automatic marks settings (acknowledgement ${s.enabled.acknowledgement ? 'on' : 'off'}, links ${s.enabled.links ? 'on' : 'off'}, late reports ${s.enabled.reports ? 'on' : 'off'}, reassigned-mail replies ${s.enabled.mailReply ? 'on' : 'off'}; ack −${s.points.ackPerItem} per call/email, links −${s.points.processorLinks}/−${s.points.reviewerLinks}, late report −${s.points.reportLate}, unreplied reassigned mail −${s.points.mailReplyLate}).`);
  db.save();
  res.json({ settings: s });
});
// "What would have happened on that day?" — changes nothing.
app.post('/api/admin/auto-marks/preview', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const day = (req.body || {}).day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return res.status(400).json({ error: 'Choose a day.' });
  const { previewAutoMarksDay } = require('./connector');
  res.json({ day, results: previewAutoMarksDay(day) });
});
// Run the daily check now (it also runs by itself every morning).
app.post('/api/admin/auto-marks/run', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const { runAutoMarks } = require('./connector');
  res.json(runAutoMarks('manual'));
});

// Creates one mark and tells the person — shared by the manual "Give marks"
// form and the workshop pre-reading penalty, so both behave identically
// (activity-feed line, notification, same row shape).
function addMark(state, me, to, pts, why, shot, workshopId, taskId) {
  state.marksSeq = (state.marksSeq || 0) + 1;
  const row = {
    id: 'mk' + state.marksSeq, toId: to.id, byId: me.id, points: pts, reason: why, screenshot: shot || null,
    type: workshopId ? 'pre_reading' : (taskId ? 'review' : 'general'), workshopId: workshopId || null, taskId: taskId || null,
    createdAt: new Date().toISOString(), voidedAt: null, voidedBy: null,
  };
  state.marks.push(row);
  const label = (pts > 0 ? '+' : '') + pts.toLocaleString();
  const detail = why || 'see the attached snip';
  logEvent(state, to.id, `<b>${escHtml(me.name)}</b> gave you <b>${label} marks</b> — "${escHtml(detail)}"${why && shot ? ' (snip attached)' : ''}.`);
  notify(state, to.id, 'mark', `${me.name} gave you ${label} marks — ${detail}`, null, { noDedupe: true });
  return row;
}
// Everyone who currently has a (non-voided) pre-reading mark for a workshop:
// { employeeId: markId }. Voiding a mark frees the person to be marked again.
function workshopPenalties(state, workshopId) {
  const out = {};
  (state.marks || []).forEach(m => { if (m.workshopId === workshopId && !m.voidedAt) out[m.toId] = m.id; });
  return out;
}
function workshopById(state, id) { return (state.workshops || []).find(w => w.id === id); }
app.post('/api/marks', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const { toId, points, reason, screenshot, workshopId } = req.body || {};
  const to = findEmployee(state, toId);
  if (!to) return res.status(400).json({ error: 'Choose who the mark is for.' });
  if (to.id === me.id) return res.status(400).json({ error: "You can't give marks to yourself." });
  if (me.accessRole === 'employee') return res.status(403).json({ error: 'Only a manager can give marks.' });
  if (!canManageEmployee(state, me, to.id)) return res.status(403).json({ error: "You can only give marks to people on your own team." });
  const pts = Math.round(Number(points));
  if (!Number.isFinite(pts) || pts === 0) return res.status(400).json({ error: 'Marks must be a non-zero whole number (negative to deduct).' });
  if (Math.abs(pts) > 10000) return res.status(400).json({ error: 'That is too large — marks are limited to ±10,000 each.' });
  let why = String(reason || '').trim().slice(0, 300);
  let shot = null;
  if (screenshot != null && screenshot !== '') {
    if (typeof screenshot !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(screenshot) || screenshot.length > 6_000_000) {
      return res.status(400).json({ error: 'The snip must be an image under about 4 MB.' });
    }
    shot = screenshot;
  }
  // A workshop pre-reading mark: tied to that workshop, one per person (until
  // a mistaken one is voided), with the standard reason filled in if blank.
  let wid = null;
  if (workshopId) {
    const w = workshopById(state, String(workshopId));
    if (!w) return res.status(400).json({ error: 'That workshop was not found.' });
    if (workshopPenalties(state, w.id)[to.id]) return res.status(409).json({ error: `${to.name} already has a pre-reading mark for ${w.name}.` });
    wid = w.id;
    if (!why) why = `Did not complete the pre-reading for ${w.name}`;
  }
  if (why.length < 3 && !shot) return res.status(400).json({ error: 'Add a reason, a snip, or both.' });
  const row = addMark(state, me, to, pts, why, shot, wid);
  db.save();
  res.status(201).json({ mark: markForClient(row) });
});

// ---------------------------------------------------------------------------
// WORKSHOPS — pre-reading. A superadmin sets up each workshop (Workshop 1,
// Workshop 2, …) with a date, optional reading material and a mark penalty
// (default −1). Everyone is asked to read it beforehand and confirms with "I've
// read it". At or after the workshop the superadmin reviews who hasn't and
// applies the penalty as ordinary Marks (pre-reading type), with the option
// to leave people out; a manager can also give the same mark one-by-one from
// the Give marks form. Nothing is automatic — a person is only marked down
// by a human pressing the button.
// ---------------------------------------------------------------------------
function workshopForClient(state, w, me) {
  const reads = w.reads || {};
  const penalties = workshopPenalties(state, w.id);
  const out = {
    id: w.id, name: w.name, date: w.date, url: w.url || null, notes: w.notes || '', penalty: w.penalty,
    createdAt: w.createdAt, myReadAt: reads[me.id] || null, myNotReadAt: (w.notReads || {})[me.id] || null, myPenalised: !!penalties[me.id],
    // after the workshop day the answer is locked (it decides that day's capacity)
    locked: todayISO() > w.date,
    readCount: Object.keys(reads).length, total: state.employees.length,
  };
  if (me.accessRole === 'superadmin') { out.reads = reads; out.notReads = w.notReads || {}; out.penalised = penalties; }
  return out;
}
function cleanWorkshopFields(body, out) {
  const b = body || {};
  if (b.name !== undefined) {
    const n = String(b.name || '').trim().slice(0, 80);
    if (!n) return 'Give the workshop a name, e.g. "Workshop 1".';
    out.name = n;
  }
  if (b.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return 'Pick the workshop date.';
    out.date = String(b.date);
  }
  if (b.url !== undefined) {
    const u = String(b.url || '').trim();
    if (u && !/^https?:\/\/\S+$/i.test(u)) return 'The pre-reading link must start with http:// or https://.';
    out.url = u || null;
  }
  if (b.notes !== undefined) out.notes = String(b.notes || '').trim().slice(0, 500);
  if (b.penalty !== undefined) {
    const p = Math.round(Number(b.penalty));
    if (!(p >= 1 && p <= 100)) return 'The penalty must be between 1 and 100 marks.';
    out.penalty = p;
  }
  return null;
}
app.get('/api/workshops', requireAuth, (req, res) => {
  const state = db.get();
  const list = (state.workshops || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json({ workshops: list.map(w => workshopForClient(state, w, req.employee)) });
});
app.post('/api/workshops', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const f = { penalty: 1, url: null, notes: '' };
  const bad = cleanWorkshopFields(req.body, f);
  if (bad) return res.status(400).json({ error: bad });
  if (!f.name || !f.date) return res.status(400).json({ error: 'A workshop needs a name and a date.' });
  state.workshopSeq = (state.workshopSeq || 0) + 1;
  const w = { id: 'ws' + state.workshopSeq, name: f.name, date: f.date, url: f.url, notes: f.notes, penalty: f.penalty,
    createdBy: req.employee.id, createdAt: new Date().toISOString(), reads: {} };
  state.workshops.push(w);
  state.employees.forEach(e => notify(state, e.id, 'workshop',
    `Pre-reading for ${w.name}: please read it before ${w.date}. Anyone who hasn't gets −${w.penalty} mark.`, null, { noDedupe: true }));
  db.save();
  res.status(201).json({ workshop: workshopForClient(state, w, req.employee) });
});
app.patch('/api/workshops/:id', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const w = workshopById(state, req.params.id);
  if (!w) return res.status(404).json({ error: 'Workshop not found.' });
  const f = {};
  const bad = cleanWorkshopFields(req.body, f);
  if (bad) return res.status(400).json({ error: bad });
  Object.assign(w, f);
  db.save();
  res.json({ workshop: workshopForClient(state, w, req.employee) });
});
// "I've read it" — for yourself; a superadmin can also confirm on someone
// else's behalf (e.g. they read it in print). Idempotent.
app.post('/api/workshops/:id/read', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const w = workshopById(state, req.params.id);
  if (!w) return res.status(404).json({ error: 'Workshop not found.' });
  let empId = me.id;
  const target = (req.body || {}).empId;
  if (target && target !== me.id) {
    if (me.accessRole !== 'superadmin') return res.status(403).json({ error: 'You can only confirm your own reading.' });
    if (!findEmployee(state, target)) return res.status(404).json({ error: 'Employee not found.' });
    empId = target;
  }
  if (empId === me.id && me.accessRole !== 'superadmin' && todayISO() > w.date) {
    return res.status(409).json({ error: 'The workshop has already happened, so this can no longer be changed. Ask the founder if it is wrong.' });
  }
  w.reads = w.reads || {};
  w.notReads = w.notReads || {};
  const changed = !w.reads[empId] || !!w.notReads[empId];
  if (!w.reads[empId]) w.reads[empId] = new Date().toISOString();
  delete w.notReads[empId];
  if (changed) db.save();
  res.json({ workshop: workshopForClient(state, w, me) });
});
// "I haven't read it" — an honest answer. It changes nothing about that day's
// capacity (the workshop day is a full working day for anyone who hasn't
// confirmed the reading), but the founder can see who said so. Same rules as
// "I've read it": your own answer until the workshop day, a superadmin for anyone.
app.post('/api/workshops/:id/not-read', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const w = workshopById(state, req.params.id);
  if (!w) return res.status(404).json({ error: 'Workshop not found.' });
  let empId = me.id;
  const target = (req.body || {}).empId;
  if (target && target !== me.id) {
    if (me.accessRole !== 'superadmin') return res.status(403).json({ error: 'You can only answer for yourself.' });
    if (!findEmployee(state, target)) return res.status(404).json({ error: 'Employee not found.' });
    empId = target;
  }
  if (empId === me.id && me.accessRole !== 'superadmin' && todayISO() > w.date) {
    return res.status(409).json({ error: 'The workshop has already happened, so this can no longer be changed. Ask the founder if it is wrong.' });
  }
  w.reads = w.reads || {};
  w.notReads = w.notReads || {};
  const changed = !!w.reads[empId] || !w.notReads[empId];
  delete w.reads[empId];
  if (!w.notReads[empId]) w.notReads[empId] = new Date().toISOString();
  if (changed) db.save();
  res.json({ workshop: workshopForClient(state, w, me) });
});
// Apply the pre-reading penalty to everyone who hasn't read it (or just the
// ids given). Skips anyone who has read it, anyone already marked for this
// workshop, and the superadmin themself (nobody can mark themselves).
app.post('/api/workshops/:id/penalise', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const w = workshopById(state, req.params.id);
  if (!w) return res.status(404).json({ error: 'Workshop not found.' });
  const penalties = workshopPenalties(state, w.id);
  const ids = Array.isArray((req.body || {}).empIds) ? [...new Set(req.body.empIds.map(String))] : state.employees.map(e => e.id);
  const applied = [], skipped = { read: 0, already: 0, self: 0, unknown: 0 };
  ids.forEach(id => {
    const e = findEmployee(state, id);
    if (!e) { skipped.unknown++; return; }
    if (e.id === me.id) { skipped.self++; return; }
    if ((w.reads || {})[e.id]) { skipped.read++; return; }
    if (penalties[e.id]) { skipped.already++; return; }
    addMark(state, me, e, -w.penalty, `Did not complete the pre-reading for ${w.name}`, null, w.id);
    applied.push(e.name);
  });
  if (applied.length) db.save();
  res.json({ ok: true, workshop: w.name, penalty: w.penalty, applied, skipped });
});
app.post('/api/marks/:id/void', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const row = (state.marks || []).find(m => m.id === req.params.id);
  if (!row) return res.status(404).json({ error: 'Mark not found.' });
  if (row.voidedAt) return res.status(400).json({ error: 'Already voided.' });
  if (me.accessRole !== 'superadmin' && row.byId !== me.id) return res.status(403).json({ error: 'Only the person who gave it, or a superadmin, can void a mark.' });
  row.voidedAt = new Date().toISOString();
  row.voidedBy = me.id;
  logEvent(state, row.toId, `A mark of <b>${row.points > 0 ? '+' : ''}${row.points}</b> was voided by <b>${escHtml(me.name)}</b>.`);
  db.save();
  res.json({ mark: markForClient(row) });
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
  t.reworkHistory.push({ round: t.reworkCount, startedAt, endedAt, durationHours, reviewNote: t.reviewNote || null, faultType: t.faultType || null, attachments: (t.reviewAttachments || []).filter(a => a.cycle == null || a.cycle === t.reworkCount) });
  t.reworkStartedAt = null;
  t.status = 'completed';
  t.completedAt = recordSubmission(t, req.employee, 'resubmit', endedAt);
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return res.status(400).json({ error: 'Pick the new date you are proposing.' });
  if (String(date) < todayISO()) return res.status(400).json({ error: "The proposed date can't be in the past." });
  if (String(reason || '').trim().length < 3) return res.status(400).json({ error: 'Say briefly why you need the new date.' });
  t.proposedDate = date;
  t.proposedReason = String(reason).trim().slice(0, 400);
  t.status = 'window_proposed';
  logEvent(state, t.assignedTo, `Proposed a new date for "${escHtml(t.name)}" — ${escHtml(date)}. Reason: ${escHtml(reason) || 'not specified'}.`);
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
  notify(state, t.assignedTo, 'window', `${req.employee.name} approved your new date for "${t.name}" — now due ${t.internalDeadline}.`, t.id);
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

// Record a commitment-date change. The FIRST dates a task ever had are kept forever (originalInternalDeadline / originalClientDate)
// and every change adds a dateHistory row with who, when, why, old and new — nothing is overwritten silently. The assignee and
// the reviewer are told. Returns true if anything actually changed.
function recordDateChange(state, t, actor, before, note, category) {
  const after = { internal: t.internalDeadline, client: t.clientDate };
  if (before.internal === after.internal && before.client === after.client) return false;
  if (t.originalInternalDeadline === undefined) t.originalInternalDeadline = before.internal || null;
  if (t.originalClientDate === undefined) t.originalClientDate = before.client || null;
  t.dateHistory = t.dateHistory || [];
  t.dateHistory.push({ at: new Date().toISOString(), by: actor.name, byId: actor.id, from: before, to: after, note: note || null, category: category || null });
  const what = 'internal ' + (after.internal || '—') + (after.client ? ', client ' + after.client : '');
  [t.assignedTo, t.reviewerId].filter((id, i, a) => id && id !== actor.id && a.indexOf(id) === i).forEach(id =>
    notify(state, id, 'dates', actor.name + ' changed the dates on "' + t.name + '" — ' + what + (note ? ' (' + note + ')' : ''), t.id));
  return true;
}

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

  const dateChanged = recordDateChange(state, t, req.employee, before, note, asSelf ? 'self_edit' : 'manager_edit');
  if (dateChanged) {
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

// Correct a task's logged hours after the fact — superadmin only, since
// this figure feeds every worked-hours/productivity number directly. For
// fixing a runaway/forgotten timer (see sweepRunawayTimers) or any other
// bad entry once it's already landed. Requires a one-line reason; the
// prior value is kept in loggedHistory so the correction is auditable,
// the same way date/estimate edits above are.
app.post('/api/tasks/:id/correct-logged', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const body = req.body || {};
  const newLogged = Number(body.logged);
  if (!(newLogged >= 0)) return res.status(400).json({ error: 'Logged hours must be zero or a positive number.' });
  const note = String(body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'A one-line reason is required for correcting logged hours.' });
  const before = Number(t.logged) || 0;
  if (Math.abs(before - newLogged) < 0.01) return res.json({ task: taskForClient(t) });
  t.loggedHistory = t.loggedHistory || [];
  t.loggedHistory.push({ at: new Date().toISOString(), by: req.employee.name, from: before, to: newLogged, note });
  t.logged = newLogged;
  logEvent(state, t.assignedTo, `Logged hours on "${escHtml(t.name)}" corrected by <b>${escHtml(req.employee.name)}</b> — ${before.toFixed(1)}h → ${newLogged.toFixed(1)}h (${escHtml(note)}).`);
  db.save();
  res.json({ task: taskForClient(t) });
});

// Correct a task's display name — same access as editing its dates/estimate
// (whoever manages the assignee). Mainly for a garbled title left over from
// Slack "Convert to Task" pulling raw Slack markup through (e.g.
// "<mailto:x@y.com|x@y.com> Rideshare client processing") before the
// deslackifyText() fix in connector.js — a task created before that fix
// keeps whatever got saved at the time, so this is how to clean one up.
app.post('/api/tasks/:id/correct-name', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if (!(isAdminRole(req.employee.accessRole) && canManageEmployee(state, req.employee, t.assignedTo))) {
    return res.status(403).json({ error: "You're not authorized to rename this task." });
  }
  const newName = String((req.body || {}).name || '').trim().slice(0, 200);
  if (!newName) return res.status(400).json({ error: 'Task name cannot be empty.' });
  const before = t.name;
  if (before === newName) return res.json({ task: taskForClient(t) });
  t.nameHistory = t.nameHistory || [];
  t.nameHistory.push({ at: new Date().toISOString(), by: req.employee.name, from: before, to: newName });
  t.name = newName;
  logEvent(state, t.assignedTo, `Task renamed by <b>${escHtml(req.employee.name)}</b> — "${escHtml(before)}" → "${escHtml(newName)}".`);
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
  const r = applyReassign(state, t, req.employee, (req.body || {}).newAssigneeId, (req.body || {}).reason);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ task: taskForClient(t) });
});
function applyReassign(state, t, actor, newAssigneeId, reason) {
  const req = { employee: actor };
  const fail = (status, error) => ({ status, error });
  if (t.status === 'completed') return fail(400, 'Completed tasks cannot be reassigned.');
  // Both ends of a reassignment go through the same managesIds boundary
  // assignableEmployees() already enforces for brand-new assignments: the
  // acting admin must manage the CURRENT assignee (or be superadmin) as
  // well as the new one — otherwise any admin could pull a task out of a
  // team they have no authority over just because the destination is on
  // their own team.
  if (!canManageEmployee(state, req.employee, t.assignedTo)) return fail(403, "You're not authorized to reassign this employee's task.");
  const newEmp = findEmployee(state, newAssigneeId);
  if (!newEmp) return fail(400, 'Employee not found.');
  if (newAssigneeId === t.assignedTo) return fail(400, 'Task is already assigned to this person.');
  const allowed = assignableEmployees(state, req.employee).some(e => e.id === newAssigneeId);
  if (!allowed) return fail(403, "You're not authorized to reassign to this person.");
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
  notify(state, newAssigneeId, 'assigned', `${req.employee.name} reassigned "${t.name}" to you — accept it or propose a new date.`, t.id);
  logEvent(state, newAssigneeId, `Task "${escHtml(t.name)}" reassigned from <b>${fromEmp ? escHtml(fromEmp.name) : '—'}</b> to <b>${escHtml(newEmp.name)}</b> — approval needed before the clock starts.${reworkNote}${reason ? ' Reason: ' + escHtml(reason) : ''}`, {
    client: t.clientName, clientDate: t.clientDate, internalDeadline: t.internalDeadline, reassignReason: reason || null
  });
  db.save();
  return { ok: true };
}

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
  const sinceISO = Number.isFinite(days) && days > 0
    ? new Date(new Date(todayISO() + 'T00:00:00Z').getTime() - days * 86400000).toISOString().slice(0, 10) : null;
  const rows = state.employees.map(emp => {
    const assignedToMe = state.tasks.filter(t => t.assignedTo === emp.id);
    const assignedByMe = state.tasks.filter(t => t.assignedBy === emp.id);
    const delivered = assignedToMe.filter(t => t.status === 'completed' && (!sinceISO || nzDay(t.completedAt) >= sinceISO));
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
    queries: (t.queries || []).filter(q => !q.dismissedAt).map(q => ({
      reasonCode: q.reasonCode, source: q.source, sentAt: q.sentAt, sentTs: q.sentTs || null, replyAt: q.replyAt, replyTs: q.replyTs || null, resumedAt: q.resumedAt, resumedTs: q.resumedTs || null, dismissedAt: q.dismissedAt || null, dismissedReason: q.dismissedReason || null,
      ...cal.queryShift(q, todayISO()),
    })),
    loggedHours: Math.round(liveElapsedHours(t) * 100) / 100, tatHours: t.tat || 0,
  }));
  res.json({ rows, assignments });
});

// The retired P3 composite-score (five weighted factors) and P4 allocation
// scorecard used to live here — removed entirely as part of the
// productivity rebuild (see productivityQualifies/productivityFor below).

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

// Shapes one task into a drill-down row — client, allocated (the frozen
// snapshot, not live tat), status, the three-stage responsibility
// breakdown, credited hours, and why (or why not).
function productivityTaskRow(t, result) {
  return {
    id: t.id, name: t.name, clientName: t.clientName && String(t.clientName).toLowerCase() !== 'internal' ? t.clientName : (t.kind === 'internal' ? 'Admin task' : '—'),
    kind: t.kind, status: t.status,
    allocatedHours: Number(t.productivityAllocatedHoursSnapshot) || 0,
    internalDeadline: t.internalDeadline, completedAt: t.completedAt,
    clientDate: t.clientDate, sentToClientAt: t.sentToClientAt,
    stages: result.stages,
    creditedHours: result.creditedHours, qualifies: result.qualifies,
    exclusionReason: result.exclusionReason,
    dataException: !!result.dataException,
    zeroHourTask: !!result.zeroHourTask,
    rule: result.rule || null,
    qualifyingEventType: result.qualifyingEventType || null,
    qualifyingEventAt: result.qualifyingEventAt || null,
    reviewedAt: t.reviewStatus === 'clean' ? t.reviewedAt : null,
    noReviewAuthorized: !!t.noReviewAuthorizedAt,
    reportStatus: result.stages ? result.stages.sender : null, // informational only, never the exclusion reason
  };
}
// Open/unfinished work — spec §6's Exceptions section. Deliberately NOT
// period-scoped (always "what's outstanding right now"), unlike the
// qualified/excluded tables above which are bucketed by period.
function productivityOpenRow(state, t) {
  const responsible = findEmployee(state, t.assignedTo);
  return {
    id: t.id, name: t.name, clientName: t.clientName && String(t.clientName).toLowerCase() !== 'internal' ? t.clientName : (t.kind === 'internal' ? 'Admin task' : '—'),
    allocatedHours: Number(t.tat) || 0, status: t.status,
    internalDeadline: t.internalDeadline, clientDate: t.clientDate,
    holdReason: t.holdReason || null, responsibleName: responsible ? responsible.name : '—',
    lastActivity: t.heldAt || t.reworkStartedAt || t.acceptedAt || t.assignedAt || null,
    nextAction: OPEN_STATUS_REASONS[t.status] || t.status,
  };
}
// Shared / test / placeholder logins are not productive employees: they never add capacity or output to Productivity — unless a
// superadmin has explicitly marked them (countsInProductivity === true) or explicitly excluded a real person (=== false).
// Walks the period day by day and reports exactly what was removed from capacity, using the same rules as dayCapacity():
//   scheduled working days (every day the firm's week includes) − public holidays = working days
//   − approved leave (a half day counts 0.5) − workshop days (never also counted as leave) − custom-hours reductions = final eligible days
//   capacity hours = final eligible days × the working day (7 h).  A deduction is shown only if it was actually made.
function capacityBreakdownOf(state, emp, fromISO, toISO, capacityHours) {
  const base = baseHoursOf(emp), days = [];
  if (fromISO && toISO && toISO >= fromISO) {
    let cur = new Date(fromISO + 'T00:00:00Z');
    const end = new Date(toISO + 'T00:00:00Z').getTime();
    while (cur.getTime() <= end) {
      const iso = cur.toISOString().slice(0, 10), scheduled = cur.getUTCDay() !== 0;   // Sunday is the firm's weekly off
      const holiday = scheduled && !cal.isWorkingDay(iso);
      const status = scheduled && !holiday ? attendanceStatus(state, emp, iso) : 'PRESENT';
      days.push({ scheduled, holiday, status, customHours: status === 'CUSTOM' ? Number((approvedLeaveOn(state, emp.id, iso) || {}).hours || 0) : 0 });
      cur = new Date(cur.getTime() + 86400000);
    }
  }
  const b = prodRules.capacityDays(days, base);
  return { ...b, reconciles: Math.abs(b.capacityHours - capacityHours) < 0.011 };
}
function isNonProductiveAccount(emp) {
  if (!emp) return true;
  if (emp.countsInProductivity === true) return false;
  if (emp.countsInProductivity === false) return true;
  return isSystemAccount(emp) || String(emp.email || '').toLowerCase() === 'hr@elitetaxation.co.nz';
}
function productivityFor(state, empIds, fromISO, toISO) {
  empIds = empIds.filter(id => !isNonProductiveAccount(findEmployee(state, id)));
  const from = fromISO, to = toISO;
  const inRange = d => d && nzDay(d) >= from && nzDay(d) <= to;
  const workingDays = Math.max(0, cal.workingDaysBetween(cal.addWorkingDays(from, -1), to)); // inclusive of `to`
  // Firm-wide Workshop Saturdays inside the period — same for every
  // employee, since the calendar itself is firm-wide (see /api/capacity-calendar).
  // Surfaced separately from leaveDays so the capacity card can explain
  // BOTH kinds of deduction; without this, a workshop-only gap between
  // "N working days" and the displayed hours had no visible explanation.
  const r2 = n => Math.round(n * 100) / 100;
  const v2At = state.productivityV2EffectiveAt || PRODUCTIVITY_V2_EFFECTIVE_AT_DEFAULT;

  return empIds.map(id => {
    const emp = findEmployee(state, id) || { id, name: '—' };
    const capacityHours = capacityHoursBetween(state, emp, from, to);
    const leave = leaveDaysBetween(state, id, from, to);
    const workshopDays = workshopDaysBetween(state, id, from, to);

    // Compute qualification ONCE per completed task (reused for period
    // bucketing, the qualified/excluded split, and the commitment stat) —
    // never re-derived, so it can't drift between the different readings.
    const allCompleted = state.tasks.filter(t => t.assignedTo === id && t.status === 'completed');
    const computed = allCompleted.map(t => {
      const reportInfo = reportSentFor(t);
      const result = productivityQualifies(state, t, v2At, reportInfo);
      return { t, reportInfo, result };
    });
    // Bucketed by their qualifying event date, not completedAt.
    const done = computed.filter(x => inRange(x.result.periodDate || x.t.completedAt));
    const qualified = [], excluded = [];
    done.forEach(({ t, result }) => {
      (result.qualifies ? qualified : excluded).push(productivityTaskRow(t, result));
    });
    // On-hold "month close" partial credits (see closeMonthOnHoldCredits) —
    // actual hours banked for a task that was on hold at a manual
    // month-close, credited to whichever period the close itself happened
    // in. Independent of the task's own eventual qualifying event, which
    // still earns credit later too, minus whatever was already banked here
    // (see productivityQualifies) — so the two together always add up to
    // no more than the task's original estimate, never double-counted.
    state.tasks.filter(t => t.assignedTo === id).forEach(t => {
      (t.monthCloseCredits || []).forEach(c => {
        // Credited to the month that was closed (its last day), NOT the day
        // the close button happened to be pressed — closing September on
        // 2 October must still land in September's numbers.
        if (!inRange(c.creditDate || c.closedAt)) return;
        qualified.push({
          id: t.id + ':close:' + c.period, name: t.name, clientName: t.clientName && String(t.clientName).toLowerCase() !== 'internal' ? t.clientName : (t.kind === 'internal' ? 'Admin task' : '—'),
          kind: t.kind, status: t.status,
          allocatedHours: Number(t.productivityAllocatedHoursSnapshot) || 0,
          internalDeadline: t.internalDeadline, completedAt: null,
          clientDate: t.clientDate, sentToClientAt: null,
          stages: { processor: null, reviewer: null, sender: null },
          creditedHours: c.hours, qualifies: true,
          exclusionReason: null, dataException: false, zeroHourTask: c.hours === 0,
          rule: 'on_hold_month_close', qualifyingEventType: 'month_close', qualifyingEventAt: c.creditDate || c.closedAt,
          reviewedAt: null, noReviewAuthorized: false, reportStatus: null,
        });
      });
    });
    const qualifiedHours = r2(qualified.reduce((s, x) => s + x.creditedHours, 0));
    const rawPct = capacityHours > 0 ? (qualifiedHours / capacityHours) * 100 : null;
    // One decimal, capped at 100 — anything qualified beyond capacity shows
    // as "additional qualifying output" instead of pushing past 100%; the
    // raw (uncapped) figure is exposed alongside it, never hidden.
    const productivityPct = rawPct == null ? null : Math.min(100, Math.round(rawPct * 10) / 10);
    const rawUtilisationPct = rawPct == null ? null : Math.round(rawPct * 10) / 10;
    const additionalHours = rawPct != null && rawPct > 100 ? r2(qualifiedHours - capacityHours) : 0;

    // Internal Commitment — fully separate from Productivity. Over every
    // completed task with both timestamps, in period, independent of
    // whether it went on to qualify (so review/send delays don't hide a
    // processor's own on-time record).
    const withCommitment = done.filter(x => x.t.completedAt && x.t.internalDeadline);
    const commitmentMet = withCommitment.filter(x => x.result.stages.processor === 'met').length;
    const commitmentTotal = withCommitment.length;
    const commitmentPct = commitmentTotal > 0 ? Math.round((commitmentMet / commitmentTotal) * 1000) / 10 : null;

    // Report Sent — fully separate, 5 pts per eligible client report.
    let reportsRequired = 0, reportsOnTime = 0, reportsLate = 0, reportsReadyNotSent = 0, reportsNoDate = 0, reportPoints = 0, reportMaxPoints = 0;
    done.forEach(({ reportInfo: r }) => {
      if (!r) return;
      if (r.reason === 'no_external_date') { reportsNoDate++; return; }
      if (r.reason === 'sending_not_required') return; // excluded from scoring entirely
      reportsRequired++; reportMaxPoints += 5; reportPoints += r.points;
      if (r.outcome === 'sent_on_time') reportsOnTime++;
      else if (r.outcome === 'sent_late') reportsLate++;
      else if (r.outcome === 'not_sent') reportsReadyNotSent++;
    });

    // Open/unfinished work — current state, not period-scoped.
    const openWork = state.tasks.filter(t => t.assignedTo === id && t.status !== 'completed');
    const excludedRows = excluded.concat(
      openWork.filter(t => t.internalDeadline && inRange(t.internalDeadline))
        .map(t => productivityTaskRow(t, { qualifies: false, creditedHours: 0, exclusionReason: OPEN_STATUS_REASONS[t.status] || t.status, stages: { processor: null, reviewer: null, sender: null } }))
    );

    // Capacity not converted into completed output — the gap could be
    // truly unallocated capacity, OR work already assigned that's still in
    // progress or awaiting review; never labelled a blanket employee
    // penalty. assignedOpenHours sums both the still-open tasks (live tat)
    // and the completed-but-excluded tasks (frozen snapshot) due in period.
    const capacityNotConverted = r2(Math.max(0, capacityHours - qualifiedHours));
    const assignedOpenHours = r2(excludedRows.reduce((s, r) => s + (r.allocatedHours || 0), 0));
    // The breakdown must ADD UP to the total — no overlap, nothing invented. Fill in order: still-open work, then completed work that
    // did not qualify, then whatever is left is genuinely unallocated capacity. (Open work larger than the gap just fills it.)
    const nc = prodRules.splitNotConverted(capacityNotConverted,
      excludedRows.filter(r => r.status !== 'completed').reduce((n, r) => n + (r.allocatedHours || 0), 0),
      excludedRows.filter(r => r.status === 'completed').reduce((n, r) => n + (r.allocatedHours || 0), 0));
    const openPart = nc.openAllocated, trulyUnallocatedHours = nc.unallocated, notConvertedBreakdown = nc;
    // The capacity days, shown in full: scheduled → holidays → leave → workshop → final eligible days → hours (days × the 7 h day).
    const capacityBreakdown = capacityBreakdownOf(state, emp, from, to, capacityHours);

    return {
      id, name: emp.name, team: emp.team || '—', jobTitle: emp.jobTitle || '', group: prodGroupOf(emp),
      capacityHours: r2(capacityHours), workingDays, leaveDays: leave.equivalent, workshopDays,
      qualifiedHours, productivityPct, rawUtilisationPct, additionalHours,
      notScorable: capacityHours <= 0,
      commitmentMet, commitmentTotal, commitmentPct,
      reportsRequired, reportsOnTime, reportsLate, reportsReadyNotSent, reportsNoDate,
      reportPoints, reportMaxPoints,
      reportSentRate: reportMaxPoints > 0 ? Math.round((reportPoints / reportMaxPoints) * 1000) / 10 : null,
      outstandingReports: reportsReadyNotSent + reportsLate,
      qualifiedTasks: qualified, excludedTasks: excludedRows, openWork: openWork.map(t => productivityOpenRow(state, t)),
      capacityNotConverted, assignedOpenHours: openPart, trulyUnallocatedHours, notConvertedBreakdown, capacityBreakdown,
    };
  });
}

app.get('/api/productivity', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const clamp = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)) ? s.slice(0, 10) : null;
  const to = clamp(req.query.to) || todayISO();
  const requestedFrom = clamp(req.query.from)
    || new Date(new Date(to + 'T00:00:00Z').getTime() - 90 * 86400000).toISOString().slice(0, 10);
  if (requestedFrom > to) return res.status(400).json({ error: 'from must be on or before to.' });
  // No real data before go-live — count capacity / working days / worked
  // hours from 7 Sept 2026 on, never from the fiscal-year start.
  const from = floorAtGoLive(requestedFrom, to);

  // scope: an employee sees only themselves; an admin their reports + self;
  // a superadmin the whole firm (or ?scope=me to narrow).
  let ids;
  // A superadmin who runs a team on the new dashboard (Parvinder) sees HIS TEAM by default — ?scope=firm widens it to everyone.
  const teamManager = me.accessRole === 'admin' || (me.accessRole === 'superadmin' && !!me.dashboardV2 && !firmWide(me) && req.query.scope !== 'firm');
  if (req.query.scope === 'me' || me.accessRole === 'employee') ids = [me.id];
  else if (teamManager) ids = [...new Set([me.id, ...teamRoster(state, me).map(e => e.id)])];
  else ids = state.employees.map(e => e.id);
  const scopeLabel = (req.query.scope === 'me' || me.accessRole === 'employee') ? 'me' : (teamManager ? 'team' : 'firm');
  // ?group=processor|marketing narrows to one productivity group (totals
  // included). Admin staff are measured by calls/emails instead — see
  // /api/admin-activity — so they're not shown on the hours-based view.
  const grp = String(req.query.group || '');
  if (PROD_GROUPS.includes(grp)) ids = ids.filter(id => prodGroupOf(findEmployee(state, id)) === grp);

  const people = productivityFor(state, ids, from, to);
  const sum = (k) => people.reduce((s, p) => s + (p[k] || 0), 0);
  // Team/firm totals: summed hours over summed capacity, never an average of
  // individual percentages — a person with more capacity should weigh more
  // in the team figure, not count the same as everyone else.
  const totalQualified = sum('qualifiedHours'), totalCap = sum('capacityHours');
  const rawTotalPct = totalCap > 0 ? (totalQualified / totalCap) * 100 : null;
  const totalReportPoints = sum('reportPoints'), totalReportMax = sum('reportMaxPoints');
  const totalCommitmentMet = sum('commitmentMet'), totalCommitmentTotal = sum('commitmentTotal');
  // workingDays is the same shared calendar fact for everyone in one call
  // (only per-day capacity *deductions* are person-specific) — copying it
  // straight onto totals (rather than never including it) is the fix for
  // the team-summary card's "undefined working days" display bug.
  const totalWorkingDays = people.length ? people[0].workingDays : Math.max(0, cal.workingDaysBetween(cal.addWorkingDays(from, -1), to));
  // same firm-wide fact as workingDays above — not a per-person sum.
  const totalWorkshopDays = people.length ? Math.max(...people.map(p => p.workshopDays)) : (state.capacityCalendarAdjustments || [])
    .filter(a => a.active && a.type === 'WORKSHOP' && a.date >= from && a.date <= to).length;

  res.json({
    from, to, requestedFrom, goLive: SYSTEM_GO_LIVE,
    goLiveApplied: from !== requestedFrom,
    fiscalYearStart: floorAtGoLive(fiscalYearStart(to), to),
    v2EffectiveAt: state.productivityV2EffectiveAt || PRODUCTIVITY_V2_EFFECTIVE_AT_DEFAULT,
    v3EffectiveAt: state.productivityV3EffectiveAt || PRODUCTIVITY_V3_EFFECTIVE_AT_DEFAULT,
    scope: scopeLabel,
    // Show everyone in scope, including zero-output people, with a plain
    // reason rather than hiding them.
    people,
    totals: {
      capacityHours: Math.round(totalCap * 100) / 100,
      workingDays: totalWorkingDays, leaveDays: Math.round(sum('leaveDays') * 100) / 100,
      workshopDays: totalWorkshopDays,
      qualifiedHours: Math.round(totalQualified * 100) / 100,
      productivityPct: rawTotalPct == null ? null : Math.min(100, Math.round(rawTotalPct * 10) / 10),
      rawUtilisationPct: rawTotalPct == null ? null : Math.round(rawTotalPct * 10) / 10,
      additionalHours: rawTotalPct != null && rawTotalPct > 100 ? Math.round((totalQualified - totalCap) * 100) / 100 : 0,
      notScorable: totalCap <= 0,
      commitmentMet: totalCommitmentMet, commitmentTotal: totalCommitmentTotal,
      commitmentPct: totalCommitmentTotal > 0 ? Math.round((totalCommitmentMet / totalCommitmentTotal) * 1000) / 10 : null,
      reportsRequired: sum('reportsRequired'), reportsOnTime: sum('reportsOnTime'),
      reportsLate: sum('reportsLate'), reportsReadyNotSent: sum('reportsReadyNotSent'), reportsNoDate: sum('reportsNoDate'),
      reportPoints: totalReportPoints, reportMaxPoints: totalReportMax,
      reportSentRate: totalReportMax > 0 ? Math.round((totalReportPoints / totalReportMax) * 1000) / 10 : null,
      outstandingReports: sum('outstandingReports'),
      capacityNotConverted: Math.round(sum('capacityNotConverted') * 100) / 100,
      assignedOpenHours: Math.round(sum('assignedOpenHours') * 100) / 100,
      trulyUnallocatedHours: Math.round(sum('trulyUnallocatedHours') * 100) / 100,
      notConvertedBreakdown: (() => {
        const k = f => Math.round(people.reduce((n, p) => n + ((p.notConvertedBreakdown || {})[f] || 0), 0) * 100) / 100;
        const b = { total: k('total'), openAllocated: k('openAllocated'), nonQualifyingCompleted: k('nonQualifyingCompleted'), unallocated: k('unallocated') };
        return { ...b, reconciles: people.every(p => (p.notConvertedBreakdown || {}).reconciles !== false) && Math.abs(b.openAllocated + b.nonQualifyingCompleted + b.unallocated - b.total) < 0.05 };
      })(),
    },
  });
});

// Month-end: banks the ACTUAL hours logged so far on every task still on
// hold as Productivity credit for the month being closed — otherwise a task
// held through month-end earns nothing until it finally completes (maybe
// months later, maybe never). Only credits the DELTA since the last close,
// so a task held across several month-ends gets each month its own slice,
// and idempotent per (task, month). The credit is dated the LAST DAY of the
// month being closed (creditDate), not the day the button was pressed, so
// closing September on 2 October still lands in September's numbers. See
// productivityQualifies for how this reconciles against the task's own
// eventual qualifying-event credit.
function periodBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}
function closeMonthOnHoldCredits(state, period, byEmployeeId) {
  const credited = [];
  const creditDate = periodBounds(period).to;
  (state.tasks || []).filter(t => t.status === 'on_hold').forEach(t => {
    t.monthCloseCredits = t.monthCloseCredits || [];
    if (t.monthCloseCredits.some(c => c.period === period)) return;
    const alreadyBanked = t.monthCloseCredits.reduce((s, c) => s + (Number(c.hours) || 0), 0);
    const delta = Math.round(Math.max(0, (t.logged || 0) - alreadyBanked) * 100) / 100;
    if (delta <= 0) return;
    t.monthCloseCredits.push({ period, hours: delta, creditDate, closedAt: new Date().toISOString(), closedBy: byEmployeeId });
    credited.push({ taskId: t.id, taskName: t.name, assignedTo: t.assignedTo, hours: delta });
  });
  return credited;
}
// Reverses a month-end's hold credits entirely — strips every entry tagged
// with this exact period off every task, restoring things exactly as if the
// close never happened.
function undoMonthCloseCredits(state, period) {
  const reverted = [];
  (state.tasks || []).forEach(t => {
    if (!Array.isArray(t.monthCloseCredits) || !t.monthCloseCredits.length) return;
    const before = t.monthCloseCredits.length;
    t.monthCloseCredits = t.monthCloseCredits.filter(c => c.period !== period);
    if (t.monthCloseCredits.length !== before) reverted.push({ taskId: t.id, taskName: t.name, assignedTo: t.assignedTo });
  });
  return reverted;
}

// A frozen card for every employee for one month — what the month looked
// like at the moment it was finalised, so a late review or an edited task
// next week can't quietly rewrite last month's numbers. Hours-based figures
// (processors, marketing), calls/emails acknowledged (admin staff), marks
// and recognition for the month; the card shown depends on the person's
// group, but everything is stored for everyone.
function buildMonthlyCards(state, period) {
  const { from: from0, to } = periodBounds(period);
  const from = floorAtGoLive(from0, to);
  const { callsEmailsStats } = require('./connector');
  const prod = productivityFor(state, state.employees.map(e => e.id), from, to);
  const activity = {};
  callsEmailsStats(state, from, to).people.forEach(p => { activity[p.id] = p; });
  const inMonth = ts => { if (!ts) return false; const d = nzDay(ts); return d >= from0 && d <= to; };
  const r2 = n => Math.round(n * 100) / 100;
  return prod.map(p => {
    const act = activity[p.id] || { calls: { total: 0, ack: 0, notAck: 0 }, emails: { total: 0, ack: 0, notAck: 0 } };
    const mk = (state.marks || []).filter(m => m.toId === p.id && !m.voidedAt && inMonth(m.createdAt));
    const banked = state.tasks.filter(t => t.assignedTo === p.id)
      .reduce((s, t) => s + (t.monthCloseCredits || []).filter(c => c.period === period).reduce((x, c) => x + (Number(c.hours) || 0), 0), 0);
    return {
      id: p.id, name: p.name, team: p.team, jobTitle: p.jobTitle, group: p.group,
      productivity: {
        capacityHours: p.capacityHours, workingDays: p.workingDays, leaveDays: p.leaveDays,
        qualifiedHours: p.qualifiedHours, bankedHoldHours: r2(banked),
        productivityPct: p.productivityPct, rawUtilisationPct: p.rawUtilisationPct, additionalHours: p.additionalHours, notScorable: p.notScorable,
        commitmentMet: p.commitmentMet, commitmentTotal: p.commitmentTotal, commitmentPct: p.commitmentPct,
        reportsRequired: p.reportsRequired, reportsOnTime: p.reportsOnTime, reportsLate: p.reportsLate,
        reportPoints: p.reportPoints, reportMaxPoints: p.reportMaxPoints, reportSentRate: p.reportSentRate,
        qualifiedTasks: p.qualifiedTasks.map(t => ({ id: t.id, name: t.name, clientName: t.clientName, creditedHours: t.creditedHours, rule: t.rule, qualifyingEventAt: t.qualifyingEventAt })),
        excludedCount: p.excludedTasks.length, openCount: p.openWork.length,
      },
      activity: act,
      marks: {
        positive: mk.filter(m => m.points > 0).reduce((s, m) => s + m.points, 0),
        negative: mk.filter(m => m.points < 0).reduce((s, m) => s + m.points, 0),
        net: mk.reduce((s, m) => s + m.points, 0), count: mk.length,
      },
      recognition: {
        kudos: (state.kudos || []).filter(k => k.toId === p.id && inMonth(k.awardedAt)).length,
        points: (state.points || []).filter(x => x.toId === p.id && inMonth(x.awardedAt)).reduce((s, x) => s + (x.amount || 0), 0),
      },
    };
  });
}
function monthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
// Finalise a month: bank hold hours (see closeMonthOnHoldCredits), freeze a
// card for everyone, and tell each person theirs is ready. One action, and
// fully reversible with unfinalize-month while it's being checked.
app.post('/api/productivity/finalize-month', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const period = String((req.body || {}).period || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM, e.g. 2026-09.' });
  if (periodBounds(period).to >= todayISO()) return res.status(400).json({ error: "That month hasn't finished yet." });
  state.monthlyCards = state.monthlyCards || {};
  if (state.monthlyCards[period]) return res.status(409).json({ error: `${monthLabel(period)} is already finalised — undo it first to redo it.` });
  const credited = closeMonthOnHoldCredits(state, period, req.employee.id);
  const cards = buildMonthlyCards(state, period);
  const b = periodBounds(period);
  state.monthlyCards[period] = { period, from: b.from, to: b.to, finalizedAt: new Date().toISOString(), finalizedBy: req.employee.id, cards };
  state.employees.forEach(e => notify(state, e.id, 'card', `Your ${monthLabel(period)} monthly card is ready.`, null, { noDedupe: true }));
  db.save();
  res.json({
    ok: true, period, cards: cards.length, tasksCredited: credited.length,
    hoursBanked: Math.round(credited.reduce((s, c) => s + c.hours, 0) * 100) / 100,
  });
});
app.post('/api/productivity/unfinalize-month', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const period = String((req.body || {}).period || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM, e.g. 2026-09.' });
  const had = !!(state.monthlyCards && state.monthlyCards[period]);
  if (had) delete state.monthlyCards[period];
  const reverted = undoMonthCloseCredits(state, period);
  if (had || reverted.length) db.save();
  res.json({ ok: true, period, wasFinalised: had, tasksReverted: reverted.length });
});
// Who can see which cards: an employee their own, an admin their team's, a
// superadmin everyone's.
function cardScopeIds(state, me) {
  if (me.accessRole === 'superadmin') return null; // everyone
  const ids = new Set([me.id]);
  if (me.accessRole === 'admin') teamRoster(state, me).forEach(e => ids.add(e.id));
  return ids;
}
app.get('/api/monthly-cards', requireAuth, (req, res) => {
  const state = db.get();
  const periods = Object.values(state.monthlyCards || {}).map(c => ({
    period: c.period, label: monthLabel(c.period), finalizedAt: c.finalizedAt,
    finalizedBy: (findEmployee(state, c.finalizedBy) || {}).name || '—',
  })).sort((a, b) => b.period.localeCompare(a.period));
  res.json({ periods });
});
app.get('/api/monthly-cards/:period', requireAuth, (req, res) => {
  const state = db.get();
  const c = (state.monthlyCards || {})[req.params.period];
  if (!c) return res.status(404).json({ error: 'That month has not been finalised.' });
  const scope = cardScopeIds(state, req.employee);
  res.json({
    period: c.period, label: monthLabel(c.period), from: c.from, to: c.to, finalizedAt: c.finalizedAt,
    finalizedBy: (findEmployee(state, c.finalizedBy) || {}).name || '—',
    cards: c.cards.filter(x => !scope || scope.has(x.id)),
  });
});
// Add the time someone actually spent on a task while it's on hold — the
// clock isn't running on a held task, so work done around it (chasing the
// client, preparing the file) never gets logged unless it's entered here.
// ADDS to the logged hours (unlike the superadmin "correct logged hours",
// which sets an absolute value) and is kept in the task's history. Enter
// it before month-end so it's banked for that month.
app.post('/api/tasks/:id/add-hours', requireAuth, (req, res) => {
  const state = db.get();
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const me = req.employee;
  if (t.status !== 'on_hold') return res.status(400).json({ error: 'Time can be added to a task while it is on hold.' });
  if (t.assignedTo !== me.id && me.accessRole !== 'superadmin' && !canManageEmployee(state, me, t.assignedTo)) {
    return res.status(403).json({ error: 'Only the assignee, or a manager over them, can add time.' });
  }
  const h = Math.round(Number((req.body || {}).hours) * 100) / 100;
  if (!(h > 0) || h > 200) return res.status(400).json({ error: 'Enter between 0 and 200 hours.' });
  const note = String((req.body || {}).note || '').trim().slice(0, 200);
  const before = Number(t.logged) || 0;
  t.logged = Math.round((before + h) * 100) / 100;
  t.loggedHistory = t.loggedHistory || [];
  t.loggedHistory.push({ at: new Date().toISOString(), by: me.name, from: before, to: t.logged, added: h, note: note || null });
  logEvent(state, t.assignedTo, `<b>${escHtml(me.name)}</b> added <b>${h}h</b> of time spent to "${escHtml(t.name)}" (on hold) — now ${t.logged.toFixed(1)}h.`);
  db.save();
  res.json({ task: taskForClient(t) });
});
// Which productivity model each person is measured by — see prodGroupOf.
app.post('/api/employees/:id/prod-group', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const emp = findEmployee(state, req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  const group = String((req.body || {}).group || '');
  if (!PROD_GROUPS.includes(group)) return res.status(400).json({ error: 'Group must be processor, admin, marketing or management.' });
  emp.prodGroup = group;
  db.save();
  res.json({ employee: publicEmployee(emp, true) });
});
// Admin-group productivity: measured by calls and emails acknowledged, not
// hours. This is the data-collection phase — counts and acknowledgement
// rates per person, with a per-person drill-down — before a scoring rule is
// layered on. Scoped like Productivity: employee self, admin their team,
// superadmin everyone.
function adminActivityRange(req) {
  const clamp = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)) ? s.slice(0, 10) : null;
  const to = clamp(req.query.to) || todayISO();
  const requestedFrom = clamp(req.query.from) || to.slice(0, 7) + '-01';
  return { from: floorAtGoLive(requestedFrom, to), to };
}
const ackRate = (ack, total) => total > 0 ? Math.round((ack / total) * 1000) / 10 : null;
app.get('/api/admin-activity', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const { from, to } = adminActivityRange(req);
  const { callsEmailsStats } = require('./connector');
  const scope = cardScopeIds(state, me);
  const stats = {};
  callsEmailsStats(state, from, to).people.forEach(p => { stats[p.id] = p; });
  const inScope = e => !scope || scope.has(e.id);
  const people = state.employees.filter(e => prodGroupOf(e) === 'admin' && inScope(e)).map(e => {
    const s = stats[e.id] || { calls: { total: 0, ack: 0, notAck: 0 }, emails: { total: 0, ack: 0, notAck: 0 } };
    return { id: e.id, name: e.name, team: e.team || '—', calls: s.calls, emails: s.emails,
      callsRate: ackRate(s.calls.ack, s.calls.total), emailsRate: ackRate(s.emails.ack, s.emails.total) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const sum = (k, f) => people.reduce((s, p) => s + p[k][f], 0);
  const totals = {
    calls: { total: sum('calls', 'total'), ack: sum('calls', 'ack'), notAck: sum('calls', 'notAck') },
    emails: { total: sum('emails', 'total'), ack: sum('emails', 'ack'), notAck: sum('emails', 'notAck') },
  };
  totals.callsRate = ackRate(totals.calls.ack, totals.calls.total);
  totals.emailsRate = ackRate(totals.emails.ack, totals.emails.total);
  // People who actually took calls/emails but aren't in the Admin group yet —
  // offered to the superadmin as a one-click "set as Admin".
  const suggested = me.accessRole !== 'superadmin' ? [] : Object.values(stats)
    .map(s => findEmployee(state, s.id)).filter(e => e && prodGroupOf(e) !== 'admin')
    .map(e => ({ id: e.id, name: e.name }));
  res.json({ from, to, people, totals, suggested });
});
app.get('/api/admin-activity/:personId', requireAuth, (req, res) => {
  const state = db.get();
  const scope = cardScopeIds(state, req.employee);
  const emp = findEmployee(state, req.params.personId);
  if (!emp || (scope && !scope.has(emp.id))) return res.status(404).json({ error: 'Not found.' });
  const { from, to } = adminActivityRange(req);
  const { callsEmailsDetail } = require('./connector');
  res.json({ from, to, name: emp.name, ...callsEmailsDetail(state, emp.id, from, to) });
});

// Productivity rebuild removed the composite-score weights editor and the
// allocation-notes scorecard entirely (both were part of the retired P3/P4
// system) — GET/PUT /api/productivity/weights and the /api/allocation-notes
// endpoints are gone. state.productivityWeights is no longer written to;
// state.allocationNotes[] is left in place, untouched, as a read-only
// historical record (nothing reads or writes it any more).

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
  res.json({ workload: rows });
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

  if (!mirroring && isAdminRole(me.accessRole) && teamsOf(emp).some(t => t !== 'Unassigned')) {
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
// An unread alert about something that's since been dealt with ("due soon and
// not started" once it's done, "accept this task" once accepted…) is no longer
// news — it's left out of the inbox and the unread count. Nothing is deleted
// and seenAt is never touched, so "did they open it" stays truthful.
function notificationResolved(state, n) {
  if (!n.taskId) return false;
  const t = findTask(state, n.taskId);
  if (!t) return true;
  switch (n.type) {
    case 'due': return t.status === 'completed' || t.status === 'on_hold' || !!t.startedAt || t.assignedTo !== n.empId;
    case 'assigned': return t.assignedTo !== n.empId || t.status !== 'awaiting_acceptance';
    case 'nudge': return t.status === 'completed' || t.assignedTo !== n.empId;
    case 'review': return t.status !== 'completed' || !!t.reviewStatus || t.reviewerId !== n.empId;
    case 'rework': return t.assignedTo !== n.empId || t.status !== 'awaiting_acceptance';
    case 'send_report': return !t.awaitingClientDecision || t.reportSendOwner !== n.empId;
    case 'profit_confirm': return t.profitConfirmStatus !== 'pending' && !t.awaitingClientDecision;
    case 'attention': { const ak = String(n.alertKey || ''), i = ak.lastIndexOf('|'); const a = (state.managerAlerts || {})[ak.slice(0, i)]; return !a || !!a.resolvedAt || String(a.episodes) !== ak.slice(i + 1); }   // (task ids contain '#', so '|' separates the episode)   // resolved, or superseded by a newer episode
    default: return false;
  }
}
app.get('/api/notifications', requireAuth, (req, res) => {
  const state = db.get();
  const mine = (state.notifications || []).filter(n => n.empId === req.employee.id && (n.seenAt || !notificationResolved(state, n)))
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
// ET-CRM CUT-OVER. ET-CRM is authoritative for attendance and leave. Until a
// superadmin flips a switch (Admin → ET-CRM connection) the Task Manager's own
// Punch In/Out and its own leave booking keep working exactly as before. Each
// switch refuses to turn ON until real data of that kind has arrived from
// ET-CRM, and can always be turned OFF again (instant rollback).
//   attendance ON → no Punch In/Out, no manual attendance edits, no device ingest
//   leave ON      → leave can no longer be booked / approved / changed here
// Independently of the switches, a day that ET-CRM supplied is never
// overwritten by a punch, an edit or a device reading.
// ---------------------------------------------------------------------------
function crmCutover(state) {
  const c = (state && state.crmSync && state.crmSync.cutover) || {};
  return { attendance: !!c.attendance, leave: !!c.leave };
}
const crmOwnsDay = day => !!day && day.source === 'crm';
const CLOCK_BY_CRM = { code: 'CLOCK_MANAGED_BY_CRM', error: 'Attendance now comes from ET-CRM — there is no Punch In/Out here. Ask HR to correct a day in ET-CRM.' };
const LEAVE_BY_CRM = { code: 'LEAVE_MANAGED_BY_CRM', error: 'Leave is managed in ET-CRM. Book or change it there — it shows here automatically once approved.' };
function crmEvidence(state, kind) {
  const c = (((state.crmSync || {}).counts) || {})[kind] || {};
  return { events: (c.created || 0) + (c.updated || 0) + (c.ok || 0), lastOk: c.lastOk || null };
}
function crmCutoverStatus(state) {
  const cut = crmCutover(state), s = (state.crmSync && state.crmSync.cutover) || {};
  const emps = state.employees || [];
  const recentErrors = kind => ((state.crmSync || {}).events || []).filter(e => e.kind === kind && ['error', 'invalid', 'conflict', 'unlinked'].includes(e.outcome)).slice(0, 5).map(e => ({ at: e.at, outcome: e.outcome, note: e.note }));
  const part = (kind, on, at) => {
    const ev = crmEvidence(state, kind);
    return { on, at: at || null, events: ev.events, lastOk: ev.lastOk, ready: ev.events > 0 || (kind === 'leave' && !!s.leaveConfirmedNoneAt),
      linkedEmployees: emps.filter(e => e.crmUserId).length, unlinkedEmployees: emps.filter(e => !e.crmUserId).length, recentErrors: recentErrors(kind) };
  };
  const leave = part('leave', cut.leave, s.leaveAt);
  leave.confirmedNoLeave = !!s.leaveConfirmedNoneAt;
  return { attendance: part('attendance', cut.attendance, s.attendanceAt), leave };
}
// What the browser needs to know to hide the clock / the leave form.
app.get('/api/crm-mode', requireAuth, (req, res) => {
  const cut = crmCutover(db.get());
  res.json({ attendanceFromCrm: cut.attendance, leaveFromCrm: cut.leave });
});
app.post('/api/admin/crm-sync/cutover', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const sync = state.crmSync = state.crmSync || { events: [], counts: {} };
  sync.cutover = sync.cutover || {};
  const b = req.body || {};
  const now = new Date().toISOString();
  const labels = { attendance: 'attendance (Punch In/Out)', leave: 'leave booking' };
  for (const kind of ['attendance', 'leave']) {
    if (typeof b[kind] !== 'boolean') continue;
    if (b[kind] && !crmEvidence(state, kind).events) {
      // No leave has arrived — fine ONLY if there is genuinely none: a founder must say so, and it is recorded.
      if (kind === 'leave' && b.confirmNoLeave === true) {
        sync.cutover.leaveConfirmedNoneAt = now; sync.cutover.leaveConfirmedNoneBy = req.employee.id;
        logEvent(state, req.employee.id, 'Confirmed there is <b>no current leave</b> in ET-CRM, so leave can be switched on before any leave event has arrived.');
      } else {
        return res.status(409).json({ error: `No ${kind} has arrived from ET-CRM yet, so ${labels[kind]} stays here. Switch on once a real ${kind} event has been received` + (kind === 'leave' ? ', or confirm that there is currently no leave in ET-CRM.' : '.'), code: kind === 'leave' ? 'CONFIRM_NO_LEAVE_POSSIBLE' : 'NO_EVIDENCE' });
      }
    }
    if (!!sync.cutover[kind] === b[kind]) continue;
    sync.cutover[kind] = b[kind];
    sync.cutover[kind + 'At'] = now;
    sync.cutover.by = req.employee.id;
    logEvent(state, req.employee.id, `Switched <b>${b[kind] ? 'ON' : 'OFF'}</b> ET-CRM as the source for ${labels[kind]}.`);
  }
  db.save();
  res.json(crmCutoverStatus(state));
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
function getAttendanceDay(state, empId, date) {
  state.attendance[empId] = state.attendance[empId] || {};
  if (!state.attendance[empId][date]) {
    state.attendance[empId][date] = { loginAt: null, logoutAt: null, secondsWorked: 0 };
  }
  return state.attendance[empId][date];
}
function getPunchState(state, empId) {
  const existing = state.punchLog[empId];
  if (!existing || existing.date !== todayISO()) {
    // A record left mid-shift from a previous day (forgot to punch out)
    // used to be silently discarded here — replaced with a blank record for
    // the new day, losing that whole day's hours. Flush whatever was banked
    // plus whatever accrued since the last punch-in into that day's
    // attendance record first, capped the same way attendance/ingest caps a
    // device reading, so a very stale record can't produce a bogus shift.
    if (existing && existing.punchedInAt && !crmCutover(state).attendance) {
      const seconds = Math.min(existing.seconds + Math.floor((Date.now() - existing.punchedInAt) / 1000), 16 * 3600);
      const day = getAttendanceDay(state, empId, existing.date);
      if (!crmOwnsDay(day)) {
        if (!day.logoutAt) day.logoutAt = new Date().toISOString();
        day.secondsWorked = seconds;
      }
    }
    state.punchLog[empId] = { date: todayISO(), punchedOut: false, punchedInAt: null, seconds: 0 };
  }
  return state.punchLog[empId];
}
app.get('/api/punch/me', requireAuth, (req, res) => {
  const state = db.get();
  const st = getPunchState(state, req.employee.id);
  const liveSeconds = st.punchedInAt ? st.seconds + Math.floor((Date.now() - st.punchedInAt) / 1000) : st.seconds;
  res.json({ punch: { ...st, liveSeconds, punching: !!st.punchedInAt, disabled: crmCutover(state).attendance } });
});
app.post('/api/punch/toggle', requireAuth, (req, res) => {
  const state = db.get();
  if (crmCutover(state).attendance) return res.status(409).json(CLOCK_BY_CRM);
  const st = getPunchState(state, req.employee.id);
  if (st.punchedOut) return res.status(409).json({ error: 'Already punched out for today.' });
  const day = getAttendanceDay(state, req.employee.id, todayISO());
  if (!st.punchedInAt) {
    st.punchedInAt = Date.now();
    if (!day.loginAt && !crmOwnsDay(day)) day.loginAt = new Date().toISOString();
  } else {
    // NON-NEGOTIABLE RULE: you can only punch out once every task is settled
    // — delivered, or explicitly put on hold with a reason. Anything left
    // awaiting acceptance, in rework, or actively in progress and due
    // today/overdue must be dealt with first. Enforced here, not just in the
    // UI, so it can't be bypassed by calling the API direct.
    //
    // A task with a proposed window is deliberately NOT in this list: the
    // employee already did their part (proposed a new date) and it's now
    // sitting with their manager to approve or reject — nothing further for
    // THEM to do. Blocking punch-out on someone else's pending decision
    // meant an unavailable manager could trap an employee at their desk
    // every single day; the manager still gets nudged separately (the
    // "windows proposed" banner + Manager Dashboard).
    const today = todayISO();
    const mine = state.tasks.filter(t => t.assignedTo === req.employee.id);
    const unsettled = mine.filter(t =>
      ['awaiting_acceptance', 'rework'].includes(t.status) ||
      (t.status === 'accepted' && (!t.internalDeadline || t.internalDeadline <= today)));
    if (unsettled.length > 0) {
      const acc = unsettled.filter(t => t.status === 'awaiting_acceptance');
      const rw = unsettled.filter(t => t.status === 'rework');
      const ip = unsettled.filter(t => t.status === 'accepted');
      const parts = [];
      if (acc.length) parts.push(`${acc.length} awaiting your acceptance`);
      if (rw.length) parts.push(`${rw.length} in rework`);
      if (ip.length) parts.push(`${ip.length} in progress due today`);
      return res.status(409).json({
        error: `You have ${parts.join(', ')}. Finish ${unsettled.length > 1 ? 'them' : 'it'}, or put ${unsettled.length > 1 ? 'them' : 'it'} on hold with a reason, before logging off.`,
        code: 'PENDING_ACCEPTANCE',
        pendingTasks: acc.map(t => ({ id: t.id, name: t.name, scope: t.scope, clientName: t.clientName, reviewStatus: t.reviewStatus, reviewNote: t.reviewNote, reworkCount: t.reworkCount, kind: 'acceptance' })),
        pendingRework: rw.map(t => ({ id: t.id, name: t.name, scope: t.scope, clientName: t.clientName, reviewNote: t.reviewNote, reworkCount: t.reworkCount, kind: 'rework' })),
        pendingActive: ip.map(t => ({ id: t.id, name: t.name, scope: t.scope, clientName: t.clientName, status: t.status, kind: 'active' })),
      });
    }
    // Stop the clock on anything of theirs still actively running — a task
    // shouldn't keep accruing "worked" hours after its owner has clocked off
    // for the day. Whatever accrued is banked, same as a manual Pause.
    state.tasks.forEach(t => {
      if (t.assignedTo === req.employee.id && t.timerStartedAt) {
        t.logged += (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000;
        t.timerStartedAt = null;
      }
    });
    st.seconds += Math.floor((Date.now() - st.punchedInAt) / 1000);
    st.punchedInAt = null;
    st.punchedOut = true; // one punch in/out cycle per day, then locked
    if (!crmOwnsDay(day)) { // a day ET-CRM supplied is never overwritten by a punch
      day.logoutAt = new Date().toISOString();
      day.secondsWorked = st.seconds;
    }
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
  if (crmCutover(state).attendance) return res.status(409).json(CLOCK_BY_CRM);
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
  if (!crmOwnsDay(day)) day.logoutAt = null;
  if (resumeClock) {
    st.punchedInAt = Date.now();
    if (!day.loginAt && !crmOwnsDay(day)) day.loginAt = new Date().toISOString();
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
      canReopen: !crmCutover(state).attendance && canManageEmployee(state, me, emp.id),
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

// Founder correction of a login/logout record — for a forgotten punch-out, a
// punch at the wrong time, or a day that was never punched. Times are NZ
// wall-clock (HH:MM) on the chosen day, the same calendar the whole app runs
// on. Today's live clock is kept in step with the edit, and every change is
// written to the activity log (who, what it was, what it became).
const _NZ_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nzLocalToISO(date, hhmm) {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = hhmm.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) { // converge on the NZ offset (handles daylight saving)
    const p = Object.fromEntries(_NZ_PARTS.formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    guess += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(guess).toISOString();
}
const _fmtNZTime = iso => iso ? new Date(iso).toLocaleTimeString('en-NZ', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit' }) : 'none';
app.post('/api/attendance/edit', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  if (crmCutover(state).attendance) return res.status(409).json(CLOCK_BY_CRM);
  const { employeeId, date, login, logout } = req.body || {};
  const emp = findEmployee(state, employeeId);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  const today = todayISO();
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Choose a date.' });
  if (date > today) return res.status(400).json({ error: "You can't set attendance for a future day." });
  const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
  if (typeof login !== 'string' || !hhmm.test(login)) return res.status(400).json({ error: 'Enter a login time.' });
  const hasLogout = typeof logout === 'string' && logout.trim() !== '';
  if (hasLogout && !hhmm.test(logout)) return res.status(400).json({ error: 'That logout time is not valid.' });
  const loginISO = nzLocalToISO(date, login.padStart(5, '0'));
  const logoutISO = hasLogout ? nzLocalToISO(date, logout.padStart(5, '0')) : null;
  if (new Date(loginISO).getTime() > Date.now()) return res.status(400).json({ error: "That login time hasn't happened yet." });
  if (logoutISO) {
    if (new Date(logoutISO) <= new Date(loginISO)) return res.status(400).json({ error: 'Logout must be after login.' });
    if (new Date(logoutISO).getTime() > Date.now()) return res.status(400).json({ error: "That logout time hasn't happened yet." });
  }
  const st = getPunchState(state, emp.id); // flushes any stale mid-shift record first
  const day = getAttendanceDay(state, emp.id, date);
  if (crmOwnsDay(day)) return res.status(409).json({ code: 'DAY_FROM_CRM', error: 'That day came from ET-CRM — correct it there.' });
  const before = { login: day.loginAt, logout: day.logoutAt };
  day.loginAt = loginISO;
  day.logoutAt = logoutISO;
  day.secondsWorked = logoutISO ? Math.min(Math.round((new Date(logoutISO) - new Date(loginISO)) / 1000), 16 * 3600) : 0;
  day.editedBy = req.employee.id;
  day.editedAt = new Date().toISOString();
  if (date === today) { // keep today's live clock in step with the record
    if (logoutISO) { st.punchedOut = true; st.punchedInAt = null; st.seconds = day.secondsWorked; }
    else { st.punchedOut = false; st.punchedInAt = new Date(loginISO).getTime(); st.seconds = 0; }
  }
  logEvent(state, emp.id, `Attendance for ${date} corrected by <b>${escHtml(req.employee.name)}</b>: login ${_fmtNZTime(before.login)} → ${_fmtNZTime(loginISO)}, logout ${_fmtNZTime(before.logout)} → ${_fmtNZTime(logoutISO)} (NZ time).`);
  if (req.employee.id !== emp.id) logEvent(state, req.employee.id, `Corrected <b>${escHtml(emp.name)}</b>'s attendance for ${date}.`);
  db.save();
  res.json({ ok: true, date, loginAt: day.loginAt, logoutAt: day.logoutAt, hours: Math.round(day.secondsWorked / 36) / 100 });
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
  if (crmCutover(state).attendance) return res.status(409).json(CLOCK_BY_CRM);
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
  if (crmOwnsDay(rec)) return res.json({ applied: false, reason: 'day-from-crm', employeeId: emp.id, name: emp.name, date });
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
  if (me.accessRole === 'superadmin' || me.isHr) return (state.leaveRequests || []).slice();
  // A plain employee sees only their own; a manager sees their whole team's
  // (same boundary as the attendance log).
  const ids = isAdminRole(me.accessRole)
    ? new Set([me.id, ...teamRoster(state, me).map(e => e.id)])
    : new Set([me.id]);
  return (state.leaveRequests || []).filter(l => ids.has(l.employeeId) || l.createdBy === me.id);
}
function publicLeave(state, l) {
  const emp = findEmployee(state, l.employeeId);
  return { ...l, employeeName: emp ? emp.name : '—', team: emp ? (emp.team || null) : null, teams: emp ? teamsOf(emp) : [] };
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
// Checked at the moment someone applies for leave — any open task of theirs
// due inside the requested range would otherwise just sit there overdue
// while they're away. Lets the leave form prompt a handoff/hold right then,
// instead of the gap only surfacing after the fact. A soft nudge, not a
// hard block — same pattern as the over-capacity assign warning: shown,
// not enforced, since a manager may have their own reason to submit anyway.
app.get('/api/leave/conflicts', requireAuth, (req, res) => {
  const state = db.get();
  const employeeId = req.query.employeeId || req.employee.id;
  if (employeeId !== req.employee.id && !canManageEmployee(state, req.employee, employeeId)) {
    return res.status(403).json({ error: 'Not your team.' });
  }
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
  const from = isDate(req.query.from) ? req.query.from.slice(0, 10) : null;
  const to = isDate(req.query.to) ? req.query.to.slice(0, 10) : from;
  if (!from) return res.status(400).json({ error: 'Pick a start date.' });
  const conflicts = state.tasks.filter(t => t.assignedTo === employeeId
    && t.status !== 'completed' && t.status !== 'on_hold'
    && t.internalDeadline && t.internalDeadline >= from && t.internalDeadline <= to
  ).map(taskForClient);
  res.json({ conflicts });
});
app.post('/api/leave', requireAuth, (req, res) => {
  const state = db.get();
  if (crmCutover(state).leave) return res.status(409).json(LEAVE_BY_CRM);
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
  // Custom/partial hours (e.g. "2 hours off") — an alternative to halfDay,
  // not combinable with it; also a single-date-only request, same as a half
  // day. Capped at a normal day's hours (checked against 7h in dayCapacity).
  let hours = null;
  if (b.hours !== undefined && b.hours !== null && b.hours !== '') {
    hours = Number(b.hours);
    if (!(hours > 0)) return res.status(400).json({ error: 'Custom hours must be a positive number.' });
    if (from !== to) return res.status(400).json({ error: 'Custom-hours leave must be a single date.' });
    if (halfDay) return res.status(400).json({ error: "Use either half-day or custom hours, not both." });
  }
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
  // Leave that already happened (a missed entry being added after the fact) is
  // allowed on the same rules as any other leave — a manager adding it for
  // their report books it approved; someone adding their own goes to their
  // manager. It's flagged so the list can say so.
  const backdated = from < todayISO();
  const l = {
    id: 'lv-' + (++state.leaveSeq),
    employeeId, from, to, type, halfDay, hours, backdated,
    reason: (b.reason == null ? '' : String(b.reason)).slice(0, 400),
    status: selfApprove ? 'approved' : 'pending',
    createdBy: me.id, createdAt: now,
    decidedBy: selfApprove ? me.id : null, decidedAt: selfApprove ? now : null, decisionNote: null,
  };
  state.leaveRequests.push(l);
  logEvent(state, employeeId, `Time off ${backdated ? (selfApprove ? 'added after the fact' : 'requested after the fact') : (selfApprove ? 'booked' : 'requested')} — ${from}${to !== from ? ' to ' + to : ''}${halfDay ? ' (half day)' : ''}${hours ? ` (${hours}h)` : ''}${employeeId !== me.id ? ` by <b>${escHtml(me.name)}</b>` : ''}.`);
  db.save();
  // A month whose cards are already finalized won't pick this up by itself.
  const closedMonths = Object.values(state.monthlyCards || {}).filter(c => c && c.from && c.to && !(to < c.from || from > c.to)).map(c => c.period);
  res.status(201).json({ leave: publicLeave(state, l), closedMonths });
});
app.post('/api/leave/:id/decision', requireAuth, (req, res) => {
  const state = db.get();
  if (crmCutover(state).leave) return res.status(409).json(LEAVE_BY_CRM);
  const me = req.employee;
  const l = (state.leaveRequests || []).find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'Request not found.' });
  if (l.source === 'crm') return res.status(409).json({ error: 'This leave is managed in ET-CRM — change it there.' });
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
// HR (and superadmins) can turn a half day — or a part-day of custom hours — into
// a full day off, for anyone in the org EXCEPT the founder (only the founder
// changes their own). The record keeps who changed it and what it was before.
app.post('/api/leave/:id/make-full-day', requireAuth, (req, res) => {
  const state = db.get();
  if (crmCutover(state).leave) return res.status(409).json(LEAVE_BY_CRM);
  const me = req.employee;
  if (!me.isHr && me.accessRole !== 'superadmin') return res.status(403).json({ error: 'Only HR can change a half day into a full day.' });
  const l = (state.leaveRequests || []).find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'Request not found.' });
  if (l.source === 'crm') return res.status(409).json({ error: 'This leave is managed in ET-CRM — change it there.' });
  const emp = findEmployee(state, l.employeeId);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  if (emp.isFounder && emp.id !== me.id) return res.status(403).json({ error: "The founder's time off can only be changed by the founder." });
  if (!['pending', 'approved'].includes(l.status)) return res.status(409).json({ error: `That request is ${l.status} — nothing to change.` });
  if (!l.halfDay && !(l.hours > 0)) return res.status(409).json({ error: 'That is already a full day.' });
  const was = l.halfDay ? `half day (${l.halfDay === 'AM' ? 'morning' : 'afternoon'})` : `${l.hours}h part-day`;
  l.history = l.history || [];
  l.history.push({ at: new Date().toISOString(), by: me.id, change: `${was} → full day` });
  l.halfDay = null;
  l.hours = null;
  logEvent(state, emp.id, `Time off ${l.from} changed from a ${escHtml(was)} to a <b>full day</b> by ${escHtml(me.name)}.`);
  if (emp.id !== me.id) {
    notify(state, emp.id, 'leave', `${me.name} changed your time off on ${l.from} from a ${was} to a full day.`, null);
    logEvent(state, me.id, `Changed <b>${escHtml(emp.name)}</b>'s ${escHtml(was)} on ${l.from} to a full day.`);
  }
  db.save();
  const closedMonths = Object.values(state.monthlyCards || {}).filter(c => c && c.from && c.to && !(l.to < c.from || l.from > c.to)).map(c => c.period);
  res.json({ leave: publicLeave(state, l), closedMonths });
});
app.post('/api/leave/:id/cancel', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const l = (state.leaveRequests || []).find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'Request not found.' });
  if (l.source === 'crm') return res.status(409).json({ error: 'This leave is managed in ET-CRM — change it there.' });
  // Once ET-CRM owns leave, only a superadmin may tidy up an old local record.
  if (crmCutover(state).leave && me.accessRole !== 'superadmin') return res.status(409).json(LEAVE_BY_CRM);
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
// HOLIDAY CALENDAR — admin-manageable, replacing the hardcoded list that
// used to live only in calendar.js (still there as the one-time seed / a
// last-resort fallback if this table is ever emptied — see cal.setHolidays).
// Every add/remove re-syncs calendar.js's in-memory working-day Set
// immediately, so date math (commitment dates, capacity, query freezes)
// reflects the change without a restart. Superadmin only — a wrong entry
// here silently shifts every deadline and capacity number in the firm.
// ---------------------------------------------------------------------------
app.get('/api/holidays', requireAuth, (req, res) => {
  const state = db.get();
  res.json({ holidays: (state.holidays || []).slice().sort((a, b) => a.date.localeCompare(b.date)) });
});
app.post('/api/holidays', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const b = req.body || {};
  const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  if (!date) return res.status(400).json({ error: 'Give a valid date (YYYY-MM-DD).' });
  const name = (b.name == null ? '' : String(b.name)).trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Give the holiday a name.' });
  if ((state.holidays || []).some(h => h.date === date)) return res.status(409).json({ error: 'That date is already on the calendar.' });
  state.holidays = state.holidays || [];
  state.holidays.push({ date, name, addedBy: req.employee.id, addedAt: new Date().toISOString() });
  cal.setHolidays(state.holidays.map(h => h.date));
  logEvent(state, req.employee.id, `Added <b>${escHtml(name)}</b> (${date}) to the holiday calendar.`);
  db.save();
  res.status(201).json({ holidays: state.holidays.slice().sort((a, b) => a.date.localeCompare(b.date)) });
});
app.delete('/api/holidays/:date', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const date = req.params.date;
  const before = (state.holidays || []).length;
  state.holidays = (state.holidays || []).filter(h => h.date !== date);
  if (state.holidays.length === before) return res.status(404).json({ error: 'Not on the calendar.' });
  // Never let the working-day engine silently fall back to empty — if this
  // was the last entry, cal.setHolidays() ignores an empty list and the
  // hardcoded default keeps standing (see calendar.js) rather than opening
  // every date up as a working day.
  cal.setHolidays(state.holidays.length ? state.holidays.map(h => h.date) : cal.DEFAULT_HOLIDAYS.map(([d]) => d));
  logEvent(state, req.employee.id, `Removed ${date} from the holiday calendar.`);
  db.save();
  res.json({ holidays: state.holidays.slice().sort((a, b) => a.date.localeCompare(b.date)) });
});

// ---------------------------------------------------------------------------
// CAPACITY CALENDAR — Superadmin-managed, firm-wide Workshop Saturdays.
// Deliberately separate from state.holidays[]: a holiday removes a date
// from the working-day COUNT itself (cal.isWorkingDay → false); a workshop
// Saturday must stay a counted working day while contributing zero capacity
// (see isFirmWorkshopDay/attendanceStatus above) — different mechanisms,
// so this is its own table, never a hard delete (cancel only, full audit).
// ---------------------------------------------------------------------------
function capacityCalendarImpact(state, dateISO) {
  const affected = state.employees.filter(e => dayCapacity(state, e, dateISO) > 0);
  const today = todayISO();
  const periods = [];
  const monthStart = today.slice(0, 7) + '-01';
  if (dateISO >= monthStart && dateISO <= today) periods.push('This month');
  const fyStart = fiscalYearStart(today);
  if (dateISO >= fyStart && dateISO <= today) periods.push('This fiscal year');
  return {
    isPast: dateISO < today,
    affectedEmployees: affected.length,
    capacityHoursRemoved: Math.round(affected.length * CAP_SEED * 100) / 100,
    reportingPeriodsAffected: periods,
  };
}
function validateWorkshopDate(state, b) {
  const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  if (!date) return { error: 'Give a valid date (YYYY-MM-DD).' };
  if (cal.parse(date).getUTCDay() !== 6) return { error: 'Workshop days must be a Saturday.' };
  const name = (b.name == null ? '' : String(b.name)).trim().slice(0, 120);
  if (!name) return { error: 'Give the workshop a name.' };
  const reason = (b.reason == null ? '' : String(b.reason)).trim().slice(0, 300);
  if (!reason) return { error: 'Give a reason.' };
  if ((state.capacityCalendarAdjustments || []).some(a => a.active && a.date === date)) {
    return { error: 'That Saturday already has an active workshop record.' };
  }
  return { date, name, reason };
}
app.get('/api/capacity-calendar', requireAuth, (req, res) => {
  const state = db.get();
  res.json({ adjustments: (state.capacityCalendarAdjustments || []).slice().sort((a, b) => b.date.localeCompare(a.date)) });
});
app.post('/api/capacity-calendar/preview', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const v = validateWorkshopDate(state, req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  res.json({ date: v.date, name: v.name, reason: v.reason, ...capacityCalendarImpact(state, v.date) });
});
app.post('/api/capacity-calendar', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const b = req.body || {};
  const v = validateWorkshopDate(state, b);
  if (v.error) return res.status(400).json({ error: v.error });
  const impact = capacityCalendarImpact(state, v.date);
  if (impact.isPast && b.confirmedPastImpact !== true) {
    return res.status(409).json({ error: 'This is a historical capacity change — confirm the impact preview first.', ...impact });
  }
  state.capacityCalendarAdjustments = state.capacityCalendarAdjustments || [];
  const record = {
    id: 'cc-' + (state.capacityCalendarAdjustments.length + 1) + '-' + Date.now(),
    date: v.date, type: 'WORKSHOP', scope: 'FIRM_WIDE', name: v.name, reason: v.reason,
    createdBy: req.employee.id, createdAt: new Date().toISOString(), active: true,
    cancelledBy: null, cancelledAt: null, cancellationReason: null,
  };
  state.capacityCalendarAdjustments.push(record);
  logEvent(state, req.employee.id, `Marked ${v.date} as a firm-wide Workshop day (<b>${escHtml(v.name)}</b>) — ${escHtml(v.reason)}. ${impact.affectedEmployees} people affected, ${impact.capacityHoursRemoved}h removed.`);
  db.save();
  res.status(201).json({ adjustment: record });
});
app.post('/api/capacity-calendar/:id/cancel', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const rec = (state.capacityCalendarAdjustments || []).find(a => a.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found.' });
  if (!rec.active) return res.status(400).json({ error: 'Already cancelled.' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Give a reason.' });
  rec.active = false; rec.cancelledBy = req.employee.id; rec.cancelledAt = new Date().toISOString(); rec.cancellationReason = reason;
  logEvent(state, req.employee.id, `Cancelled the ${rec.date} Workshop day (<b>${escHtml(rec.name)}</b>) — ${escHtml(reason)}.`);
  db.save();
  res.json({ adjustment: rec });
});

// ---------------------------------------------------------------------------
// PRODUCTIVITY V2 CUTOFF — read-only under normal operation (see the fixed
// PRODUCTIVITY_V2_EFFECTIVE_AT_DEFAULT literal seeded once by db.js). This
// is an emergency-correction path only: preview (no save) then confirm
// (saves + audits), both superadmin-only, so the cutoff can never move via
// a single silent call.
// ---------------------------------------------------------------------------
function productivityV2Impact(state, atISO) {
  const newMs = Date.parse(atISO);
  const curMs = Date.parse(state.productivityV2EffectiveAt || PRODUCTIVITY_V2_EFFECTIVE_AT_DEFAULT);
  let taskCountAffected = 0;
  state.tasks.forEach(t => {
    if (t.status !== 'completed' || !t.completedAt) return;
    const ms = Date.parse(t.completedAt);
    if (!Number.isFinite(ms)) return;
    const wasHistorical = ms < curMs, willBeHistorical = ms < newMs;
    if (wasHistorical !== willBeHistorical) taskCountAffected++;
  });
  return { taskCountAffected };
}
app.post('/api/admin/productivity-v2-effective-at/preview', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const at = (req.body || {}).at;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return res.status(400).json({ error: 'Give a valid ISO timestamp.' });
  res.json({ at, current: state.productivityV2EffectiveAt || PRODUCTIVITY_V2_EFFECTIVE_AT_DEFAULT, ...productivityV2Impact(state, at) });
});
app.post('/api/admin/productivity-v2-effective-at/confirm', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const b = req.body || {};
  const at = b.at;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return res.status(400).json({ error: 'Give a valid ISO timestamp.' });
  const reason = String(b.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Give a reason.' });
  const from = state.productivityV2EffectiveAt || PRODUCTIVITY_V2_EFFECTIVE_AT_DEFAULT;
  const impact = productivityV2Impact(state, at);
  state.productivityV2History = state.productivityV2History || [];
  state.productivityV2History.push({ from, to: at, by: req.employee.id, at: new Date().toISOString(), reason, taskCountAffected: impact.taskCountAffected });
  state.productivityV2EffectiveAt = at;
  logEvent(state, req.employee.id, `Emergency-corrected the Productivity V2 cutoff from ${from} to ${at} — ${escHtml(reason)} (${impact.taskCountAffected} tasks reclassified).`);
  db.save();
  res.json({ v2EffectiveAt: at, history: state.productivityV2History });
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
    sheetLink: null, cashbookLink: null, profitConfirmStatus: null, profitConfirmRequestedAt: null, profitConfirmRequestedBy: null, profitConfirmAt: null, profitConfirmBy: null,
    productivityAllocatedHoursSnapshot: 0, // accepted immediately, tat starts at 0
    reportDeliveryStatus: null, reportDeliveryChannel: null, reportDeliveryReference: null,
    reportDeliveryWaivedReason: null, reportDeliveryWaivedBy: null, reportDeliveryWaivedAt: null,
    noReviewAuthorizedBy: null, noReviewAuthorizedAt: null, noReviewAuthorizedReason: null,
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
    t.completedAt = recordSubmission(t, null, 'done');
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
app.get('/api/admin/storage-health', requireAuth, requireSuperAdmin, async (req, res) => {
  const state = db.get();
  res.json({
    mode: db._mode(),
    rev: db._rev(),
    postgresWrites: db._pgStats(), // writes done / skipped-unchanged / failures — see db.js
    files: await fileStore.totals().catch(() => null), // attachments + screenshots held outside the state
    employees: (state.employees || []).length,
    tasks: (state.tasks || []).length,
    clients: (state.clients || []).length,
    teams: (state.teams || []).length,
  });
});

// ---------------------------------------------------------------------------
// TODAY (GET /api/workflow/today — the older /api/today feeds the current dashboard) — the personal command centre (see workflow.js). Read-only: it derives a picture of the tasks the caller may see and
// scopes it to THEIR work — their team, tasks they review, tasks whose report they send, tasks they assigned. Everything is
// computed on the company clock (Pacific/Auckland), so the greeting, the date and "overdue" always agree.
// ---------------------------------------------------------------------------
const BUSINESS_TZ = 'Pacific/Auckland';
function todayTouched(t, day) {
  return [t.reviewedAt, t.sentToClientAt, t.assignedAt].some(x => x && nzDay(x) === day) || (t.reassignHistory || []).some(h => h.at && nzDay(h.at) === day);
}
app.get('/api/workflow/today', requireAuth, (req, res) => {
  const state = db.get(), me = req.employee;
  const nowMs = Date.now(), today = todayISO();
  const roster = new Set(teamRoster(state, me).map(e => e.id)); roster.add(me.id);
  const visible = visibleTasks(state, me);
  const scoped = visible.filter(t => {
    const mine = !t.assignedTo || roster.has(t.assignedTo) || t.reviewerId === me.id || t.reportSendOwner === me.id || t.reviewedBy === me.id || t.assignedBy === me.id;
    if (!mine) return false;
    // long-finished work only matters if I touched it today (it feeds "Completed today")
    const finished = t.status === 'completed' && (t.reviewStatus === 'done' || (t.reviewStatus === 'clean' && t.sentToClient !== null && t.sentToClient !== undefined));
    return !finished || todayTouched(t, today);
  });
  const po = profitConfirmOwner(state);
  // Manager exceptions for the Manager view's "Needs Manager Attention" tile — the same rule the Manager attention page uses.
  let attentionIds = [];
  if (isAdminRole(me.accessRole)) {
    const wdeps = workflowDeps(state, me), byId = {}, rows = [];
    for (const t of scoped) { byId[t.id] = t; rows.push(mgr.enrich(workflow.card(t, wdeps), t, wdeps)); }
    const ws = workflowSettings(state);
    attentionIds = [...new Set(mgr.exceptions(rows, byId, { today, nowMs, enforceDomains: !!ws.linkDomainsEnforced, allowedDomains: ws.linkDomains }).map(a => a.id))];
  }
  const payload = workflow.buildToday(scoped, me, {
    attentionIds, reviewSlaHours: Number((workflowSettings(state) || {}).reviewSlaHours) || undefined,
    today, nowMs, nzDay, nameOf: id => (findEmployee(state, id) || {}).name || null, profitOwnerId: po ? po.id : null, profitOwnerOf: t => { const o = profitConfirmOwner(state, t); return o ? o.id : null; },
    canApprove: t => !!t.assignedTo && isAdminRole(me.accessRole) && canManageEmployee(state, me, t.assignedTo), isManager: isAdminRole(me.accessRole),
    roleOf: id => ((findEmployee(state, id) || {}).isFounder ? 'founder' : 'manager'),
  });
  const hour = Math.floor(nzMinutesOfDay(nowMs) / 60);
  res.json({ ...payload, today, timezone: BUSINESS_TZ, hour, greeting: workflow.greetingFor(hour), name: me.name });
});

// ---------------------------------------------------------------------------
// MANAGER VIEWS (Phase 5) — My Team, Needs Manager Attention, the paginated Tasks list, Calendar and Timeline. All derived from the
// same cards as Today (see manager-views.js); the only write is POST /api/tasks/:id/manager-change, which needs a reason and is audited.
// ---------------------------------------------------------------------------
function workflowDeps(state, me, extra) {
  const po = profitConfirmOwner(state);
  return {
    today: todayISO(), nowMs: Date.now(), nzDay, nameOf: id => (findEmployee(state, id) || {}).name || null, profitOwnerId: po ? po.id : null, profitOwnerOf: t => { const o = profitConfirmOwner(state, t); return o ? o.id : null; },
    canApprove: t => !!t.assignedTo && isAdminRole(me.accessRole) && canManageEmployee(state, me, t.assignedTo), isManager: isAdminRole(me.accessRole),
    roleOf: id => ((findEmployee(state, id) || {}).isFounder ? 'founder' : 'manager'),
    reportInfo: reportSentFor, queryShiftDays: taskShiftDays, addWorkingDays: cal.addWorkingDays, ...(extra || {}),
  };
}
// Every task in the manager's world, as enriched cards. Only managers/founders reach this (requireAdmin).
// My Team, the manager Tasks list and the measures show the manager's OWN team. Only the founder (or a firm-wide observer) sees everyone —
// a superadmin who is not the founder (e.g. Parvinder) is scoped to the team(s) he belongs to, like any other manager.
const firmWide = me => !!(me.isFounder || me.dashObserver);
function managerRows(state, me) {
  const deps = workflowDeps(state, me);
  const roster = new Set(teamRoster(state, me).map(e => e.id)); roster.add(me.id);
  const tasks = visibleTasks(state, me).filter(t => firmWide(me) || !t.assignedTo || roster.has(t.assignedTo) || t.reviewerId === me.id || t.reportSendOwner === me.id || t.assignedBy === me.id);
  const byId = {}, rows = [];
  for (const t of tasks) { byId[t.id] = t; rows.push(mgr.enrich(workflow.card(t, deps), t, deps)); }
  return { rows, byId, deps };
}
function teamPeople(state, me) {
  const list = firmWide(me) ? state.employees.filter(canReceiveNewWork) : teamRoster(state, me).filter(canReceiveNewWork);
  return list.filter(e => e.id !== me.id).map(e => ({ id: e.id, name: e.name }));
}
app.get('/api/workflow/team', requireAuth, requireAdmin, (req, res) => {
  const state = db.get(), me = req.employee;
  const { rows, byId, deps } = managerRows(state, me);
  const people = teamPeople(state, me);
  const team = mgr.teamSummary(rows, people, { today: deps.today, workloadOf: id => availabilityOf(state, findEmployee(state, id)) });
  const attention = mgr.exceptions(rows, byId, { today: deps.today, nowMs: deps.nowMs, enforceDomains: !!workflowSettings(state).linkDomainsEnforced, allowedDomains: workflowSettings(state).linkDomains });
  const byType = {};
  attention.forEach(a => { (byType[a.type] = byType[a.type] || []).push(a); });
  res.json({ today: deps.today, team, attention, attentionCounts: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])) });
});
app.get('/api/workflow/tasks', requireAuth, requireAdmin, (req, res) => {
  const state = db.get(), q = req.query || {};
  const { rows, deps } = managerRows(state, req.employee);
  const filtered = mgr.applyFilters(rows, { ...q, today: deps.today, nzDay });
  const page = mgr.paginate(mgr.sortRows(filtered, q.sort), q.page, q.pageSize);
  // facets so the filter bar offers only real options
  const facet = f => [...new Set(rows.map(f).filter(Boolean))].sort();
  res.json({
    ...page, today: deps.today,
    facets: { employees: teamPeople(state, req.employee), clients: facet(r => r.clientName), types: facet(r => r.taskType), reviewers: [...new Map(rows.filter(r => r.reviewerId).map(r => [r.reviewerId, r.reviewerName])).entries()].map(([id, name]) => ({ id, name })) },
  });
});
// Filter choices for the Calendar and Timeline — only real options.
function viewFacets(state, me, rows) {
  const facet = f => [...new Set(rows.map(f).filter(Boolean))].sort();
  return { employees: teamPeople(state, me), clients: facet(r => r.clientName), types: facet(r => r.taskType), statuses: facet(r => r.status),
    reviewers: [...new Map(rows.filter(r => r.reviewerId).map(r => [r.reviewerId, r.reviewerName])).entries()].map(([id, name]) => ({ id, name })) };
}
app.get('/api/workflow/calendar', requireAuth, requireAdmin, (req, res) => {
  const state = db.get(), q = req.query || {};
  const { rows, byId, deps } = managerRows(state, req.employee);
  const open = mgr.applyFilters(rows.filter(r => r.status !== 'Completed'), { ...q, today: deps.today });
  let ev = mgr.calendarEvents(open, deps);
  // which dates to show: both by default; ?kinds=internal or ?kinds=client narrows (follow-ups and corrections always show)
  if (q.kinds) { const k = new Set(String(q.kinds).split(',').filter(Boolean)); ev = ev.filter(e => k.has(e.kind) || !['internal', 'client'].includes(e.kind)); }
  if (q.from) ev = ev.filter(e => e.date >= String(q.from).slice(0, 10));
  if (q.to) ev = ev.filter(e => e.date <= String(q.to).slice(0, 10));
  res.json({ today: deps.today, events: ev, legend: mgr.TONE_LABEL, facets: viewFacets(state, req.employee, rows) });
});
app.get('/api/workflow/timeline', requireAuth, requireAdmin, (req, res) => {
  const state = db.get(), q = req.query || {};
  const { rows, byId, deps } = managerRows(state, req.employee);
  const open = mgr.applyFilters(rows.filter(r => r.status !== 'Completed'), { ...q, today: deps.today });
  const all = mgr.timelineRows(open, byId, deps);
  const size = [25, 50, 100].includes(Number(q.pageSize)) ? Number(q.pageSize) : 25, page = Math.max(1, Math.floor(Number(q.page)) || 1);
  res.json({ today: deps.today, total: all.length, page, pageSize: size, rows: all.slice((page - 1) * size, page * size), facets: viewFacets(state, req.employee, rows) });
});


// CLIENT-QUERY AUDIT — a hold for "awaiting client" opens a query record that freezes the client date. The Hold box used to start on
// "Awaiting client answer to a query" (with Email and today pre-filled), so a hold put on for any other reason could silently become a
// "query to the client". This lists every query record with the signs that it was never really a query, and lets a superadmin dismiss
// the ones that were not — the record and its history stay; only the freeze it caused is lifted. Nothing is deleted.
function queryAuditRows(state) {
  const today = todayISO(), rows = [];
  for (const t of (state.tasks || [])) {
    for (const q of (t.queries || [])) {
      const hh = (t.holdHistory || []).find(h => h.queryId === q.id) || null;
      const meta = HOLD_REASONS[q.reasonCode] || {};
      const typed = hh ? String(hh.reason || '').trim() : String(q.note || '').trim();
      const noDetail = !typed || typed === meta.label;
      const resumedNoReply = !!q.resumedAt && !q.replyAt;
      const flags = [];
      if (q.reasonCode === 'CLIENT_QUERY' && noDetail) flags.push('no_detail');
      if (resumedNoReply) flags.push('no_reply_logged');
      if (q.reasonCode === 'CLIENT_QUERY' && q.source === 'email' && noDetail && resumedNoReply) flags.push('looks_like_default');
      const shift = q.dismissedAt ? 0 : cal.queryShift(q, today).shift;
      rows.push({
        taskId: t.id, taskName: t.name, clientName: t.clientName || null, assigneeId: t.assignedTo || null, assigneeName: (findEmployee(state, t.assignedTo) || {}).name || null,
        queryId: q.id, reasonCode: q.reasonCode, reasonLabel: meta.label || q.reasonCode, source: q.source, raisedBy: (findEmployee(state, q.raisedBy) || {}).name || null,
        sentAt: q.sentAt, sentTs: q.sentTs || (hh && hh.heldAt && nzDay(hh.heldAt) === String(q.sentAt).slice(0, 10) ? hh.heldAt : null), typedDetail: noDetail ? null : typed,
        replyAt: q.replyAt || null, resumedAt: q.resumedAt || null, open: !q.replyAt && !q.dismissedAt, shiftDays: shift,
        dismissedAt: q.dismissedAt || null, dismissedBy: (findEmployee(state, q.dismissedBy) || {}).name || null, dismissedReason: q.dismissedReason || null,
        flags, suspect: flags.includes('looks_like_default') || (flags.includes('no_detail') && !q.dismissedAt && !q.replyAt && !!q.resumedAt),
      });
    }
  }
  return rows.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
}
app.get('/api/admin/query-audit', requireAuth, requireSuperAdmin, (req, res) => {
  const rows = queryAuditRows(db.get());
  res.json({
    asOf: todayISO(), total: rows.length, suspect: rows.filter(r => r.suspect && !r.dismissedAt).length, dismissed: rows.filter(r => r.dismissedAt).length,
    daysGranted: rows.reduce((n, r) => n + (r.shiftDays || 0), 0), rows,
  });
});
app.post('/api/admin/query-audit/dismiss', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get(), body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  const reason = String(body.reason || '').trim();
  if (!items.length) return res.status(400).json({ error: 'Choose at least one query.' });
  if (reason.length < 5) return res.status(400).json({ error: 'Give a short reason (at least a few words) — it is kept on each task.' });
  let done = 0; const skipped = [];
  for (const it of items) {
    const t = findTask(state, String(it.taskId || '')), q = t && (t.queries || []).find(x => x.id === it.queryId);
    if (!q) { skipped.push({ ...it, why: 'not found' }); continue; }
    if (q.dismissedAt) { skipped.push({ ...it, why: 'already dismissed' }); continue; }
    q.dismissedAt = new Date().toISOString(); q.dismissedBy = req.employee.id; q.dismissedReason = reason.slice(0, 300);
    // a task still on hold under this query is no longer "waiting on the client": it is an ordinary internal hold
    const last = (t.holdHistory || [])[(t.holdHistory || []).length - 1];
    if (t.status === 'on_hold' && last && last.queryId === q.id) {
      t.holdReasonCode = 'BLOCKED_OTHER'; last.reasonWas = last.reasonCode; last.reasonCode = 'BLOCKED_OTHER';
      last.clocksStopped = { ...(last.clocksStopped || {}), clientCommitment: false };
    }
    logEvent(state, t.assignedTo, `A query record on "${escHtml(t.name)}" was dismissed by <b>${escHtml(req.employee.name)}</b> — it was not a real client query (${escHtml(reason)}). The commitment-date freeze it caused is lifted.`);
    done++;
  }
  if (done) db.save();
  res.json({ ok: true, dismissed: done, skipped });
});

// DATA QUALITY — a read-only report for a superadmin: duplicates, test logins, missing clients, zero hours, personal details in titles,
// contradictory Client/Admin typing, duplicate task types. It never changes, merges or deletes anything; ?format=csv gives a list with a
// "decision" column to review and sign off before anyone touches the data.
app.get('/api/admin/data-quality', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const report = dataQuality.build({ employees: state.employees, tasks: [...(state.tasks || []), ...(state.deletedTasks || []).filter(() => false)], clients: state.clients, taxonomy: state.taxonomy },
    { today: todayISO(), isSystemAccount });
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="data-quality-' + todayISO() + '.csv"');
    return res.send(dataQuality.toCsv(report));
  }
  res.json(report);
});

// ---------------------------------------------------------------------------
// PROFIT CONFIRMERS — who confirms profit: a company default, optional team confirmers, a backup, and an optional per-task override.
// Everyone can read who the confirmer is (the approval form shows the name); only a superadmin changes it, and every change is audited.
// ---------------------------------------------------------------------------
const pcPerson = (state, id) => { const e = id ? findEmployee(state, id) : null; return e ? { id: e.id, name: e.name } : null; };
function profitConfirmersView(state) {
  const cfg = workflowSettings(state).profitConfirmers || {};
  const info = profitConfirmerInfo(state, null);
  return {
    default: pcPerson(state, cfg.default), effectiveDefault: info.owner ? { id: info.owner.id, name: info.owner.name, source: info.source } : null,
    teams: Object.entries(cfg.teams || {}).map(([team, id]) => ({ team, ...(pcPerson(state, id) || { id, name: null }) })),
    backup: pcPerson(state, cfg.backup),
  };
}
app.get('/api/workflow/profit-confirmers', requireAuth, (req, res) => res.json(profitConfirmersView(db.get())));
app.post('/api/admin/profit-confirmers', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get(), b = req.body || {};
  const ok = id => id && (state.employees || []).some(e => e.id === id && canReceiveNewWork(e) && isAdminRole(e.accessRole));
  const next = { default: b.default || null, backup: b.backup || null, teams: {} };
  if (next.default && !ok(next.default)) return res.status(400).json({ error: 'The default confirmer must be an active manager or founder.' });
  if (next.backup && !ok(next.backup)) return res.status(400).json({ error: 'The backup confirmer must be an active manager or founder.' });
  if (next.default && next.backup && next.default === next.backup) return res.status(400).json({ error: 'The backup must be a different person from the default.' });
  for (const [team, id] of Object.entries(b.teams || {})) {
    if (!id) continue;
    if (!ok(id)) return res.status(400).json({ error: 'The confirmer for ' + team + ' must be an active manager or founder.' });
    next.teams[String(team).slice(0, 80)] = id;
  }
  state.workflowSettings = state.workflowSettings || {};
  const before = state.workflowSettings.profitConfirmers || null;
  state.workflowSettings.profitConfirmers = next;
  state.settingsAudit = state.settingsAudit || [];
  state.settingsAudit.push({ at: new Date().toISOString(), by: req.employee.id, key: 'profitConfirmers', from: before, to: next });
  logEvent(state, req.employee.id, 'Changed who confirms profit (default ' + ((pcPerson(state, next.default) || {}).name || 'unchanged legacy') + ', backup ' + ((pcPerson(state, next.backup) || {}).name || 'none') + ').');
  db.save();
  res.json(profitConfirmersView(state));
});
// A per-task override: a manager/superadmin names who confirms profit for THIS task (audited on the task).
app.post('/api/tasks/:id/profit-confirmer', requireAuth, requireAdmin, (req, res) => {
  const state = db.get(), t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if (t.profitConfirmStatus === 'pending' || t.profitConfirmStatus === 'confirmed') return res.status(409).json({ error: 'Profit confirmation has already started on this task.' });
  const id = (req.body || {}).confirmerId || null;
  if (id && !(state.employees || []).some(e => e.id === id && canReceiveNewWork(e) && isAdminRole(e.accessRole))) return res.status(400).json({ error: 'Choose an active manager or founder.' });
  const was = t.profitConfirmerId || null;
  t.profitConfirmerId = id;
  t.profitConfirmerHistory = [...(t.profitConfirmerHistory || []), { at: new Date().toISOString(), by: req.employee.id, from: was, to: id }];
  logEvent(state, t.assignedTo || req.employee.id, `"${escHtml(t.name)}": profit confirmer set to <b>${escHtml((pcPerson(state, id) || { name: 'the default confirmer' }).name)}</b> by <b>${escHtml(req.employee.name)}</b>.`);
  db.save();
  res.json({ task: taskForClient(t) });
});

app.get('/api/admin/workflow-settings', requireAuth, requireSuperAdmin, (req, res) => {
  const ws = workflowSettings(db.get());
  res.json({ settings: { linkDomainsEnforced: !!ws.linkDomainsEnforced, linkDomains: ws.linkDomains || mgr.clientLinkDomains }, defaultDomains: mgr.clientLinkDomains });
});
app.post('/api/admin/workflow-settings', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get(), b = req.body || {};
  state.workflowSettings = state.workflowSettings || {};
  if (typeof b.linkDomainsEnforced === 'boolean') state.workflowSettings.linkDomainsEnforced = b.linkDomainsEnforced;
  if (Array.isArray(b.linkDomains)) {
    const list = b.linkDomains.map(d => String(d).trim().toLowerCase()).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
    if (!list.length) return res.status(400).json({ error: 'Give at least one valid website, like docs.google.com.' });
    state.workflowSettings.linkDomains = list;
  }
  logEvent(state, req.employee.id, 'Changed the link policy (approved sites ' + (state.workflowSettings.linkDomainsEnforced ? 'on' : 'off') + ').');
  db.save();
  const ws = workflowSettings(state);
  res.json({ settings: { linkDomainsEnforced: !!ws.linkDomainsEnforced, linkDomains: ws.linkDomains || mgr.clientLinkDomains } });
});

// ---------------------------------------------------------------------------
// MANAGER ALERTS (Phase 7). A problem raises ONE notification per episode (never a flood), is tracked in state.managerAlerts, and is
// resolved automatically — the notification drops out of the inbox — as soon as the problem is gone. A problem that comes back
// after being resolved is a new episode and is raised again.
// ---------------------------------------------------------------------------
const ALERT_TYPES = new Set(['blocked_long', 'followup_due', 'report_unsent', 'profit_overdue', 'repeated_return', 'no_review_attempt', 'missing_reviewer']);
function alertRecipients(state, type, t, exceptId) {
  const to = new Set();
  const founders = state.employees.filter(e => e.accessRole === 'superadmin' && !e.accessDisabled);
  if (t.assignedTo) managersOfEmployee(state, t.assignedTo).forEach(m => to.add(m.id));
  if (t.assignedBy) { const a = findEmployee(state, t.assignedBy); if (a && isAdminRole(a.accessRole)) to.add(a.id); }
  if (type === 'followup_due' && t.assignedTo) to.add(t.assignedTo);
  if (type === 'report_unsent') { to.add(t.reportSendOwner || t.assignedTo); }
  if (type === 'profit_overdue') { const po = profitConfirmOwner(state, t); if (po) to.add(po.id); founders.forEach(f => to.add(f.id)); }
  if (!t.assignedTo) founders.forEach(f => to.add(f.id));
  to.delete(exceptId); to.delete(null); to.delete(undefined);
  return [...to];
}
function raiseAlert(state, type, t, text, recipients) {
  state.managerAlerts = state.managerAlerts || {};
  const key = type + ':' + t.id, prev = state.managerAlerts[key];
  if (prev && !prev.resolvedAt) return false;                       // already raised and still open — say it once
  state.managerAlerts[key] = { key, type, taskId: t.id, raisedAt: new Date().toISOString(), resolvedAt: null, to: recipients, episodes: ((prev && prev.episodes) || 0) + 1 };
  const episode = state.managerAlerts[key].episodes;
  recipients.forEach(id => { const row = notify(state, id, 'attention', text, t.id, { noDedupe: true }); if (row) row.alertKey = key + '|' + episode; });
  return true;
}
function sweepManagerAlerts(state) {
  const me = { id: '_sweep', accessRole: 'superadmin', name: 'System' };
  const deps = workflowDeps(state, me);
  const byId = {}, rows = [];
  for (const t of state.tasks) { byId[t.id] = t; rows.push(mgr.enrich(workflow.card(t, deps), t, deps)); }
  // A missing reviewer only alerts once the internal due date is within two working days — before it is, it stays on the exceptions list.
  const soon = cal.addWorkingDays(deps.today, 2);
  const found = mgr.exceptions(rows, byId, { today: deps.today, nowMs: deps.nowMs }).filter(a => ALERT_TYPES.has(a.type) && (a.type !== 'missing_reviewer' || ((byId[a.id] || {}).internalDeadline || '9999') <= soon));
  const open = new Set();
  let raised = 0, resolved = 0;
  for (const a of found) {
    const t = byId[a.id], key = a.type + ':' + a.id;
    open.add(key);
    const who = a.assigneeName ? ' (' + a.assigneeName + ')' : '';
    if (raiseAlert(state, a.type, t, a.label + ' — ' + (a.clientName || 'Admin task') + ' · ' + a.name + who + (a.detail ? ': ' + a.detail : ''), alertRecipients(state, a.type, t))) raised++;
  }
  for (const [key, al] of Object.entries(state.managerAlerts || {})) {
    if (al.resolvedAt || open.has(key)) continue;
    al.resolvedAt = new Date().toISOString(); resolved++;
  }
  if (raised || resolved) db.save();
  return { raised, resolved, open: open.size };
}
app.post('/api/admin/manager-alerts/run', requireAuth, requireSuperAdmin, (req, res) => res.json(sweepManagerAlerts(db.get())));
if (process.env.NODE_ENV !== 'test') {
  setInterval(() => { try { sweepManagerAlerts(db.get()); } catch (e) { console.error('[alerts] sweep failed:', e && e.message); } }, 30 * 60 * 1000).unref();
  setTimeout(() => { try { sweepManagerAlerts(db.get()); } catch (e) { /* first sweep is best-effort */ } }, 60 * 1000).unref();
}

// The reporting measures — each one separate (see manager-views.js measures).
app.get('/api/workflow/measures', requireAuth, requireAdmin, (req, res) => {
  const state = db.get(), me = req.employee;
  const deps = workflowDeps(state, me, { commitmentOutcome });
  const roster = new Set(teamRoster(state, me).map(e => e.id));
  const tasks = visibleTasks(state, me).filter(t => firmWide(me) || (t.assignedTo && roster.has(t.assignedTo)));
  res.json(mgr.measures(tasks, deps, req.query.days));
});

// A manager's one-off change to someone's task. Always needs a reason; every change is written to t.managerActions (who, when, why,
// before → after) and the people affected are told.
app.post('/api/tasks/:id/manager-change', requireAuth, requireAdmin, (req, res) => {
  const state = db.get(), me = req.employee;
  const t = findTask(state, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  const b = req.body || {};
  const reason = String(b.reason || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'Give a short reason — it is kept in the task history.' });
  if (b.requestId) { const dup = (t.managerActions || []).find(a => a.requestId === b.requestId); if (dup) return res.json({ task: taskForClient(t), duplicate: true }); }
  if (t.assignedTo ? !canManageEmployee(state, me, t.assignedTo) : false) return res.status(403).json({ error: "You're not authorized to change this employee's task." });
  const log = (action, from, to) => {
    t.managerActions = t.managerActions || [];
    t.managerActions.push({ id: crypto.randomUUID(), requestId: b.requestId || null, at: new Date().toISOString(), by: me.id, byName: me.name, action, reason, from, to });
  };
  switch (b.action) {
    case 'reassign': {
      const from = t.assignedTo || null;
      const r = applyReassign(state, t, me, b.newAssigneeId, reason);
      if (r.error) return res.status(r.status).json({ error: r.error });
      log('reassign', from, b.newAssigneeId);
      break;
    }
    case 'change_due': {
      const iso = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) ? x.slice(0, 10) : null;
      const internal = iso(b.internalDeadline);
      if (!internal) return res.status(400).json({ error: 'Give a valid internal due date.' });
      if (t.status === 'completed') return res.status(400).json({ error: 'A finished task has no due date to change.' });
      if (internal < todayISO() && internal !== t.internalDeadline) return res.status(400).json({ error: "You can't set the due date in the past." });
      const before = { internal: t.internalDeadline, client: t.clientDate };
      t.internalDeadline = internal;
      const cd = iso(b.clientDate);
      if (cd) { t.clientDate = cd; t.clientDateOverride = true; }
      recordDateChange(state, t, me, before, reason, 'manager_change');
      log('change_due', before, { internal: t.internalDeadline, client: t.clientDate });
      break;
    }
    case 'change_reviewer': {
      const rv = findEmployee(state, b.reviewerId);
      if (!rv || !isAdminRole(rv.accessRole)) return res.status(400).json({ error: 'Pick a manager or founder as reviewer.' });
      if (rv.id === t.assignedTo) return res.status(400).json({ error: 'The reviewer cannot be the person doing the work.' });
      if (t.status === 'completed' && t.reviewStatus !== 'done' && t.reviewStatus !== 'clean' && t.reviewStatus !== 'error') { /* in review: allowed */ }
      const from = t.reviewerId || t.assignedReviewerId || null;
      t.reviewerId = rv.id;
      if (t.status !== 'completed') { t.assignedReviewerId = rv.id; if (t.reviewerLater) t.reviewerLater = { ...t.reviewerLater, resolvedAt: new Date().toISOString(), resolvedBy: me.id }; }
      notify(state, rv.id, 'review', me.name + ' made you the reviewer of "' + t.name + '" — ' + reason, t.id);
      log('change_reviewer', from, rv.id);
      break;
    }
    case 'waive_review': {
      if (!workflow.isClientTask(t)) return res.status(400).json({ error: 'Admin tasks do not need a review waiver.' });
      if (t.status === 'completed') return res.status(400).json({ error: 'This task is already finished.' });
      if (reason.length < 5) return res.status(400).json({ error: 'Say why this client task needs no review.' });
      t.reviewRequired = false; t.noReviewAuthorizedBy = me.id; t.noReviewAuthorizedAt = new Date().toISOString(); t.noReviewAuthorizedReason = reason;
      log('waive_review', true, false);
      break;
    }
    default: return res.status(400).json({ error: 'Unknown action.' });
  }
  logEvent(state, t.assignedTo || me.id, '<b>' + escHtml(me.name) + '</b> changed "' + escHtml(t.name) + '" (' + escHtml(b.action) + '): ' + escHtml(reason));
  db.save();
  res.json({ task: taskForClient(t) });
});

// Recover calls Aircall never delivered (see connector.js recoverCalls). Superadmin only. DRY RUN unless the
// body says { "dryRun": false } — so a first look never changes anything. { "day": "YYYY-MM-DD" } is the NZ day.
app.post('/api/admin/calls/recover', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { recoverCalls } = require('./connector');
    const b = req.body || {};
    const r = await recoverCalls({ day: b.day, dryRun: b.dryRun !== false, max: b.max });
    res.json(r);
  } catch (e) { res.status(502).json({ error: 'Could not read the calls from Aircall: ' + (e && e.message || e) }); }
});

// ---------------------------------------------------------------------------
// FOUNDER ALERTS + the watchers that raise them: failed database saves, the volume filling up, Aircall calls recovered by the
// self-heal. An alert is an in-app notification AND a Slack DM to every founder (the DM still works when the database does not).
// Each kind is throttled so a problem is loud once, not a flood.
// ---------------------------------------------------------------------------
const _alertThrottle = {};
async function alertFounders(key, text, minGapMs) {
  const gap = minGapMs != null ? minGapMs : 3600e3, now = Date.now();
  if (_alertThrottle[key] && now - _alertThrottle[key] < gap) return { sent: false, throttled: true };
  _alertThrottle[key] = now;
  const state = db.get();
  const founders = (state.employees || []).filter(e => e.accessRole === 'superadmin' && !e.accessDisabled);
  founders.forEach(e => { try { notify(state, e.id, 'system', text, null, { noDedupe: true }); } catch (x) { /* keep going */ } });
  try { db.save(); } catch (x) { /* the DM below is the point if the database is the problem */ }
  let dms = 0;
  try {
    const { slackDm } = require('./connector');
    for (const e of founders) if (e.slackUserId) { try { const r = await slackDm(e.slackUserId, '🛠 ' + text); if (r && r.ok !== false) dms++; } catch (x) { /* one DM failing must not stop the rest */ } }
  } catch (x) { /* connector not loaded */ }
  console.log('[alert] ' + key + ': ' + text);
  return { sent: true, inApp: founders.length, slackDms: dms, founders: founders.map(e => e.name) };
}
db.setAlertHook((key, text) => alertFounders(key, text, 3600e3));
try { require('./connector').setAlertSink((key, text) => alertFounders(key, text, 6 * 3600e3)); } catch (e) { /* tests that load server.js without the connector */ }

async function spaceWatchTick() {
  try {
    if (db._mode() !== 'postgres') return null;
    const u = await db.volumeUsage();
    if (!u) return null;
    const state = db.get(), prev = state.spaceWatch || {};
    const level = spaceWatch.levelFor(u.pct), d = spaceWatch.decide(prev, level, Date.now());
    state.spaceWatch = { level, pct: u.pct, usedMB: u.usedMB, volumeMB: u.volumeMB, checkedAt: new Date().toISOString(), lastAlertAt: d.alert ? new Date().toISOString() : (prev.lastAlertAt || null) };
    if (d.alert) await alertFounders('disk_' + level, spaceWatch.message(level, u.pct, u.usedMB, u.volumeMB), 0);
    db.save();
    return state.spaceWatch;
  } catch (e) { console.error('[watch] disk check failed:', e && e.message); return null; }
}

// ET-CRM connection alerts — checked every 15 minutes; only MEANINGFUL problems are raised (repeated refusals, many unlinked
// users, a link conflict, attendance gone stale while ET-CRM is the source) and each is throttled to once a day.
async function crmAlertsTick() {
  try {
    for (const a of crmHealth.alertCandidates(db.get(), Date.now())) await alertFounders(a.key, '🔌 ' + a.text, 24 * 3600e3);
  } catch (e) { console.error('[crm] alert check failed:', e && e.message); }
}

// ---------------------------------------------------------------------------
// ARCHIVE — calls / emails / WhatsApp older than ARCHIVE_AFTER_DAYS (95) leave the state and live in downloadable monthly files.
// ---------------------------------------------------------------------------
let _archiving = false;
async function archiveOldRecords(opts) {
  if (_archiving) return null;
  _archiving = true;
  try {
    const r = await archive.run(db.get(), { fileStore, persist: async () => { db.save(); await db.flush(); } }, opts);
    if (r.archived) console.log('[archive] moved ' + r.archived + ' record(s) older than ' + r.days + ' days into monthly files.');
    if (r.errors.length) console.error('[archive] problems:', r.errors.join(' | '));
    return r;
  } catch (e) { console.error('[archive] failed:', e && e.message); return null; }
  finally { _archiving = false; }
}
// Prove the alerts reach you: sends a harmless test message to every founder (in-app + Slack DM).
app.post('/api/admin/alerts/test', requireAuth, requireSuperAdmin, async (req, res) => {
  const r = await alertFounders('test:' + Date.now(), 'Test alert from the Task Manager — if you can read this, database and Aircall alerts will reach you. (Sent by ' + req.employee.name + '.)', 0);
  res.json(r);
});
app.get('/api/admin/archives', requireAuth, requireSuperAdmin, (req, res) => {
  const state = db.get();
  const p = archive.plan(state, archive.cutoffISO());
  res.json({
    afterDays: archive.days(), cutoff: archive.cutoffISO(),
    waiting: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.total])),
    inState: { calls: (state.calls || []).length, emails: (state.emails || []).length, waMessages: (state.waMessages || []).length },
    archives: (state.archives || []).slice().sort((a, b) => (b.month + b.kind).localeCompare(a.month + a.kind)),
    note: 'Download any archive file with GET /api/files/<fileId> (founder only).',
  });
});
// DRY RUN unless the body says { "dryRun": false }.
app.post('/api/admin/archive/run', requireAuth, requireSuperAdmin, async (req, res) => {
  const dryRun = (req.body || {}).dryRun !== false;
  const r = await archiveOldRecords({ dryRun });
  if (!r) return res.status(409).json({ error: 'An archive run is already in progress.' });
  res.json(r);
});

// What is using the database, and a safe clean-up. Superadmin only.
app.get('/api/admin/space-report', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const rep = await db.spaceReport();
    rep.files = await fileStore.totals().catch(() => null);
    rep.watch = db.get().spaceWatch || null;
    rep.archives = (db.get().archives || []).length;
    res.json(rep);
  } catch (e) { res.status(500).json({ error: 'Could not build the report: ' + e.message }); }
});
app.post('/api/admin/space-cleanup', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const r = await db.maintenance();
    if (!r.ok) return res.status(400).json(r);
    logEvent(db.get(), req.employee.id, `Ran the database clean-up — ${r.beforeMB}MB → ${r.afterMB}MB.`);
    db.save();
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Clean-up failed: ' + e.message }); }
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
app.post('/api/admin/state-import', requireAuth, requireSuperAdmin, async (req, res) => {
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
  await db.flush(); // an import must be in Postgres before we say it worked
  res.json({ ok: true, mode: db._mode(), employees: state.employees.length, tasks: state.tasks.length });
});

// ---------------------------------------------------------------------------
// CALLS — listened-vs-remaining, for whoever's Slack ID is tagged on an
// agent's calls (connector.js AGENT_MAP). Read-only: actually listening and
// marking done still happens on the Slack card (recording playback, the
// button) — this is just visibility, so it's clear how much is outstanding
// without having to dig through Slack. status:'ended' only, same as the
// tag itself — a voicemail or missed call was never posted or tagged.
// ---------------------------------------------------------------------------
app.get('/api/calls/mine', requireAuth, (req, res) => {
  const state = db.get();
  const { callStatsForSlackId } = require('./connector');
  res.json(callStatsForSlackId(state, req.employee.slackUserId));
});
// Every tagged call in a date window, with a 5-way outcome breakdown — the
// Calls page for everyone. A superadmin gets the whole firm (filterable by
// owner/agent, with a firm-wide breakdown); anyone else is hard-scoped
// inside allCallsReport() to only the calls they're responsible for
// listening to, so the personId/agentId filters below only ever matter for
// a superadmin's request.
app.get('/api/calls/all', requireAuth, (req, res) => {
  const state = db.get();
  const { allCallsReport } = require('./connector');
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  const personId = req.query.personId ? String(req.query.personId) : null;
  const agentId = req.query.agentId ? String(req.query.agentId) : null;
  res.json(allCallsReport(state, { from, to, personId, agentId, actor: req.employee }));
});
// Call routing — who's responsible for listening to each Aircall agent's
// calls (state.agentMap, superadmin-editable from the "Team Assignments"
// page instead of a code change). GET is open to any authenticated user
// (read-only, small); only a superadmin can PATCH.
app.get('/api/calls/agent-routing', requireAuth, (req, res) => {
  const state = db.get();
  const rows = Object.keys(state.agentMap || {}).map(agentId => {
    const r = state.agentMap[agentId];
    const emps = (Array.isArray(r.employeeIds) ? r.employeeIds : []).map(id => findEmployee(state, id)).filter(Boolean);
    return { agentId, name: r.name, team: r.team, mandatory: !!r.mandatory, employeeIds: emps.map(e => e.id), employeeNames: emps.map(e => e.name) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ routing: rows });
});
// employeeIds: up to two people can be responsible for one agent's calls
// (e.g. a senior reviewing alongside the main reviewer) — the same person
// in both slots is allowed, agentSlackIds() de-dupes it for notifications.
app.patch('/api/calls/agent-routing/:agentId', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const r = (state.agentMap || {})[req.params.agentId];
  if (!r) return res.status(404).json({ error: 'Unknown Aircall agent.' });
  if (req.body && Array.isArray(req.body.employeeIds)) {
    const ids = [];
    for (const empId of req.body.employeeIds) {
      if (!empId) continue;
      const emp = findEmployee(state, empId);
      if (!emp) return res.status(400).json({ error: 'Unknown employee.' });
      ids.push(emp.id);
    }
    r.employeeIds = ids;
  }
  if (typeof (req.body && req.body.mandatory) === 'boolean') r.mandatory = req.body.mandatory;
  if (req.body && req.body.team !== undefined) r.team = String(req.body.team || '').trim() || r.team;
  db.save();
  const emps = r.employeeIds.map(id => findEmployee(state, id)).filter(Boolean);
  res.json({ agentId: req.params.agentId, name: r.name, team: r.team, mandatory: !!r.mandatory, employeeIds: emps.map(e => e.id), employeeNames: emps.map(e => e.name) });
});

// ---------------------------------------------------------------------------
// EMAIL (Gmail) — a firm-wide visibility/audit log for 4 real mailboxes
// (employee.gmailAddresses[] — one employee can own more than one),
// mirroring Calls above: filterable by day/week/month, owner and mailbox,
// and status. Also has a WhatsApp-style "+ Task" action to turn an inbound
// message into a task (see POST /:id/task below). The poller lives in
// connector.js (pollGmailMailbox / pollAllGmailMailboxes), on its own
// scheduler tick, independent of Slack config.
// ---------------------------------------------------------------------------
app.get('/api/emails/mine', requireAuth, (req, res) => {
  const state = db.get();
  const { emailStatsForEmployee } = require('./connector');
  res.json(emailStatsForEmployee(state, req.employee.id));
});
app.get('/api/emails/all', requireAuth, (req, res) => {
  const state = db.get();
  const { allEmailsReport } = require('./connector');
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  const personId = req.query.personId ? String(req.query.personId) : null;
  const mailbox = req.query.mailbox ? String(req.query.mailbox) : null;
  res.json(allEmailsReport(state, { from, to, personId, mailbox, actor: req.employee }));
});
// Manual "refresh now" lever (also the local test entry point, driving the
// fixture path in connector.js's gmailApi when no live credentials are set).
app.post('/api/int/gmail/poll-now', requireIntegrationAuth, async (req, res) => {
  try {
    const { pollAllGmailMailboxes } = require('./connector');
    res.json(await pollAllGmailMailboxes());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
// Mailbox ownership — who owns each of the connected mailboxes
// (employee.gmailAddresses[]), superadmin-editable from the "Team
// Assignments" page instead of digging into each employee's Manage Access.
// Reassigning only affects future polls — already-logged rows keep the
// mailboxOwner they were stamped with at ingest time.
app.get('/api/emails/mailbox-owners', requireAuth, (req, res) => {
  const state = db.get();
  const owners = {};
  (state.employees || []).forEach(e => (e.gmailAddresses || []).forEach(addr => { owners[addr] = e; }));
  // A mailbox that's been polled before but currently has no owner (e.g.
  // removed from an employee without a replacement) still needs to show up
  // so it can be reassigned, not just disappear.
  (state.emails || []).forEach(e => { if (e.mailbox && !(e.mailbox in owners)) owners[e.mailbox] = null; });
  const rows = Object.keys(owners).map(mailbox => {
    const emp = owners[mailbox];
    return { mailbox, employeeId: emp ? emp.id : null, employeeName: emp ? emp.name : null };
  }).sort((a, b) => a.mailbox.localeCompare(b.mailbox));
  res.json({ mailboxes: rows });
});
app.post('/api/emails/mailbox-owners/reassign', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const mailbox = String((req.body && req.body.mailbox) || '').trim().toLowerCase();
  if (!mailbox) return res.status(400).json({ error: 'A mailbox address is required.' });
  const employeeId = req.body && req.body.employeeId;
  (state.employees || []).forEach(e => {
    if (Array.isArray(e.gmailAddresses) && e.gmailAddresses.includes(mailbox)) {
      e.gmailAddresses = e.gmailAddresses.filter(a => a !== mailbox);
    }
  });
  let newOwner = null;
  if (employeeId) {
    newOwner = findEmployee(state, employeeId);
    if (!newOwner) return res.status(400).json({ error: 'Unknown employee.' });
    newOwner.gmailAddresses = newOwner.gmailAddresses || [];
    if (!newOwner.gmailAddresses.includes(mailbox)) newOwner.gmailAddresses.push(mailbox);
  }
  db.save();
  res.json({ mailbox, employeeId: newOwner ? newOwner.id : null, employeeName: newOwner ? newOwner.name : null });
});
// Create a task from a logged email — same shape/validation as the
// WhatsApp "+ Task" endpoint above it in this file. Any authenticated user
// can do this (not owner-only — e.g. a manager triaging on someone's
// behalf), same as WhatsApp's.
app.post('/api/emails/:id/task', requireAuth, (req, res) => {
  const state = db.get();
  const e = (state.emails || []).find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Email not found.' });
  const { name, note, tat, internalDeadline, assignedTo } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Task name is required.' });
  const numTat = parseFloat(tat);
  if (!(numTat > 0)) return res.status(400).json({ error: 'A task needs an estimated time in hours.' });
  if (!internalDeadline) return res.status(400).json({ error: 'A task needs a due date.' });
  if (numTat > 100) return res.status(400).json({ error: "That's more than 100 hours — split it into smaller tasks." });
  if (/^\d{4}-\d{2}-\d{2}/.test(String(internalDeadline)) && String(internalDeadline).slice(0, 10) < todayISO()) {
    return res.status(400).json({ error: "The due date can't be in the past — pick today or a later day." });
  }
  const assignee = findEmployee(state, assignedTo);
  if (!assignee) return res.status(400).json({ error: 'Choose who this should go to.' });
  const status = assignee.id === req.employee.id ? 'accepted' : 'awaiting_acceptance';
  state.taskSeq += 1;
  const now = new Date().toISOString();
  const task = {
    id: '#' + (100000000000 + state.taskSeq), name: String(name).trim(),
    scope: note ? String(note).trim() : (e.snippet || '—'),
    kind: 'internal', team: assignee.team || null,
    clientId: null, clientName: 'Email · ' + (e.direction === 'outbound' ? ((e.toAddresses || [])[0] || '—') : e.fromAddress),
    internalRef: e.subject || null,
    clientDate: null, clientDateOverride: false, internalDeadline,
    points: 0, assignedTo: assignee.id, assignedBy: req.employee.id,
    assignedAt: now, reassignHistory: [], status,
    logged: 0, tat: numTat, acceptedAt: status === 'accepted' ? now : null,
    timerStartedAt: null, startedAt: null, completedAt: null,
    reviewStatus: null, reviewedBy: null, reviewNote: null, reviewedAt: null, reviewHours: null, reworkCount: 0,
    reviewerId: null, closedBy: null, closedAt: null, awaitingClientDecision: false, sentToClient: null, sentToClientAt: null, sentToClientBy: null,
    sheetLink: null, cashbookLink: null, profitConfirmStatus: null, profitConfirmRequestedAt: null, profitConfirmRequestedBy: null, profitConfirmAt: null, profitConfirmBy: null,
    productivityAllocatedHoursSnapshot: status === 'accepted' ? (Number(numTat) || null) : null,
    reportDeliveryStatus: null, reportDeliveryChannel: null, reportDeliveryReference: null,
    reportDeliveryWaivedReason: null, reportDeliveryWaivedBy: null, reportDeliveryWaivedAt: null,
    noReviewAuthorizedBy: null, noReviewAuthorizedAt: null, noReviewAuthorizedReason: null,
    reworkStartedAt: null, faultType: null, reworkHistory: [], holdReasonCode: null,
    dateHistory: [], tatHistory: [], queries: [], overAllocated: null,
    source: 'gmail', sourceRef: e.gmailMessageId,
  };
  state.tasks.unshift(task);
  e.taskId = task.id;
  logEvent(state, assignee.id, `Task created from an email — <b>${escHtml(e.fromAddress)}</b> — "${escHtml(task.name)}".`);
  if (status === 'awaiting_acceptance') notify(state, assignee.id, 'assigned', `${req.employee.name} assigned you "${task.name}" from an email — accept it or propose a new date.`, task.id);
  db.save();
  res.status(201).json({ task: taskForClient(task) });
});
// Manually mark (or unmark) a message as not needing a reply — e.g. an FYI
// or a notification that was correctly never actioned. Toggling, not a
// one-way flag, so a mistaken click is easy to undo. Any authenticated
// user can do this (same reasoning as the task-conversion endpoint above).
app.post('/api/emails/:id/no-reply-needed', requireAuth, (req, res) => {
  const state = db.get();
  const e = (state.emails || []).find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Email not found.' });
  e.replyNotNeeded = !e.replyNotNeeded;
  e.replyNotNeededBy = e.replyNotNeeded ? req.employee.id : null;
  e.replyNotNeededAt = e.replyNotNeeded ? new Date().toISOString() : null;
  db.save();
  res.json({ ok: true, replyNotNeeded: e.replyNotNeeded });
});
// Mail reassigned to ME that still needs a reply — shown on the dashboard.
app.get('/api/emails/reassigned-to-me', requireAuth, (req, res) => {
  const state = db.get(), me = req.employee;
  const s = autoMarks.settingsOf(state, todayISO());
  const list = (state.emails || [])
    .filter(e => e.direction === 'inbound' && e.reassignedTo === me.id && e.reassignedTo !== e.mailboxOwner && !e.replied && !e.replyNotNeeded)
    .map(e => {
      const last = (e.reassignHistory || [])[(e.reassignHistory || []).length - 1] || {};
      const by = findEmployee(state, last.by);
      // the same-working-day deadline the automatic marks use: before the daily Calls & Email report
      const d = autoMarks.reassignedMailDeadline(e, {
        nzDay, nzMinutes: nzMinutesOfDay, isWorkingDay: x => cal.isWorkingDay(x), workingDayAfter: x => cal.addWorkingDays(x, 1),
        skip: (id, day) => { const p = findEmployee(state, id); return !p || ['LEAVE', 'WORKSHOP', 'HOLIDAY'].includes(attendanceStatus(state, p, day)); },
      }, { activeFrom: '0000-01-01' });
      return { id: e.id, subject: e.subject || '(no subject)', fromAddress: e.fromAddress, mailbox: e.mailbox, occurredAt: e.occurredAt, reassignedAt: last.at || null,
        reassignedBy: by ? by.name : null, replyBy: d ? d.deadline : null, replyByTime: d ? autoMarks.cutoffLabel(d.cutoffMinutes) : null, thumbsUp: !!e.thumbsUp };
    })
    .sort((a, b) => (a.replyBy || '').localeCompare(b.replyBy || ''));
  res.json({ emails: list, penalty: s.enabled.mailReply ? s.points.mailReplyLate : 0 });
});
// Who may act on a logged email (👍 it, reassign it): a superadmin, whoever is
// currently responsible for it, or their manager.
function canActOnEmail(state, me, e) {
  const owner = e.reassignedTo || e.mailboxOwner;
  return me.accessRole === 'superadmin' || owner === me.id || (!!owner && canManageEmployee(state, me, owner));
}
// 👍 acknowledges an email without counting as a reply. A toggle, so a mistaken
// click is easy to undo.
app.post('/api/emails/:id/thumbs-up', requireAuth, (req, res) => {
  const state = db.get();
  const e = (state.emails || []).find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Email not found.' });
  if (!canActOnEmail(state, req.employee, e)) return res.status(403).json({ error: "You can only acknowledge mail that is yours (or your team's)." });
  e.thumbsUp = !e.thumbsUp;
  e.thumbsUpBy = e.thumbsUp ? req.employee.id : null;
  e.thumbsUpAt = e.thumbsUp ? new Date().toISOString() : null;
  db.save();
  res.json({ ok: true, thumbsUp: e.thumbsUp });
});
// Hand one email to someone else — they become the responsible person for it
// (it moves to their Email page and their numbers). The mailbox itself stays
// where it is; send it back to the mailbox owner by choosing them again.
app.post('/api/emails/:id/reassign', requireAuth, (req, res) => {
  const state = db.get();
  const me = req.employee;
  const e = (state.emails || []).find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Email not found.' });
  if (e.direction !== 'inbound') return res.status(400).json({ error: 'Only incoming mail can be reassigned.' });
  if (!canActOnEmail(state, me, e)) return res.status(403).json({ error: "You can only reassign mail that is yours (or your team's)." });
  const to = findEmployee(state, req.body && req.body.employeeId);
  if (!to) return res.status(400).json({ error: 'Choose who this email should go to.' });
  const from = e.reassignedTo || e.mailboxOwner;
  if (to.id === from) return res.status(400).json({ error: 'It is already with ' + to.name + '.' });
  e.reassignHistory = e.reassignHistory || [];
  e.reassignHistory.push({ at: new Date().toISOString(), by: me.id, from, to: to.id });
  e.reassignedTo = to.id === e.mailboxOwner ? null : to.id; // back to the mailbox owner clears it
  const fromEmp = findEmployee(state, from);
  const subject = e.subject || '(no subject)';
  logEvent(state, to.id, `<b>${escHtml(me.name)}</b> reassigned an email to you — "${escHtml(subject)}" from ${escHtml(e.fromAddress || '—')}.`);
  if (to.id !== me.id) notify(state, to.id, 'email', `${me.name} reassigned an email to you — "${subject}" from ${e.fromAddress || '—'}. Find it on the Email page.`, null);
  if (fromEmp && fromEmp.id !== me.id && fromEmp.id !== to.id) logEvent(state, fromEmp.id, `<b>${escHtml(me.name)}</b> reassigned "${escHtml(subject)}" from you to <b>${escHtml(to.name)}</b>.`);
  db.save();
  res.json({ ok: true, responsibleId: to.id, responsibleName: to.name });
});
// Look back at recent calls and take voicemails out of the totals (and their
// Slack cards down). Superadmin; safe to run again.
app.post('/api/admin/calls/voicemail-cleanup', requireAuth, async (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  try {
    const { cleanVoicemails } = require('./connector');
    res.json(await cleanVoicemails({ days: Number(req.body && req.body.days) || 30, max: 150 }));
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});
// Firm-wide "never show mail from this address" list — superadmin-only to
// change, but readable by anyone so the Email view can show the current
// list. Excludes from the report only (allEmailsReport); nothing in
// state.emails is ever deleted, so un-ignoring an address surfaces its
// history again immediately.
app.get('/api/emails/ignored-senders', requireAuth, (req, res) => {
  res.json({ senders: db.get().emailIgnoredSenders || [] });
});
app.post('/api/emails/ignored-senders', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const address = String((req.body && req.body.address) || '').trim().toLowerCase();
  if (!address) return res.status(400).json({ error: 'An email address is required.' });
  state.emailIgnoredSenders = state.emailIgnoredSenders || [];
  if (!state.emailIgnoredSenders.includes(address)) state.emailIgnoredSenders.push(address);
  db.save();
  res.json({ senders: state.emailIgnoredSenders });
});
app.delete('/api/emails/ignored-senders/:address', requireAuth, (req, res) => {
  if (req.employee.accessRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required.' });
  const state = db.get();
  const address = decodeURIComponent(req.params.address).trim().toLowerCase();
  state.emailIgnoredSenders = (state.emailIgnoredSenders || []).filter(a => a !== address);
  db.save();
  res.json({ senders: state.emailIgnoredSenders });
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
  if (numTat > 100) return res.status(400).json({ error: "That's more than 100 hours — split it into smaller tasks." });
  if (/^\d{4}-\d{2}-\d{2}/.test(String(internalDeadline)) && String(internalDeadline).slice(0, 10) < todayISO()) {
    return res.status(400).json({ error: "The due date can't be in the past — pick today or a later day." });
  }
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
    sheetLink: null, cashbookLink: null, profitConfirmStatus: null, profitConfirmRequestedAt: null, profitConfirmRequestedBy: null, profitConfirmAt: null, profitConfirmBy: null,
    productivityAllocatedHoursSnapshot: status === 'accepted' ? (Number(numTat) || null) : null,
    reportDeliveryStatus: null, reportDeliveryChannel: null, reportDeliveryReference: null,
    reportDeliveryWaivedReason: null, reportDeliveryWaivedBy: null, reportDeliveryWaivedAt: null,
    noReviewAuthorizedBy: null, noReviewAuthorizedAt: null, noReviewAuthorizedReason: null,
    reworkStartedAt: null, faultType: null, reworkHistory: [], holdReasonCode: null,
    dateHistory: [], tatHistory: [], queries: [], overAllocated: null,
    source: 'whatsapp', sourceRef: c.phone,
  };
  state.tasks.unshift(task);
  c.taskIds = c.taskIds || []; c.taskIds.push(task.id);
  logEvent(state, assignee.id, `Task created from a WhatsApp message — <b>${escHtml(c.name)}</b> — "${escHtml(task.name)}".`);
  if (status === 'awaiting_acceptance') notify(state, assignee.id, 'assigned', `${req.employee.name} assigned you "${task.name}" from a WhatsApp message — accept it or propose a new date.`, task.id);
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

// A few core task-state functions, for connector.js's Slack quick-action
// buttons to share instead of re-implementing the same transitions —
// required lazily from there (after this file has fully loaded), same
// pattern connector.js already uses elsewhere.
module.exports = {
  crmAlertsTick, alertFounders, spaceWatchTick, archiveOldRecords, sweepReportDeadlines, resumeTaskCore, findTask, isAdminRole, canManageEmployee, logEvent, escHtml, notify, findEmployee, attendanceStatus, announceAutoMark };

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
    // Audit trail for the Productivity V3 rule (prospective only — nothing completed before the cutoff is recalculated).
    try {
      const st = db.get();
      if (!st.productivityV3History) {
        st.productivityV3History = [{ introducedAt: new Date().toISOString(), effectiveAt: st.productivityV3EffectiveAt || PRODUCTIVITY_V3_EFFECTIVE_AT_DEFAULT, by: 'system',
          change: 'A reviewed-clean task credits at its clean-review date; Report Sent no longer moves or unlocks Productivity. Applies to work completed on/after effectiveAt; earlier work and finalised months are unchanged.' }];
        db.save();
      }
    } catch (e) { console.error('[productivity-v3] audit seed failed:', e.message); }
    initPush();
    // Keep images out of the state, and tidy files that were uploaded but never attached.
    const crmAlertTimer = setInterval(() => { crmAlertsTick(); }, 15 * 60 * 1000); if (crmAlertTimer.unref) crmAlertTimer.unref();
    const watchTimer = setInterval(() => { spaceWatchTick(); }, 30 * 60 * 1000); if (watchTimer.unref) watchTimer.unref();
    const watchFirst = setTimeout(() => { spaceWatchTick(); }, 2 * 60 * 1000); if (watchFirst.unref) watchFirst.unref();
    const archTimer = setInterval(() => { archiveOldRecords(); }, 6 * 3600 * 1000); if (archTimer.unref) archTimer.unref();
    const archFirst = setTimeout(() => { archiveOldRecords(); }, 4 * 60 * 1000); if (archFirst.unref) archFirst.unref();
    const imgTimer = setInterval(() => { externalizeInlineImages(); }, Number(process.env.FILES_MOVE_INTERVAL_MS) || 30 * 1000); if (imgTimer.unref) imgTimer.unref();
    const firstMove = setTimeout(() => { externalizeInlineImages(); }, 5000); if (firstMove.unref) firstMove.unref();
    const sweepTimer = setInterval(() => { fileStore.sweepOrphans(24 * 3600 * 1000).catch(() => {}); }, 6 * 3600 * 1000); if (sweepTimer.unref) sweepTimer.unref();
    app.listen(PORT, () => {
      console.log(`Elite Taxation Governance OS running at http://localhost:${PORT} — storage: ${db._mode()} — push: ${PUSH_READY ? 'on' : 'off'}`);
    });
  })
  .catch((err) => {
    console.error('Startup failed — could not initialise the database:', err);
    process.exit(1);
  });
