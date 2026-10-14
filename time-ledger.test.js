// Time ledger — the pure rules: splitting the clock at New Zealand midnight, banking, adjustments, honesty about older hours, the per-person report.
const test = require('node:test');
const assert = require('node:assert/strict');
const tl = require('./time-ledger');

const Z = iso => Date.parse(iso);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ' ' + a + ' vs ' + b);

test('split: a stretch inside one New Zealand day stays one piece', () => {
  const p = tl.splitByDay(Z('2026-10-13T20:00:00Z'), Z('2026-10-14T00:30:00Z'));   // 9:00 – 13:30 NZ on the 14th (NZDT, UTC+13)
  assert.equal(p.length, 1); assert.equal(p[0].day, '2026-10-14'); close(p[0].hours, 4.5);
});

test('split: a stretch across NZ midnight is cut there — 6 h one day, 3 h the next', () => {
  // NZDT midnight between 14 and 15 Oct = 11:00 UTC on the 14th. 6:00 pm NZ → 3:00 am NZ is 9 h; 6 h + 3 h
  const p = tl.splitByDay(Z('2026-10-14T05:00:00Z'), Z('2026-10-14T14:00:00Z'));
  assert.deepEqual(p.map(x => x.day), ['2026-10-14', '2026-10-15']); close(p[0].hours, 6); close(p[1].hours, 3);
  close(p.reduce((n, x) => n + x.hours, 0), 9, 'nothing lost or doubled');
});

test('split: the daylight-saving change and a very long stretch still add up exactly; empty or backwards spans give nothing', () => {
  // NZ clocks go forward on 27 Sep 2026 (a 23-hour day): 26th 20:00 NZST → 28th 04:00 NZDT
  const a = Z('2026-09-26T08:00:00Z'), b = Z('2026-09-27T15:00:00Z');
  const p = tl.splitByDay(a, b);
  assert.deepEqual(p.map(x => x.day), ['2026-09-26', '2026-09-27', '2026-09-28']);
  close(p.reduce((n, x) => n + x.hours, 0), (b - a) / 3600000);
  assert.deepEqual(tl.splitByDay(Z('2026-10-14T05:00:00Z'), Z('2026-10-14T05:00:00Z')), []);
  assert.deepEqual(tl.splitByDay(Z('2026-10-14T06:00:00Z'), Z('2026-10-14T05:00:00Z')), []);
});

test('bank: the clock stops, t.logged grows by exactly what ran, and the dated entries add up to it', () => {
  const t = { id: 't1', assignedTo: 'e1', logged: 1, timerStartedAt: '2026-10-14T05:00:00Z' };
  const h = tl.bank(t, { endMs: Z('2026-10-14T14:00:00Z') });
  close(h, 9); close(t.logged, 10); assert.equal(t.timerStartedAt, null);
  assert.deepEqual(t.timeLedger.map(x => [x.d, x.e, x.s]), [['2026-10-14', 'e1', 'timer'], ['2026-10-15', 'e1', 'timer']]);
  close(t.timeLedger.reduce((n, x) => n + x.h, 0), 9);
  assert.equal(tl.bank(t), 0, 'nothing to bank when the clock is not running'); assert.equal(t.timeLedger.length, 2);
});

test('bank: the forgotten-clock auto-pause banks a fixed amount counted from the start, labelled as such', () => {
  const t = { id: 't1', assignedTo: 'e1', logged: 0, timerStartedAt: '2026-10-14T00:00:00Z' };
  close(tl.bank(t, { endMs: Z('2026-10-16T00:00:00Z'), capHours: 10, source: 'auto_pause' }), 10);
  close(t.logged, 10); assert.ok(t.timeLedger.every(x => x.s === 'auto_pause'));
});

test('adjustments: hours with no clock run are dated today, backdated hours stay UNDATED, corrections can be negative', () => {
  const t = { id: 't1', assignedTo: 'e1', logged: 0 };
  tl.addAdjustment(t, 2, 'backdated', null);
  tl.addAdjustment(t, 1, 'added_on_hold', undefined, 'phone call');
  tl.addAdjustment(t, -0.5, 'correction', '2026-10-13', 'forgot to stop');
  assert.equal(t.timeLedger[0].d, null); assert.equal(t.timeLedger[1].d, tl.nzDayMs(Date.now())); assert.equal(t.timeLedger[1].n, 'phone call');
  assert.equal(t.timeLedger[2].h, -0.5);
  assert.equal(tl.addAdjustment(t, 0, 'correction'), null, 'a zero change writes nothing');
});

test('older hours are never spread across days: what the ledger cannot explain is "before day-by-day tracking"', () => {
  const t = { id: 't1', assignedTo: 'e1', logged: 8, tat: 8, timeLedger: [] };
  assert.deepEqual(tl.totalsOf(t), { logged: 8, tracked: 0, earlier: 8, allocated: 8 });
  tl.addAdjustment(t, 3, 'timer', '2026-10-14');
  assert.deepEqual(tl.totalsOf(t), { logged: 8, tracked: 3, earlier: 5, allocated: 8 });
  t.logged = 3.004;                                                    // float dust is not "earlier time"
  assert.equal(tl.totalsOf(t).earlier, 0);
});

const person = (tasks, from, to) => tl.personReport(tasks, 'e1', from, to, { standardHoursOn: d => (new Date(d + 'T12:00:00Z').getUTCDay() === 0 ? 0 : 7) });
test('the example: an 8-hour client task worked 5 h yesterday and 3 h today shows exactly that', () => {
  const t = { id: 't1', name: 'Client processing', clientName: 'Acme', tat: 8, logged: 8, status: 'accepted', timeLedger: [
    { id: 'tl-1', e: 'e1', d: '2026-10-13', h: 5, s: 'timer', at: 'x' }, { id: 'tl-2', e: 'e1', d: '2026-10-14', h: 3, s: 'timer', at: 'x' } ] };
  const r = person([t], '2026-10-13', '2026-10-14');
  assert.equal(r.totalHours, 8);
  assert.deepEqual(r.days.map(d => [d.day, d.hours]), [['2026-10-14', 3], ['2026-10-13', 5]], 'newest day first');
  assert.equal(r.days[0].items[0].name, 'Client processing');
  assert.deepEqual(r.byTask.map(x => [x.name, x.hours, x.days, x.allocated]), [['Client processing', 8, 2, 8]]);
  assert.deepEqual(r.byClient, [{ client: 'Acme', hours: 8, tasks: 1 }]);
  assert.equal(r.days[0].standard, 7);
});

test('report: only that person, only that range; quiet days show as 0; a day off has no standard; several tasks sort by time; undated hours are reported apart', () => {
  const a = { id: 'a', name: 'A', clientName: 'Acme', tat: 2, logged: 4, timeLedger: [{ e: 'e1', d: '2026-10-12', h: 1, s: 'timer' }, { e: 'e2', d: '2026-10-12', h: 9, s: 'timer' }, { e: 'e1', d: '2026-10-01', h: 7, s: 'timer' }, { e: 'e1', d: null, h: 2, s: 'backdated' }] };
  const b = { id: 'b', name: 'B', kind: 'internal', tat: 1, logged: 3, timeLedger: [{ e: 'e1', d: '2026-10-12', h: 3, s: 'timer' }, { e: 'e1', d: '2026-10-12', h: 0.5, s: 'added_on_hold' }] };
  const r = person([a, b], '2026-10-11', '2026-10-13');
  assert.equal(r.totalHours, 4.5); assert.equal(r.undatedHours, 2);
  assert.deepEqual(r.days.map(d => [d.day, d.hours]), [['2026-10-13', 0], ['2026-10-12', 4.5], ['2026-10-11', 0]]);
  assert.equal(r.days[2].standard, 0, 'Sunday 11 Oct is a day off');
  assert.deepEqual(r.days[1].items.map(i => [i.name, i.hours, i.client]), [['B', 3.5, 'Admin'], ['A', 1, 'Acme']]);
  assert.deepEqual(r.days[1].items[0].sources.sort(), ['Time added while on hold', 'Work clock']);
  assert.deepEqual(r.byClient.map(c => c.client), ['Admin', 'Acme']);
});

test('report: the clock running right now counts for today before it is banked', () => {
  const now = Date.now(), t = { id: 'a', name: 'A', clientName: 'Acme', tat: 2, logged: 0, assignedTo: 'e1', timerStartedAt: new Date(now - 90 * 60000).toISOString() };
  const today = tl.nzDayMs(now), yesterday = tl.addDay(today, -1);
  const r = person([t], yesterday, today);
  const mins = r.days.reduce((n, d) => n + d.hours, 0) * 60;
  assert.ok(Math.abs(mins - 90) < 2, 'about 90 minutes, got ' + mins);
});
