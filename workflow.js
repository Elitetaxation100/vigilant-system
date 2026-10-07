// Workflow view — derives the SIMPLE, shared picture of a task for the Today dashboard. Nothing here is stored and nothing here
// writes: it reads a task and says what status it is in, who owns the next action, how the client commitment stands, and how far
// along delivery is. Pure functions, so every rule is easy to test and the same task always reads the same everywhere.
//
// The seven display statuses are a LAYER over the stored statuses (no migration, no data changed):
//   Assigned · In Progress · On Hold · In Review · Correction Required · Approved · Completed
// "Commitment met/breached", "Report sent", "Reviewed clean", "Profit confirmed" are NOT statuses — they stay separate attributes.

const EXEMPT_HOLDS = new Set(['CLIENT_QUERY', 'CLIENT_DOCS']);   // holds that pause the client commitment clock

// Whole days from date-only `a` to date-only `b` ('YYYY-MM-DD'). Done in UTC so a daylight-saving change can never shift it.
function daysBetween(a, b) {
  const t = s => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86400000);
}
const isClientTask = t => !!t && !(t.kind === 'internal' && !t.clientId);
const taskKindLabel = t => (isClientTask(t) ? 'Client Task' : 'Admin Task');   // "Internal" is shown to people as "Admin"

const openEscalation = t => (t && t.escalation && t.escalation.status === 'open') ? t.escalation : null;
function isFlagged(t) { return t.reviewStatus === 'error' && t.status !== 'completed'; }

function status(t) {
  if (t.status === 'on_hold') return 'On Hold';
  if (isFlagged(t)) return 'Correction Required';
  if (t.status === 'completed') {
    if (t.reviewStatus === 'done') return 'Completed';
    if (t.reviewStatus === 'clean') {
      if (!isClientTask(t)) return 'Completed';
      return t.sentToClient === null || t.sentToClient === undefined ? 'Approved' : 'Completed';   // decided (sent or deliberately not sent)
    }
    return 'In Review';
  }
  if (t.status === 'accepted' || t.status === 'rework') return 'In Progress';
  return 'Assigned';
}
// Correction wording: never "Not started" once work has been returned.
function subState(t, st) {
  if (st === 'Correction Required') return t.status === 'rework' || t.status === 'accepted' ? 'Correction in progress' : 'Waiting for your correction';
  if (st === 'In Review' && (t.reworkCount || 0) > 0) return 'Correction resubmitted';
  return null;
}

// Who owns the NEXT action. `deps.nameOf(id)`, `deps.profitOwnerId`.
function waitingOn(t, st, deps) {
  const mk = (kind, ownerId, label) => ({ kind, ownerId: ownerId || null, ownerName: ownerId ? deps.nameOf(ownerId) : null, label });
  if (st === 'Completed') return mk('none', null, 'No action required');
  if (st === 'On Hold') {
    const c = t.holdReasonCode;
    if (c === 'CLIENT_QUERY' || c === 'CLIENT_DOCS') return mk('client', null, 'Waiting on client');
    if (c === 'THIRD_PARTY') return mk('external', null, 'Waiting on external authority');
    if (c === 'INTERNAL_REVIEW') return mk('reviewer', t.reviewerId, 'Waiting on reviewer');
    return mk('manager', null, 'Waiting on manager');
  }
  if (st === 'Correction Required') return mk('employee', t.assignedTo, 'Waiting on employee');
  const esc = openEscalation(t);
  if (st === 'In Review' && esc) {            // escalated: the reviewer stays the reviewer, but the NEXT action is the decision-maker's
    const founder = deps.roleOf && deps.roleOf(esc.toId) === 'founder';
    return mk(founder ? 'founder' : 'manager', esc.toId, founder ? 'Waiting on founder' : 'Waiting on manager');
  }
  if (st === 'In Review') return mk('reviewer', t.reviewerId, 'Waiting on reviewer');
  if (st === 'Approved') {
    if (t.profitConfirmStatus === 'pending') return mk('profit', deps.profitOwnerId, 'Waiting on profit confirmation');
    return mk('ready_to_send', t.reportSendOwner || t.assignedTo, 'Ready to send');
  }
  if (!t.assignedTo) return mk('manager', null, 'Waiting on manager');
  if (t.status === 'pending_approval' || t.status === 'window_proposed') return mk('manager', null, 'Waiting on manager');
  return mk('employee', t.assignedTo, 'Waiting on employee');
}

// How the CLIENT commitment stands today — separate from who is at fault. Never mixes in review waiting time.
function clientRisk(t, st, today) {
  if (!isClientTask(t) || !t.clientDate) return { state: 'na', days: null, label: 'Not applicable' };
  if (st === 'Completed') return { state: 'done', days: null, label: 'Done' };
  if (st === 'On Hold' && EXEMPT_HOLDS.has(t.holdReasonCode)) return { state: 'waiting_client', days: daysBetween(today, t.clientDate), label: 'Waiting on client' };
  const d = daysBetween(today, t.clientDate);
  if (d < 0) return { state: 'overdue', days: d, label: 'Client deadline: overdue by ' + (-d) + (d === -1 ? ' day' : ' days') };
  if (d === 0) return { state: 'due_today', days: 0, label: 'Client deadline: due today' };
  if (d <= 2) return { state: 'at_risk', days: d, label: 'Client deadline: ' + d + (d === 1 ? ' day' : ' days') + ' remaining' };
  return { state: 'ok', days: d, label: 'Client deadline: ' + d + ' days remaining' };
}

// The employee's OWN commitment (submitting by the internal date). A reviewer's delay is never an employee breach.
function commitmentTag(t, st, today, deps) {
  const na = { key: 'na', label: 'Not applicable' };
  if (!isClientTask(t) || !t.clientDate) return na;
  const submittedOn = t.completedAt ? deps.nzDay(t.completedAt) : null;
  const dueByEmployee = t.internalDeadline || t.clientDate;
  if (['In Review', 'Approved', 'Completed'].includes(st)) {
    if (!submittedOn) return na;
    return submittedOn <= dueByEmployee ? { key: 'met', label: 'Commitment met' } : { key: 'breached', label: 'Commitment breached' };
  }
  if (st === 'On Hold' && EXEMPT_HOLDS.has(t.holdReasonCode)) return { key: 'waiting_client', label: 'Waiting on client' };
  if (dueByEmployee < today) return { key: 'breached', label: 'Commitment breached' };
  if (dueByEmployee === today) return { key: 'due_today', label: 'Due today' };
  if (daysBetween(today, t.clientDate) <= 2) return { key: 'at_risk', label: 'At risk' };
  return { key: 'on_track', label: 'On track' };
}

// Waiting for REVIEW — measured from the latest submission, never called "overdue".
function reviewWaiting(t, st, today, deps, nowMs) {
  if (st !== 'In Review' || !t.completedAt) return null;
  const since = t.completedAt;
  return { since, days: Math.max(0, daysBetween(deps.nzDay(since), today)), hours: Math.max(0, Math.round((nowMs - new Date(since).getTime()) / 36e5 * 10) / 10) };
}

// Processing → In Review → (Correction Required) → (Profit confirmation) → Ready → Sent. A visual tracker only.
function tracker(t, st) {
  if (!isClientTask(t)) return { applicable: false, steps: [] };
  const sent = t.sentToClient === true;
  const flagged = st === 'Correction Required';
  const processingDone = ['In Review', 'Approved', 'Completed'].includes(st);
  const reviewDone = ['Approved', 'Completed'].includes(st);
  const steps = [
    { key: 'processing', label: 'Processing', state: processingDone ? 'done' : 'current' },
    { key: 'review', label: 'In Review', state: flagged ? 'done' : reviewDone ? 'done' : st === 'In Review' ? 'current' : 'todo' },
  ];
  if (flagged) steps.push({ key: 'correction', label: 'Correction Required', state: 'attention' });
  if (t.profitConfirmStatus) steps.push({ key: 'profit', label: 'Profit confirmation', state: t.profitConfirmStatus === 'confirmed' ? 'done' : 'current' });
  steps.push({ key: 'ready', label: 'Ready', state: sent || (reviewDone && t.profitConfirmStatus !== 'pending') ? (sent ? 'done' : 'current') : 'todo' });
  steps.push({ key: 'sent', label: 'Sent', state: sent ? 'done' : 'todo' });
  if (flagged) { steps[0].state = 'done'; steps[1].state = 'done'; }
  return { applicable: true, steps };
}

function nextAction(t, st, w, deps) {
  const who = w.ownerName || '';
  switch (st) {
    case 'Completed': return 'Nothing — finished';
    case 'In Review': { const e = openEscalation(t); return e ? (who || 'The manager') + ' to decide' + (e.decisionDate ? ' by ' + e.decisionDate : '') : (who || 'The reviewer') + ' to review'; }
    case 'Correction Required': return (who || 'The employee') + ' to correct and resubmit';
    case 'Approved': return w.kind === 'profit' ? (who || 'Shubam') + ' to confirm profit' : (who || 'The report sender') + ' to send the report';
    case 'On Hold': return w.label + (t.holdFollowUp ? ' — follow up ' + t.holdFollowUp : '');
    default:
      if (!t.assignedTo) return 'Assign an owner';
      if (t.status === 'pending_approval') return 'Approve the assignment';
      if (t.status === 'window_proposed') return 'Decide the proposed date';
      if (t.status === 'awaiting_acceptance') return (who || 'The employee') + ' to accept';
      return (who || 'The employee') + ' to submit' + (t.internalDeadline ? ' by ' + t.internalDeadline : '');
  }
}

// One task, fully derived. deps: { today, nowMs, nzDay, nameOf, profitOwnerId }
function card(t, deps) {
  const st = status(t);
  const w = waitingOn(t, st, deps);
  const risk = clientRisk(t, st, deps.today);
  return {
    id: t.id, name: t.name, kind: t.kind, kindLabel: taskKindLabel(t),
    clientId: t.clientId || null, clientName: t.clientName || null, taskType: t.scope && t.scope !== '—' ? t.scope : null,
    status: st, subState: subState(t, st), waitingOn: w,
    commitment: commitmentTag(t, st, deps.today, deps), clientRisk: risk,
    clientDate: t.clientDate || null, internalDeadline: t.internalDeadline || null, daysRemaining: risk.days,
    assigneeId: t.assignedTo || null, assigneeName: t.assignedTo ? deps.nameOf(t.assignedTo) : null,
    reviewerId: t.reviewerId || t.assignedReviewerId || null, reviewerName: (t.reviewerId || t.assignedReviewerId) ? deps.nameOf(t.reviewerId || t.assignedReviewerId) : null,
    reviewRequired: t.reviewRequired === undefined ? null : t.reviewRequired, noReviewAuthorized: !!t.noReviewAuthorizedAt,
    allocatedHours: t.productivityAllocatedHoursSnapshot != null ? t.productivityAllocatedHoursSnapshot : (t.tat != null ? t.tat : null),
    reworkCount: t.reworkCount || 0, priority: t.priority || null,
    escalation: openEscalation(t) ? { toId: t.escalation.toId, toName: deps.nameOf(t.escalation.toId), reason: t.escalation.reason, decisionDate: t.escalation.decisionDate, at: t.escalation.at } : null,
    correction: t.correction ? { category: t.correction.category, responsibility: t.correction.responsibility, dueDate: t.correction.dueDate } : null,
    reviewWaiting: reviewWaiting(t, st, deps.today, deps, deps.nowMs),
    tracker: tracker(t, st), nextAction: nextAction(t, st, w, deps),
    hasSheet: !!(t.sheetLink || (t.sheetFiles || []).length), hasCashbook: !!(t.cashbookLink || (t.cashbookFiles || []).length),
    attachmentCount: (t.reviewAttachments || []).length + (t.sheetFiles || []).length + (t.cashbookFiles || []).length,
  };
}

const RISK_RANK = { overdue: 0, due_today: 1, at_risk: 2 };
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, normal: 2, low: 3 };
// Order for "Needs your action now": client deadline overdue, today, tomorrow, oldest waiting, then business priority.
function needsOrder(a, b) {
  const ra = a.card.clientRisk.state === 'at_risk' && a.card.daysRemaining === 1 ? 2 : (RISK_RANK[a.card.clientRisk.state] != null && a.card.clientRisk.state !== 'at_risk' ? RISK_RANK[a.card.clientRisk.state] : 9);
  const rb = b.card.clientRisk.state === 'at_risk' && b.card.daysRemaining === 1 ? 2 : (RISK_RANK[b.card.clientRisk.state] != null && b.card.clientRisk.state !== 'at_risk' ? RISK_RANK[b.card.clientRisk.state] : 9);
  if (ra !== rb) return ra - rb;
  if (a.since !== b.since) return String(a.since || '9999').localeCompare(String(b.since || '9999'));
  const pa = PRIORITY_RANK[String(a.card.priority || '').toLowerCase()], pb = PRIORITY_RANK[String(b.card.priority || '').toLowerCase()];
  return (pa == null ? 2 : pa) - (pb == null ? 2 : pb);
}

// The Today payload for `me`. `tasks` is ALREADY the set `me` may see, restricted to their scope by the caller.
// deps: { today, nowMs, nzDay, nameOf, profitOwnerId, canApprove(t), isManager }
function buildToday(tasks, me, deps) {
  const cards = {}, byId = {};
  const open = [], doneToday = [];
  for (const t of tasks) {
    const c = card(t, deps);
    cards[t.id] = c; byId[t.id] = t;
    if (c.status !== 'Completed') open.push(t);
  }
  // ---- A. Needs you now — ONE entry per task, first matching reason wins
  const needs = [];
  const taken = new Set();
  const add = (t, type, why, since) => { if (taken.has(t.id)) return; taken.add(t.id); needs.push({ id: t.id, type, why, since: since || null, card: cards[t.id] }); };
  for (const t of open) {
    const c = cards[t.id];
    if (c.status === 'In Review' && !c.escalation && (t.reviewerId === me.id || (!t.reviewerId && deps.isManager && t.assignedTo !== me.id))) {
      add(t, c.subState === 'Correction resubmitted' ? 'correction_resubmitted' : 'review', c.subState === 'Correction resubmitted' ? 'Correction resubmitted — needs your review' : 'Waiting for your review', t.completedAt);
    }
  }
  for (const t of open) if (cards[t.id].escalation && cards[t.id].escalation.toId === me.id) add(t, 'escalation', 'A decision is requested from you', t.escalation.at);
  for (const t of open) if (t.profitConfirmStatus === 'pending' && me.id === deps.profitOwnerId) add(t, 'profit_confirm', 'Profit confirmation needs you', t.profitConfirmRequestedAt);
  for (const t of open) if (cards[t.id].status === 'Approved' && t.awaitingClientDecision && t.reportSendOwner === me.id) add(t, 'send_report', 'Report ready for you to send', t.reviewedAt);
  for (const t of open) if ((t.status === 'window_proposed' || t.status === 'pending_approval') && deps.canApprove(t)) add(t, 'decision', t.status === 'window_proposed' ? 'A new date needs your decision' : 'An assignment needs your approval', t.assignedAt);
  for (const t of open) {
    const c = cards[t.id];
    if (!t.assignedTo && ['overdue', 'due_today', 'at_risk'].includes(c.clientRisk.state)) add(t, 'unassigned', 'Urgent and nobody owns it', t.createdAt || t.assignedAt);
  }
  needs.sort(needsOrder);
  // ---- C. Completed today — what I did today
  for (const t of tasks) {
    if (t.reviewedBy === me.id && t.reviewedAt && deps.nzDay(t.reviewedAt) === deps.today) doneToday.push({ id: t.id, action: t.reviewStatus === 'error' ? 'Returned for correction' : 'Review approved', at: t.reviewedAt });
    if (t.escalation && t.escalation.status === 'open' && t.escalation.byId === me.id && t.escalation.at && deps.nzDay(t.escalation.at) === deps.today) doneToday.push({ id: t.id, action: 'Escalated to ' + (deps.nameOf(t.escalation.toId) || 'someone'), at: t.escalation.at });
    if (t.sentToClient === true && t.sentToClientBy === me.id && t.sentToClientAt && deps.nzDay(t.sentToClientAt) === deps.today) doneToday.push({ id: t.id, action: 'Report sent', at: t.sentToClientAt });
    if (t.assignedBy === me.id && t.assignedAt && t.assignedTo !== me.id && deps.nzDay(t.assignedAt) === deps.today) doneToday.push({ id: t.id, action: 'Assigned to ' + (deps.nameOf(t.assignedTo) || 'someone'), at: t.assignedAt });
    (t.reassignHistory || []).forEach(h => { if (h.by === me.id && h.at && deps.nzDay(h.at) === deps.today) doneToday.push({ id: t.id, action: 'Reassigned to ' + (deps.nameOf(h.to) || 'someone'), at: h.at }); });
  }
  doneToday.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const finishedIds = new Set(doneToday.map(d => d.id)); // an action I completed today MOVES to Completed — it is not also "waiting"
  // ---- B. Waiting on others — the next action belongs to someone else (never my overdue)
  const waitingGroups = {};
  for (const t of open) {
    if (taken.has(t.id) || finishedIds.has(t.id)) continue;
    const c = cards[t.id], w = c.waitingOn;
    if (w.kind === 'none') continue;
    if (w.ownerId && w.ownerId === me.id) continue;           // mine → it would be in A
    (waitingGroups[w.kind] = waitingGroups[w.kind] || []).push(t.id);
  }
  const KIND_LABEL = { founder: 'Founder', employee: 'Employee', client: 'Client', reviewer: 'Another reviewer', profit: 'Profit confirmer', manager: 'Another manager', external: 'External authority', ready_to_send: 'Report sender' };
  const waiting = Object.keys(KIND_LABEL).filter(k => waitingGroups[k]).map(k => ({ kind: k, label: KIND_LABEL[k], ids: waitingGroups[k] }));
  // ---- the six counts, each with the exact records behind it
  const ids = f => open.filter(f).map(t => t.id);
  const isReviewNeed = n => n.type === 'review' || n.type === 'correction_resubmitted';
  const filters = {
    review: needs.filter(isReviewNeed).map(n => n.id),
    risk: ids(t => ['overdue', 'due_today', 'at_risk'].includes(cards[t.id].clientRisk.state)),
    decision: needs.filter(n => ['decision', 'escalation', 'profit_confirm', 'unassigned'].includes(n.type)).map(n => n.id),
    reports: ids(t => cards[t.id].status === 'Approved' && isClientTask(t)),
    overdue: ids(t => cards[t.id].waitingOn.kind === 'employee' && ['Assigned', 'In Progress'].includes(cards[t.id].status) && t.internalDeadline && t.internalDeadline < deps.today),
    completed: [...new Set(doneToday.map(d => d.id))],
  };
  const rvNeeds = needs.filter(isReviewNeed);
  const urgentRisk = id => ['overdue', 'due_today', 'at_risk'].includes(cards[id].clientRisk.state);
  const urgent = rvNeeds.filter(n => urgentRisk(n.id)).map(n => n.id);
  const resubmitted = rvNeeds.filter(n => n.type === 'correction_resubmitted' && !urgent.includes(n.id)).map(n => n.id);
  const fresh = rvNeeds.filter(n => !urgent.includes(n.id) && !resubmitted.includes(n.id)).map(n => n.id);
  const waitingEmployee = open.filter(t => cards[t.id].status === 'Correction Required' && !finishedIds.has(t.id) && (t.reviewedBy === me.id || t.reviewerId === me.id)).map(t => t.id);   // one I returned TODAY is under Completed, not here
  const completedReviews = [...new Set(doneToday.filter(d => /approved|Returned|scalated/.test(d.action)).map(d => d.id))];
  const review = { urgent, resubmitted, fresh, waitingEmployee, completed: completedReviews };
  const reviewCounts = { urgent: urgent.length, newSubmissions: fresh.length, resubmitted: resubmitted.length, waitingEmployee: waitingEmployee.length, completedToday: completedReviews.length };
  const counts = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, v.length]));
  // only ship the cards the page will actually show
  const used = new Set([...Object.values(review).flat(), ...needs.map(n => n.id), ...waiting.flatMap(g => g.ids), ...doneToday.map(d => d.id), ...Object.values(filters).flat()]);
  const outCards = Object.fromEntries([...used].map(id => [id, cards[id]]));
  return { counts, filters, review, reviewCounts, sections: { needs: needs.map(({ id, type, why }) => ({ id, type, why })), waiting, completed: doneToday }, cards: outCards };
}

// "Good morning / afternoon / evening" from the BUSINESS clock (hour 0–23 in the company timezone).
function greetingFor(hour) { return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'; }

module.exports = { status, subState, waitingOn, clientRisk, commitmentTag, reviewWaiting, tracker, nextAction, card, buildToday, greetingFor, daysBetween, taskKindLabel, isClientTask, needsOrder, EXEMPT_HOLDS };
