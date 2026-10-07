// ET-CRM connection health — pure functions over the app state, so the admin panel, the one-click check and the alerts all
// say the same thing, and every rule is easy to test. NOTHING here writes: it only reads `state` (and results the caller
// already fetched). Safe metadata only — counts, ids and field names, never payload values or secrets.
const DAY = 86400000, HOUR = 3600000;
const lower = s => String(s == null ? '' : s).trim().toLowerCase();
const counts = (state, kind) => ((state.crmSync || {}).counts || {})[kind] || {};
const events = state => ((state.crmSync || {}).events || []);
const ageHours = (iso, nowMs) => iso ? Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / HOUR * 10) / 10) : null;

// WHO is linked, who is not, and — never by name — who probably should be.
function employeeHealth(state) {
  const emps = state.employees || [];
  const linked = emps.filter(e => e.crmUserId);
  const unlinked = emps.filter(e => !e.crmUserId);
  const waiting = Object.values(((state.crmSync || {}).unlinked) || {});
  const byEmail = new Map();
  emps.forEach(e => { const k = lower(e.email); if (k) byEmail.set(k, [...(byEmail.get(k) || []), e]); });
  const duplicateEmails = [...byEmail.entries()].filter(([, l]) => l.length > 1).map(([email, l]) => ({ email, employees: l.map(e => ({ id: e.id, name: e.name })) }));
  const u = counts(state, 'user');
  return {
    linked: linked.length, unlinked: unlinked.length,
    inactiveLinked: linked.filter(e => e.accessDisabled || e.crmActive === false).length,
    conflicts: (u.conflict || 0), ambiguous: (u.ambiguous || 0),
    duplicateEmails,
    // a candidate is offered ONLY when exactly one waiting CRM user carries the same work email — never a name match
    unlinkedEmployees: unlinked.map(e => {
      const hits = lower(e.email) ? waiting.filter(w => lower(w.email) === lower(e.email)) : [];
      return { id: e.id, name: e.name, email: e.email || null, crmUserId: null, inactive: !!e.accessDisabled,
        candidate: hits.length === 1 ? { crmUserId: hits[0].crmUserId, email: hits[0].email } : null, ambiguousCandidates: hits.length > 1 ? hits.length : 0 };
    }),
    waitingCrmUsers: waiting.map(w => ({ crmUserId: w.crmUserId || null, email: w.email || null, events: w.count || 0, kinds: w.kinds || {}, waiting: (w.pending || []).length })),
  };
}

// Why a contact was skipped, in plain words (from the safe event notes).
function skipReason(note) {
  const n = String(note || '');
  if (/authority/i.test(n)) return 'Authority not signed';
  if (/pbq/i.test(n)) return 'PBQ incomplete';
  if (/ambiguous/i.test(n)) return 'Ambiguous identity';
  if (/already linked|no change/i.test(n)) return 'Already linked';
  if (/delet|inactive/i.test(n)) return 'Deleted / inactive';
  return 'Other';
}
function customerHealth(state) {
  const clients = state.clients || [];
  const c = counts(state, 'customer'), lb = counts(state, 'linkback');
  const reasons = {};
  events(state).filter(e => e.kind === 'customer' && e.outcome === 'skipped').forEach(e => { const r = skipReason(e.note); reasons[r] = (reasons[r] || 0) + 1; });
  const pull = (state.crmSync || {}).pull || null;
  return {
    linked: clients.filter(x => x.crmContactId).length, unlinked: clients.filter(x => !x.crmContactId).length,
    ambiguous: c.ambiguous || 0, conflicts: (c.conflict || 0) + (lb.conflict || 0),
    skipped: c.skipped || 0, skipReasons: reasons,
    linkBack: { ok: (lb.updated || 0) + (lb.ok || 0), failed: lb.error || 0, conflicts: lb.conflict || 0, lastSuccess: lb.lastOk || null, lastFailure: lb.lastFail || null },
    lastSuccess: c.lastOk || null, lastFailure: c.lastFail || null,
    lastPull: pull ? Object.fromEntries(['at', 'mode', 'ok', 'received', 'rule', 'error', 'maybeTruncated', 'toCreate', 'linkable', 'linked', 'created', 'ambiguous', 'conflicts'].filter(k => pull[k] !== undefined).map(k => [k, pull[k]])) : null,
  };
}

// "Healthy" is judged by what is EXPECTED, not by silence: attendance is only stale once ET-CRM is the source of truth and no
// day has arrived for 3 days; leave is event-driven, so quiet is normal; policy shows when it was last reconciled.
const ATTENDANCE_STALE_HOURS = 72;
function staleness(state, nowMs) {
  const cut = ((state.crmSync || {}).cutover) || {};
  const att = counts(state, 'attendance'), lv = counts(state, 'leave'), pol = counts(state, 'policy');
  const aAge = ageHours(att.lastOk, nowMs);
  const attendance = !att.lastOk ? { status: 'never', lastAt: null, ageHours: null }
    : (cut.attendance && aAge > ATTENDANCE_STALE_HOURS) ? { status: 'stale', lastAt: att.lastOk, ageHours: aAge }
    : { status: 'ok', lastAt: att.lastOk, ageHours: aAge };
  return {
    attendance: { ...attendance, cutoverOn: !!cut.attendance },
    leave: { status: lv.lastOk ? 'ok' : 'never', lastAt: lv.lastOk || null, ageHours: ageHours(lv.lastOk, nowMs), note: 'Leave arrives only when someone books or changes it — quiet is normal.', cutoverOn: !!cut.leave },
    policy: { status: pol.lastOk ? 'ok' : 'never', lastAt: pol.lastOk || null, lastReconcile: (((state.crmSync || {}).lastReconcile || {}).policy) || null },
  };
}

// webhook calls refused for a bad / missing secret in the last `windowMs`
function authFailures(state, nowMs, windowMs) {
  return events(state).filter(e => e.outcome === 'error' && /^rejected/i.test(e.note || '') && nowMs - new Date(e.at).getTime() <= windowMs).length;
}
// our calls INTO ET-CRM refused (401 / 403) in the last `windowMs`
function apiAuthFailures(state, nowMs, windowMs) {
  return events(state).filter(e => (e.kind === 'linkback' || e.kind === 'pull') && e.outcome === 'error' && /\b40[13]\b|unauthori[sz]ed|forbidden|invalid api key|missing scope/i.test(e.note || '') && nowMs - new Date(e.at).getTime() <= windowMs).length;
}

// What deserves a founder's attention RIGHT NOW. One temporary failure is not on this list.
function alertCandidates(state, nowMs) {
  const out = [];
  const bad = authFailures(state, nowMs, 30 * 60000);
  if (bad >= 5) out.push({ key: 'crm_secret', text: `ET-CRM has been refused ${bad} times in the last 30 minutes — the webhook secret does not match. Set the same CRM_WEBHOOK_SECRET in ET-CRM and in Railway.` });
  const api = apiAuthFailures(state, nowMs, 60 * 60000);
  if (api >= 3) out.push({ key: 'crm_api', text: `Our calls to ET-CRM were refused ${api} times in the last hour (401/403) — check CRM_API_KEY and its scopes.` });
  const waiting = Object.keys(((state.crmSync || {}).unlinked) || {}).length;
  if (waiting >= 5) out.push({ key: 'crm_unlinked', text: `${waiting} ET-CRM users are waiting to be linked to an employee — open Admin → ET-CRM connection and link them (their attendance and leave are held until then).` });
  const lb = counts(state, 'linkback');
  if (lb.lastFail && lb.lastFail.outcome === 'conflict' && nowMs - new Date(lb.lastFail.at).getTime() <= DAY) out.push({ key: 'crm_conflicts', text: 'A client link-back to ET-CRM hit a conflict (ET-CRM already points that contact at a different client). Open Admin → ET-CRM connection to review it.' });
  const st = staleness(state, nowMs);
  if (st.attendance.status === 'stale') out.push({ key: 'crm_stale_attendance', text: `ET-CRM is the source for attendance, but no attendance has arrived for ${Math.round(st.attendance.ageHours)} hours. Check the ET-CRM attendance webhook.` });
  return out;
}

// One-click diagnostic. `ctx`: { nowMs, secretConfigured, apiUrlConfigured, apiKeyConfigured, probes: { policy, pipeline } }
// where a probe is { ok, error } or null (not run). Returns { status, checks[] }; never writes.
function buildCheck(state, ctx) {
  const now = ctx.nowMs || Date.now();
  const checks = [];
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail });
  add('secret', 'Webhook secret', ctx.secretConfigured ? 'ok' : 'fail', ctx.secretConfigured ? 'CRM_WEBHOOK_SECRET is set (the value is never shown).' : 'CRM_WEBHOOK_SECRET is not set — every ET-CRM webhook will be refused.');
  const bad = authFailures(state, now, DAY);
  add('secret_recent', 'Refused webhook calls (24 h)', bad >= 5 ? 'warn' : 'ok', bad ? `${bad} call(s) were refused for a bad or missing secret.` : 'None.');
  for (const [kind, label] of [['user', 'Employees'], ['customer', 'Customers'], ['attendance', 'Attendance'], ['leave', 'Leave'], ['policy', 'Policy compliance']]) {
    const c = counts(state, kind);
    const total = ['created', 'updated', 'ok', 'skipped', 'unlinked', 'conflict', 'ambiguous', 'invalid', 'error'].reduce((n, k) => n + (c[k] || 0), 0);
    add('hook_' + kind, label + ' webhook', total ? 'ok' : 'info', total ? `Last success ${c.lastOk || 'none yet'}; ${total} event(s) seen.` : 'No event has arrived yet — create the webhook in ET-CRM and send a test event.');
  }
  add('api_url', 'CRM API address', ctx.apiUrlConfigured ? 'ok' : 'warn', ctx.apiUrlConfigured ? 'Configured.' : 'Using the built-in default address.');
  add('api_key', 'CRM API key', ctx.apiKeyConfigured ? 'ok' : 'warn', ctx.apiKeyConfigured ? 'CRM_API_KEY is set (never shown).' : 'CRM_API_KEY is not set — link-back, the policy fallback and customer reconciliation cannot call ET-CRM.');
  const probe = (key, label, p, skipNote) => add(key, label, !p ? 'info' : p.ok ? 'ok' : 'fail', !p ? skipNote : p.ok ? 'Reachable and permitted.' : p.error || 'Failed.');
  probe('api_policy', 'API action get-policy-compliance', ctx.probes && ctx.probes.policy, ctx.apiKeyConfigured ? 'Not run (no linked employee to test with yet).' : 'Not run (no API key).');
  probe('api_pipeline', 'API action list-pipeline (customer reconciliation)', ctx.probes && ctx.probes.pipeline, ctx.apiKeyConfigured ? 'Not run.' : 'Not run (no API key).');
  const lb = counts(state, 'linkback');
  add('api_linkback', 'API action link-task-manager-client', lb.lastFail && (!lb.lastOk || lb.lastFail.at > lb.lastOk) ? 'fail' : lb.lastOk ? 'ok' : 'info',
    lb.lastFail && (!lb.lastOk || lb.lastFail.at > lb.lastOk) ? (lb.lastFail.note || 'Last attempt failed.') : lb.lastOk ? 'Last real link-back succeeded.' : 'Not testable without writing — shown from real link-backs (none yet).');
  const eh = employeeHealth(state);
  add('employees', 'Employee links', eh.linked ? 'ok' : 'warn', `${eh.linked} linked, ${eh.unlinked} not linked${eh.duplicateEmails.length ? ', ' + eh.duplicateEmails.length + ' duplicate work email(s)' : ''}.`);
  if (eh.duplicateEmails.length) checks[checks.length - 1].status = 'warn';
  const ch = customerHealth(state);
  add('customers', 'Client links', 'info', `${ch.linked} linked, ${ch.unlinked} not linked (Task Manager clients that have no ET-CRM contact yet).`);
  const st = staleness(state, now);
  add('attendance', 'Attendance sync', st.attendance.status === 'stale' ? 'warn' : st.attendance.status === 'ok' ? 'ok' : 'info',
    st.attendance.status === 'never' ? 'No attendance has arrived yet.' : `Last attendance ${st.attendance.lastAt} (${st.attendance.ageHours} h ago)${st.attendance.status === 'stale' ? ' — STALE while ET-CRM is the source.' : '.'}`);
  add('leave', 'Leave sync', st.leave.status === 'ok' ? 'ok' : 'info', st.leave.status === 'never' ? 'No leave has arrived yet (fine if nobody has booked any).' : `Last leave event ${st.leave.lastAt}. ${st.leave.note}`);
  add('policy', 'Policy fallback', ctx.probes && ctx.probes.policy ? (ctx.probes.policy.ok ? 'ok' : 'fail') : 'info', ctx.probes && ctx.probes.policy ? (ctx.probes.policy.ok ? 'get-policy-compliance answered.' : ctx.probes.policy.error) : 'Not run.');
  add('legacy_task', 'Legacy CRM task sync', 'ok', 'Disabled — /webhooks/crm-task answers 410 and imports nothing.');
  const cut = ((state.crmSync || {}).cutover) || {};
  add('cutover', 'Source of truth', 'info', `Attendance from ET-CRM: ${cut.attendance ? 'ON' : 'OFF'} · Leave from ET-CRM: ${cut.leave ? 'ON' : 'OFF'}.`);
  const hasFail = checks.some(c => c.status === 'fail'), hasWarn = checks.some(c => c.status === 'warn');
  const status = !ctx.secretConfigured && !ctx.apiKeyConfigured ? 'not_configured' : (hasFail || hasWarn) ? 'needs_attention' : 'healthy';
  return { status, label: { healthy: 'Healthy', needs_attention: 'Needs Attention', not_configured: 'Not Configured' }[status], checks, at: new Date(now).toISOString() };
}

const OWNERSHIP = [
  { area: 'Employees', source: 'ET-CRM' }, { area: 'Customers', source: 'ET-CRM' }, { area: 'Attendance', source: 'ET-CRM' },
  { area: 'Leave', source: 'ET-CRM' }, { area: 'Policy compliance', source: 'ET-CRM' }, { area: 'Tasks', source: 'Task Manager' },
];

module.exports = { employeeHealth, customerHealth, skipReason, staleness, authFailures, apiAuthFailures, alertCandidates, buildCheck, OWNERSHIP, ATTENDANCE_STALE_HOURS };
