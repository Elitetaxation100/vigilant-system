// ---------------------------------------------------------------------------
// ET-CRM ↔ Task Manager contract helpers — pure functions, no server, no
// database, no network.
//
// ET-CRM pushes row changes as Supabase Database Webhooks:
//   { type: 'INSERT' | 'UPDATE' | 'DELETE', table, record, old_record }
// Each mapper reads the EXPLICIT field names of the production contract first
// (docs/crm-integration.md). A few legacy aliases are still accepted purely for
// backward compatibility with what was wired up before the contract was fixed.
//
// What ET-CRM owns: employees, customers, attendance, leave, policy compliance.
// What the Task Manager owns: tasks (there is NO CRM task sync).
// ---------------------------------------------------------------------------
const NZ_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

const blank = v => v === undefined || v === null || String(v).trim() === '';
function pick(row, keys) {
  if (!row) return undefined;
  for (const k of keys) { if (!blank(row[k])) return row[k]; }
  return undefined;
}
const str = v => (blank(v) ? null : String(v).trim());
const lower = v => (blank(v) ? null : String(v).trim().toLowerCase());
function num(v) {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// A flag column can be a boolean, a "yes"/"true", or a timestamp of when it happened.
function isSet(v) {
  if (blank(v)) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return !/^(false|no|n|0|null|none|pending)$/i.test(String(v).trim());
}
// A tri-state boolean: true / false / null (not given).
function triBool(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (/^(true|yes|y|1)$/.test(s)) return true;
  if (/^(false|no|n|0)$/.test(s)) return false;
  return null;
}

// The shape a Supabase Database Webhook sends — or, failing that, the bare row.
function normalizeEvent(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.record && typeof b.record === 'object') {
    return { type: String(b.type || 'INSERT').toUpperCase(), table: b.table || null, row: b.record, oldRow: b.old_record || null };
  }
  if (b.type && String(b.type).toUpperCase() === 'DELETE' && b.old_record && typeof b.old_record === 'object') {
    return { type: 'DELETE', table: b.table || null, row: b.old_record, oldRow: b.old_record };
  }
  if (b.data && typeof b.data === 'object' && !Array.isArray(b.data)) {
    return { type: String(b.type || b.event || 'INSERT').toUpperCase(), table: b.table || null, row: b.data, oldRow: null };
  }
  return { type: String(b.type || b.event || 'INSERT').toUpperCase(), table: b.table || null, row: b, oldRow: null };
}

// A YYYY-MM-DD in New Zealand time, from a plain date or any timestamp.
function toDay(v) {
  if (blank(v)) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : NZ_DAY.format(d);
}
// A full timestamp as ISO; a bare clock time ("09:15") comes back as { time }.
function toStamp(v) {
  if (blank(v)) return { iso: null, time: null };
  const s = String(v).trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return { iso: null, time: s.slice(0, 5).padStart(5, '0') };
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? { iso: null, time: null } : { iso: d.toISOString(), time: null };
}

// NZ wall-clock "HH:MM" on a YYYY-MM-DD → ISO instant (handles daylight saving).
const NZ_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nzLocalToISO(date, hhmm) {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = hhmm.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(NZ_PARTS.formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    guess += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(guess).toISOString();
}

// ===========================================================================
// EMPLOYEES — ET-CRM crm_users
//   crm_user_id, full_name, email, is_active, department, designation,
//   employment_type, employment_status, slack_user_id, manager_id
// ===========================================================================
// Statuses that end a person's access. "on_leave" is deliberately NOT here — a
// person on leave keeps their account.
const INACTIVE_STATUSES = ['inactive', 'terminated', 'resigned'];
function mapUser(row) {
  const status = lower(pick(row, ['employment_status', 'status']));
  const isActive = triBool(pick(row, ['is_active', 'active']));
  return {
    crmUserId: str(pick(row, ['crm_user_id', 'id'])),
    name: str(pick(row, ['full_name', 'name'])),
    email: lower(pick(row, ['email', 'work_email'])),
    isActive,
    department: str(pick(row, ['department'])),
    designation: str(pick(row, ['designation', 'job_title'])),
    employmentType: str(pick(row, ['employment_type'])),
    employmentStatus: status,
    slackUserId: str(pick(row, ['slack_user_id', 'slack_id'])),
    managerId: str(pick(row, ['manager_id'])),
    // Inactive when the CRM says so explicitly, or the employment status ends it.
    inactive: isActive === false || INACTIVE_STATUSES.includes(status || ''),
  };
}

// ===========================================================================
// CUSTOMERS — ET-CRM contacts
//   id (= crmContactId), name, email, phone, category, assigned_to,
//   authority_signed, pbq_done_at, task_manager_client_id
// ===========================================================================
// Which CRM contacts are real working clients. Configurable (Admin → CRM
// connection); the default is the rule agreed with the firm: authority signed
// AND the PBQ done — i.e. we hold everything needed to start work.
const DEFAULT_ELIGIBILITY = { requireAuthoritySigned: true, requirePbqDone: true };
function eligibility(c, rule) {
  const r = { ...DEFAULT_ELIGIBILITY, ...(rule || {}) };
  const missing = [];
  if (r.requireAuthoritySigned && !(c && c.authoritySigned)) missing.push('authority not signed');
  if (r.requirePbqDone && !(c && c.pbqDone)) missing.push('PBQ not done');
  return { ok: missing.length === 0, reason: missing.join(' and ') };
}
const isClientContact = (c, rule) => eligibility(c, rule).ok;
function describeEligibility(rule) {
  const r = { ...DEFAULT_ELIGIBILITY, ...(rule || {}) };
  const parts = [];
  if (r.requireAuthoritySigned) parts.push('authority signed');
  if (r.requirePbqDone) parts.push('PBQ done');
  return parts.length ? parts.join(' AND ') : 'every contact (no conditions)';
}
function mapContact(row) {
  const first = str(pick(row, ['first_name', 'firstname', 'given_name']));
  const last = str(pick(row, ['last_name', 'lastname', 'surname', 'family_name']));
  return {
    id: str(pick(row, ['id', 'crm_contact_id'])),
    name: str(pick(row, ['name', 'full_name', 'display_name', 'company_name'])) || [first, last].filter(Boolean).join(' ') || null,
    email: lower(pick(row, ['email', 'email_address'])),
    phone: str(pick(row, ['phone', 'mobile', 'phone_number'])),
    category: str(pick(row, ['category', 'type'])),
    linkedTmId: str(pick(row, ['task_manager_client_id'])),
    authoritySigned: isSet(pick(row, ['authority_signed', 'authority_signed_at', 'authority_received_at'])),
    pbqDone: isSet(row && row.pbq_done_at),
    stages: {
      status: lower(row && row.status), lead: lower(row && row.lead_stage), onboarding: lower(row && row.onboarding_stage),
    },
    owner: {
      crmUserId: str(pick(row, ['assigned_to', 'owner_id', 'agent_id', 'account_manager_id', 'assigned_user_id'])),
      email: lower(pick(row, ['owner_email', 'assigned_to_email', 'agent_email'])),
    },
  };
}

// digits only; compare on the last 8 so "+64 21 123 456" and "021 123 456" meet
function normPhone(v) {
  const d = blank(v) ? '' : String(v).replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-8) : null;
}
// Which existing client is this contact? Linked id first, then the id the CRM
// stored back, then email, phone, and finally an exact multi-word name — each
// only when it points at exactly ONE client that isn't already tied to another
// contact. The firm's own address is never proof of identity.
function matchClient(clients, c) {
  const free = x => !x.crmContactId || x.crmContactId === c.id;
  let hit = clients.find(x => c.id && x.crmContactId === c.id);
  if (hit) return { client: hit, by: 'linked' };
  if (c.linkedTmId) { hit = clients.find(x => x.id === c.linkedTmId && free(x)); if (hit) return { client: hit, by: 'stored id' }; }
  const tries = [
    ['email', c.email && !/@elitetaxation\.co\.nz$/i.test(c.email) && c.email, x => lower(x.email) === c.email],
    ['phone', normPhone(c.phone), x => normPhone(x.phone) === normPhone(c.phone)],
    // a bare first name ("Varun") is not enough to say two records are the same person
    ['name', c.name && /\S\s+\S/.test(c.name.trim()) && c.name.trim().toLowerCase(), x => x.name && x.name.trim().toLowerCase() === c.name.toLowerCase()],
  ];
  for (const [by, key, test] of tries) {
    if (!key) continue;
    const found = clients.filter(x => free(x) && test(x));
    if (found.length === 1) return { client: found[0], by };
    if (found.length > 1) return { ambiguous: true, by };
  }
  return null;
}

// The response of ET-CRM's `link-task-manager-client` action, as an outcome.
// ET-CRM refuses to overwrite a different Task Manager id — that is a CONFLICT
// we report, not an error we retry.
function classifyLinkBack(result) {
  if (result && result.ok) return { outcome: 'updated', note: 'linked back in ET-CRM' };
  const msg = String((result && result.error) || 'no answer');
  if (/conflict|already|different|mismatch|409/i.test(msg)) return { outcome: 'conflict', note: 'ET-CRM already has a different Task Manager client: ' + msg.slice(0, 120) };
  if (/unknown action|not supported|invalid action/i.test(msg)) return { outcome: 'error', note: 'ET-CRM does not offer link-task-manager-client yet: ' + msg.slice(0, 120) };
  return { outcome: 'error', note: 'link-back failed: ' + msg.slice(0, 120) };
}

// ===========================================================================
// ATTENDANCE — ET-CRM attendance_daily
//   crm_attendance_id, crm_user_id, date, check_in_at, check_out_at,
//   net_minutes, status
// ===========================================================================
function mapAttendance(row) {
  const inS = toStamp(pick(row, ['check_in_at', 'check_in', 'clock_in_at', 'clock_in', 'check_in_time']));
  const outS = toStamp(pick(row, ['check_out_at', 'check_out', 'clock_out_at', 'clock_out', 'check_out_time']));
  const netMinutes = num(pick(row, ['net_minutes', 'minutes_worked', 'worked_minutes', 'total_minutes']));
  const hours = num(pick(row, ['hours_worked', 'worked_hours', 'total_hours']));
  return {
    crmAttendanceId: str(pick(row, ['crm_attendance_id', 'id'])),
    user: {
      crmUserId: str(pick(row, ['crm_user_id', 'user_id', 'employee_id'])),
      email: lower(pick(row, ['email', 'user_email', 'employee_email'])),
    },
    date: toDay(pick(row, ['date', 'work_date', 'attendance_date'])),
    inISO: inS.iso, inTime: inS.time,
    outISO: outS.iso, outTime: outS.time,
    seconds: netMinutes != null ? netMinutes * 60 : (hours != null ? hours * 3600 : null),
    status: lower(pick(row, ['status'])),
  };
}

// ===========================================================================
// LEAVE — ET-CRM leave requests
//   crm_leave_request_id, crm_user_id, start_date, end_date, days_count,
//   is_half_day, half_day_period, status (pending|approved|rejected|cancelled)
// ===========================================================================
const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
function mapLeave(row) {
  const rawStatus = lower(pick(row, ['status']));
  const status = rawStatus === 'canceled' ? 'cancelled' : rawStatus;
  const period = lower(pick(row, ['half_day_period', 'half_day']));
  const start = toDay(pick(row, ['start_date', 'from_date', 'from']));
  return {
    crmLeaveRequestId: str(pick(row, ['crm_leave_request_id', 'id'])),
    user: {
      crmUserId: str(pick(row, ['crm_user_id', 'user_id', 'employee_id'])),
      email: lower(pick(row, ['email', 'user_email', 'employee_email'])),
    },
    start,
    end: toDay(pick(row, ['end_date', 'to_date', 'to'])) || start,
    daysCount: num(pick(row, ['days_count', 'days'])),
    isHalfDay: triBool(pick(row, ['is_half_day', 'half_day_flag'])) === true,
    // AM = morning, PM = afternoon; anything unclear on a half day defaults to AM
    halfDayPeriod: period && /^(pm|afternoon|p)/.test(period) ? 'PM' : 'AM',
    status,
    statusValid: LEAVE_STATUSES.includes(status),
    type: str(pick(row, ['leave_type', 'type'])),
    reason: str(pick(row, ['reason', 'notes'])),
  };
}

// ---- contact lists from ET-CRM's list-pipeline action ----
// The response shape isn't fixed, so accept a bare array or the first array
// found under a likely key (or any key).
function extractList(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return null;
  for (const k of ['contacts', 'data', 'results', 'items', 'pipeline', 'rows', 'records', 'users', 'attendance', 'leave']) {
    if (Array.isArray(json[k])) return json[k];
    if (json[k] && typeof json[k] === 'object') { const inner = extractList(json[k]); if (inner) return inner; }
  }
  for (const k of Object.keys(json)) if (Array.isArray(json[k])) return json[k];
  return null;
}

// ===========================================================================
// What has been received and what became of it — state.crmSync, shown in
// Admin → CRM connection. Safe metadata only: field NAMES, never values.
//   outcomes: created · updated · skipped · unlinked · ambiguous · conflict
//             · invalid · error   (legacy rows may carry 'ok')
// ===========================================================================
const OK_OUTCOMES = ['created', 'updated', 'ok'];
const FAIL_OUTCOMES = ['error', 'invalid', 'conflict', 'ambiguous'];
function record(state, kind, type, outcome, note, crmId, keys) {
  const s = state.crmSync = state.crmSync || { events: [], counts: {} };
  const c = s.counts[kind] = s.counts[kind] || { last: null };
  const at = new Date().toISOString();
  c[outcome] = (c[outcome] || 0) + 1;
  c.last = { at, type, outcome, note: String(note || '').slice(0, 200) };
  if (OK_OUTCOMES.includes(outcome)) c.lastOk = at;
  if (FAIL_OUTCOMES.includes(outcome)) c.lastFail = { at, outcome, note: String(note || '').slice(0, 200) };
  s.events.unshift({
    at, kind, type, outcome, note: String(note || '').slice(0, 200),
    crmId: blank(crmId) ? null : String(crmId).slice(0, 64),
    keys: Array.isArray(keys) ? keys.slice(0, 40) : null,
  });
  if (s.events.length > 100) s.events.length = 100;
}

// ---- people ET-CRM mentions that we cannot match to an employee yet ----
// Attendance / leave for an unknown CRM user is never guessed by name: it waits
// here (compact rows only) until an admin links that CRM user to an employee,
// and is then replayed. Capped so it can never grow without bound.
const UNLINKED_MAX_USERS = 200, UNLINKED_MAX_ROWS = 40;
function noteUnlinked(state, kind, user, pendingRow) {
  const s = state.crmSync = state.crmSync || { events: [], counts: {} };
  const q = s.unlinked = s.unlinked || {};
  const key = (user && user.crmUserId) || (user && user.email) || 'unknown';
  if (!q[key] && Object.keys(q).length >= UNLINKED_MAX_USERS) return null;
  const at = new Date().toISOString();
  const e = q[key] = q[key] || { key, crmUserId: (user && user.crmUserId) || null, email: (user && user.email) || null, firstAt: at, lastAt: at, count: 0, kinds: {}, pending: [] };
  e.lastAt = at; e.count++; e.kinds[kind] = (e.kinds[kind] || 0) + 1;
  if (pendingRow) {
    // the same CRM row sent again replaces the earlier copy
    const idKey = pendingRow.crmAttendanceId || pendingRow.crmLeaveRequestId;
    if (idKey) e.pending = e.pending.filter(p => !(p.kind === kind && p.row && (p.row.crmAttendanceId || p.row.crmLeaveRequestId) === idKey));
    e.pending.push({ kind, row: pendingRow });
    if (e.pending.length > UNLINKED_MAX_ROWS) e.pending.shift();
  }
  return e;
}
function takeUnlinked(state, crmUserId) {
  const q = (state.crmSync && state.crmSync.unlinked) || {};
  const e = q[crmUserId];
  if (e) delete q[crmUserId];
  return e || null;
}
function unlinkedList(state) {
  const q = (state.crmSync && state.crmSync.unlinked) || {};
  return Object.values(q).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))
    .map(e => ({ key: e.key, crmUserId: e.crmUserId, email: e.email, firstAt: e.firstAt, lastAt: e.lastAt, count: e.count, kinds: e.kinds, waiting: (e.pending || []).length }));
}

module.exports = {
  pick, blank, str, lower, num, isSet, triBool, normalizeEvent, toDay, toStamp, nzLocalToISO, extractList, normPhone,
  INACTIVE_STATUSES, mapUser,
  DEFAULT_ELIGIBILITY, eligibility, isClientContact, describeEligibility, mapContact, matchClient, classifyLinkBack,
  mapAttendance, LEAVE_STATUSES, mapLeave,
  OK_OUTCOMES, FAIL_OUTCOMES, record, noteUnlinked, takeUnlinked, unlinkedList,
};
