const test = require('node:test');
const assert = require('node:assert/strict');
const dq = require('./data-quality');

const state = () => ({
  employees: [
    { id: 'e1', name: 'Diksha', email: 'diksha@x.nz' }, { id: 'e2', name: 'Disha Chaudhary', email: 'disha@x.nz' }, { id: 'e3', name: 'Ranjit Choudhary', email: 'ranjit@x.nz' },
    { id: 'e4', name: 'Test User', email: 'test@x.nz' }, { id: 'e5', name: 'HR Administrator', email: 'hr@elitetaxation.co.nz' },
  ],
  clients: [{ id: 'c1', name: 'Real Ltd' }, { id: 'c2', name: 'test' }],
  tasks: [
    { id: '#1', name: 'GST retrun for Real', kind: 'client', clientId: 'c1', clientName: 'Real Ltd', tat: 2, internalDeadline: '2026-10-20', status: 'accepted' },
    { id: '#2', name: 'Call 021 555 1234 about payroll', kind: 'client', clientId: 'c1', clientName: 'Real Ltd', tat: 1, internalDeadline: '2026-10-20', status: 'accepted' },
    { id: '#3', name: 'Send to jo.smith@gmail.com', kind: 'client', clientId: null, clientName: 'Admin task', tat: 0, internalDeadline: null, status: 'accepted' },
    { id: '#4', name: 'Review', kind: 'internal', clientId: 'c1', clientName: 'Real Ltd', cashbookLink: 'https://x.y/z', tat: 1, internalDeadline: '2026-10-20', status: 'accepted' },
    { id: '#5', name: 'Fine task', kind: 'client', clientId: 'c1', clientName: 'Real Ltd', tat: 1, internalDeadline: '2026-10-20', status: 'completed', reviewStatus: 'clean', scope: 'GST return' },
    { id: '#6', name: 'Other fine task', kind: 'client', clientId: 'c1', clientName: 'Real Ltd', tat: 1, internalDeadline: '2026-10-20', status: 'completed', reviewStatus: 'clean', scope: 'gst  Return' },
  ],
  taxonomy: { departments: [{ name: 'Tax', services: ['GST', 'gst', 'Income'] }, { name: 'tax', services: [] }] },
});
const opts = { today: '2026-10-07', isSystemAccount: e => /test/i.test(e.name) };
const find = (r, cat, id) => r.rows.filter(x => x.category === cat && (!id || x.id === id));

test('it finds each kind of problem and says what to do — and writes nothing', () => {
  const s = state(), before = JSON.stringify(s);
  const r = dq.build(s, opts);
  assert.equal(JSON.stringify(s), before, 'the data is untouched'); assert.equal(r.readOnly, true);
  assert.equal(find(r, 'duplicate_user').length, 1); assert.match(find(r, 'duplicate_user')[0].suggestion, /do not delete/i);
  assert.equal(find(r, 'system_or_test_user')[0].id, 'e4'); assert.equal(find(r, 'hr_in_productivity')[0].id, 'e5');
  assert.equal(find(r, 'missing_client', '#3').length, 1); assert.equal(find(r, 'fake_client_value', '#3').length, 1);
  assert.equal(find(r, 'fake_client_value', 'c2').length, 1, 'a client record named "test"');
  assert.equal(find(r, 'wrong_classification', '#4').length, 1);
  assert.equal(find(r, 'zero_allocated_hours', '#3').length, 1); assert.equal(find(r, 'missing_internal_due', '#3').length, 1);
  assert.equal(find(r, 'email_in_title', '#3').length, 1); assert.ok(!find(r, 'email_in_title', '#3')[0].detail.includes('jo.smith'), 'the address is masked in the report itself');
  assert.equal(find(r, 'phone_in_title', '#2').length, 1);
  assert.equal(find(r, 'possible_misspelling', '#1').length, 1); assert.match(find(r, 'possible_misspelling', '#1')[0].detail, /retrun/);
  assert.ok(find(r, 'duplicate_task_type').length >= 2, 'departments, services and task-scope spellings');
  r.rows.forEach(x => { assert.ok(x.detail && x.suggestion && x.label && x.severity); });
});
test('clean data produces no findings for the clean records', () => {
  const r = dq.build(state(), opts);
  assert.equal(r.rows.filter(x => x.id === '#5' || x.id === '#6').filter(x => x.category !== 'duplicate_task_type').length, 0);
});
test('the CSV has a column for the human decision and quotes properly', () => {
  const csv = dq.toCsv(dq.build(state(), opts));
  assert.match(csv.split('\n')[0], /decision \(yours\)$/);
  assert.ok(csv.includes('"Possible typo: retrun.'.replace(/^"/, '')) || csv.includes('Possible typo: retrun'));
  assert.ok(/"[^"\n]*,[^"\n]*"/.test(csv), 'a value with a comma is quoted');
  assert.equal(csv.split('\n').filter(Boolean).length, dq.build(state(), opts).rows.length + 1);
});
test('edit distance', () => { assert.equal(dq.lev('retrun', 'return'), 1, 'a swapped pair is one slip'); assert.equal(dq.lev('returnn', 'return'), 1); assert.equal(dq.lev('abc', 'abc'), 0); });
