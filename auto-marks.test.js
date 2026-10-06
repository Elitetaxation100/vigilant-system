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

/* ---------------- rule 3: report deadline ---------------- */
test('report: late only the day AFTER the committed date, and never for dates before the rules started', () => {
  assert.equal(am.reportIsLate('2026-10-12', '2026-10-12', '2026-10-01'), false, 'on the committed date itself is still on time');
  assert.equal(am.reportIsLate('2026-10-12', '2026-10-13', '2026-10-01'), true);
  assert.equal(am.reportIsLate('2026-10-12', '2026-10-20', '2026-10-13'), false, 'it was already overdue before the rules started — no retroactive hit');
  assert.equal(am.reportIsLate('2026-10-13', '2026-10-20', '2026-10-13'), true, 'a date on the first day the rules started counts');
  assert.equal(am.reportIsLate(null, '2026-10-20', '2026-10-01'), false, 'no committed date (internal work) → never late');
});
test('report: the −10 is recorded once per task per round, even if the sender changes', () => {
  const s = { employees: [{ id: 'e1' }, { id: 'e2' }], marks: [] };
  const a = am.createAutoMark(s, { toId: 'e1', points: 10, type: 'auto_report_late', key: 'report:t1:0', taskId: 't1', reason: 'late' });
  assert.equal(a.points, -10);
  assert.equal(am.createAutoMark(s, { toId: 'e2', points: 10, type: 'auto_report_late', key: 'report:t1:0', taskId: 't1', reason: 'late' }), null);
});

/* ---------------- rule 4: a reassigned email must be replied to BEFORE the daily report ---------------- */
const wd = new Set(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20']); // Mon–Fri, then Mon–Tue
const nextWd = d => { let x = am.addDays(d, 1); while (!wd.has(x)) x = am.addDays(x, 1); return x; };
const CUT = 18 * 60 + 45; // the daily report goes out at 18:45 NZ
// timestamps in these tests are written directly as NZ wall-clock time: 'YYYY-MM-DDTHH:MM'
const mins = iso => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
const mailCtx = (today, nowHHMM, extra) => ({ today, nowMinutes: Number(nowHHMM.slice(0, 2)) * 60 + Number(nowHHMM.slice(3, 5)), cutoffMinutes: CUT,
  nzDay: iso => iso.slice(0, 10), nzMinutes: mins, isWorkingDay: d => wd.has(d), workingDayAfter: nextWd, ...(extra || {}) });
const handedAt = at => [{ at, by: 'e1', from: 'e1', to: 'e2' }];
const mailState = (over, settings) => ({ employees: [{ id: 'e1' }, { id: 'e2' }], marks: [], autoMarks: { settings: { activeFrom: '2026-10-01', ...(settings || {}) } },
  emails: [{ id: 'm1', direction: 'inbound', subject: 'Client question', mailboxOwner: 'e1', reassignedTo: 'e2', reassignHistory: handedAt('2026-10-12T10:00'), replied: false, replyNotNeeded: false, ...(over || {}) }] });
const deadlineOf = (at, extra) => { const s = mailState({ reassignHistory: handedAt(at) }); return am.reassignedMailDeadline(s.emails[0], mailCtx('2026-10-20', '09:00', extra), s.autoMarks.settings); };

test('mail: reassigned BEFORE the daily report on a working day → due that same day; after it → the next working day', () => {
  assert.equal(deadlineOf('2026-10-12T10:00').deadline, '2026-10-12', 'Monday morning → Monday');
  assert.equal(deadlineOf('2026-10-12T18:44').deadline, '2026-10-12', 'a minute before the report → still Monday');
  assert.equal(deadlineOf('2026-10-12T18:45').deadline, '2026-10-13', 'at/after the report → Tuesday');
  assert.equal(deadlineOf('2026-10-12T21:30').deadline, '2026-10-13');
  assert.equal(deadlineOf('2026-10-16T10:00').deadline, '2026-10-16', 'Friday morning → Friday');
  assert.equal(deadlineOf('2026-10-16T19:30').deadline, '2026-10-19', 'Friday evening → Monday');
  assert.equal(deadlineOf('2026-10-17T11:00').deadline, '2026-10-19', 'Saturday (not a working day) → Monday');
  assert.equal(deadlineOf('2026-10-12T10:00').cutoffMinutes, CUT);
});
test('mail: nothing is deducted until the daily report has gone out; then −10, once, to the person it was reassigned to', () => {
  const s = mailState();
  assert.equal(am.evaluateReassignedMail(s, mailCtx('2026-10-12', '12:00')).length, 0, 'same day, report not sent yet');
  assert.equal(am.evaluateReassignedMail(s, mailCtx('2026-10-12', '18:44')).length, 0);
  const made = [];
  const r = am.evaluateReassignedMail(s, mailCtx('2026-10-12', '18:45', { onCreated: row => made.push(row) }));
  assert.equal(r.length, 1); assert.equal(r[0].created, true);
  assert.equal(made[0].toId, 'e2'); assert.equal(made[0].points, -10); assert.equal(made[0].type, 'auto_mail_reply');
  assert.match(made[0].reason, /"Client question" reassigned to you on .* was not replied to by 6:45 pm on .* \(before the daily report\)/);
  assert.equal(am.evaluateReassignedMail(s, mailCtx('2026-10-12', '19:30')).filter(x => x.created).length, 0, 'never twice for the same hand-off');
  assert.equal(am.evaluateReassignedMail(s, mailCtx('2026-10-13', '09:00')).filter(x => x.created).length, 0);
  assert.equal(s.marks.length, 1);
});
test('mail: handed over after the report → not due that evening, due before the next working day\'s report', () => {
  const s = mailState({ reassignHistory: handedAt('2026-10-12T19:30') });
  assert.equal(am.evaluateReassignedMail(s, mailCtx('2026-10-12', '23:00')).length, 0);
  assert.equal(am.evaluateReassignedMail(s, mailCtx('2026-10-13', '12:00')).length, 0, 'Tuesday midday');
  assert.equal(am.evaluateReassignedMail(s, mailCtx('2026-10-13', '18:45')).filter(x => x.created).length, 1);
});
test('mail: a reply, "no reply needed", or handing it back to the mailbox owner means no deduction', () => {
  const late = mailCtx('2026-10-12', '19:00');
  assert.equal(am.evaluateReassignedMail(mailState({ replied: true }), late).length, 0);
  assert.equal(am.evaluateReassignedMail(mailState({ replyNotNeeded: true }), late).length, 0);
  assert.equal(am.evaluateReassignedMail(mailState({ reassignedTo: null }), late).length, 0);
  assert.equal(am.evaluateReassignedMail(mailState({ direction: 'outbound' }), late).length, 0);
});
test('mail: a hand-off before the rules started is never judged; the rule can be switched off; leave moves the deadline', () => {
  assert.equal(am.evaluateReassignedMail(mailState({}, { activeFrom: '2026-10-13' }), mailCtx('2026-10-20', '09:00')).length, 0);
  assert.equal(am.evaluateReassignedMail(mailState({}, { enabled: { mailReply: false } }), mailCtx('2026-10-20', '09:00')).length, 0);
  const s = mailState();
  const onLeave12 = (id, day) => id === 'e2' && day === '2026-10-12';
  assert.equal(am.evaluateReassignedMail(s, mailCtx('2026-10-12', '19:00', { skip: onLeave12 })).length, 0, 'on leave that day → due the next working day instead');
  assert.equal(am.evaluateReassignedMail(s, mailCtx('2026-10-13', '19:00', { skip: onLeave12 })).length, 1);
});
test('mail: only the CURRENT hand-off counts, and each hand-off has its own clock', () => {
  const s = mailState({ reassignHistory: [
    { at: '2026-10-12T09:00', by: 'e1', from: 'e1', to: 'e2' },
    { at: '2026-10-12T15:00', by: 'e2', from: 'e2', to: 'e1x' }], reassignedTo: 'e1x' });
  s.employees.push({ id: 'e1x' });
  const r = am.evaluateReassignedMail(s, mailCtx('2026-10-12', '18:45'));
  assert.equal(r.length, 1); assert.equal(r[0].toId, 'e1x', 'the person who passed it on at 15:00 is not charged — it is the new owner\'s');
});
test('mail: the report time follows CALLS_EMAILS_DIGEST_HOUR and reads naturally', () => {
  assert.equal(am.cutoffLabel(18 * 60 + 45), '6:45 pm');
  assert.equal(am.cutoffLabel(9 * 60 + 5), '9:05 am');
  const keep = process.env.CALLS_EMAILS_DIGEST_HOUR;
  process.env.CALLS_EMAILS_DIGEST_HOUR = '17';
  assert.equal(am.digestCutoffMinutes(), 17 * 60 + 45);
  if (keep === undefined) delete process.env.CALLS_EMAILS_DIGEST_HOUR; else process.env.CALLS_EMAILS_DIGEST_HOUR = keep;
  assert.equal(am.digestCutoffMinutes(), 18 * 60 + 45);
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
const workingDays = new Set(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']); // Mon–Fri, then the next Monday
// the second argument is the NZ clock time, 'HH:MM'; the daily report goes out at 18:45
const mkDeps = (state, today, hhmm, extra) => ({ today, nowMinutes: Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)), cutoffMinutes: 18 * 60 + 45, isWorkingDay: d => workingDays.has(d), getStats: () => people, now: today + 'T00:00:00Z', ...(extra || {}) });
test('runDays: nothing is ever deducted retroactively — it starts the day the rules were first read', () => {
  const s = { employees: staff, marks: [] };
  const r = am.runDays(s, mkDeps(s, '2026-10-14', '09:00'));  // first read on the 14th, in the morning
  assert.equal(s.autoMarks.settings.activeFrom, '2026-10-14');
  assert.equal(r.created, 0, 'the 13th and earlier are never judged'); assert.equal(s.marks.length, 0);
});
test('runDays: a day is judged the SAME evening, at 18:45 when the daily report goes out — not before, and once', () => {
  const s = { employees: staff, marks: [], autoMarks: { settings: { activeFrom: '2026-10-12' } } };
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-12', '09:00')).created, 0, 'morning: the day is still open');
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-12', '18:44')).created, 0, 'a minute before the report: still open');
  const evening = am.runDays(s, mkDeps(s, '2026-10-12', '18:45'));
  assert.deepEqual(evening.days.map(d => d.day), ['2026-10-12']); assert.equal(evening.created, 3, 'judged the same evening');
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-12', '21:00')).created, 0, 'the same day is not judged twice');
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-13', '08:00')).created, 0, 'and the next morning does not re-judge it');
  assert.equal(s.autoMarks.lastEvaluated, '2026-10-12');
});
test('runDays: weekends are skipped, and a missed day is judged afterwards', () => {
  const w = { employees: staff, marks: [], autoMarks: { settings: { activeFrom: '2026-10-16' } } };
  const fri = am.runDays(w, mkDeps(w, '2026-10-16', '19:00'));
  assert.deepEqual(fri.days.map(d => d.day), ['2026-10-16']);
  const mon = am.runDays(w, mkDeps(w, '2026-10-19', '10:00'));
  assert.equal(mon.days.length, 0, 'Saturday and Sunday are not working days, Monday is still open');
  assert.equal(w.autoMarks.lastEvaluated, '2026-10-18');
  const down = { employees: staff, marks: [], autoMarks: { settings: { activeFrom: '2026-10-12' } } };
  const caught = am.runDays(down, mkDeps(down, '2026-10-14', '09:00')); // server was down on the 12th and 13th
  assert.deepEqual(caught.days.map(d => d.day), ['2026-10-12', '2026-10-13']);
});
test('runDays: switched off, it does not catch up when switched back on', () => {
  const s = { employees: staff, marks: [], autoMarks: { settings: { activeFrom: '2026-10-12', enabled: { acknowledgement: false } } } };
  am.runDays(s, mkDeps(s, '2026-10-16', '19:00'));
  assert.equal(s.marks.length, 0);
  s.autoMarks.settings.enabled.acknowledgement = true;
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-16', '20:00')).created, 0, 'the days it was off are not judged afterwards');
  assert.equal(am.runDays(s, mkDeps(s, '2026-10-19', '19:00')).days.map(d => d.day).join(), '2026-10-19');
});

/* ---------------- settings ---------------- */
test('settings: defaults, validation, and activeFrom stays put', () => {
  const s = {};
  const d = am.settingsOf(s, '2026-10-12');
  assert.deepEqual(d.points, { ackAll: 10, ackHalfMax: 5, processorLinks: 20, reviewerLinks: 30, reportLate: 10, mailReplyLate: 10 });
  assert.deepEqual(d.enabled, { acknowledgement: true, links: true, reports: true, mailReply: true });
  assert.equal(d.activeFrom, '2026-10-12');
  assert.equal(am.settingsOf(s, '2026-11-01').activeFrom, '2026-10-12');
  am.updateSettings(s, { enabled: { links: false, nonsense: true }, points: { processorLinks: '15', reviewerLinks: -5, ackAll: 'abc' }, activeFrom: 'tomorrow' }, '2026-10-12');
  assert.equal(s.autoMarks.settings.enabled.links, false); assert.equal(s.autoMarks.settings.enabled.acknowledgement, true);
  assert.equal(s.autoMarks.settings.points.processorLinks, 15);
  assert.equal(s.autoMarks.settings.points.reviewerLinks, 30, 'a negative number is ignored');
  assert.equal(s.autoMarks.settings.points.ackAll, 10, 'a non-number is ignored');
  assert.equal(s.autoMarks.settings.activeFrom, '2026-10-12', 'an invalid date is ignored');
});
