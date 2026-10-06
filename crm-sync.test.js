const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('./crm-sync');

test('Supabase webhook envelope is unwrapped, DELETE reads old_record', () => {
  const ev = sync.normalizeEvent({ type: 'insert', table: 'crm_users', record: { id: 'a' }, old_record: null });
  assert.equal(ev.type, 'INSERT'); assert.equal(ev.row.id, 'a'); assert.equal(ev.table, 'crm_users');
  const del = sync.normalizeEvent({ type: 'DELETE', table: 'contacts', record: null, old_record: { id: 'gone' } });
  assert.equal(del.type, 'DELETE'); assert.equal(del.row.id, 'gone');
  assert.equal(sync.normalizeEvent({ id: 'x' }).row.id, 'x');
});

test('USER contract: explicit names, status handling', () => {
  const u = sync.mapUser({ crm_user_id: 'u1', full_name: ' Ann Lee ', email: 'ANN@Firm.nz', is_active: true, department: 'Tax', designation: 'Accountant',
    employment_type: 'full_time', employment_status: 'On_Leave', slack_user_id: 'U123', manager_id: 'm1' });
  assert.deepEqual([u.crmUserId, u.name, u.email, u.department, u.designation, u.employmentType, u.slackUserId, u.managerId],
    ['u1', 'Ann Lee', 'ann@firm.nz', 'Tax', 'Accountant', 'full_time', 'U123', 'm1']);
  assert.equal(u.employmentStatus, 'on_leave');
  assert.equal(u.inactive, false, 'on leave is never inactive');
  assert.equal(sync.mapUser({ crm_user_id: 'u', is_active: false }).inactive, true);
  assert.equal(sync.mapUser({ crm_user_id: 'u', employment_status: 'Terminated' }).inactive, true);
  assert.equal(sync.mapUser({ crm_user_id: 'u', employment_status: 'resigned', is_active: true }).inactive, true);
  assert.equal(sync.mapUser({ crm_user_id: 'u' }).inactive, false);
  assert.equal(sync.mapUser({ id: 'legacy' }).crmUserId, 'legacy'); // legacy alias still read
});

test('CONTACT contract + the configurable client rule', () => {
  const c = row => sync.mapContact(row);
  const full = c({ id: 'k1', name: 'Kiwi Ltd', email: 'K@kp.nz', authority_signed: true, pbq_done_at: '2026-09-01', task_manager_client_id: 'c9' });
  assert.equal(full.id, 'k1'); assert.equal(full.email, 'k@kp.nz'); assert.equal(full.linkedTmId, 'c9');
  assert.deepEqual(sync.eligibility(full), { ok: true, reason: '' });
  assert.equal(sync.eligibility(c({ id: 2, authority_signed: true })).reason, 'PBQ not done');
  assert.equal(sync.eligibility(c({ id: 3, pbq_done_at: '2026-09-01' })).reason, 'authority not signed');
  assert.equal(sync.eligibility(c({ id: 4 })).reason, 'authority not signed and PBQ not done');
  // configurable
  assert.equal(sync.eligibility(c({ id: 5, authority_signed: true }), { requirePbqDone: false }).ok, true);
  assert.equal(sync.eligibility(c({ id: 6 }), { requireAuthoritySigned: false, requirePbqDone: false }).ok, true);
  assert.equal(sync.describeEligibility(), 'authority signed AND PBQ done');
  assert.equal(sync.describeEligibility({ requirePbqDone: false }), 'authority signed');
  assert.equal(sync.isClientContact(c({ id: 7, authority_signed: 'no', pbq_done_at: 'x' })), false);
});

test('a contact is matched to the one client it is, never a guess', () => {
  const clients = [
    { id: 'c1', name: 'Kiwi Plumbing', email: 'a@kp.nz', phone: '021 123 456' },
    { id: 'c2', name: 'Other Ltd', email: 'x@o.nz', phone: null, crmContactId: 'crm-9' },
    { id: 'c3', name: 'Twin', email: 'same@t.nz' }, { id: 'c4', name: 'Twin 2', email: 'same@t.nz' },
  ];
  const m = c => sync.matchClient(clients, sync.mapContact(c));
  assert.equal(m({ id: 'k1', name: 'zzz', email: 'A@kp.nz' }).client.id, 'c1');
  assert.equal(m({ id: 'k2', name: 'zzz', phone: '+64211 23456' }).client.id, 'c1');
  assert.equal(m({ id: 'crm-9', name: 'Whatever' }).by, 'linked');
  assert.equal(m({ id: 'k3', email: 'same@t.nz' }).ambiguous, true);
  assert.equal(m({ id: 'k4', name: 'kiwi plumbing' }).client.id, 'c1');
  assert.equal(m({ id: 'k5', name: 'Nobody' }), null);
  assert.equal(m({ id: 'k6', email: 'x@o.nz' }), null, 'a client already tied to another contact is not stolen');
  assert.equal(m({ id: 'k7', task_manager_client_id: 'c1', name: 'zzz' }).by, 'stored id');
  const first = [{ id: 'c9', name: 'Varun', email: 'v@v.nz' }];
  assert.equal(sync.matchClient(first, sync.mapContact({ id: 'k9', name: 'varun' })), null, 'a bare first name is never enough');
  const own = [{ id: 'c8', name: 'Training module', email: 'info@elitetaxation.co.nz' }];
  assert.equal(sync.matchClient(own, sync.mapContact({ id: 'k8', name: 'Elite Taxation', email: 'info@elitetaxation.co.nz' })), null, 'the firm address is never identity proof');
});

test('link-back outcome: ok, conflict (never overwritten) and not-yet-offered', () => {
  assert.equal(sync.classifyLinkBack({ ok: true }).outcome, 'updated');
  assert.equal(sync.classifyLinkBack({ ok: false, error: 'Conflict: contact already linked to a different client' }).outcome, 'conflict');
  assert.equal(sync.classifyLinkBack({ ok: false, error: 'HTTP 409' }).outcome, 'conflict');
  assert.equal(sync.classifyLinkBack({ ok: false, error: 'unknown action' }).outcome, 'error');
  assert.equal(sync.classifyLinkBack({ ok: false, error: 'timeout' }).outcome, 'error');
});

test('ATTENDANCE contract: explicit names, NZ day, net minutes', () => {
  const a = sync.mapAttendance({ crm_attendance_id: 'a1', crm_user_id: 'u1', date: '2026-10-05', check_in_at: '2026-10-04T20:00:00Z', check_out_at: '2026-10-05T04:30:00Z', net_minutes: 480, status: 'Present' });
  assert.equal(a.crmAttendanceId, 'a1'); assert.equal(a.user.crmUserId, 'u1'); assert.equal(a.date, '2026-10-05');
  assert.equal(a.inISO, '2026-10-04T20:00:00.000Z'); assert.equal(a.outISO, '2026-10-05T04:30:00.000Z');
  assert.equal(a.seconds, 28800); assert.equal(a.status, 'present');
  assert.equal(sync.mapAttendance({ crm_user_id: 'u', check_in_at: '2026-11-03T20:30:00Z' }).date, null);
  assert.equal(sync.toDay('2026-11-03T20:30:00Z'), '2026-11-04', 'already tomorrow in New Zealand');
  const t = sync.mapAttendance({ id: 'x', user_id: 'u', date: '2026-10-05', clock_in: '09:05', clock_out: '17:30' });
  assert.equal(t.inTime, '09:05'); assert.equal(t.outTime, '17:30'); // legacy aliases still read
});

test('LEAVE contract: explicit names, statuses, half-day period', () => {
  const l = sync.mapLeave({ crm_leave_request_id: 'l1', crm_user_id: 'u1', start_date: '2026-10-06', end_date: '2026-10-08', days_count: 3, is_half_day: false, status: 'Approved' });
  assert.deepEqual([l.crmLeaveRequestId, l.user.crmUserId, l.start, l.end, l.daysCount, l.isHalfDay, l.status, l.statusValid], ['l1', 'u1', '2026-10-06', '2026-10-08', 3, false, 'approved', true]);
  const h = sync.mapLeave({ crm_leave_request_id: 'l2', crm_user_id: 'u', start_date: '2026-10-06', is_half_day: true, half_day_period: 'afternoon', status: 'pending' });
  assert.equal(h.isHalfDay, true); assert.equal(h.halfDayPeriod, 'PM'); assert.equal(h.end, '2026-10-06');
  assert.equal(sync.mapLeave({ crm_leave_request_id: 'l', crm_user_id: 'u', start_date: '2026-10-06', is_half_day: true, half_day_period: 'morning' }).halfDayPeriod, 'AM');
  assert.equal(sync.mapLeave({ status: 'canceled' }).status, 'cancelled');
  assert.equal(sync.mapLeave({ status: 'maybe' }).statusValid, false);
});

test('outcomes are counted, last ok / last failure are remembered, events stay bounded', () => {
  const state = {};
  sync.record(state, 'user', 'INSERT', 'created', 'new', 'u1', ['crm_user_id']);
  sync.record(state, 'user', 'UPDATE', 'updated', 'name', 'u1', []);
  sync.record(state, 'user', 'UPDATE', 'skipped', 'no change', 'u1', []);
  sync.record(state, 'user', 'UPDATE', 'conflict', 'email clash', 'u2', []);
  const c = state.crmSync.counts.user;
  assert.deepEqual([c.created, c.updated, c.skipped, c.conflict], [1, 1, 1, 1]);
  assert.ok(c.lastOk); assert.equal(c.lastFail.outcome, 'conflict');
  assert.equal(state.crmSync.events[0].crmId, 'u2'); assert.deepEqual(state.crmSync.events[3].keys, ['crm_user_id']);
  for (let i = 0; i < 300; i++) sync.record(state, 'leave', 'UPDATE', 'updated', 'x', String(i), []);
  assert.equal(state.crmSync.events.length, 100); assert.equal(state.crmSync.counts.leave.updated, 300);
});

test('unlinked CRM users wait in a bounded queue, a repeat replaces its earlier row', () => {
  const state = {};
  sync.noteUnlinked(state, 'attendance', { crmUserId: 'u9', email: null }, { crmAttendanceId: 'a1', date: '2026-10-05' });
  sync.noteUnlinked(state, 'attendance', { crmUserId: 'u9', email: null }, { crmAttendanceId: 'a1', date: '2026-10-06' }); // correction
  sync.noteUnlinked(state, 'leave', { crmUserId: 'u9', email: null }, { crmLeaveRequestId: 'l1' });
  const list = sync.unlinkedList(state);
  assert.equal(list.length, 1); assert.equal(list[0].waiting, 2); assert.equal(list[0].count, 3); assert.deepEqual(list[0].kinds, { attendance: 2, leave: 1 });
  const e = sync.takeUnlinked(state, 'u9');
  assert.equal(e.pending.find(p => p.kind === 'attendance').row.date, '2026-10-06');
  assert.equal(sync.unlinkedList(state).length, 0);
  for (let i = 0; i < 260; i++) sync.noteUnlinked(state, 'leave', { crmUserId: 'x' + i }, null);
  assert.equal(sync.unlinkedList(state).length, 200);
});

test('contact lists are found whatever the response is called; phones match across formats; flags', () => {
  assert.deepEqual(sync.extractList({ ok: true, contacts: [{ id: 2 }] }), [{ id: 2 }]);
  assert.equal(sync.extractList({ ok: true }), null);
  assert.equal(sync.normPhone('+64 21 123 456'), sync.normPhone('021 123 456'));
  [[true, true], [false, false], ['yes', true], ['No', false], ['2026-01-01', true], [null, false], [0, false], [1, true]].forEach(([v, want]) => assert.equal(sync.isSet(v), want, String(v)));
});
test('NZ wall-clock times convert across daylight saving', () => {
  assert.equal(sync.nzLocalToISO('2026-10-05', '09:00'), '2026-10-04T20:00:00.000Z');
  assert.equal(sync.nzLocalToISO('2026-06-15', '09:00'), '2026-06-14T21:00:00.000Z');
});

test("ET-CRM's real daily attendance row (team_member_id, check_in_at, net_minutes) maps to the right person and day", () => {
  const m = sync.mapAttendance({ id: 'att-1', team_member_id: 'user-9', date: '2026-10-05', check_in_at: '2026-10-04T20:00:00Z',
    check_out_at: '2026-10-05T04:30:00Z', gross_minutes: 540, break_minutes: 30, net_minutes: 510, status: 'present', notes: null });
  assert.equal(m.crmAttendanceId, 'att-1');
  assert.equal(m.user.crmUserId, 'user-9', 'team_member_id identifies the person');
  assert.equal(m.date, '2026-10-05');
  assert.equal(m.seconds, 510 * 60);
});
test('a leave row can identify the person by team_member_id too', () => {
  const m = sync.mapLeave({ id: 'lv-1', team_member_id: 'user-9', start_date: '2026-10-14', end_date: '2026-10-14', status: 'approved' });
  assert.equal(m.user.crmUserId, 'user-9');
});
test("ET-CRM's real user row (id, full_name, email, role, is_active) maps; role is ignored", () => {
  const m = sync.mapUser({ id: 'user-9', full_name: 'Ann Lee', email: 'ANN@elitetaxation.co.nz', role: 'admin', is_active: true });
  assert.equal(m.crmUserId, 'user-9'); assert.equal(m.name, 'Ann Lee'); assert.equal(m.email, 'ann@elitetaxation.co.nz');
  assert.ok(!('role' in m) || m.role === undefined, 'a CRM role never becomes a Task Manager role');
});
