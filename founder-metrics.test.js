// The pure rules behind the Founder dashboard: periods (elapsed only), the shared firm formula, first-pass dating, CSV.
const test = require('node:test');
const assert = require('node:assert/strict');
const fm = require('./founder-metrics');
const rules = require('./productivity-rules');

const d = (today, extra) => ({ today, goLive: '2026-09-07', fiscalYearStart: iso => (Number(iso.slice(5, 7)) >= 4 ? iso.slice(0, 4) : String(Number(iso.slice(0, 4)) - 1)) + '-04-01', nzDay: ts => String(ts).slice(0, 10), ...(extra || {}) });

test('periods: month-to-date ends TODAY — the planned end is kept separately and never counted', () => {
  const p = fm.resolvePeriod({ preset: 'month' }, d('2026-10-09'));
  assert.equal(p.from, '2026-10-01'); assert.equal(p.to, '2026-10-09'); assert.equal(p.plannedTo, '2026-10-31'); assert.equal(p.elapsedOnly, true); assert.equal(p.days, 9);
  assert.match(p.label, /This month through 9 October/);
  const done = fm.resolvePeriod({ preset: 'month' }, d('2026-10-31'));
  assert.equal(done.elapsedOnly, false); assert.equal(done.to, '2026-10-31');
});
test('periods: week is Monday–Sunday, quarter is the calendar quarter, year is the financial year from 1 April', () => {
  const w = fm.resolvePeriod({ preset: 'week' }, d('2026-10-09'));      // Friday
  assert.equal(w.requested.from, '2026-10-05'); assert.equal(w.requested.to, '2026-10-11'); assert.equal(w.to, '2026-10-09');
  const q = fm.resolvePeriod({ preset: 'quarter' }, d('2026-10-09'));
  assert.equal(q.requested.from, '2026-10-01'); assert.equal(q.requested.to, '2026-12-31');
  const y = fm.resolvePeriod({ preset: 'year' }, d('2026-10-09'));
  assert.equal(y.requested.from, '2026-04-01'); assert.equal(y.requested.to, '2027-03-31'); assert.equal(y.from, '2026-09-07', 'and never before go-live');
  assert.equal(fm.resolvePeriod({ preset: 'last30' }, d('2026-10-09')).requested.from, '2026-09-10');
  assert.equal(fm.resolvePeriod({ preset: 'last90' }, d('2026-10-09')).requested.from, '2026-07-12');
  assert.equal(fm.resolvePeriod({ preset: 'today' }, d('2026-10-09')).days, 1);
});
test('periods: custom ranges are validated, swapped if backwards, and a wholly-future range is empty — never silently 0%', () => {
  const c = fm.resolvePeriod({ preset: 'custom', from: '2026-10-05', to: '2026-10-01' }, d('2026-10-09'));
  assert.equal(c.requested.from, '2026-10-01'); assert.equal(c.requested.to, '2026-10-05');
  const future = fm.resolvePeriod({ preset: 'custom', from: '2026-11-01', to: '2026-11-30' }, d('2026-10-09'));
  assert.equal(future.empty, true); assert.equal(future.days, 0);
  assert.equal(fm.resolvePeriod({ preset: 'nonsense' }, d('2026-10-09')).preset, 'month', 'an unknown preset falls back to this month');
});
test('periods: the previous period is the same length immediately before, and is not offered when it pre-dates go-live', () => {
  const p = fm.resolvePeriod({ preset: 'custom', from: '2026-09-21', to: '2026-09-27' }, d('2026-10-09'));
  assert.deepEqual(p.prev, { from: '2026-09-14', to: '2026-09-20' });
  const early = fm.resolvePeriod({ preset: 'custom', from: '2026-09-07', to: '2026-09-13' }, d('2026-10-09'));
  assert.equal(early.prev, null, 'before go-live there is no real data to compare with');
});

test('firm productivity = total qualified hours ÷ total capacity — NOT the average of the individual percentages (the spec example)', () => {
  const people = [{ id: 'r', qualifiedHours: 35, capacityHours: 28 }, { id: 'n', qualifiedHours: 20, capacityHours: 35 }];
  const t = rules.aggregateTotals(people);
  assert.equal(t.rawUtilisationPct, 87.3, '(35 + 20) ÷ (28 + 35)');
  assert.notEqual(t.rawUtilisationPct, Math.round((125 + 57.1) / 2 * 10) / 10, 'not (125% + 57.1%) ÷ 2 = 91.1%');
  assert.equal(t.qualifiedHours, 55); assert.equal(t.capacityHours, 63);
  assert.equal(rules.aggregateTotals([]).rawUtilisationPct, null, 'no capacity → not available, never 0%');
  assert.equal(rules.aggregateTotals([{ qualifiedHours: 0, capacityHours: 28 }]).rawUtilisationPct, 0, '0% only when capacity exists and nothing qualified');
});

test('first-pass dating: the first completed review decides — a later clean approval after a return is NOT a first pass', () => {
  const x = (t) => fm.firstReview(t, d('2026-10-09'));
  assert.deepEqual(x({ reviewEvents: [{ type: 'returned', at: '2026-10-02T01:00:00Z' }, { type: 'approved', at: '2026-10-05T01:00:00Z' }] }), { day: '2026-10-02', clean: false });
  assert.deepEqual(x({ reviewEvents: [{ type: 'approved', at: '2026-10-03T01:00:00Z' }] }), { day: '2026-10-03', clean: true });
  assert.deepEqual(x({ reviewStatus: 'clean', reworkCount: 0, reviewedAt: '2026-10-04T01:00:00Z' }), { day: '2026-10-04', clean: true }, 'older tasks without an event log');
  assert.equal(x({ reviewStatus: 'clean', reworkCount: 1, reworkHistory: [{ startedAt: '2026-10-03T01:00:00Z' }], reviewedAt: '2026-10-06T01:00:00Z' }).clean, false);
  assert.equal(x({ reviewStatus: 'done' }), null, 'no review required → no first review');
  assert.equal(x({}), null);
});
test('created / completed dates: created survives a reassignment; completed is the clean-review or done date', () => {
  assert.equal(fm.createdDay({ createdAt: '2026-10-01T01:00:00Z', assignedAt: '2026-10-07T01:00:00Z' }, d('2026-10-09')), '2026-10-01');
  assert.equal(fm.createdDay({ reassignHistory: [{ at: '2026-10-02T01:00:00Z' }], assignedAt: '2026-10-07T01:00:00Z' }, d('2026-10-09')), '2026-10-02', 'older tasks: the first reassignment is the best evidence');
  assert.equal(fm.completedDay({ status: 'completed', reviewStatus: 'clean', reviewedAt: '2026-10-05T01:00:00Z', completedAt: '2026-10-04T01:00:00Z' }), '2026-10-05T01:00:00Z');
  assert.equal(fm.completedDay({ status: 'completed', reviewStatus: 'done', closedAt: '2026-10-06T01:00:00Z' }), '2026-10-06T01:00:00Z');
  assert.equal(fm.completedDay({ status: 'accepted' }), null);
  assert.equal(fm.completedDay({ status: 'completed', reviewStatus: 'error' }), null, 'returned work is not completed');
});
test('exports escape commas, quotes and line breaks and open cleanly in Excel', () => {
  const csv = fm.toCsv(['A', 'B'], [['x,y', 'say "hi"'], ['line\nbreak', null]]);
  assert.ok(csv.startsWith('﻿')); assert.match(csv, /"x,y","say ""hi"""/); assert.match(csv, /"line\nbreak",\r?$/m);
});
test('duplicate suggestions: the same person twice is flagged for a human to confirm — different people are not', () => {
  const state = { employees: [{ id: 'a', name: 'Nitish' }, { id: 'b', name: 'Nitish Uppal' }, { id: 'c', name: 'Khushi' }, { id: 'd', name: 'Khushi Goyal' }, { id: 'e', name: 'Ranjit Choudhary' }, { id: 'f', name: 'Manya Nanda' }, { id: 'g', name: 'Manya Nanda' }, { id: 'h', name: 'Anjana Pandey' }, { id: 'i', name: 'Disha Chaudhary' }] };
  const pairs = fm.suspectedDuplicates(state).map(p => [p.a.name, p.b.name].sort().join(' / '));
  assert.ok(pairs.includes('Nitish / Nitish Uppal')); assert.ok(pairs.includes('Khushi / Khushi Goyal')); assert.ok(pairs.includes('Manya Nanda / Manya Nanda'));
  assert.equal(pairs.length, 3, JSON.stringify(pairs));
  state.employees[1].duplicateOf = 'a';
  assert.ok(!fm.suspectedDuplicates(state).some(p => p.b.id === 'b'), 'once mapped it is no longer suggested');
});
