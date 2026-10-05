const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('./crm-sync');
const apply = require('./crm-apply');

// fast, deterministic dependencies (no bcrypt cost, fixed ids)
let seq = 0;
const deps = { newId: p => p + 'T' + (++seq), hashPassword: pw => 'hash:' + pw, newTempPassword: () => 'Temp-' + (++seq), today: () => '2026-10-05', now: () => '2026-10-05T01:00:00.000Z', retired: new Set(['gone@firm.nz']) };
const fresh = () => ({
  employees: [
    { id: 'e1', name: 'Founder', email: 'founder@firm.nz', accessRole: 'superadmin', jobTitle: 'Director' },
    { id: 'e2', name: 'Ann Lee', email: 'ann@firm.nz', accessRole: 'employee', jobTitle: 'Team Member', team: 'Tax', slackUserId: null },
    { id: 'e3', name: 'Bob Ray', email: 'bob@firm.nz', accessRole: 'employee', jobTitle: 'Accountant', crmUserId: 'u-bob' },
  ],
  clients: [], tasks: [], attendance: {}, leaveRequests: [], leaveSeq: 0,
});
const user = (o) => ({ crm_user_id: 'u-new', full_name: 'New Person', email: 'new@firm.nz', is_active: true, ...o });

/* ============================ EMPLOYEES ============================ */
test('EMPLOYEE: a new CRM user becomes a plain employee with a welcome login, never admin', () => {
  const s = fresh();
  const r = apply.applyUser(s, user({ designation: 'Accountant', department: 'Tax', slack_user_id: 'U9', manager_id: 'u-bob' }), deps);
  assert.equal(r.http, 200); assert.equal(r.outcome, 'created');
  const e = s.employees.find(x => x.crmUserId === 'u-new');
  assert.equal(e.accessRole, 'employee'); assert.deepEqual(e.managesIds, []); assert.equal(e.team, 'Unassigned');
  assert.equal(e.jobTitle, 'Accountant'); assert.equal(e.crmDepartment, 'Tax'); assert.equal(e.crmManagerId, 'u-bob'); assert.equal(e.mustChangePassword, true);
  assert.equal(r.welcome.slackUserId, 'U9'); assert.ok(r.welcome.tempPassword);
  assert.equal(e.passwordHash, 'hash:' + r.welcome.tempPassword);
  assert.ok(!('password' in e), 'no CRM credentials are ever imported');
});
test('EMPLOYEE: the same CRM user again updates the same employee — never a second one', () => {
  const s = fresh();
  apply.applyUser(s, user(), deps);
  const n = s.employees.length;
  const r2 = apply.applyUser(s, user({ full_name: 'New Person Renamed', designation: 'Senior' }), deps);
  assert.equal(r2.outcome, 'updated'); assert.equal(s.employees.length, n);
  assert.equal(s.employees.filter(e => e.crmUserId === 'u-new').length, 1);
  const r3 = apply.applyUser(s, user({ full_name: 'New Person Renamed', designation: 'Senior' }), deps);
  assert.equal(r3.outcome, 'skipped', 'an unchanged repeat is a safe no-op'); assert.equal(r3.http, 202); assert.equal(s.employees.length, n);
});
test('EMPLOYEE: unique work email links an existing person and persists the CRM id', () => {
  const s = fresh();
  const r = apply.applyUser(s, user({ crm_user_id: 'u-ann', email: 'ANN@firm.nz', full_name: 'Ann Lee' }), deps);
  assert.equal(r.outcome, 'updated'); assert.match(r.note, /linked by work email/);
  const ann = s.employees.find(e => e.id === 'e2');
  assert.equal(ann.crmUserId, 'u-ann'); assert.equal(ann.crmUserIdHistory.length, 1); assert.equal(s.employees.length, 3);
  assert.equal(ann.accessRole, 'employee'); assert.equal(ann.team, 'Tax', 'team/role/org chart are not overwritten');
});
test('EMPLOYEE: a name alone never links anyone', () => {
  const s = fresh();
  const r = apply.applyUser(s, user({ crm_user_id: 'u-x', email: 'someone.else@firm.nz', full_name: 'Ann Lee' }), deps);
  assert.equal(r.outcome, 'created'); assert.equal(s.employees.find(e => e.id === 'e2').crmUserId, undefined);
});
test('EMPLOYEE: ambiguous work email is blocked, a linked-elsewhere email is a conflict', () => {
  const s = fresh();
  s.employees.push({ id: 'e9', name: 'Ann Twin', email: 'ann@firm.nz', accessRole: 'employee' });
  const amb = apply.applyUser(s, user({ crm_user_id: 'u-ann', email: 'ann@firm.nz' }), deps);
  assert.equal(amb.http, 409); assert.equal(amb.outcome, 'ambiguous'); assert.equal(s.employees.filter(e => e.crmUserId === 'u-ann').length, 0);
  const clash = apply.applyUser(s, user({ crm_user_id: 'u-other', email: 'bob@firm.nz' }), deps);
  assert.equal(clash.http, 409); assert.equal(clash.outcome, 'conflict'); assert.equal(s.employees.find(e => e.id === 'e3').crmUserId, 'u-bob');
  const dup = fresh(); dup.employees.push({ id: 'e8', name: 'Dup', email: 'dup@firm.nz', crmUserId: 'u-bob' });
  assert.equal(apply.applyUser(dup, user({ crm_user_id: 'u-bob', email: 'bob@firm.nz' }), deps).outcome, 'ambiguous');
});
test('EMPLOYEE: invalid payloads are rejected', () => {
  const s = fresh();
  assert.equal(apply.applyUser(s, { full_name: 'No Id', email: 'x@firm.nz' }, deps).http, 400);
  assert.equal(apply.applyUser(s, { crm_user_id: 'u-noemail', full_name: 'No Email' }, deps).http, 400);
  assert.equal(s.employees.length, 3);
});
test('EMPLOYEE: inactive / terminated / resigned disables access but keeps history and open work', () => {
  const s = fresh();
  s.tasks.push({ id: 't1', assignedTo: 'e3', status: 'accepted' }, { id: 't2', assignedTo: 'e3', status: 'completed' });
  const r = apply.applyUser(s, user({ crm_user_id: 'u-bob', email: 'bob@firm.nz', is_active: false, employment_status: 'resigned' }), deps);
  assert.equal(r.outcome, 'updated'); assert.equal(r.openTasks, 1); assert.equal(r.newlyDisabled, true);
  const bob = s.employees.find(e => e.id === 'e3');
  assert.equal(bob.accessDisabled.by, 'crm');
  assert.ok(s.employees.find(e => e.id === 'e3'), 'employee record kept');
  assert.equal(s.tasks.find(t => t.id === 't1').assignedTo, 'e3', 'open work is NOT reassigned automatically');
  assert.equal(s.tasks.length, 2);
  // repeated event: no second disable
  assert.equal(apply.applyUser(s, user({ crm_user_id: 'u-bob', email: 'bob@firm.nz', is_active: false, employment_status: 'resigned' }), deps).outcome, 'skipped');
  // terminated by status alone
  const s2 = fresh();
  assert.equal(apply.applyUser(s2, user({ crm_user_id: 'u-bob', email: 'bob@firm.nz', is_active: true, employment_status: 'terminated' }), deps).newlyDisabled, true);
});
test('EMPLOYEE: on leave never disables; coming back restores CRM-disabled access', () => {
  const s = fresh();
  const r = apply.applyUser(s, user({ crm_user_id: 'u-bob', email: 'bob@firm.nz', employment_status: 'on_leave' }), deps);
  assert.ok(!s.employees.find(e => e.id === 'e3').accessDisabled);
  assert.equal(r.accessDisabled, false);
  apply.applyUser(s, user({ crm_user_id: 'u-bob', email: 'bob@firm.nz', is_active: false }), deps);
  assert.ok(s.employees.find(e => e.id === 'e3').accessDisabled);
  const back = apply.applyUser(s, user({ crm_user_id: 'u-bob', email: 'bob@firm.nz', is_active: true, employment_status: 'active' }), deps);
  assert.match(back.note, /access restored/); assert.ok(!s.employees.find(e => e.id === 'e3').accessDisabled);
});
test('EMPLOYEE: the last active superadmin is never locked out by a CRM flag', () => {
  const s = fresh();
  s.employees.find(e => e.id === 'e1').crmUserId = 'u-founder';
  const r = apply.applyUser(s, user({ crm_user_id: 'u-founder', email: 'founder@firm.nz', is_active: false }), deps);
  assert.equal(r.http, 409); assert.equal(r.outcome, 'conflict'); assert.ok(!s.employees.find(e => e.id === 'e1').accessDisabled);
});
test('EMPLOYEE: inactive people are not created; retired people are not re-created; a delete never deletes', () => {
  const s = fresh();
  assert.equal(apply.applyUser(s, user({ crm_user_id: 'u-i', email: 'i@firm.nz', is_active: false }), deps).outcome, 'skipped');
  assert.equal(apply.applyUser(s, user({ crm_user_id: 'u-r', email: 'gone@firm.nz' }), deps).outcome, 'skipped');
  assert.equal(s.employees.length, 3);
  const d = apply.applyUserDelete(s, { crm_user_id: 'u-bob' }, deps);
  assert.equal(d.outcome, 'skipped'); assert.equal(s.employees.length, 3); assert.ok(s.employees.find(e => e.id === 'e3').crmDeletedAt);
  assert.ok(!s.employees.find(e => e.id === 'e3').accessDisabled, 'a delete alone does not end access');
});

/* ============================ CUSTOMERS ============================ */
const contact = o => ({ id: 'k1', name: 'Kiwi Plumbing Ltd', email: 'k@kp.nz', phone: '021 555 0001', authority_signed: true, pbq_done_at: '2026-09-01T00:00:00Z', ...o });
test('CUSTOMER: an eligible contact creates a client and asks for the link-back', () => {
  const s = fresh();
  const r = apply.applyCustomer(s, contact({ assigned_to: 'u-bob' }), deps);
  assert.equal(r.outcome, 'created'); assert.equal(s.clients.length, 1);
  const c = s.clients[0];
  assert.equal(c.crmContactId, 'k1'); assert.equal(c.ownerId, 'e3');
  assert.deepEqual(r.linkBack, { crmContactId: 'k1', clientId: c.id });
});
test('CUSTOMER: the same event again never duplicates; a change updates the linked client', () => {
  const s = fresh();
  apply.applyCustomer(s, contact(), deps);
  const again = apply.applyCustomer(s, contact({ task_manager_client_id: s.clients[0].id }), deps);
  assert.equal(again.outcome, 'skipped'); assert.equal(again.linkBack, null, 'ET-CRM already holds our id'); assert.equal(s.clients.length, 1);
  const up = apply.applyCustomer(s, contact({ name: 'Kiwi Plumbing Limited', task_manager_client_id: s.clients[0].id }), deps);
  assert.equal(up.outcome, 'updated'); assert.equal(s.clients[0].name, 'Kiwi Plumbing Limited'); assert.equal(s.clients.length, 1);
});
test('CUSTOMER: a not-yet-eligible contact is skipped with the reason; an existing linked client still updates', () => {
  const s = fresh();
  const a = apply.applyCustomer(s, contact({ pbq_done_at: null }), deps);
  assert.equal(a.outcome, 'skipped'); assert.equal(a.http, 202); assert.match(a.note, /PBQ not done/); assert.equal(s.clients.length, 0);
  const b = apply.applyCustomer(s, contact({ authority_signed: false }), deps);
  assert.match(b.note, /authority not signed/);
  apply.applyCustomer(s, contact(), deps);
  const later = apply.applyCustomer(s, contact({ name: 'Kiwi Renamed Ltd', pbq_done_at: null }), deps);
  assert.equal(later.outcome, 'updated', 'once linked, eligibility no longer gates updates');
});
test('CUSTOMER: the client rule is configurable', () => {
  const s = fresh();
  s.crmSync = { eligibility: { requirePbqDone: false } };
  assert.equal(apply.applyCustomer(s, contact({ pbq_done_at: null }), deps).outcome, 'created');
  const s2 = fresh(); s2.crmSync = { eligibility: { requireAuthoritySigned: false, requirePbqDone: false } };
  assert.equal(apply.applyCustomer(s2, contact({ authority_signed: null, pbq_done_at: null }), deps).outcome, 'created');
});
test('CUSTOMER: an existing client is linked (not duplicated) by unique email, blanks filled, name kept', () => {
  const s = fresh();
  s.clients.push({ id: 'c1', name: 'Kiwi Plumbing', email: 'k@kp.nz', phone: null, ownerId: null });
  const r = apply.applyCustomer(s, contact({ pbq_done_at: null, authority_signed: false }), deps); // linking needs no eligibility
  assert.equal(r.outcome, 'updated'); assert.equal(s.clients.length, 1);
  assert.equal(s.clients[0].crmContactId, 'k1'); assert.equal(s.clients[0].name, 'Kiwi Plumbing'); assert.equal(s.clients[0].phone, '021 555 0001');
  assert.deepEqual(r.linkBack, { crmContactId: 'k1', clientId: 'c1' });
});
test('CUSTOMER: ambiguous matches are blocked, never merged', () => {
  const s = fresh();
  s.clients.push({ id: 'c1', name: 'Twin One', email: 'twin@t.nz' }, { id: 'c2', name: 'Twin Two', email: 'twin@t.nz' });
  const r = apply.applyCustomer(s, contact({ email: 'twin@t.nz' }), deps);
  assert.equal(r.http, 409); assert.equal(r.outcome, 'ambiguous'); assert.equal(s.clients.length, 2); assert.ok(!s.clients.some(c => c.crmContactId));
});
test('CUSTOMER: the firm\'s own email is never identity proof', () => {
  const s = fresh();
  s.clients.push({ id: 'c1', name: 'Training module', email: 'info@elitetaxation.co.nz' });
  const r = apply.applyCustomer(s, contact({ id: 'k2', name: 'Elite Taxation', email: 'info@elitetaxation.co.nz' }), deps);
  assert.equal(r.outcome, 'created'); assert.equal(s.clients.length, 2); assert.ok(!s.clients.find(c => c.id === 'c1').crmContactId);
});
test('CUSTOMER: ET-CRM pointing at a client that belongs to another contact is a conflict', () => {
  const s = fresh();
  s.clients.push({ id: 'c1', name: 'Taken', email: 't@t.nz', crmContactId: 'other' });
  const r = apply.applyCustomer(s, contact({ id: 'k5', task_manager_client_id: 'c1' }), deps);
  assert.equal(r.http, 409); assert.equal(r.outcome, 'conflict'); assert.equal(s.clients[0].crmContactId, 'other');
  const s2 = fresh();
  s2.clients.push({ id: 'c1', name: 'Kiwi Plumbing', email: 'k@kp.nz' }, { id: 'c2', name: 'Other', email: 'o@o.nz' });
  // ET-CRM's own stored id outranks email: the contact links to c2 (what ET-CRM says), never silently to c1
  const pick = apply.applyCustomer(s2, contact({ task_manager_client_id: 'c2' }), deps);
  assert.equal(pick.outcome, 'updated'); assert.equal(s2.clients.find(c => c.id === 'c2').crmContactId, 'k1'); assert.ok(!s2.clients.find(c => c.id === 'c1').crmContactId);
});
test('CUSTOMER: invalid payload and delete', () => {
  const s = fresh();
  assert.equal(apply.applyCustomer(s, { name: 'No id' }, deps).http, 400);
  apply.applyCustomer(s, contact(), deps);
  const d = apply.applyCustomerDelete(s, { id: 'k1' });
  assert.equal(d.outcome, 'skipped'); assert.equal(s.clients.length, 1); assert.ok(s.clients[0].crmDeletedAt);
});

/* ============================ ATTENDANCE ============================ */
const att = o => ({ crm_attendance_id: 'a1', crm_user_id: 'u-bob', date: '2026-10-05', check_in_at: '2026-10-04T20:00:00Z', check_out_at: '2026-10-05T04:30:00Z', net_minutes: 480, status: 'present', ...o });
test('ATTENDANCE: creates the day for the linked employee (NZ date, net minutes)', () => {
  const s = fresh();
  const r = apply.applyAttendance(s, att(), deps);
  assert.equal(r.http, 200); assert.equal(r.outcome, 'created'); assert.equal(r.date, '2026-10-05');
  const day = s.attendance.e3['2026-10-05'];
  assert.equal(day.loginAt, '2026-10-04T20:00:00.000Z'); assert.equal(day.secondsWorked, 28800); assert.equal(day.source, 'crm'); assert.equal(day.crmAttendanceId, 'a1');
});
test('ATTENDANCE: a duplicate is safe, a correction updates the SAME day', () => {
  const s = fresh();
  apply.applyAttendance(s, att(), deps);
  const dup = apply.applyAttendance(s, att(), deps);
  assert.equal(dup.outcome, 'skipped'); assert.equal(Object.keys(s.attendance.e3).length, 1);
  const fix = apply.applyAttendance(s, att({ check_out_at: '2026-10-05T05:30:00Z', net_minutes: 540 }), deps);
  assert.equal(fix.outcome, 'updated'); assert.equal(s.attendance.e3['2026-10-05'].secondsWorked, 32400); assert.equal(Object.keys(s.attendance.e3).length, 1);
});
test('ATTENDANCE: without an id, employee + date is the key (no second daily record)', () => {
  const s = fresh();
  apply.applyAttendance(s, att({ crm_attendance_id: undefined }), deps);
  apply.applyAttendance(s, att({ crm_attendance_id: undefined, net_minutes: 420 }), deps);
  assert.equal(Object.keys(s.attendance.e3).length, 1); assert.equal(s.attendance.e3['2026-10-05'].secondsWorked, 25200);
});
test('ATTENDANCE: a correction that moves the day clears the old one (no double day)', () => {
  const s = fresh();
  apply.applyAttendance(s, att(), deps);
  const mv = apply.applyAttendance(s, att({ date: '2026-10-06', check_in_at: '2026-10-05T20:00:00Z', check_out_at: '2026-10-06T04:00:00Z', net_minutes: 450 }), deps);
  assert.equal(mv.outcome, 'created'); assert.match(mv.note, /moved/);
  assert.equal(s.attendance.e3['2026-10-05'].secondsWorked, 0); assert.equal(s.attendance.e3['2026-10-05'].crmAttendanceId, undefined);
  assert.equal(s.attendance.e3['2026-10-06'].secondsWorked, 27000);
});
test('ATTENDANCE: the New Zealand day is used when only timestamps arrive', () => {
  const s = fresh();
  apply.applyAttendance(s, { crm_user_id: 'u-bob', check_in_at: '2026-11-03T20:30:00Z', check_out_at: '2026-11-04T04:30:00Z' }, deps);
  assert.ok(s.attendance.e3['2026-11-04'], '20:30Z is already the next morning in NZ');
  assert.equal(s.attendance.e3['2026-11-04'].secondsWorked, 28800);
});
test('ATTENDANCE: unknown user is skipped safely, queued, never matched by name; unique email works', () => {
  const s = fresh();
  const r = apply.applyAttendance(s, att({ crm_user_id: 'u-stranger' }), deps);
  assert.equal(r.http, 202); assert.equal(r.outcome, 'unlinked'); assert.deepEqual(s.attendance, {});
  assert.equal(sync.unlinkedList(s).length, 1);
  const byEmail = apply.applyAttendance(s, att({ crm_user_id: undefined, email: 'ann@firm.nz', crm_attendance_id: 'a2' }), deps);
  assert.equal(byEmail.outcome, 'created'); assert.ok(s.attendance.e2['2026-10-05']);
  assert.equal(s.employees.find(e => e.id === 'e2').crmUserId, undefined, 'attendance never links an identity by itself');
});
test('ATTENDANCE: invalid payloads', () => {
  const s = fresh();
  assert.equal(apply.applyAttendance(s, { crm_user_id: 'u-bob' }, deps).http, 400);
  assert.equal(apply.applyAttendance(s, { date: '2026-10-05' }, deps).http, 400);
});

/* ============================ LEAVE ============================ */
const leave = o => ({ crm_leave_request_id: 'l1', crm_user_id: 'u-bob', start_date: '2026-10-06', end_date: '2026-10-06', days_count: 1, is_half_day: false, status: 'approved', ...o });
test('LEAVE: approved full day is stored as approved leave (7h capacity cut — see e2e)', () => {
  const s = fresh();
  const r = apply.applyLeave(s, leave(), deps);
  assert.equal(r.outcome, 'created');
  const l = s.leaveRequests[0];
  assert.deepEqual([l.employeeId, l.from, l.to, l.halfDay, l.status, l.source, l.crmLeaveRequestId], ['e3', '2026-10-06', '2026-10-06', null, 'approved', 'crm', 'l1']);
});
test('LEAVE: half day carries its period (capacity 3.5h comes from base/2)', () => {
  const s = fresh();
  apply.applyLeave(s, leave({ is_half_day: true, half_day_period: 'afternoon', days_count: 0.5 }), deps);
  assert.equal(s.leaveRequests[0].halfDay, 'PM');
  assert.equal(apply.applyLeave(fresh(), leave({ is_half_day: true, start_date: '2026-10-06', end_date: '2026-10-07' }), deps).http, 400, 'a half day is one date');
});
test('LEAVE: pending and rejected are stored but are not approved (no capacity cut)', () => {
  const s = fresh();
  apply.applyLeave(s, leave({ crm_leave_request_id: 'lp', status: 'pending' }), deps);
  apply.applyLeave(s, leave({ crm_leave_request_id: 'lr', start_date: '2026-10-08', end_date: '2026-10-08', status: 'rejected' }), deps);
  assert.deepEqual(s.leaveRequests.map(l => l.status), ['pending', 'rejected']);
  assert.equal(s.leaveRequests.filter(l => l.status === 'approved').length, 0);
});
test('LEAVE: approved → cancelled, and a repeated event, update the SAME record', () => {
  const s = fresh();
  apply.applyLeave(s, leave(), deps);
  assert.equal(apply.applyLeave(s, leave(), deps).outcome, 'skipped');
  assert.equal(s.leaveRequests.length, 1);
  const c = apply.applyLeave(s, leave({ status: 'Cancelled' }), deps);
  assert.equal(c.outcome, 'updated'); assert.equal(s.leaveRequests.length, 1); assert.equal(s.leaveRequests[0].status, 'cancelled');
  const re = apply.applyLeave(s, leave({ status: 'approved', end_date: '2026-10-07', days_count: 2 }), deps);
  assert.equal(re.outcome, 'updated'); assert.equal(s.leaveRequests.length, 1); assert.equal(s.leaveRequests[0].to, '2026-10-07');
  assert.equal(s.leaveSeq, 1, 'no second leave number was issued');
});
test('LEAVE: unknown user waits, invalid payloads are rejected, a delete cancels but keeps the record', () => {
  const s = fresh();
  assert.equal(apply.applyLeave(s, leave({ crm_user_id: 'u-stranger' }), deps).outcome, 'unlinked'); assert.equal(s.leaveRequests.length, 0);
  assert.equal(apply.applyLeave(s, leave({ status: 'maybe' }), deps).http, 400);
  assert.equal(apply.applyLeave(s, leave({ end_date: '2026-10-01' }), deps).http, 400);
  assert.equal(apply.applyLeave(s, leave({ crm_leave_request_id: undefined }), deps).http, 400);
  assert.equal(apply.applyLeave(s, leave({ start_date: undefined, end_date: undefined }), deps).http, 400);
  apply.applyLeave(s, leave(), deps);
  const d = apply.applyLeaveDelete(s, { crm_leave_request_id: 'l1' }, deps);
  assert.equal(d.outcome, 'updated'); assert.equal(s.leaveRequests.length, 1); assert.equal(s.leaveRequests[0].status, 'cancelled'); assert.equal(s.leaveRequests[0].decisionNote, 'deleted in ET-CRM');
});

/* ============================ RESOLVING UNLINKED USERS ============================ */
test('an admin links a waiting CRM user and what was waiting is replayed', () => {
  const s = fresh();
  apply.applyAttendance(s, att({ crm_user_id: 'u-late' }), deps);
  apply.applyLeave(s, leave({ crm_user_id: 'u-late' }), deps);
  assert.equal(sync.unlinkedList(s)[0].waiting, 2);
  const bad = apply.linkUser(s, 'u-late', 'e3', 'Admin', deps);
  assert.equal(bad.ok, false); assert.equal(bad.http, 409, 'Bob is already linked to a different CRM user');
  const r = apply.linkUser(s, 'u-late', 'e2', 'Admin', deps);
  assert.equal(r.ok, true); assert.deepEqual(r.replayed, { attendance: 1, leave: 1, failed: 0 });
  assert.equal(s.employees.find(e => e.id === 'e2').crmUserId, 'u-late');
  assert.ok(s.attendance.e2['2026-10-05']); assert.equal(s.leaveRequests[0].employeeId, 'e2');
  assert.equal(sync.unlinkedList(s).length, 0);
  assert.equal(apply.linkUser(s, 'u-late', 'e1', 'Admin', deps).http, 409, 'a CRM id cannot be on two employees');
  assert.equal(apply.linkUser(s, 'u-x', 'nobody', 'Admin', deps).http, 404);
});

/* ============================ TASKS ARE NOT CRM'S ============================ */
test('there is no CRM task apply at all', () => {
  assert.equal(apply.applyTask, undefined); assert.equal(sync.mapTask, undefined);
});
