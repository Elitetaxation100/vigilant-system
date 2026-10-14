// The simple Today list: only what needs THIS person today (the next action is theirs), most urgent first, one short reason each.
const test = require('node:test');
const assert = require('node:assert/strict');
const wf = require('./workflow');

const NAMES = { me: 'Parvinder Kumar', emp: 'Ranjit Choudhary', rev: 'Disha Chaudhary' };
const nzDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const NOW = Date.parse('2026-10-07T01:00:00Z');            // 14:00 on Wed 7 Oct 2026, NZ
const TODAY = '2026-10-07';
const deps = o => ({ today: TODAY, nowMs: NOW, nzDay, nameOf: id => NAMES[id] || id, profitOwnerId: 'sh', canApprove: () => false, isManager: false, queryShiftDays: () => 0, addWorkingDays: require('./calendar').addWorkingDays, ...(o || {}) });
const task = (id, o) => ({ id, name: 'Task ' + id, kind: 'client', clientId: 'c1', clientName: 'Acme Ltd', status: 'accepted', assignedTo: 'emp', reviewerId: 'rev', internalDeadline: '2026-10-09', clientDate: '2026-10-20', tat: 2, submissions: [], reviewEvents: [], ...(o || {}) });
const asEmp = (tasks, o) => wf.buildToday(tasks, { id: 'emp', name: 'Ranjit' }, deps(o));
const ids = r => r.attention.map(a => a.id);

test('a processor sees only the work that is theirs to do today — with a reason each', () => {
  const r = asEmp([
    task('#due', { internalDeadline: TODAY }),                                                         // due today
    task('#overdue', { internalDeadline: '2026-10-05' }),                                              // was due 5 Oct
    task('#future', { internalDeadline: '2026-10-12' }),                                               // not today
    task('#fix', { status: 'rework', reviewStatus: 'error', internalDeadline: '2026-10-12' }),         // sent back, in progress
    task('#review', { status: 'completed', completedAt: '2026-10-06T01:00:00Z' }),                     // waiting on a reviewer — not theirs
    task('#hold', { status: 'on_hold', holdReasonCode: 'CLIENT_DOCS', internalDeadline: '2026-10-01' }),   // waiting on the client — not theirs
    task('#ready', { status: 'on_hold', holdReasonCode: 'CLIENT_DOCS', holdResolvedAt: '2026-10-07T00:00:00Z' }),   // what they waited for arrived
    task('#cont', { resumeOn: TODAY, internalDeadline: '2026-10-12' }),                                // planned to continue today
    task('#run', { timerStartedAt: '2026-10-07T00:00:00Z', internalDeadline: '2026-10-12' }),          // clock running
  ]);
  assert.deepEqual(ids(r).sort(), ['#cont', '#due', '#fix', '#overdue', '#ready', '#run'].sort());
  const why = Object.fromEntries(r.attention.map(a => [a.id, a.why]));
  assert.match(why['#due'], /Due today/); assert.match(why['#overdue'], /Overdue — was due 2026-10-05/); assert.match(why['#fix'], /Sent back for a correction/);
  assert.match(why['#ready'], /ready to continue/); assert.match(why['#cont'], /planned to continue/); assert.match(why['#run'], /working on this now/);
  assert.ok(!ids(r).includes('#future') && !ids(r).includes('#review') && !ids(r).includes('#hold'), 'future work, work with a reviewer and work waiting on a client are not "needs you today"');
  assert.equal(r.attentionSummary.total, 6); assert.equal(r.attentionSummary.waitingOthers, 2, 'the review and the client hold are only counted, not listed');
  r.attention.forEach(a => assert.ok(r.cards[a.id], 'every row has its card'));
});

test('sorted: client date overdue / due today first, then decisions and corrections and passed deadlines, then ordinary work for today', () => {
  const r = asEmp([
    task('#normal', { internalDeadline: TODAY, clientDate: '2026-10-25' }),
    task('#client', { internalDeadline: TODAY, clientDate: TODAY }),                                  // client date TODAY → urgent
    task('#late', { internalDeadline: '2026-10-05', clientDate: '2026-10-22' }),                     // deadline passed
    task('#fix', { status: 'rework', reviewStatus: 'error', clientDate: '2026-10-21' }),            // correction
    task('#over', { internalDeadline: '2026-10-05', clientDate: '2026-10-05' }),                    // client date PASSED → urgent
  ]);
  assert.deepEqual(r.attention.filter(a => a.rank === 0).map(a => a.id).sort(), ['#client', '#over']);
  assert.deepEqual(ids(r).slice(0, 2).sort(), ['#client', '#over'], 'urgent first');
  const rank = Object.fromEntries(r.attention.map(a => [a.id, a.rank]));
  assert.ok(rank['#late'] === 1 && rank['#fix'] === 1 && rank['#normal'] === 2);
  assert.equal(ids(r).at(-1), '#normal', 'ordinary work last');
  assert.equal(r.attentionSummary.urgent, 2);
  // within a rank, the earlier client date comes first
  assert.deepEqual(r.attention.filter(a => a.rank === 1).map(a => a.id), ['#fix', '#late'], 'client 21 Oct before 22 Oct');
});

test('a task appears ONCE, and what is not mine never shows: a reviewer sees reviews, a report sender sees reports, nobody sees colleagues\' work', () => {
  const tasks = [
    task('#r', { status: 'completed', completedAt: '2026-10-06T01:00:00Z', reviewerId: 'me' }),                       // in review with ME
    task('#s', { status: 'completed', completedAt: '2026-10-01T01:00:00Z', reviewStatus: 'clean', sentToClient: null, reportSendOwner: 'me', awaitingClientDecision: true, reviewedBy: 'rev', reviewedAt: '2026-10-06T01:00:00Z' }),   // I must send the report
    task('#mine', { assignedTo: 'me', internalDeadline: TODAY }),                                                    // my own work, due today
    task('#theirs', { assignedTo: 'emp', internalDeadline: TODAY }),                                                // a colleague's work
  ];
  const r = wf.buildToday(tasks, { id: 'me', name: 'Parvinder' }, deps({ isManager: true }));
  assert.deepEqual(ids(r).sort(), ['#mine', '#r', '#s'].sort());
  assert.equal(new Set(ids(r)).size, ids(r).length, 'each task once');
  assert.equal(r.attention.find(a => a.id === '#r').action, 'review'); assert.equal(r.attention.find(a => a.id === '#s').action, 'send_report'); assert.equal(r.attention.find(a => a.id === '#mine').action, 'work');
});

test('an empty day is an empty list, not an error', () => {
  const r = asEmp([task('#later', { internalDeadline: '2026-10-20' }), task('#done', { status: 'completed', reviewStatus: 'done', completedAt: '2026-10-06T01:00:00Z' })]);
  assert.deepEqual(r.attention, []); assert.equal(r.attentionSummary.total, 0); assert.equal(r.attentionSummary.urgent, 0);
});
