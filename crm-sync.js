// ---------------------------------------------------------------------------
// CRM ↔ Task Manager sync helpers — pure functions, no server or database.
//
// The CRM (crm.elitetaxation.co.nz, Supabase) pushes row changes to us as
// Database Webhooks: { type: 'INSERT'|'UPDATE'|'DELETE', table, record,
// old_record }. We don't have the CRM's schema in front of us, so each mapper
// accepts the column names a CRM would most plausibly use and ignores the
// rest. What actually arrives is visible in Admin → CRM connection (field
// NAMES only, never the values), so a wrong guess shows up in minutes and is
// a one-line fix here.
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

// The shape a Supabase Database Webhook sends — or, failing that, the bare row.
function normalizeEvent(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.record && typeof b.record === 'object') {
    return { type: String(b.type || 'INSERT').toUpperCase(), table: b.table || null, row: b.record, oldRow: b.old_record || null };
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

function mapTask(row) {
  const hoursRaw = num(pick(row, ['estimated_hours', 'estimate_hours', 'est_hours', 'hours', 'estimated_time']));
  const minutes = num(pick(row, ['estimated_minutes', 'estimate_minutes', 'est_minutes', 'minutes']));
  return {
    crmTaskId: blank(row && row.id) ? null : String(row.id),
    title: str(pick(row, ['title', 'name', 'subject', 'task_name', 'task', 'summary'])),
    note: str(pick(row, ['description', 'notes', 'details', 'body'])),
    assignee: {
      crmUserId: str(pick(row, ['assigned_to', 'assignee_id', 'assigned_to_id', 'assigned_user_id', 'owner_id', 'user_id'])),
      email: lower(pick(row, ['assigned_to_email', 'assignee_email', 'owner_email', 'user_email'])),
    },
    creator: {
      crmUserId: str(pick(row, ['created_by', 'creator_id', 'created_by_id'])),
      email: lower(pick(row, ['created_by_email', 'creator_email'])),
    },
    client: {
      crmContactId: str(pick(row, ['customer_id', 'contact_id', 'client_id', 'customer', 'contact'])),
      name: str(pick(row, ['customer_name', 'contact_name', 'client_name'])),
    },
    due: toDay(pick(row, ['due_date', 'due_at', 'due_on', 'due', 'deadline'])),
    hours: hoursRaw != null ? hoursRaw : (minutes != null ? minutes / 60 : null),
    status: lower(pick(row, ['status', 'state'])),
  };
}

function mapAttendance(row) {
  const inS = toStamp(pick(row, ['check_in', 'clock_in', 'clock_in_at', 'check_in_at', 'login_at', 'start_time', 'in_time', 'punch_in', 'first_in', 'checked_in_at']));
  const outS = toStamp(pick(row, ['check_out', 'clock_out', 'clock_out_at', 'check_out_at', 'logout_at', 'end_time', 'out_time', 'punch_out', 'last_out', 'checked_out_at']));
  const hours = num(pick(row, ['hours_worked', 'worked_hours', 'total_hours', 'duration_hours', 'hours']));
  const minutes = num(pick(row, ['minutes_worked', 'worked_minutes', 'total_minutes', 'duration_minutes']));
  const secs = num(pick(row, ['seconds_worked', 'worked_seconds', 'duration_seconds']));
  return {
    crmAttendanceId: blank(row && row.id) ? null : String(row.id),
    user: {
      crmUserId: str(pick(row, ['user_id', 'employee_id', 'staff_id', 'profile_id', 'assigned_to'])),
      email: lower(pick(row, ['email', 'user_email', 'employee_email'])),
    },
    date: toDay(pick(row, ['date', 'work_date', 'attendance_date', 'day'])),
    inISO: inS.iso, inTime: inS.time,
    outISO: outS.iso, outTime: outS.time,
    seconds: secs != null ? secs : (hours != null ? hours * 3600 : (minutes != null ? minutes * 60 : null)),
  };
}

// ---- pulling contacts from the CRM's list-pipeline action ----
// The response shape isn't documented to us, so accept a bare array or the
// first array found under a likely key (or any key).
function extractList(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return null;
  for (const k of ['contacts', 'data', 'results', 'items', 'pipeline', 'rows', 'records']) {
    if (Array.isArray(json[k])) return json[k];
    if (json[k] && typeof json[k] === 'object') { const inner = extractList(json[k]); if (inner) return inner; }
  }
  for (const k of Object.keys(json)) if (Array.isArray(json[k])) return json[k];
  return null;
}
// digits only; compare on the last 8 so "+64 21 123 456" and "021 123 456" meet
function normPhone(v) {
  const d = blank(v) ? '' : String(v).replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-8) : null;
}
// A flag column can be a boolean, a "yes", or a timestamp of when it happened.
function isSet(v) {
  if (blank(v)) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return !/^(false|no|n|0|null|none|pending)$/i.test(String(v).trim());
}
function mapContact(row) {
  const first = str(pick(row, ['first_name', 'firstname', 'given_name']));
  const last = str(pick(row, ['last_name', 'lastname', 'surname', 'family_name']));
  return {
    id: blank(row && row.id) ? null : String(row.id),
    name: str(pick(row, ['name', 'full_name', 'display_name', 'company_name'])) || [first, last].filter(Boolean).join(' ') || null,
    email: lower(pick(row, ['email', 'email_address'])),
    phone: str(pick(row, ['phone', 'mobile', 'phone_number'])),
    category: str(pick(row, ['category', 'type'])),
    stage: lower(pick(row, ['stage', 'pipeline_stage', 'onboarding_stage', 'status'])),
    linkedTmId: str(pick(row, ['task_manager_client_id'])),
    // What the CRM says about onboarding — the rule for "is a client" is
    // isClientContact(): authority signed AND onboarding finished.
    authoritySigned: isSet(pick(row, ['authority_signed', 'authority_signed_at', 'authority_received_at'])),
    // "Onboarding finished" = pbq_done_at is set: we then hold everything needed to start work (for now).
    onboardingDone: isSet(row && row.pbq_done_at),
    stages: {
      status: lower(row && row.status), lead: lower(row && row.lead_stage), onboarding: lower(row && row.onboarding_stage),
    },
    owner: {
      crmUserId: str(pick(row, ['owner_id', 'assigned_to', 'agent_id', 'account_manager_id', 'assigned_user_id'])),
      email: lower(pick(row, ['owner_email', 'assigned_to_email', 'agent_email'])),
    },
  };
}
// The user's definition: a client is someone whose onboarding is finished and
// whose authority is signed. "Finished" means pbq_done_at is set — we then
// have all the information needed to start working on them.
const isClientContact = c => !!(c && c.authoritySigned && c.onboardingDone);
// Which existing client is this contact? Linked id first, then the id the CRM
// stored back, then email, phone, and finally an exact name — each only when
// it points at exactly ONE client that isn't already tied to another contact.
function matchClient(clients, c) {
  const free = x => !x.crmContactId || x.crmContactId === c.id;
  let hit = clients.find(x => c.id && x.crmContactId === c.id);
  if (hit) return { client: hit, by: 'linked' };
  if (c.linkedTmId) { hit = clients.find(x => x.id === c.linkedTmId && free(x)); if (hit) return { client: hit, by: 'stored id' }; }
  const tries = [
    ['email', c.email, x => lower(x.email) === c.email],
    ['phone', normPhone(c.phone), x => normPhone(x.phone) === normPhone(c.phone)],
    ['name', c.name && c.name.toLowerCase(), x => x.name && x.name.trim().toLowerCase() === c.name.toLowerCase()],
  ];
  for (const [by, key, test] of tries) {
    if (!key) continue;
    const found = clients.filter(x => free(x) && test(x));
    if (found.length === 1) return { client: found[0], by };
    if (found.length > 1) return { ambiguous: true, by };
  }
  return null;
}

// What has been received and what happened to it — kept in state.crmSync so
// the Admin screen can show it. Only field names are stored, never values.
function record(state, kind, type, outcome, note, crmId, keys) {
  const s = state.crmSync = state.crmSync || { events: [], counts: {} };
  const c = s.counts[kind] = s.counts[kind] || { ok: 0, skipped: 0, error: 0, last: null };
  const at = new Date().toISOString();
  c[outcome] = (c[outcome] || 0) + 1;
  c.last = { at, type, outcome, note: String(note || '').slice(0, 200) };
  s.events.unshift({
    at, kind, type, outcome, note: String(note || '').slice(0, 200),
    crmId: blank(crmId) ? null : String(crmId).slice(0, 64),
    keys: Array.isArray(keys) ? keys.slice(0, 40) : null,
  });
  if (s.events.length > 60) s.events.length = 60;
}

module.exports = { pick, normalizeEvent, toDay, toStamp, nzLocalToISO, extractList, normPhone, isSet, isClientContact, mapContact, matchClient, mapTask, mapAttendance, record };
