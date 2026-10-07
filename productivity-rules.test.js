const test = require('node:test');
const assert = require('node:assert/strict');
const { capacityDays, splitNotConverted, v3Applies } = require('./productivity-rules');
const day = (o) => ({ scheduled: true, holiday: false, status: 'PRESENT', customHours: 0, ...(o || {}) });

test('capacity: six eligible days, one leave day, one workshop day → four eligible days → 28 hours', () => {
  // Mon–Sat are scheduled (six days); two of them are removed — one personal leave, one firm workshop
  const days = [day(), day(), day({ status: 'LEAVE' }), day(), day(), day({ status: 'WORKSHOP' })];
  const c = capacityDays(days, 7);
  assert.equal(c.scheduledDays, 6); assert.equal(c.leaveDays, 1); assert.equal(c.workshopDays, 1);
  assert.equal(c.finalEligibleDays, 4); assert.equal(c.capacityHours, 28);
});
test('capacity: a Saturday that is not in the period is never deducted or shown', () => {
  const c = capacityDays([day(), day(), day(), day(), day()], 7);      // Mon–Fri only
  assert.equal(c.workshopDays, 0); assert.equal(c.finalEligibleDays, 5); assert.equal(c.capacityHours, 35);
});
test('capacity: a workshop day is deducted once even when the person also had leave booked that day', () => {
  // the caller resolves precedence (workshop wins); a day carries ONE status, so it can only be removed once
  const c = capacityDays([day({ status: 'WORKSHOP' }), day()], 7);
  assert.equal(c.leaveDays, 0); assert.equal(c.workshopDays, 1); assert.equal(c.capacityHours, 7);
});
test('capacity: holidays, half days and reduced hours come off the day count and the hours agree', () => {
  const c = capacityDays([day(), day({ holiday: true }), day({ status: 'HALF' }), day({ status: 'CUSTOM', customHours: 3.5 }), { scheduled: false }], 7);
  assert.equal(c.scheduledDays, 4); assert.equal(c.publicHolidays, 1); assert.equal(c.workingDays, 3);
  assert.equal(c.leaveDays, 0.5); assert.equal(c.customHoursOff, 3.5);
  assert.equal(c.finalEligibleDays, 2); assert.equal(c.capacityHours, 14);
});
test('capacity: the weekly off is never a scheduled day', () => {
  assert.equal(capacityDays([{ scheduled: false }, day()], 7).scheduledDays, 1);
});

test('not converted: the parts add up to the total — 121.9 h is never shown as 115 open + 84 unallocated', () => {
  const b = splitNotConverted(121.9, 115, 0);
  assert.equal(b.openAllocated, 115); assert.equal(b.unallocated, 6.9); assert.equal(b.nonQualifyingCompleted, 0);
  assert.equal(b.openAllocated + b.nonQualifyingCompleted + b.unallocated, b.total); assert.ok(b.reconciles);
});
test('not converted: open work larger than the gap fills it and nothing else is invented', () => {
  const b = splitNotConverted(40, 115, 30);
  assert.deepEqual([b.openAllocated, b.nonQualifyingCompleted, b.unallocated], [40, 0, 0]); assert.ok(b.reconciles);
});
test('not converted: order is open → completed-but-not-qualifying → unallocated, always summing to the total', () => {
  for (const [t, o, n] of [[50, 20, 10], [50, 20, 100], [0, 5, 5], [33.33, 10.1, 5.05], [10, 0, 0]]) {
    const b = splitNotConverted(t, o, n);
    assert.ok(Math.abs(b.openAllocated + b.nonQualifyingCompleted + b.unallocated - b.total) < 0.011, JSON.stringify([t, o, n, b]));
    assert.ok(b.unallocated >= 0 && b.openAllocated >= 0 && b.nonQualifyingCompleted >= 0);
  }
  const b = splitNotConverted(50, 20, 10); assert.deepEqual([b.openAllocated, b.nonQualifyingCompleted, b.unallocated], [20, 10, 20]);
});
test('V3 applies only to work completed on/after the cutoff', () => {
  const at = '2026-10-07T11:00:00.000Z';
  assert.equal(v3Applies(Date.parse('2026-10-07T10:59:59Z'), at), false);
  assert.equal(v3Applies(Date.parse('2026-10-07T11:00:00Z'), at), true);
  assert.equal(v3Applies(NaN, at), false);
});
