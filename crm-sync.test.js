const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('./crm-sync');

test('Supabase webhook envelope is unwrapped', () => {
  const ev = sync.normalizeEvent({ type: 'insert', table: 'tasks', record: { id: 'a' }, old_record: null });
  assert.equal(ev.type, 'INSERT'); assert.equal(ev.row.id, 'a'); assert.equal(ev.table, 'tasks');
});
test('a bare row is accepted too', () => {
  const ev = sync.normalizeEvent({ id: 'x', title: 'T' });
  assert.equal(ev.row.id, 'x'); assert.equal(ev.type, 'INSERT');
});
test('task fields are read from the plausible column names', () => {
  const m = sync.mapTask({ id: 7, name: ' GST return ', assigned_to: 'u-1', customer_id: 'c-9', due_date: '2026-11-03', estimated_minutes: 90 });
  assert.equal(m.crmTaskId, '7'); assert.equal(m.title, 'GST return');
  assert.equal(m.assignee.crmUserId, 'u-1'); assert.equal(m.client.crmContactId, 'c-9');
  assert.equal(m.due, '2026-11-03'); assert.equal(m.hours, 1.5);
});
test('task assignee can be given by email', () => {
  const m = sync.mapTask({ id: 1, title: 'x', assignee_email: 'Person@Example.com' });
  assert.equal(m.assignee.email, 'person@example.com');
});
test('timestamps become a New Zealand calendar day', () => {
  assert.equal(sync.toDay('2026-11-03T20:30:00Z'), '2026-11-04'); // already tomorrow in NZ
  assert.equal(sync.toDay('2026-11-03'), '2026-11-03');
  assert.equal(sync.toDay('nonsense'), null);
});
test('attendance reads check-in/out and worked hours', () => {
  const m = sync.mapAttendance({ id: 'a1', user_id: 'u-1', date: '2026-10-05', check_in: '2026-10-04T17:00:00Z', check_out: '2026-10-05T02:00:00Z', hours_worked: 8.5 });
  assert.equal(m.user.crmUserId, 'u-1'); assert.equal(m.date, '2026-10-05');
  assert.equal(m.inISO, '2026-10-04T17:00:00.000Z'); assert.equal(m.outISO, '2026-10-05T02:00:00.000Z'); assert.equal(m.seconds, 30600);
});
test('attendance clock times without a date keep the time of day', () => {
  const m = sync.mapAttendance({ email: 'a@b.nz', date: '2026-10-05', clock_in: '09:05', clock_out: '17:30' });
  assert.equal(m.inTime, '09:05'); assert.equal(m.outTime, '17:30'); assert.equal(m.inISO, null);
});
test('NZ wall-clock times convert across daylight saving', () => {
  assert.equal(sync.nzLocalToISO('2026-10-05', '09:00'), '2026-10-04T20:00:00.000Z'); // NZDT, UTC+13
  assert.equal(sync.nzLocalToISO('2026-06-15', '09:00'), '2026-06-14T21:00:00.000Z'); // NZST, UTC+12
});
test('record keeps counts, the latest outcome and field names only', () => {
  const state = {};
  sync.record(state, 'task', 'INSERT', 'ok', 'created', 't1', ['id', 'title']);
  sync.record(state, 'task', 'INSERT', 'skipped', 'assignee not linked', 't2', ['id']);
  assert.equal(state.crmSync.counts.task.ok, 1); assert.equal(state.crmSync.counts.task.skipped, 1);
  assert.equal(state.crmSync.events[0].crmId, 't2'); assert.deepEqual(state.crmSync.events[1].keys, ['id', 'title']);
});
test('the event list never grows past 60', () => {
  const state = {};
  for (let i = 0; i < 100; i++) sync.record(state, 'user', 'UPDATE', 'ok', 'x', String(i), []);
  assert.equal(state.crmSync.events.length, 60); assert.equal(state.crmSync.counts.user.ok, 100);
});
