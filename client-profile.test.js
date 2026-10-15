const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('./client-profile');

const dayOf = ts => String(ts).slice(0, 10);

test('financial years: the NZ tax year runs 1 April – 31 March, and a client can have another balance date', () => {
  assert.equal(cp.fyOfDay('2026-10-15'), '2026–27');
  assert.equal(cp.fyOfDay('2026-03-31'), '2025–26');
  assert.equal(cp.fyOfDay('2026-04-01'), '2026–27');
  assert.equal(cp.fyOfDay('2026-10-15', '06-30'), '2026–27');
  assert.equal(cp.fyOfDay('2026-05-15', '06-30'), '2025–26');
  assert.deepEqual(cp.fyRange('2025–26'), { start: '2025-04-01', end: '2026-03-31' });
  assert.equal(cp.normalFY('2025-26'), '2025–26');
  assert.equal(cp.normalFY('2025–27'), null, 'the two halves must follow each other');
  assert.equal(cp.balanceLabel('03-31'), '31 Mar');
  assert.equal(cp.balanceLabel('bad'), '31 Mar', 'a bad value falls back to 31 March');
});

test('a tax return done after the year closes is for the year that closed; ordinary work is for the year it falls in', () => {
  assert.equal(cp.defaultFY({ name: 'Income tax return (IR3)', clientDate: '2026-08-12' }, {}, dayOf), '2025–26');
  assert.equal(cp.defaultFY({ name: 'GST return', clientDate: '2026-10-13' }, {}, dayOf), '2026–27');
  assert.equal(cp.defaultFY({ name: 'Income tax return', clientDate: '2026-11-20' }, {}, dayOf), '2026–27', 'seven months in is the new year');
  assert.equal(cp.fyOfTask({ name: 'Income tax', clientDate: '2026-08-12', financialYear: '2026–27' }, {}, dayOf), '2026–27', 'an explicit year always wins');
});

test('the checklist is built per client type from the work: done first, then open, and a row with no work shows when it is due', () => {
  const client = { type: 'Rideshare', balanceDate: null };
  const mk = (id, name, date, over) => Object.assign({ id, name, clientDate: date, createdAt: date + 'T00:00:00Z' }, over || {});
  const tasks = [mk('a', 'GST return', '2026-10-13'), mk('b', 'GST return period 1', '2026-07-10'), mk('c', 'Income tax return (IR3)', '2026-08-12', { financialYear: '2025–26' })];
  const cards = { a: { status: 'Approved', primaryStatus: 'Ready to Send', clientRisk: { state: 'overdue' } }, b: { status: 'Completed', primaryStatus: 'Report Sent', clientRisk: { state: 'done' } }, c: { status: 'Completed', primaryStatus: 'Report Sent', clientRisk: { state: 'done' } } };
  const ck = cp.buildChecklist({ client, fy: '2026–27', tasks, cardOf: t => cards[t.id], dayOf });
  assert.equal(ck.total, 4);
  assert.equal(ck.items[0].label, 'GST return, period 1'); assert.equal(ck.items[0].done, true, 'the finished return is period 1');
  assert.equal(ck.items[1].state, 'approved_unsent'); assert.equal(ck.items[1].tone, 'bad');
  assert.equal(ck.items[2].pill, 'Not started');
  assert.equal(ck.items[3].pill, 'Due Jul 2027', 'annual work is due four months after the year end');
  assert.equal(ck.done, 1);
  const last = cp.buildChecklist({ client, fy: '2025–26', tasks, cardOf: t => cards[t.id], dayOf });
  assert.equal(last.items[3].done, true, 'the return done in August counts for the year before');
  assert.equal(cp.buildChecklist({ client: { type: 'Custom' }, fy: '2026–27', tasks: [], cardOf: () => null, dayOf }), null, 'a type with no list has no checklist');
});

test('a client status says the most pressing thing about its open work', () => {
  const card = (status, primaryStatus, risk, wait) => ({ status, primaryStatus, clientRisk: { state: risk || 'ok' }, waitingOn: { kind: wait || 'employee' } });
  const st = (...cards) => cp.clientStatus({ openCards: cards, checklist: null });
  assert.equal(st(card('In Progress', 'In Progress'), card('Approved', 'Ready to Send')).label, 'Approved, not sent');
  assert.equal(st(card('Correction Required', 'Fix Needed')).label, 'Fix needed');
  assert.equal(st(card('In Progress', 'To Do', 'overdue')).label, 'Not sent');
  assert.equal(st(card('In Progress', 'To Do', 'due_today')).label, 'Due today');
  assert.equal(st(card('On Hold', 'On Hold', 'ok', 'client')).waiting, true);
  assert.equal(st(card('In Progress', 'In Progress')).label, 'On track');
  assert.equal(st().label, 'No open work');
  assert.equal(cp.clientStatus({ openCards: [], checklist: { total: 3, done: 3 } }).label, 'Up to date');
  assert.equal(st(card('Approved', 'Ready to Send')).late, true);
});

test('checklist templates are validated', () => {
  assert.equal(cp.validateTemplates({ Rideshare: [{ group: 'g', label: 'GST', match: 'gst' }] }), null);
  assert.ok(cp.validateTemplates({ Rideshare: [{ group: 'g', label: 'GST', match: '(' }] }));
  assert.ok(cp.validateTemplates({ Rideshare: [{ label: 'GST' }] }));
  assert.ok(cp.validateTemplates([]));
});
