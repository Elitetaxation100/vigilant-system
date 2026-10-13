// Commitment watch (pure rules) and the new automatic-mark rules: late callback, the 2026-10 point scale.
const test = require('node:test');
const assert = require('node:assert/strict');
const watch = require('./commitment-watch');
const am = require('./auto-marks');

const nzDay = iso => iso.slice(0, 10);
const deps = (today, extra) => ({ today, nzDay, nameOf: id => id, queryShiftDays: () => 0, addWorkingDays: require('./calendar').addWorkingDays, ...(extra || {}) });
const task = over => ({ id: 't1', name: 'GST return', kind: 'client', clientId: 'c1', clientName: 'Acme', assignedTo: 'e1', reviewerId: 'e2', status: 'accepted', reviewStatus: null,
  internalDeadline: '2026-10-14', clientDate: '2026-10-20', sentToClient: null, submissions: [], reviewEvents: [], ...(over || {}) });
const card = (t, today) => require('./workflow').card(t, deps(today));

test('stage timeline: the five stages, each with its own recorded time — a missing one is null, never guessed', () => {
  const t = task({
    status: 'completed', reviewStatus: 'clean', completedAt: '2026-10-13T01:00:00Z', reviewedAt: '2026-10-13T03:00:00Z', reviewedBy: 'e2', readyForReportAt: '2026-10-13T03:00:01Z',
    submissions: [{ at: '2026-10-12T22:00:00Z', byId: 'e1', kind: 'review' }, { at: '2026-10-13T01:00:00Z', byId: 'e1', kind: 'resubmit' }],
    reviewEvents: [{ id: 'rv-1', type: 'returned', at: '2026-10-12T23:00:00Z', byId: 'e2' }, { id: 'rv-2', type: 'approved', at: '2026-10-13T03:00:00Z', byId: 'e2' }],
  });
  const s = Object.fromEntries(watch.stageTimeline(t, deps('2026-10-14')).map(x => [x.key, x]));
  assert.equal(s.submitted.at, '2026-10-13T01:00:00Z'); assert.equal(s.submitted.count, 2); assert.equal(s.submitted.firstAt, '2026-10-12T22:00:00Z');
  assert.equal(s.reviewed.at, '2026-10-13T03:00:00Z'); assert.equal(s.reviewed.outcome, 'approved');
  assert.equal(s.sent_back.at, '2026-10-12T23:00:00Z'); assert.equal(s.sent_back.count, 1);
  assert.equal(s.ready_for_report.at, '2026-10-13T03:00:01Z');
  assert.equal(s.report_sent.at, null, 'not sent yet → no time, not a made-up one');
  assert.deepEqual(watch.stageTimeline(t, deps('2026-10-14')).map(x => x.key), ['submitted', 'reviewed', 'sent_back', 'ready_for_report', 'report_sent']);
});

test('stage timeline: older tasks fall back to the stamps they have, marked approximate — and report-not-needed says so', () => {
  const old = task({ status: 'completed', reviewStatus: 'clean', completedAt: '2026-10-01T01:00:00Z', reviewedAt: '2026-10-02T01:00:00Z', reportReturnedAt: '2026-10-02T01:00:00Z' });
  const s = Object.fromEntries(watch.stageTimeline(old, deps('2026-10-14')).map(x => [x.key, x]));
  assert.equal(s.submitted.at, '2026-10-01T01:00:00Z'); assert.equal(s.submitted.exact, false);
  assert.equal(s.reviewed.exact, false); assert.equal(s.ready_for_report.at, '2026-10-02T01:00:00Z');
  const none = task({ status: 'completed', reviewStatus: 'clean', sentToClient: false, sentToClientAt: '2026-10-02T01:00:00Z', reportDeliveryStatus: 'sending_not_required' });
  const n = watch.stageTimeline(none, deps('2026-10-14')).find(x => x.key === 'report_sent');
  assert.equal(n.at, null); assert.match(n.note, /No report needed/);
});

test('flag 1: not submitted by the internal due date — only once that day has passed', () => {
  const t = task({ internalDeadline: '2026-10-12' });
  assert.deepEqual(watch.flagsOf(t, card(t, '2026-10-12'), deps('2026-10-12')).map(f => f.code), [], 'due today is not late yet');
  const f = watch.flagsOf(t, card(t, '2026-10-13'), deps('2026-10-13')).find(x => x.code === 'not_submitted');
  assert.ok(f); assert.equal(f.tone, 'late'); assert.match(f.detail, /1 day late/);
  const submitted = task({ internalDeadline: '2026-10-12', status: 'completed', completedAt: '2026-10-12T01:00:00Z', submissions: [{ at: '2026-10-12T01:00:00Z', byId: 'e1', kind: 'review' }] });
  assert.equal(watch.flagsOf(submitted, card(submitted, '2026-10-13'), deps('2026-10-13')).some(x => x.code === 'not_submitted'), false);
});

test('flag 2: review not done before the commitment date — at risk on the day, late after it; clears once reviewed', () => {
  const t = task({ status: 'completed', completedAt: '2026-10-13T01:00:00Z', submissions: [{ at: '2026-10-13T01:00:00Z', byId: 'e1', kind: 'review' }], clientDate: '2026-10-15' });
  assert.equal(watch.flagsOf(t, card(t, '2026-10-14'), deps('2026-10-14')).some(x => x.code === 'review_not_done'), false, 'the day before is not yet a flag');
  assert.equal(watch.flagsOf(t, card(t, '2026-10-15'), deps('2026-10-15')).find(x => x.code === 'review_not_done').tone, 'at_risk');
  assert.equal(watch.flagsOf(t, card(t, '2026-10-16'), deps('2026-10-16')).find(x => x.code === 'review_not_done').tone, 'late');
  const reviewed = { ...t, reviewStatus: 'clean', reviewedAt: '2026-10-14T01:00:00Z' };
  assert.equal(watch.flagsOf(reviewed, card(reviewed, '2026-10-15'), deps('2026-10-15')).some(x => x.code === 'review_not_done'), false);
});

test('flag 3: no update one working day before the commitment date — an update on/after that day clears it', () => {
  // commitment Wed 21 Oct 2026 → the working day before is Tue 20 Oct
  const t = task({ clientDate: '2026-10-21', internalDeadline: '2026-10-30', acceptedAt: '2026-10-10T01:00:00Z' });
  assert.equal(watch.flagsOf(t, card(t, '2026-10-19'), deps('2026-10-19')).some(x => x.code === 'no_update'), false, 'two days before: too early');
  const f = watch.flagsOf(t, card(t, '2026-10-20'), deps('2026-10-20')).find(x => x.code === 'no_update');
  assert.ok(f); assert.equal(f.tone, 'at_risk'); assert.equal(f.lastUpdateAt, '2026-10-10T01:00:00Z');
  assert.equal(watch.flagsOf(t, card(t, '2026-10-22'), deps('2026-10-22')).find(x => x.code === 'no_update').tone, 'late');
  const updated = { ...t, queries: [{ id: 'q1', sentAt: '2026-10-20T00:30:00Z' }] };
  assert.equal(watch.flagsOf(updated, card(updated, '2026-10-20'), deps('2026-10-20')).some(x => x.code === 'no_update'), false, 'an update on the day clears it');
  const timer = { ...t, timerStartedAt: '2026-10-20T02:00:00Z' };
  assert.equal(watch.flagsOf(timer, card(timer, '2026-10-20'), deps('2026-10-20')).some(x => x.code === 'no_update'), false, 'a running timer is an update');
});

test('flags: nothing for finished, cancelled or deleted work; admin tasks have no commitment-date flags', () => {
  const done = task({ status: 'completed', reviewStatus: 'done', sentToClient: true, internalDeadline: '2026-10-01', clientDate: '2026-10-02' });
  assert.deepEqual(watch.flagsOf(done, card(done, '2026-10-14'), deps('2026-10-14')), []);
  const gone = task({ internalDeadline: '2026-10-01', deletedAt: '2026-10-05T00:00:00Z' });
  assert.deepEqual(watch.flagsOf(gone, card(gone, '2026-10-14'), deps('2026-10-14')), []);
  const admin = task({ kind: 'internal', clientId: null, clientDate: null, internalDeadline: '2026-10-20' });
  assert.deepEqual(watch.flagsOf(admin, card(admin, '2026-10-19'), deps('2026-10-19')).filter(f => f.code !== 'not_submitted'), []);
});

test('breach: the commitment date has passed and the report has not been sent — at any stage; sent / not-needed / decided-not-to-send / admin / future never', () => {
  const d = deps('2026-10-14');
  const inReview = task({ status: 'completed', clientDate: '2026-10-12' });
  const b = watch.breachOf(inReview, card(inReview, '2026-10-14'), d);
  assert.equal(b.daysOver, 2); assert.equal(b.stage, 'In Review'); assert.equal(b.ownerId, 'e2', 'the reviewer owns the next step');
  const approved = task({ status: 'completed', reviewStatus: 'clean', clientDate: '2026-10-12', reportSendOwner: 'e1', awaitingClientDecision: true });
  assert.equal(watch.breachOf(approved, card(approved, '2026-10-14'), d).ownerId, 'e1');
  const working = task({ clientDate: '2026-10-13' });
  assert.equal(watch.breachOf(working, card(working, '2026-10-14'), d).ownerId, 'e1', 'the processor owns work not yet handed in');
  assert.equal(watch.breachOf(task({ clientDate: '2026-10-14' }), card(task({ clientDate: '2026-10-14' }), '2026-10-14'), d), null, 'on the date itself is still on time');
  assert.equal(watch.breachOf(task({ clientDate: '2026-10-20' }), card(task(), '2026-10-14'), d), null);
  const sent = task({ status: 'completed', reviewStatus: 'clean', clientDate: '2026-10-01', sentToClient: true, sentToClientAt: '2026-10-02T00:00:00Z' });
  assert.equal(watch.breachOf(sent, card(sent, '2026-10-14'), d), null);
  const decided = task({ status: 'completed', reviewStatus: 'clean', clientDate: '2026-10-01', sentToClient: false });
  assert.equal(watch.breachOf(decided, card(decided, '2026-10-14'), d), null, 'deliberately not sent is a decision, not a breach');
  const notNeeded = task({ clientDate: '2026-10-01', reportRequired: false });
  assert.equal(watch.breachOf(notNeeded, card(notNeeded, '2026-10-14'), d), null);
  const admin = task({ kind: 'internal', clientId: null, clientDate: '2026-10-01' });
  assert.equal(watch.breachOf(admin, card(admin, '2026-10-14'), d), null);
});

// ---- the 2026-10 point scale -----------------------------------------------------------------------------------------------------------------
test('scale: a live database that stored the old amounts is moved to −50 / −250 ONCE, and a later change by a superadmin sticks', () => {
  const s = { autoMarks: { settings: { activeFrom: '2026-10-06', enabled: { acknowledgement: true, links: true, reports: true, mailReply: true }, points: { ackPerItem: 10, processorLinks: 20, reviewerLinks: 30, reportLate: 10, mailReplyLate: 10 } } } };
  const a = am.settingsOf(s, '2026-10-14');
  assert.equal(a.points.ackPerItem, 50); assert.equal(a.points.reportLate, 250); assert.equal(a.points.callbackLate, 50); assert.equal(a.points.submitLate, 50);
  assert.equal(a.points.processorLinks, 20, 'amounts that did not change are left alone'); assert.equal(a.points.mailReplyLate, 10);
  assert.equal(a.activeFrom, '2026-10-06'); assert.equal(a.scaleFrom, '2026-10-14');
  assert.equal(a.ruleFrom.callback, '2026-10-14'); assert.equal(a.ruleFrom.submitLate, '2026-10-14', 'the new rules start the day they arrive — never retroactive');
  am.updateSettings(s, { points: { ackPerItem: 70 } }, '2026-10-20');
  const b = am.settingsOf(s, '2026-10-21');
  assert.equal(b.points.ackPerItem, 70, 'not reset on the next read'); assert.equal(b.scaleFrom, '2026-10-14');
  assert.equal(am.updateSettings(s, { points: { reportLate: 5000 } }, '2026-10-21').points.reportLate, 250, 'out-of-range amounts are ignored');
});

// ---- late callback -------------------------------------------------------------------------------------------------------------------------
const CUT = 18 * 60 + 45;
const wd = new Set(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20']);
const nextWd = d => { let x = new Date(d + 'T00:00:00Z'); do { x = new Date(x.getTime() + 86400000); } while (!wd.has(x.toISOString().slice(0, 10))); return x.toISOString().slice(0, 10); };
const mins = iso => { const [h, m] = iso.slice(11, 16).split(':').map(Number); return h * 60 + m; };
const cbCtx = (today, hhmm, extra) => ({ today, nowMinutes: Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), cutoffMinutes: CUT, nzDay, nzMinutes: mins, isWorkingDay: d => wd.has(d), workingDayAfter: nextWd,
  responsible: c => c.agent ? [{ id: c.agent, name: c.agent }] : [], ...(extra || {}) });
const call = over => ({ id: 'call1', callerPhone: '210000001', direction: 'inbound', status: 'not_picked_up', occurredAt: '2026-10-12T10:00:00Z', agent: 'e1', clientName: 'Acme Ltd', team: 'Main', ...(over || {}) });
const cbState = (calls, settings) => ({ employees: [{ id: 'e1' }, { id: 'e2' }], marks: [], calls, autoMarks: { settings: { activeFrom: '2026-10-01', scale: 2, scaleFrom: '2026-10-01', ruleFrom: { callback: '2026-10-01', submitLate: '2026-10-01' }, ...(settings || {}) } } });

test('callback: a missed call is due the same working day before 6:45 pm; after that — or on a day off — the next working day', () => {
  const dl = (at) => am.callbackDeadline(call({ occurredAt: at }), 'e1', cbCtx('2026-10-20', '09:00')).deadline;
  assert.equal(dl('2026-10-12T10:00:00Z'), '2026-10-12');
  assert.equal(dl('2026-10-12T18:44:00Z'), '2026-10-12');
  assert.equal(dl('2026-10-12T18:45:00Z'), '2026-10-13');
  assert.equal(dl('2026-10-16T19:30:00Z'), '2026-10-19', 'Friday evening → Monday');
  assert.equal(dl('2026-10-17T11:00:00Z'), '2026-10-19', 'Saturday → Monday');
});

test('callback: not called back by the deadline → −50 to each person it was routed to, once; before the cutoff nothing', () => {
  const s = cbState([call()]);
  assert.equal(am.evaluateCallbacks(s, cbCtx('2026-10-12', '12:00')).length, 0, 'same day, still time');
  assert.equal(am.evaluateCallbacks(s, cbCtx('2026-10-12', '18:44')).length, 0);
  const made = [];
  const r = am.evaluateCallbacks(s, cbCtx('2026-10-12', '18:45', { onCreated: row => made.push(row) }));
  assert.equal(r.length, 1); assert.equal(made.length, 1);
  assert.equal(made[0].points, -50); assert.equal(made[0].toId, 'e1'); assert.equal(made[0].type, 'auto_callback_late'); assert.equal(made[0].byId, null);
  assert.match(made[0].reason, /missed call from Acme Ltd .* not called back/);
  assert.equal(am.evaluateCallbacks(s, cbCtx('2026-10-13', '09:00')).filter(x => x.created).length, 0, 'never twice for the same call');
});

test('callback: an outbound attempt or an answered call from the same number counts as the callback — on time it is fine, after the deadline it is late', () => {
  const back = (over) => cbState([call(), { id: 'call2', callerPhone: '210000001', direction: 'outbound', status: 'ended', occurredAt: '2026-10-12T14:00:00Z', ...(over || {}) }]);
  assert.equal(am.evaluateCallbacks(back(), cbCtx('2026-10-13', '09:00')).length, 0, 'called back in time');
  assert.equal(am.evaluateCallbacks(back({ status: 'not_picked_up' }), cbCtx('2026-10-13', '09:00')).length, 0, 'an attempt (they did not pick up) is still a callback');
  assert.equal(am.evaluateCallbacks(back({ direction: 'inbound', status: 'ended' }), cbCtx('2026-10-13', '09:00')).length, 0, 'they rang back and it was answered');
  const late = am.evaluateCallbacks(back({ occurredAt: '2026-10-13T09:00:00Z' }), cbCtx('2026-10-14', '09:00'));
  assert.equal(late.length, 1, 'called back the NEXT day — after the deadline'); assert.match(late[0].calledBackAt, /2026-10-13/);
  assert.equal(am.evaluateCallbacks(cbState([call(), { id: 'c3', callerPhone: '999999999', direction: 'outbound', status: 'ended', occurredAt: '2026-10-12T11:00:00Z' }]), cbCtx('2026-10-13', '09:00')).length, 1, 'a call to a different number is not a callback');
});

test('callback: handled calls, outbound / answered calls, recovered calls, unmapped numbers, leave days, old calls and a switched-off rule never count', () => {
  const ctx = cbCtx('2026-10-14', '09:00');
  [{ finalOutcome: 'Spoke to client' }, { taskId: 't9' }, { status: 'no_action' }, { direction: 'outbound' }, { status: 'ended' }, { recovered: true }, { callerPhone: '' }, { agent: null }]
    .forEach(over => assert.equal(am.evaluateCallbacks(cbState([call(over)]), ctx).length, 0, JSON.stringify(over)));
  assert.equal(am.evaluateCallbacks(cbState([call({ status: 'voicemail' })]), ctx).length, 1, 'a voicemail is owed a callback too');
  assert.equal(am.evaluateCallbacks(cbState([call({ occurredAt: '2026-09-28T10:00:00Z' })], { ruleFrom: { callback: '2026-10-05' } }), ctx).length, 0, 'before the rule started — not judged');
  assert.equal(am.evaluateCallbacks(cbState([call()], { enabled: { callback: false } }), ctx).length, 0, 'switched off');
  const onLeave = am.evaluateCallbacks(cbState([call({ occurredAt: '2026-10-12T10:00:00Z' })]), cbCtx('2026-10-13', '09:00', { skip: (id, day) => id === 'e1' && day === '2026-10-12' }));
  assert.equal(onLeave.length, 0, 'a leave day pushes the deadline to the next working day (still in time on the 13th morning)');
  assert.equal(am.evaluateCallbacks(cbState([call({ agent: 'e1' })]), cbCtx('2026-10-14', '09:00', { responsible: () => [{ id: 'e1' }, { id: 'e2' }] })).length, 2, 'every person it was routed to');
});
