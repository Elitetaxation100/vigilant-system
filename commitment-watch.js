// ---------------------------------------------------------------------------
// COMMITMENT WATCH — pure functions over a task (and its workflow card). Nothing here writes anything.
//
//  1. stageTimeline(t)      the five stage timestamps: submitted · reviewed · sent back · ready for report · report sent
//  2. flagsOf(t, card)      late / at-risk flags:  not submitted by the due date · review not done before the commitment date ·
//                           no update one working day before the commitment date
//  3. breachOf(t, card)     a client commitment breach: the commitment date has passed and the report has not been sent
//
// A time that was never recorded is returned as null — it is never guessed. A time worked out from an older record carries `exact: false`.
// ---------------------------------------------------------------------------
const wf = require('./workflow');
const cal = require('./calendar');

const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const maxIso = list => list.filter(Boolean).sort().pop() || null;

const STAGES = [
  ['submitted', 'Submitted for review'],
  ['reviewed', 'Reviewed'],
  ['sent_back', 'Sent back'],
  ['ready_for_report', 'Marked ready for report'],
  ['report_sent', 'Report sent'],
];

function stageTimeline(t, deps) {
  const subs = (t.submissions || []).filter(x => x && x.at && !x.invalid && ['review', 'resubmit', 'direct_profit', 'done'].includes(x.kind));
  const lastSub = subs[subs.length - 1];
  const first = wf.firstSubmission(t, deps);
  const ev = (t.reviewEvents || []).filter(e => e && e.at);
  const decisions = ev.filter(e => e.type === 'approved' || e.type === 'returned');
  const lastDecision = decisions[decisions.length - 1];
  const lastReturn = [...ev].reverse().find(e => e.type === 'returned');
  const out = {};
  out.submitted = lastSub ? { at: lastSub.at, byId: lastSub.byId || null, exact: true, count: subs.length, firstAt: first ? first.at : lastSub.at, note: subs.length > 1 ? 'Handed in ' + subs.length + ' times — this is the latest' : null }
    : (t.completedAt ? { at: t.completedAt, byId: t.assignedTo || null, exact: false, count: 1, firstAt: first ? first.at : t.completedAt, note: 'From the completion time (the hand-in was not recorded separately)' } : { at: null });
  out.reviewed = lastDecision ? { at: lastDecision.at, byId: lastDecision.byId || null, exact: true, outcome: lastDecision.type }
    : (t.reviewedAt ? { at: t.reviewedAt, byId: t.reviewedBy || null, exact: false, outcome: t.reviewStatus === 'error' ? 'returned' : (t.reviewStatus === 'clean' || t.reviewStatus === 'done' ? 'approved' : null) } : { at: null });
  out.sent_back = lastReturn ? { at: lastReturn.at, byId: lastReturn.byId || null, exact: true, count: ev.filter(e => e.type === 'returned').length, note: lastReturn.premature ? 'Marked premature / incomplete' : null } : { at: null };
  // "ready for report": stamped when the work is approved and the report is waiting to go out (after a profit confirmation, from that moment)
  const readyAt = t.readyForReportAt || t.reportReturnedAt || (t.profitConfirmStatus === 'confirmed' ? t.profitConfirmAt : null) || null;
  out.ready_for_report = readyAt ? { at: readyAt, byId: t.reportReturnedBy || t.profitConfirmBy || t.reviewedBy || null, exact: true } : { at: null };
  const notRequired = t.reportDeliveryStatus === 'sending_not_required';
  out.report_sent = t.sentToClient && t.sentToClientAt && !notRequired ? { at: t.sentToClientAt, byId: t.sentToClientBy || null, exact: true }
    : { at: null, note: notRequired ? 'No report needed for this task' : null };
  return STAGES.map(([key, label]) => ({ key, label, ...out[key] }));
}

// The newest recorded sign of life on a task: any hand-in, review step, hold / query / date change, report step, or a running timer.
const SCALAR_UPDATES = ['acceptedAt', 'startedAt', 'timerStartedAt', 'completedAt', 'reviewedAt', 'heldAt', 'holdResolvedAt', 'resumedAt', 'profitConfirmRequestedAt', 'profitConfirmAt',
  'reportReturnedAt', 'readyForReportAt', 'sentToClientAt', 'assignedAt'];
function lastUpdateAt(t) {
  const times = SCALAR_UPDATES.map(k => t[k]);
  ['submissions', 'reviewEvents', 'dateHistory', 'tatHistory', 'reviewerHistory', 'holdHistory'].forEach(k => (t[k] || []).forEach(x => times.push(x && (x.at || x.startedAt || x.resumedAt))));
  (t.reworkHistory || []).forEach(x => times.push(x && x.startedAt));
  (t.queries || []).forEach(q => times.push(q.sentTs, q.sentAt, q.replyTs, q.replyAt, q.resumedAt));
  return maxIso(times.filter(x => typeof x === 'string'));
}

const finished = (t, c) => !t || t.deletedAt || t.status === 'cancelled' || (c && c.status === 'Completed');

// ctx: { today, nzDay, internalDueOf?, addWorkingDays? } — the same deps the workflow cards use.
function flagsOf(t, c, deps) {
  const flags = [];
  if (finished(t, c)) return flags;
  const today = deps.today, nzDay = deps.nzDay;
  const add = (code, tone, label, detail, extra) => flags.push({ code, tone, label, detail, ...(extra || {}) });
  const dueBy = wf.internalDueOf(t, deps);
  const first = wf.firstSubmission(t, deps);
  const preSubmit = ['Assigned', 'In Progress', 'On Hold'].includes(c.status) && !(t.submissions || []).length && !t.completedAt;
  // 1. not submitted by the due date (a hold only protects the date when an approved pause has already moved it — see workflow.commitmentTag)
  if (preSubmit && !first && isDay(dueBy) && dueBy < today && !(c.commitment && c.commitment.key === 'waiting_client')) {
    const days = wf.daysBetween(dueBy, today);
    add('not_submitted', 'late', 'Not submitted by the due date', 'Internal due ' + dueBy + ' — ' + days + (days === 1 ? ' day' : ' days') + ' late', { days, date: dueBy });
  }
  const client = wf.isClientTask(t) && isDay(t.clientDate);
  if (client) {
    const eff = t.clientDate;
    // 2. review not done before the commitment date
    if (c.status === 'In Review' && today >= eff) {
      const late = today > eff;
      add('review_not_done', late ? 'late' : 'at_risk', 'Review not done before the commitment date', late ? 'Commitment date ' + eff + ' has passed and the review is still open' : 'The commitment date is today and the review is still open', { date: eff });
    }
    // 3. no update one working day before the commitment date (and none since)
    const before = cal.addWorkingDays(eff, -1);
    const lastUp = lastUpdateAt(t);
    if (today >= before && !(lastUp && nzDay(lastUp) >= before)) {
      add('no_update', today > eff ? 'late' : 'at_risk', 'No update before the commitment date', 'Nothing recorded since ' + (lastUp ? nzDay(lastUp) : 'it was created') + ' — update it (the commitment date is ' + eff + ')', { date: eff, lastUpdateAt: lastUp || null });
    }
  }
  return flags;
}

// The commitment date has passed and the report has not been sent. Held work is NOT excused by the hold itself (the client date only
// moves for an approved client query — that already shifted t.clientDate); closed / cancelled / no-report-needed work is not a breach.
function breachOf(t, c, deps) {
  if (!t || t.deletedAt || t.status === 'cancelled' || !wf.isClientTask(t) || !isDay(t.clientDate)) return null;
  if (t.sentToClient !== null && t.sentToClient !== undefined) return null;      // the report was sent, or was deliberately decided not to be (workflow.status)
  if (t.reportRequired === false || t.reportDeliveryStatus === 'sending_not_required') return null;
  if (t.clientDate >= deps.today) return null;
  const days = wf.daysBetween(t.clientDate, deps.today);
  const w = c.waitingOn || {};
  return { taskId: t.id, commitmentDate: t.clientDate, daysOver: days, stage: c.status, waitingOn: w.label || null, ownerId: w.ownerId || t.assignedTo || null };
}

module.exports = { STAGES, stageTimeline, lastUpdateAt, flagsOf, breachOf };
