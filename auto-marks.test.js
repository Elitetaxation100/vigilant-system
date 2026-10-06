const test = require('node:test');
const assert = require('node:assert/strict');
const am = require('./auto-marks');

/* ---------------- rule 1: acknowledgement ---------------- */
test('ack: nothing acknowledged, or more than half unacknowledged → −10', () => {
  assert.equal(am.ackDeduction(5, 5), 10);   // nothing acknowledged
  assert.equal(am.ackDeduction(1, 1), 10);
  assert.equal(am.ackDeduction(10, 6), 10);  // 60% — more than half
  assert.equal(am.ackDeduction(3, 2), 10);   // 67%
});
test('ack: half or fewer unacknowledged → 5 or less, in proportion; none → nothing', () => {
  assert.equal(am.ackDeduction(10, 5), 5);   // exactly half
  assert.equal(am.ackDeduction(10, 4), 4);
  assert.equal(am.ackDeduction(10, 3), 3);
  assert.equal(am.ackDeduction(10, 2), 2);
  assert.equal(am.ackDeduction(10, 1), 1);
  assert.equal(am.ackDeduction(40, 1), 1, 'never rounds down to nothing while something is unacknowledged');
  assert.equal(am.ackDeduction(4, 1), 3);    // 25% → 2.5 → 3
  assert.equal(am.ackDeduction(10, 0), 0);   // all acknowledged
  assert.equal(am.ackDeduction(0, 0), 0);    // nothing came in
});
test('ack: the amounts are adjustable', () => {
  assert.equal(am.ackDeduction(5, 5, { ackAll: 20, ackHalfMax: 8 }), 20);
  assert.equal(am.ackDeduction(10, 5, { ackAll: 20, ackHalfMax: 8 }), 8); // capped at the half-max
});

/* ---------------- rule 2: links ---------------- */
test('links: only client work that goes through review needs them', () => {
  assert.equal(am.linksRequired({ kind: 'client', source: 'manual' }), true);
  assert.equal(am.linksRequired({ kind: 'client' }), true);
  assert.equal(am.linksRequired({ kind: 'internal' }), false, 'internal tasks: link not mandatory');
  assert.equal(am.linksRequired({ kind: 'client', source: 'call' }), false);
  assert.equal(am.linksRequired({ kind: 'client', source: 'slack_message' }), false);
  assert.equal(am.linksRequired(null), false);
});
test('links: both missing = full, one missing = half; blank counts as missing', () => {
  assert.deepEqual(am.missingLinks({}), ['Sheet', 'Cashbook']);
  assert.deepEqual(am.missingLinks({ sheetLink: 'https://x', cashbookLink: '' }), ['Cashbook']);
  assert.deepEqual(am.missingLinks({ sheetLink: '  ', cashbookLink: 'https://y' }), ['Sheet']);
  assert.deepEqual(am.missingLinks({ sheetLink: 'https://x', cashbookLink: 'https://y' }), []);
  assert.equal(am.linkMarks(['Sheet', 'Cashbook'], 20), 20); // processor, both
  assert.equal(am.linkMarks(['Cashbook'], 20), 10);          // processor, one
  assert.equal(am.linkMarks(['Sheet', 'Cashbook'], 30), 30); // reviewer, both
  assert.equal(am.linkMarks(['Sheet'], 30), 15);             // reviewer, one
  assert.equal(am.linkMarks([], 30), 0);
});

/* ---------------- creating marks ---------------- */
test('an automatic mark is negative, tagged, and can never be given twice for the same thing', () => {
  const s = { employees: [{ id: 'e1' }], marks: [] };
  const a = am.createAutoMark(s, { toId: 'e1', points: 20, reason: 'x', type: 'auto_links_processor', key: 'k1', taskId: 't1' });
  assert.equal(a.points, -20); assert.equal(a.byId, null); assert.equal(a.auto, true); assert.equal(a.type, 'auto_links_processor'); assert.equal(a.taskId, 't1');
  assert.equal(am.createAutoMark(s, { toId: 'e1', points: 20, reason: 'x', type: 'auto_links_processor', key: 'k1' }), null);
  a.voidedAt = 'now'; // even once voided by an admin, the same event does not re-fire
  assert.equal(am.createAutoMark(s, { toId: 'e1', points: 20, reason: 'x', type: 'auto_links_processor', key: 'k1' }), null);
  assert.equal(s.marks.length, 1);
  assert.equal(am.createAutoMark(s, { toId: 'e1', points: 3, reason: 'y', type: 'auto_ack', key: 'k2' }).points, -3);
});

/* ---------------- evaluating a day ---------------- */
const staff = [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }];
const people = [
  { id: 'e1', name: 'Ann', emails: { total: 4, ack: 0, notAck: 4 }, calls: { total: 2, ack: 2, notAck: 0 } },   // emails −10, calls none
  { id: 'e2', name: 'Bob', emails: { total: 10, ack: 7, notAck: 3 }, calls: { total: 5, ack: 1, notAck: 4 } },  // emails −3, calls −10
  { id: 'e3', name: 'Cy', emails: { total: 6, ack: 6, notAck: 0 }, calls: { total: 0, ack: 0, notAck: 0 } },    // nothing
  { id: 'mailbox@x', name: 'Unowned', emails: { total: 3, ack: 0, notAck: 3 }, calls: { total: 0, ack: 0, notAck: 0 } }, // not a person
];
test('a day: emails and calls are judged separately; unowned mailboxes are ignored', () => {
  const s = { employees: staff, marks: [] };
  const created = [];
  const r = am.evaluateAckDay(s, '2026-10-12', people, { today: '2026-10-13', onCreated: row => created.push(row) });
  const by = (id, ch) => r.find(x => x.toId === id && x.channel === ch);
  assert.equal(by('e1', 'emails').marks, 10); assert.equal(by('e1', 'calls'), undefined);
  assert.equal(by('e2', 'emails').marks, 3); assert.equal(by('e2', 'calls').marks, 10);
  assert.equal(r.filter(x => x.toId === 'e3').length, 0);
  assert.equal(r.filter(x => x.toId === 'mailbox@x').length, 0);
  assert.equal(created.length, 3);
  assert.deepEqual(s.marks.map(m => [m.toId, m.points]).sort(), [['e1', -10], ['e2', -10], ['e2', -3]].sort());
  assert.match(s.marks.find(m => m.toId === 'e2' && m.points === -3).reason, /3 of 10 emails on .* not acknowledged/);
});
test('a day: running it again never doubles up; a dry run changes nothing', () => {
  const s = { employees: staff, marks: [] };
  am.evaluateAckDay(s, '2026-10-12', people, { today: '2026-10-13' });
  const n = s.marks.length;
  const again = am.evaluateAckDay(s, '2026-10-12', people, { today: '2026-10-13' });
  assert.equal(s.marks.length, n); assert.equal(again.filter(x => x.created).length, 0);
  const s2 = { employees: staff, marks: [] };
  const dry = am.evaluateAckDay(s2, '2026-10-12', people, { today: '2026-10-13', dryRun: true });
  assert.equal(s2.marks.length, 0); assert.equal(dry.length, 3);
});
test('a day: someone on leave / a workshop / a holiday is not marked down', () => {
  const s = { employees: staff, marks: [] };
  const r = am.evaluateAckDay(s, '2026-10-12', people, { today: '2026-10-13', skip: id => id === 'e1' });
  assert.equal(r.find(x => x.toId === 'e1').skipped, true);
  assert.ok(!s.marks.some(m => m.toId === 'e1')); assert.ok(s.marks.some(m => m.toId === 'e2'));
});

/* ---------------- running the finished days ---------------- */
const workingDays = new Set(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
const mkDeps = (state, today, hourNZ, extra) => ({ today, hourNZ, isWorkingDay: d => workingDays.has(d), getStats: () => people, now: today + 'T00:00:00Z', ...(extra || {}) });
test('runDays: nothing is ever deducted retroactively — it starts the day the rules were first read', () => {
  const s = { employees: staff, marks: [] };
  const r = am.runDays(s, mkDeps(s, '2026-10-14', 9));  // first read on the 14th
  assert.equal(s.autoMarks.settings.activeFrom, '2026-10-14');
  assert.equal(r.created, 0, 'the 13th and earlier are never judged'); assert.equal(s.marks.length, 0);
});
test('runDays: a day is judged only after 08:00 the next morning, once, and skips non-working days', () => {
  const s = { employees: staff, marks: [], autoMarks: { settings: { activeFrom: '2026-10-12' } } };
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-13', 7)).created, 0, 'before 08:00 on the 13th the 12th is still open');
  const morning = am.runDays(s, mkDeps(s, '2026-10-13', 8));
  assert.deepEqual(morning.days.map(d => d.day), ['2026-10-12']); assert.equal(morning.created, 3);
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-13', 12)).created, 0, 'the same day is not judged twice');
  // weekend: 17th and 18th are not working days; Monday 19th morning judges Friday 16th only
  const w = { employees: staff, marks: [], autoMarks: { settings: { activeFrom: '2026-10-16' } } };
  const mon = am.runDays(w, mkDeps(w, '2026-10-19', 9));
  assert.deepEqual(mon.days.map(d => d.day), ['2026-10-16']);
  assert.equal(w.autoMarks.lastEvaluated, '2026-10-18');
});
test('runDays: switched off, it does not catch up when switched back on', () => {
  const s = { employees: staff, marks: [], autoMarks: { settings: { activeFrom: '2026-10-12', enabled: { acknowledgement: false } } } };
  am.runDays(s, mkDeps(s, '2026-10-16', 9));
  assert.equal(s.marks.length, 0);
  s.autoMarks.settings.enabled.acknowledgement = true;
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-16', 10)).created, 0, 'the days it was off are not judged afterwards');
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-19', 9)).days.map(d => d.day).join(), '2026-10-16');
});

/* ---------------- settings ---------------- */
test('settings: defaults, validation, and activeFrom stays put', () => {
  const s = {};
  const d = am.settingsOf(s, '2026-10-12');
  assert.deepEqual(d.points, { ackAll: 10, ackHalfMax: 5, processorLinks: 20, reviewerLinks: 30 });
  assert.equal(d.activeFrom, '2026-10-12');
  assert.equal(am.settingsOf(s, '2026-11-01').activeFrom, '2026-10-12');
  am.updateSettings(s, { enabled: { links: false, nonsense: true }, points: { processorLinks: '15', reviewerLinks: -5, ackAll: 'abc' }, activeFrom: 'tomorrow' }, '2026-10-12');
  assert.equal(s.autoMarks.settings.enabled.links, false); assert.equal(s.autoMarks.settings.enabled.acknowledgement, true);
  assert.equal(s.autoMarks.settings.points.processorLinks, 15);
  assert.equal(s.autoMarks.settings.points.reviewerLinks, 30, 'a negative number is ignored');
  assert.equal(s.autoMarks.settings.points.ackAll, 10, 'a non-number is ignored');
  assert.equal(s.autoMarks.settings.activeFrom, '2026-10-12', 'an invalid date is ignored');
});
