// The Today dashboard's derived picture of a task: display status, who owns the next action, the client commitment, review
// waiting time (kept apart from client lateness), and the delivery tracker — plus how the Today lists are built.
const test = require('node:test');
const assert = require('node:assert/strict');
const wf = require('./workflow');

const NAMES = { me: 'Parvinder Kumar', emp: 'Ranjit Choudhary', rev: 'Disha Chaudhary', other: 'Anjana Pandey', sh: 'Shubam Sharma' };
const nzDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const NOW = Date.parse('2026-10-07T01:00:00Z');         // 14:00 on Wed 7 Oct 2026, NZ
const TODAY = '2026-10-07';
const deps = (o) => ({ today: TODAY, nowMs: NOW, nzDay, nameOf: id => NAMES[id] || id, profitOwnerId: 'sh', canApprove: () => false, isManager: true, ...(o || {}) });
const base = (o) => ({ id: '#1', name: 'GST return', kind: 'client', clientId: 'c1', clientName: 'Acme Ltd', status: 'accepted', assignedTo: 'emp', reviewerId: 'me', internalDeadline: '2026-10-09', clientDate: '2026-10-14', tat: 3, reworkCount: 0, ...(o || {}) });
const submitted = (o) => base({ status: 'completed', completedAt: '2026-10-05T01:00:00Z', reviewStatus: null, ...(o || {}) });

test('seven display statuses are derived from the stored ones — nothing is stored or renamed', () => {
  assert.equal(wf.status(base({ status: 'awaiting_acceptance' })), 'Assigned');
  assert.equal(wf.status(base({ status: 'pending_approval' })), 'Assigned');
  assert.equal(wf.status(base({ status: 'accepted' })), 'In Progress');
  assert.equal(wf.status(base({ status: 'on_hold' })), 'On Hold');
  assert.equal(wf.status(submitted()), 'In Review');
  assert.equal(wf.status(base({ status: 'awaiting_acceptance', reviewStatus: 'error' })), 'Correction Required');
  assert.equal(wf.status(base({ status: 'rework', reviewStatus: 'error' })), 'Correction Required');
  assert.equal(wf.status(submitted({ reviewStatus: 'clean', sentToClient: null })), 'Approved', 'clean but the report is not sent: Approved, not Completed');
  assert.equal(wf.status(submitted({ reviewStatus: 'clean', sentToClient: true })), 'Completed');
  assert.equal(wf.status(submitted({ reviewStatus: 'done' })), 'Completed');
  assert.equal(wf.status(submitted({ kind: 'internal', clientId: null, reviewStatus: 'clean' })), 'Completed', 'an Admin Task has no report to send');
});

test('returned work is never "not started": it reads as a correction, and a resubmission says so', () => {
  const returned = base({ status: 'awaiting_acceptance', reviewStatus: 'error', reworkCount: 1 });
  assert.equal(wf.subState(returned, 'Correction Required'), 'Waiting for your correction');
  assert.equal(wf.subState(base({ status: 'rework', reviewStatus: 'error', reworkCount: 1 }), 'Correction Required'), 'Correction in progress');
  assert.equal(wf.subState(submitted({ reworkCount: 1 }), 'In Review'), 'Correction resubmitted');
  assert.equal(wf.subState(submitted(), 'In Review'), null);
});

test('every task has ONE owner for the next action, in the spec\'s words', () => {
  const w = t => wf.waitingOn(t, wf.status(t), deps());
  assert.deepEqual([w(base()).kind, w(base()).label], ['employee', 'Waiting on employee']);
  assert.deepEqual([w(submitted()).kind, w(submitted()).ownerName], ['reviewer', 'Parvinder Kumar']);
  assert.equal(w(base({ status: 'awaiting_acceptance', reviewStatus: 'error' })).label, 'Waiting on employee');
  assert.equal(w(base({ status: 'on_hold', holdReasonCode: 'CLIENT_DOCS' })).label, 'Waiting on client');
  assert.equal(w(base({ status: 'on_hold', holdReasonCode: 'THIRD_PARTY' })).label, 'Waiting on external authority');
  assert.equal(w(base({ status: 'on_hold', holdReasonCode: 'CAPACITY' })).label, 'Waiting on manager');
  assert.equal(w(base({ assignedTo: null, status: 'awaiting_acceptance' })).label, 'Waiting on manager');
  const profit = submitted({ reviewStatus: 'clean', sentToClient: null, profitConfirmStatus: 'pending' });
  assert.deepEqual([w(profit).kind, w(profit).ownerName, w(profit).label], ['profit', 'Shubam Sharma', 'Waiting on profit confirmation']);
  const ready = submitted({ reviewStatus: 'clean', sentToClient: null, reportSendOwner: 'other' });
  assert.deepEqual([w(ready).label, w(ready).ownerName], ['Ready to send', 'Anjana Pandey']);
  assert.equal(w(submitted({ reviewStatus: 'done' })).label, 'No action required');
});

test('REVIEW waiting time and CLIENT deadline are two separate things; waiting is never called "overdue"', () => {
  const t = submitted({ completedAt: '2026-10-02T01:00:00Z', clientDate: '2026-10-09' });   // submitted 5 days ago; client date in 2 days
  const c = wf.card(t, deps());
  assert.equal(c.reviewWaiting.days, 5, 'waiting for review: 5 days — from the submission');
  assert.equal(c.clientRisk.days, 2); assert.match(c.clientRisk.label, /2 days remaining/);
  assert.ok(!/overdue/i.test(JSON.stringify(c.reviewWaiting)), 'review waiting is never labelled overdue');
  const late = wf.card(submitted({ completedAt: '2026-10-02T01:00:00Z', clientDate: '2026-10-05' }), deps());
  assert.equal(late.clientRisk.state, 'overdue'); assert.match(late.clientRisk.label, /overdue by 2 days/);
  assert.equal(late.reviewWaiting.days, 5);
  assert.equal(wf.clientRisk(base({ clientDate: TODAY }), 'In Progress', TODAY).label, 'Client deadline: due today');
  assert.equal(wf.clientRisk(base({ clientDate: '2026-10-08' }), 'In Progress', TODAY).label, 'Client deadline: 1 day remaining');
  assert.equal(wf.card(submitted({ completedAt: '2026-10-07T00:00:00Z' }), deps()).reviewWaiting.days, 0, 'submitted today: 0 days');
});

test('a resubmission restarts the review clock from the NEW submission, not the original', () => {
  const first = submitted({ completedAt: '2026-09-28T01:00:00Z', reworkCount: 1 });
  const resubmitted = { ...first, completedAt: '2026-10-06T01:00:00Z' };       // /resubmit refreshes completedAt
  assert.equal(wf.card(resubmitted, deps()).reviewWaiting.days, 1);
});

test('commitment tags: a REVIEWER delay is never an employee breach', () => {
  const tag = t => wf.card(t, deps()).commitment.key;
  assert.equal(tag(submitted({ completedAt: '2026-10-05T01:00:00Z', internalDeadline: '2026-10-08', clientDate: '2026-10-06' })), 'met', 'submitted before the internal date; the client date passed while it sat in review — the employee met their commitment');
  assert.equal(tag(submitted({ completedAt: '2026-10-07T01:00:00Z', internalDeadline: '2026-10-05' })), 'breached', 'submitted after the internal date');
  assert.equal(tag(base({ internalDeadline: '2026-10-05' })), 'breached', 'still not submitted after the internal date');
  assert.equal(tag(base({ internalDeadline: TODAY })), 'due_today');
  assert.equal(tag(base({ internalDeadline: '2026-10-10', clientDate: '2026-10-09' })), 'at_risk');
  assert.equal(tag(base({ internalDeadline: '2026-10-10', clientDate: '2026-10-20' })), 'on_track');
  assert.equal(tag(base({ kind: 'internal', clientId: null })), 'na', 'an Admin Task has no client commitment');
  assert.equal(tag(base({ status: 'on_hold', holdReasonCode: 'CLIENT_QUERY', internalDeadline: '2026-10-01' })), 'waiting_client', 'an approved client-wait hold pauses the clock');
});

test('date arithmetic cannot shift across daylight saving (NZ clocks went forward on 27 Sept 2026 and back on 5 Apr 2026)', () => {
  assert.equal(wf.daysBetween('2026-09-26', '2026-09-28'), 2);
  assert.equal(wf.daysBetween('2026-09-27', '2026-09-28'), 1);
  assert.equal(wf.daysBetween('2026-04-04', '2026-04-06'), 2);
  assert.equal(wf.daysBetween('2026-10-07', '2026-10-07'), 0); assert.equal(wf.daysBetween('2026-10-08', '2026-10-07'), -1);
  // a date-only deadline is the same day whichever side of midnight "now" is on
  const lateNight = deps({ today: '2026-10-07' });
  assert.equal(wf.clientRisk(base({ clientDate: '2026-10-07' }), 'In Progress', lateNight.today).state, 'due_today');
});

test('the greeting follows the BUSINESS clock', () => {
  assert.deepEqual([0, 6, 11, 12, 16, 17, 23].map(wf.greetingFor), ['Good morning', 'Good morning', 'Good morning', 'Good afternoon', 'Good afternoon', 'Good evening', 'Good evening']);
});

test('the four-stage tracker, with Correction Required and profit confirmation as visible milestones', () => {
  const states = t => wf.tracker(t, wf.status(t)).steps.map(s => s.key + ':' + s.state).join(' ');
  assert.equal(states(base()), 'processing:current review:todo ready:todo sent:todo');
  assert.equal(states(submitted()), 'processing:done review:current ready:todo sent:todo');
  assert.equal(states(base({ status: 'awaiting_acceptance', reviewStatus: 'error' })), 'processing:done review:done correction:attention ready:todo sent:todo');
  assert.equal(states(submitted({ reviewStatus: 'clean', sentToClient: null, profitConfirmStatus: 'pending' })), 'processing:done review:done profit:current ready:todo sent:todo');
  assert.equal(states(submitted({ reviewStatus: 'clean', sentToClient: null })), 'processing:done review:done ready:current sent:todo');
  assert.equal(states(submitted({ reviewStatus: 'clean', sentToClient: true, profitConfirmStatus: 'confirmed' })), 'processing:done review:done profit:done ready:done sent:done');
  assert.equal(wf.tracker(base({ kind: 'internal', clientId: null }), 'In Progress').applicable, false, 'an Admin Task has no delivery tracker');
  assert.equal(wf.taskKindLabel(base({ kind: 'internal', clientId: null })), 'Admin Task'); assert.equal(wf.taskKindLabel(base()), 'Client Task');
});

/* ---------------- the Today lists ---------------- */
const mine = { id: 'me', name: 'Parvinder Kumar' };
const T = (id, o) => base({ id, name: 'Task ' + id, ...(o || {}) });
const fixture = () => [
  T('#a', { status: 'completed', completedAt: '2026-10-03T01:00:00Z', clientDate: '2026-10-06' }),                                   // in review, mine, client OVERDUE
  T('#b', { status: 'completed', completedAt: '2026-10-06T01:00:00Z', clientDate: '2026-10-07' }),                                   // in review, mine, due TODAY
  T('#c', { status: 'completed', completedAt: '2026-10-04T01:00:00Z', clientDate: '2026-10-20', reworkCount: 2 }),                  // correction resubmitted, mine
  T('#d', { status: 'completed', completedAt: '2026-10-04T01:00:00Z', reviewerId: 'rev', clientDate: '2026-10-08' }),               // in review but with ANOTHER reviewer
  T('#e', { status: 'awaiting_acceptance', reviewStatus: 'error', clientDate: '2026-10-15' }),                                        // correction — employee owns it
  T('#f', { status: 'on_hold', holdReasonCode: 'CLIENT_DOCS', internalDeadline: '2026-10-01' }),                                      // waiting on client, NOT overdue
  T('#g', { status: 'accepted', internalDeadline: '2026-10-05' }),                                                                    // employee overdue
  T('#h', { status: 'completed', completedAt: '2026-10-05T01:00:00Z', reviewStatus: 'clean', sentToClient: null, reportSendOwner: 'me', awaitingClientDecision: true, reviewedBy: 'me', reviewedAt: '2026-10-07T00:30:00Z' }),   // I approved it today; I must send the report
  T('#i', { status: 'awaiting_acceptance', assignedTo: null, clientDate: '2026-10-07' }),                                             // unassigned and urgent
  T('#j', { status: 'completed', completedAt: '2026-09-20T01:00:00Z', reviewStatus: 'clean', sentToClient: true, sentToClientAt: '2026-10-07T00:00:00Z', sentToClientBy: 'me', reviewedBy: 'me', reviewedAt: '2026-09-25T00:00:00Z' }),   // I sent it today
  T('#k', { status: 'window_proposed' }),                                                                                              // a new date to decide
];
const today = (o) => wf.buildToday(fixture(), mine, deps({ canApprove: t => t.status === 'window_proposed', ...(o || {}) }));

test('TODAY: only MY actions are in "Needs you now", one entry per task, ordered overdue → today → tomorrow', () => {
  const r = today();
  const ids = r.sections.needs.map(n => n.id);
  assert.deepEqual(ids.slice(0, 2), ['#a', '#b'], 'client-overdue first, then due today');
  assert.ok(ids.includes('#c') && ids.includes('#h') && ids.includes('#i') && ids.includes('#k'));
  assert.ok(!ids.includes('#d'), 'a task in review with ANOTHER reviewer is not mine');
  assert.ok(!ids.includes('#e') && !ids.includes('#f') && !ids.includes('#g'), 'work the employee or client owns is not mine');
  assert.equal(new Set(ids).size, ids.length, 'no task appears twice');
  const type = id => r.sections.needs.find(n => n.id === id).type;
  assert.deepEqual([type('#a'), type('#c'), type('#h'), type('#i'), type('#k')], ['review', 'correction_resubmitted', 'send_report', 'unassigned', 'decision']);
});

test('TODAY: work waiting on others is grouped by who owns the next action, and is NOT counted as my overdue', () => {
  const r = today();
  const g = k => (r.sections.waiting.find(x => x.kind === k) || { ids: [] }).ids;
  assert.deepEqual(g('client'), ['#f']); assert.ok(g('employee').includes('#e') && g('employee').includes('#g'));
  assert.deepEqual(g('reviewer'), ['#d']);
  assert.deepEqual(r.filters.overdue, ['#g'], 'only the employee-owned task past its internal date counts — not the client wait, not the review');
  const needsIds = new Set(r.sections.needs.map(n => n.id));
  r.sections.waiting.forEach(grp => grp.ids.forEach(id => assert.ok(!needsIds.has(id), id + ' is in both lists')));
});

test('TODAY: completed today shows what I did, and the six counts equal their filtered lists', () => {
  const r = today();
  const done = Object.fromEntries(r.sections.completed.map(d => [d.id, d.action]));
  assert.equal(done['#h'], 'Review approved'); assert.equal(done['#j'], 'Report sent');
  assert.deepEqual(Object.keys(r.counts).sort(), ['completed', 'decision', 'overdue', 'reports', 'review', 'risk']);
  for (const [k, n] of Object.entries(r.counts)) assert.equal(n, r.filters[k].length, k + ': the count is the length of the list it opens');
  assert.deepEqual(r.filters.review, ['#a', '#b', '#c'], 'needs my review');
  assert.deepEqual(r.filters.decision.sort(), ['#i', '#k'], 'waiting for my decision');
  assert.deepEqual(r.filters.reports, ['#h'], 'approved, not yet sent');
  assert.ok(r.filters.risk.includes('#a') && r.filters.risk.includes('#b') && !r.filters.risk.includes('#j'), 'at risk = not-yet-delivered client work near or past its date');
  Object.keys(r.cards).forEach(id => assert.ok(r.cards[id].status), 'every shipped card is complete');
});

test('TODAY: finishing an action moves it from "Needs you" to "Completed today"', () => {
  const before = today();
  assert.ok(before.sections.needs.some(n => n.id === '#a'));
  const tasks = fixture().map(t => t.id === '#a' ? { ...t, reviewStatus: 'clean', reviewedBy: 'me', reviewedAt: '2026-10-07T00:45:00Z', sentToClient: null, awaitingClientDecision: true, reportSendOwner: 'emp' } : t);
  const after = wf.buildToday(tasks, mine, deps({ canApprove: t => t.status === 'window_proposed' }));
  assert.ok(!after.sections.needs.some(n => n.id === '#a'), 'it left my list');
  assert.ok(after.sections.completed.some(d => d.id === '#a' && d.action === 'Review approved'));
  assert.ok(!after.sections.waiting.some(g => g.ids.includes('#a')), 'a finished action is not ALSO listed as waiting — it moved');
  assert.ok(after.filters.reports.includes('#a'), 'but the report still shows under Reports not sent, waiting on its sender');
  assert.equal(after.cards['#a'].waitingOn.label, 'Ready to send');
});

/* ---------------- timezone: the company clock is Pacific/Auckland ---------------- */
test('OVERDUE flips exactly at business midnight, and a date-only deadline never shifts', () => {
  const t = base({ clientDate: '2026-10-07' });
  assert.equal(wf.clientRisk(t, 'In Progress', '2026-10-07').state, 'due_today', 'on the day: due today');
  const next = wf.clientRisk(t, 'In Progress', '2026-10-08');
  assert.equal(next.state, 'overdue'); assert.equal(next.days, -1, 'the next business day: overdue by one');
  assert.equal(wf.clientRisk(t, 'In Progress', '2026-10-06').days, 1, 'the day before: one day remaining');
  assert.equal(t.clientDate, '2026-10-07', 'the stored date-only deadline is never rewritten');
});

test('NZ daylight saving: instants either side of the clock changes land on the right business day', () => {
  // Clocks went FORWARD at 02:00 NZST on Sun 27 Sep 2026 (= 14:00Z Sat 26 Sep): NZST is UTC+12, NZDT UTC+13.
  assert.equal(nzDay('2026-09-26T10:59:00Z'), '2026-09-26', '22:59 NZST, Saturday');
  assert.equal(nzDay('2026-09-26T11:59:00Z'), '2026-09-26', '23:59 NZST, Saturday');
  assert.equal(nzDay('2026-09-26T12:00:00Z'), '2026-09-27', 'midnight NZST → Sunday');
  assert.equal(nzDay('2026-09-26T14:30:00Z'), '2026-09-27', '03:30 NZDT, Sunday (just after the change)');
  assert.equal(nzDay('2026-09-27T10:59:00Z'), '2026-09-27', '23:59 NZDT, Sunday');
  assert.equal(nzDay('2026-09-27T11:00:00Z'), '2026-09-28', 'midnight NZDT → Monday');
  // Clocks went BACK at 03:00 NZDT on Sun 5 Apr 2026 (= 14:00Z Sat 4 Apr).
  assert.equal(nzDay('2026-04-04T13:59:00Z'), '2026-04-05', '02:59 NZDT, Sunday');
  assert.equal(nzDay('2026-04-04T14:30:00Z'), '2026-04-05', '02:30 NZST, Sunday — the repeated hour is still Sunday');
  assert.equal(nzDay('2026-04-05T10:59:00Z'), '2026-04-05', '22:59 NZST'); assert.equal(nzDay('2026-04-05T12:00:00Z'), '2026-04-06', 'midnight NZST → Monday');
});

test('review waiting days are whole business days, correct across a daylight-saving change', () => {
  const across = submitted({ completedAt: '2026-09-26T11:00:00Z' });                     // 23:00 NZST Saturday 26 Sep
  assert.equal(wf.card(across, deps({ today: '2026-09-28' })).reviewWaiting.days, 2, 'Saturday night → Monday is 2 days even though a clock hour was lost');
  assert.equal(wf.card(across, deps({ today: '2026-09-27' })).reviewWaiting.days, 1);
  const backAcross = submitted({ completedAt: '2026-04-04T10:00:00Z' });                  // 23:00 NZDT Saturday 4 Apr (before clocks go back)
  assert.equal(wf.card(backAcross, deps({ today: '2026-04-06' })).reviewWaiting.days, 2, 'and when an hour is gained');
});
