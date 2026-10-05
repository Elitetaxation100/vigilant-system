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
test('contact lists are found whatever the response is called', () => {
  assert.deepEqual(sync.extractList([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(sync.extractList({ ok: true, contacts: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(sync.extractList({ ok: true, result: { data: [{ id: 3 }] } }) || sync.extractList({ data: [{ id: 3 }] }), [{ id: 3 }]);
  assert.equal(sync.extractList({ ok: true }), null);
});
test('phones match across formats', () => {
  assert.equal(sync.normPhone('+64 21 123 456'), sync.normPhone('021 123 456'));
  assert.equal(sync.normPhone('12'), null);
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
  // a client already tied to a different contact is not stolen by email
  assert.equal(m({ id: 'k6', email: 'x@o.nz' }), null);
});
test('contact fields are read from likely names', () => {
  const c = sync.mapContact({ id: 7, first_name: 'Jo', last_name: 'Lee', email: 'J@X.nz', pipeline_stage: 'Client', agent_id: 'u1' });
  assert.equal(c.name, 'Jo Lee'); assert.equal(c.email, 'j@x.nz'); assert.equal(c.stage, 'client'); assert.equal(c.owner.crmUserId, 'u1');
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
