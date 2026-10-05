// ---------------------------------------------------------------------------
// ET-CRM → Task Manager: applying one event to the state document.
//
// Pure with respect to I/O: these functions only read/write the `state` object
// they are given (the caller saves it, sends Slack messages, calls ET-CRM).
// That keeps every rule unit-testable and lets "preview" run on a clone.
//
// Every apply* returns { http, outcome, note, crmId, ...extras } where
//   http     200 applied · 202 safely skipped · 400 invalid · 409 identity conflict
//   outcome  created · updated · skipped · unlinked · ambiguous · conflict · invalid
//
// What ET-CRM owns: employees, customers, attendance, leave, policy compliance.
// Tasks are never created, changed or imported from ET-CRM.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sync = require('./crm-sync');

const OK = (outcome, note, crmId, extra) => ({ http: 200, outcome, note, crmId: crmId || null, ...(extra || {}) });
const SKIP = (note, crmId, extra) => ({ http: 202, outcome: 'skipped', note, crmId: crmId || null, ...(extra || {}) });
const INVALID = (note, crmId) => ({ http: 400, outcome: 'invalid', note, crmId: crmId || null });
const CONFLICT = (note, crmId) => ({ http: 409, outcome: 'conflict', note, crmId: crmId || null });
const AMBIGUOUS = (note, crmId) => ({ http: 409, outcome: 'ambiguous', note, crmId: crmId || null });

const nowISO = () => new Date().toISOString();
const todayNZ = () => sync.toDay(nowISO());
const newId = prefix => prefix + Date.now().toString(36) + Math.floor(Math.random() * 100000).toString(36);
const defaults = {
  now: nowISO, today: todayNZ, newId,
  retired: new Set(),
  newTempPassword: () => crypto.randomBytes(9).toString('base64url'),
  hashPassword: pw => bcrypt.hashSync(pw, 10),
};
const depsOf = d => ({ ...defaults, ...(d || {}) });

// ---- who is this CRM user? crmUserId first, then a UNIQUE work email. Never a name. ----
function resolveEmployee(state, who) {
  const emps = (state && state.employees) || [];
  if (who && who.crmUserId) {
    const direct = emps.filter(e => e.crmUserId && String(e.crmUserId) === String(who.crmUserId));
    if (direct.length === 1) return { employee: direct[0], by: 'crmUserId' };
    if (direct.length > 1) return { ambiguous: true };
  }
  if (who && who.email) {
    const byEmail = emps.filter(e => e.email && e.email.toLowerCase() === who.email);
    if (byEmail.length === 1 && !(who.crmUserId && byEmail[0].crmUserId && String(byEmail[0].crmUserId) !== String(who.crmUserId))) {
      return { employee: byEmail[0], by: 'email' };
    }
    if (byEmail.length > 1) return { ambiguous: true };
  }
  return { employee: null };
}
const openTasksOf = (state, empId) => (state.tasks || []).filter(t => t.assignedTo === empId && t.status !== 'completed').length;
const activeSuperadmins = (state, exceptId) => (state.employees || []).filter(e => e.accessRole === 'superadmin' && !e.accessDisabled && e.id !== exceptId).length;

// ===========================================================================
// EMPLOYEES
// ===========================================================================
function applyUser(state, row, deps) {
  const d = depsOf(deps);
  const u = sync.mapUser(row);
  if (!u.crmUserId) return INVALID('crm_user_id is required');
  const emps = state.employees = state.employees || [];

  const byCrm = emps.filter(e => e.crmUserId && String(e.crmUserId) === u.crmUserId);
  if (byCrm.length > 1) return AMBIGUOUS('more than one employee already carries this CRM user id', u.crmUserId);
  let emp = byCrm[0] || null, linkedByEmail = false;
  if (!emp && u.email) {
    const byEmail = emps.filter(e => e.email && e.email.toLowerCase() === u.email);
    if (byEmail.length > 1) return AMBIGUOUS('more than one employee has this work email — not linked', u.crmUserId);
    if (byEmail.length === 1) {
      if (byEmail[0].crmUserId && String(byEmail[0].crmUserId) !== u.crmUserId) {
        return CONFLICT('this work email already belongs to an employee linked to a different CRM user', u.crmUserId);
      }
      emp = byEmail[0]; linkedByEmail = true;
    }
  }

  // ---- someone we have never seen ----
  if (!emp) {
    if (!u.email) return INVALID('email is required to create an employee', u.crmUserId);
    if (u.inactive) return SKIP('inactive in ET-CRM — not created', u.crmUserId);
    if (d.retired && d.retired.has(u.email)) return SKIP('retired person — not re-created', u.crmUserId);
    const tempPassword = d.newTempPassword();
    const created = {
      id: d.newId('e'), name: u.name || u.email, email: u.email, passwordHash: d.hashPassword(tempPassword),
      jobTitle: u.designation || 'Team Member', team: 'Unassigned',
      accessRole: 'employee', managesIds: [], memberships: [], gmailAddresses: [], isFounder: false,
      crmUserId: u.crmUserId, slackUserId: u.slackUserId || null,
      mustChangePassword: true,
      crmDepartment: u.department, crmDesignation: u.designation, employmentType: u.employmentType,
      employmentStatus: u.employmentStatus, crmManagerId: u.managerId, crmActive: u.isActive !== false,
      crmSyncedAt: d.now(),
    };
    emps.push(created);
    return OK('created', 'new employee added (' + created.id + ')' + (u.slackUserId ? ', login sent on Slack' : ', no Slack — login must be handed over by hand'), u.crmUserId,
      { empId: created.id, name: created.name, welcome: { slackUserId: u.slackUserId || null, email: u.email, name: created.name, tempPassword } });
  }

  // ---- someone we know: update, never duplicate ----
  const changed = [];
  const set = (field, value, label) => { if (value !== undefined && value !== null && emp[field] !== value) { emp[field] = value; changed.push(label || field); } };
  if (linkedByEmail) {
    emp.crmUserIdHistory = emp.crmUserIdHistory || [];
    emp.crmUserIdHistory.push({ at: d.now(), by: 'crm-sync', from: null, to: u.crmUserId });
    emp.crmUserId = u.crmUserId;
    changed.push('linked by work email');
  }
  set('name', u.name, 'name');
  set('crmDepartment', u.department, 'department');
  set('crmDesignation', u.designation, 'designation');
  set('employmentType', u.employmentType, 'employment type');
  set('employmentStatus', u.employmentStatus, 'employment status');
  set('crmManagerId', u.managerId, 'manager');
  if (u.isActive !== null) set('crmActive', u.isActive, 'active flag');
  if (u.slackUserId && !emp.slackUserId) { emp.slackUserId = u.slackUserId; changed.push('Slack id'); }
  if (u.designation && (!emp.jobTitle || emp.jobTitle === 'Team Member')) set('jobTitle', u.designation, 'job title');
  emp.crmSyncedAt = d.now();

  // Access follows ET-CRM — but only ever for people who have LEFT. Being on
  // leave never disables an account, history is never touched, and open work is
  // not reassigned (an admin reviews it).
  let openTasks = 0, accessNote = '';
  if (u.inactive) {
    if (!emp.accessDisabled) {
      if (emp.accessRole === 'superadmin' && activeSuperadmins(state, emp.id) === 0) {
        return CONFLICT('this is the last active superadmin — access NOT disabled; resolve in ET-CRM or promote someone first', u.crmUserId);
      }
      emp.accessDisabled = { at: d.now(), by: 'crm', reason: u.employmentStatus || 'inactive' };
      openTasks = openTasksOf(state, emp.id);
      changed.push('access disabled');
      accessNote = ' — login disabled' + (openTasks ? ', ' + openTasks + ' open task(s) need admin review' : '');
    }
  } else if (emp.accessDisabled && emp.accessDisabled.by === 'crm') {
    delete emp.accessDisabled;
    changed.push('access restored');
  }
  if (!changed.length) return SKIP('no change for ' + emp.id, u.crmUserId, { empId: emp.id });
  return OK('updated', emp.id + ': ' + changed.join(', ') + accessNote, u.crmUserId, { empId: emp.id, name: emp.name, accessDisabled: !!emp.accessDisabled, openTasks, newlyDisabled: changed.includes('access disabled') });
}

// A delete in ET-CRM never deletes a person here. They are marked, history is kept.
function applyUserDelete(state, row, deps) {
  const d = depsOf(deps);
  const u = sync.mapUser(row);
  if (!u.crmUserId) return INVALID('crm_user_id is required');
  const emp = (state.employees || []).find(e => e.crmUserId && String(e.crmUserId) === u.crmUserId);
  if (!emp) return SKIP('deleted in ET-CRM — not an employee here', u.crmUserId);
  emp.crmDeletedAt = d.now();
  return SKIP('deleted in ET-CRM — ' + emp.id + ' left as it is (history kept, login unchanged); set them inactive in ET-CRM to end access', u.crmUserId, { empId: emp.id });
}

// ===========================================================================
// CUSTOMERS
// ===========================================================================
function applyCustomer(state, row, deps) {
  const d = depsOf(deps);
  const c = sync.mapContact(row);
  if (!c.id) return INVALID('contact id is required');
  const clients = state.clients = state.clients || [];
  const rule = (state.crmSync && state.crmSync.eligibility) || null;

  // ET-CRM already points at a Task Manager client that belongs to another contact: a conflict, never a merge.
  if (c.linkedTmId) {
    const claimed = clients.find(x => x.id === c.linkedTmId);
    if (claimed && claimed.crmContactId && claimed.crmContactId !== c.id) {
      return CONFLICT('ET-CRM links this contact to a Task Manager client that belongs to a different contact', c.id);
    }
  }
  const m = sync.matchClient(clients, c);
  if (m && m.ambiguous) return AMBIGUOUS('more than one client matches by ' + m.by + ' — not merged', c.id);
  const owner = c.owner && (c.owner.crmUserId || c.owner.email) ? resolveEmployee(state, c.owner).employee : null;
  const linkBackFor = client => (c.linkedTmId === client.id ? null : { crmContactId: c.id, clientId: client.id });

  if (m) {
    const client = m.client;
    if (m.by !== 'linked' && c.linkedTmId && c.linkedTmId !== client.id && clients.find(x => x.id === c.linkedTmId)) {
      return CONFLICT('ET-CRM links this contact to a different Task Manager client than the one it matches', c.id);
    }
    const changed = [];
    if (m.by !== 'linked') { client.crmContactId = c.id; changed.push('linked (matched by ' + m.by + ')'); }
    // a linked client follows ET-CRM; a freshly-matched one only gets blanks filled
    const fresh = m.by !== 'linked';
    const put = (field, value, label) => {
      if (!value) return;
      if (fresh ? !client[field] : client[field] !== value) { client[field] = value; changed.push(label); }
    };
    put('name', c.name, 'name'); put('email', c.email, 'email'); put('phone', c.phone, 'phone'); put('type', c.category, 'category');
    if (!client.ownerId && owner) { client.ownerId = owner.id; changed.push('owner'); }
    const lb = linkBackFor(client);
    if (!changed.length) return SKIP('no change for client ' + client.id, c.id, { clientId: client.id, linkBack: lb });
    return OK('updated', 'client ' + client.id + ': ' + changed.join(', '), c.id, { clientId: client.id, linkBack: lb });
  }

  // Nothing matches — create only if this contact is a real working client.
  const el = sync.eligibility(c, rule);
  if (!el.ok) return SKIP('not a working client yet: ' + el.reason, c.id);
  const client = {
    id: d.newId('c'), name: c.name || 'Unnamed', email: c.email, phone: c.phone, type: c.category,
    ownerId: owner ? owner.id : null, addedBy: null, crmContactId: c.id,
  };
  clients.push(client);
  return OK('created', 'client added (' + client.id + ')', c.id, { clientId: client.id, linkBack: linkBackFor(client) });
}
function applyCustomerDelete(state, row) {
  const c = sync.mapContact(row);
  if (!c.id) return INVALID('contact id is required');
  const client = (state.clients || []).find(x => x.crmContactId === c.id);
  if (client) client.crmDeletedAt = new Date().toISOString();
  return SKIP('deleted in ET-CRM — the client here is kept exactly as it is', c.id, { clientId: client ? client.id : null });
}

// ===========================================================================
// ATTENDANCE
// ===========================================================================
function compactAttendance(a) { return { ...a, user: { ...a.user } }; }
function applyAttendance(state, row, deps) { return applyAttendanceMapped(state, sync.mapAttendance(row), deps); }
function applyAttendanceMapped(state, a, deps) {
  const d = depsOf(deps);
  if (!a.user.crmUserId && !a.user.email) return INVALID('crm_user_id is required', a.crmAttendanceId);
  const date = a.date || (a.inISO ? sync.toDay(a.inISO) : null);
  if (!date) return INVALID('date (or check_in_at) is required', a.crmAttendanceId);
  const r = resolveEmployee(state, a.user);
  if (r.ambiguous) return AMBIGUOUS('more than one employee matches this CRM user', a.crmAttendanceId);
  if (!r.employee) {
    sync.noteUnlinked(state, 'attendance', a.user, compactAttendance(a));
    return { http: 202, outcome: 'unlinked', note: 'CRM user ' + (a.user.crmUserId || a.user.email) + ' is not linked to an employee — waiting', crmId: a.crmAttendanceId };
  }
  const emp = r.employee;
  const inISO = a.inISO || (a.inTime ? sync.nzLocalToISO(date, a.inTime) : null);
  const outISO = a.outISO || (a.outTime ? sync.nzLocalToISO(date, a.outTime) : null);
  let seconds = a.seconds;
  if (seconds == null || !(seconds >= 0)) seconds = (inISO && outISO) ? Math.max(0, (new Date(outISO) - new Date(inISO)) / 1000) : null;
  if (seconds != null) seconds = Math.min(Math.round(seconds), 16 * 3600);

  const log = state.attendance = state.attendance || {};
  const mine = log[emp.id] = log[emp.id] || {};
  // Idempotency: the CRM attendance id first (a correction may MOVE the row to
  // another date), then employee + date.
  let moved = false;
  if (a.crmAttendanceId) {
    for (const [dt, day] of Object.entries(mine)) {
      if (day && day.crmAttendanceId === a.crmAttendanceId && dt !== date) {
        delete day.crmAttendanceId; day.loginAt = null; day.logoutAt = null; day.secondsWorked = 0; day.source = null; day.crmStatus = null;
        moved = true;
      }
    }
  }
  const existing = mine[date];
  const day = existing || { loginAt: null, logoutAt: null, secondsWorked: 0 };
  const before = JSON.stringify([day.loginAt, day.logoutAt, day.secondsWorked, day.crmStatus, day.crmAttendanceId]);
  day.loginAt = inISO || day.loginAt || null;
  day.logoutAt = outISO || day.logoutAt || null;
  if (seconds != null) day.secondsWorked = seconds;
  day.source = 'crm';
  day.crmStatus = a.status || day.crmStatus || null;
  if (a.crmAttendanceId) day.crmAttendanceId = a.crmAttendanceId;
  day.crmSyncedAt = d.now();
  mine[date] = day;
  const after = JSON.stringify([day.loginAt, day.logoutAt, day.secondsWorked, day.crmStatus, day.crmAttendanceId]);
  const label = emp.id + ' ' + date + ': ' + (Math.round((day.secondsWorked || 0) / 36) / 100) + 'h' + (day.logoutAt ? '' : ' (still in)') + (moved ? ' (moved from another date)' : '');
  if (!existing) return OK('created', label, a.crmAttendanceId, { empId: emp.id, date });
  if (before === after && !moved) return SKIP('no change — ' + label, a.crmAttendanceId, { empId: emp.id, date });
  return OK('updated', label, a.crmAttendanceId, { empId: emp.id, date });
}

// ===========================================================================
// LEAVE — only APPROVED leave reduces capacity (approvedLeaveOn reads status).
//   full day → 7h · half day → 3.5h (base/2); task allocated hours are untouched.
// ===========================================================================
function compactLeave(l) { return { ...l, user: { ...l.user } }; }
function applyLeave(state, row, deps) { return applyLeaveMapped(state, sync.mapLeave(row), deps); }
function applyLeaveMapped(state, l, deps) {
  const d = depsOf(deps);
  if (!l.crmLeaveRequestId) return INVALID('crm_leave_request_id is required');
  if (!l.user.crmUserId && !l.user.email) return INVALID('crm_user_id is required', l.crmLeaveRequestId);
  if (!l.start) return INVALID('start_date is required', l.crmLeaveRequestId);
  if (l.end < l.start) return INVALID('end_date is before start_date', l.crmLeaveRequestId);
  if (!l.statusValid) return INVALID('status must be pending, approved, rejected or cancelled', l.crmLeaveRequestId);
  if (l.isHalfDay && l.end !== l.start) return INVALID('a half day must be a single date', l.crmLeaveRequestId);
  const r = resolveEmployee(state, l.user);
  if (r.ambiguous) return AMBIGUOUS('more than one employee matches this CRM user', l.crmLeaveRequestId);
  if (!r.employee) {
    sync.noteUnlinked(state, 'leave', l.user, compactLeave(l));
    return { http: 202, outcome: 'unlinked', note: 'CRM user ' + (l.user.crmUserId || l.user.email) + ' is not linked to an employee — waiting', crmId: l.crmLeaveRequestId };
  }
  const emp = r.employee;
  const reqs = state.leaveRequests = state.leaveRequests || [];
  const LEAVE_TYPES = ['ANNUAL', 'SICK', 'UNPAID', 'WORKSHOP', 'OTHER'];
  const type = l.type && LEAVE_TYPES.includes(l.type.toUpperCase()) ? l.type.toUpperCase() : 'ANNUAL';
  const halfDay = l.isHalfDay ? l.halfDayPeriod : null;
  let rec = reqs.find(x => x.crmLeaveRequestId === l.crmLeaveRequestId);
  const decided = l.status !== 'pending';
  if (!rec) {
    state.leaveSeq = (state.leaveSeq || 0) + 1;
    rec = {
      id: 'lv-' + state.leaveSeq, employeeId: emp.id, from: l.start, to: l.end, type, halfDay, hours: null,
      backdated: l.start < d.today(), reason: l.reason || '', status: l.status,
      createdBy: null, createdAt: d.now(),
      decidedBy: null, decidedAt: decided ? d.now() : null, decisionNote: null,
      source: 'crm', crmLeaveRequestId: l.crmLeaveRequestId, crmDaysCount: l.daysCount, crmSyncedAt: d.now(),
    };
    reqs.push(rec);
    return OK('created', emp.id + ' ' + l.start + (l.end !== l.start ? '–' + l.end : '') + (halfDay ? ' (half day)' : '') + ' · ' + l.status, l.crmLeaveRequestId, { empId: emp.id, leaveId: rec.id });
  }
  const before = JSON.stringify([rec.employeeId, rec.from, rec.to, rec.halfDay, rec.status, rec.type, rec.reason]);
  rec.employeeId = emp.id; rec.from = l.start; rec.to = l.end; rec.halfDay = halfDay; rec.hours = null;
  rec.type = type; rec.reason = l.reason != null ? l.reason : rec.reason; rec.crmDaysCount = l.daysCount;
  if (rec.status !== l.status) { rec.status = l.status; rec.decidedAt = decided ? d.now() : null; }
  rec.crmSyncedAt = d.now();
  const after = JSON.stringify([rec.employeeId, rec.from, rec.to, rec.halfDay, rec.status, rec.type, rec.reason]);
  const label = emp.id + ' ' + l.start + (l.end !== l.start ? '–' + l.end : '') + (halfDay ? ' (half day)' : '') + ' · ' + l.status;
  if (before === after) return SKIP('no change — ' + label, l.crmLeaveRequestId, { empId: emp.id, leaveId: rec.id });
  return OK('updated', label, l.crmLeaveRequestId, { empId: emp.id, leaveId: rec.id });
}
// A leave deleted in ET-CRM no longer exists there: it stops reducing capacity,
// but the record (and who it was for) stays in the history.
function applyLeaveDelete(state, row, deps) {
  const d = depsOf(deps);
  const l = sync.mapLeave(row);
  if (!l.crmLeaveRequestId) return INVALID('crm_leave_request_id is required');
  const rec = (state.leaveRequests || []).find(x => x.crmLeaveRequestId === l.crmLeaveRequestId);
  if (!rec) return SKIP('deleted in ET-CRM — nothing here to cancel', l.crmLeaveRequestId);
  if (rec.status === 'cancelled') return SKIP('already cancelled here', l.crmLeaveRequestId);
  rec.status = 'cancelled'; rec.decidedAt = d.now(); rec.decisionNote = 'deleted in ET-CRM';
  return OK('updated', 'leave cancelled here because it was deleted in ET-CRM (history kept)', l.crmLeaveRequestId, { leaveId: rec.id });
}

// ===========================================================================
// Linking an unmatched CRM user by hand, then replaying what was waiting.
// ===========================================================================
function linkUser(state, crmUserId, employeeId, byName, deps) {
  const d = depsOf(deps);
  const emp = (state.employees || []).find(e => e.id === employeeId);
  if (!crmUserId) return { ok: false, http: 400, error: 'crmUserId is required.' };
  if (!emp) return { ok: false, http: 404, error: 'Employee not found.' };
  const clash = (state.employees || []).find(e => e.id !== emp.id && e.crmUserId && String(e.crmUserId) === String(crmUserId));
  if (clash) return { ok: false, http: 409, error: clash.name + ' already has that CRM user id.' };
  if (emp.crmUserId && String(emp.crmUserId) !== String(crmUserId)) return { ok: false, http: 409, error: emp.name + ' is already linked to a different CRM user. Change it in Manage Access first.' };
  if (!emp.crmUserId) {
    emp.crmUserIdHistory = emp.crmUserIdHistory || [];
    emp.crmUserIdHistory.push({ at: d.now(), by: byName || 'admin', from: null, to: String(crmUserId) });
    emp.crmUserId = String(crmUserId);
  }
  const entry = sync.takeUnlinked(state, String(crmUserId));
  const replayed = { attendance: 0, leave: 0, failed: 0 };
  ((entry && entry.pending) || []).forEach(p => {
    const res = p.kind === 'attendance' ? applyAttendanceMapped(state, p.row, d) : applyLeaveMapped(state, p.row, d);
    if (res.http === 200 || res.http === 202) replayed[p.kind]++; else replayed.failed++;
  });
  return { ok: true, employee: emp, replayed };
}

module.exports = {
  resolveEmployee, applyUser, applyUserDelete, applyCustomer, applyCustomerDelete,
  applyAttendance, applyAttendanceMapped, applyLeave, applyLeaveMapped, applyLeaveDelete, linkUser,
};
