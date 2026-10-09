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
    if (t.profitConfirmStatus === 'pending') return mk('profit', deps.profitOwnerOf ? deps.profitOwnerOf(t) : deps.profitOwnerId, 'Waiting on profit confirmation');
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

// The internal date the employee is held to: the agreed internal date, moved forward by the working days the file waited on the client
// (the same freeze that moves the client date) — time spent waiting for a client reply is never the employee's miss.
function internalDueOf(t, deps) {
  const base = t.internalDeadline || null;
  if (!base) return null;
  const shift = deps && deps.queryShiftDays ? deps.queryShiftDays(t) : 0;
  return shift > 0 && deps.addWorkingDays ? deps.addWorkingDays(base, shift) : base;
}
// When the employee FIRST handed the work in. Newer tasks keep every hand-in (t.submissions); older tasks only kept the latest one, so for
// those the earliest hard evidence is used — the first time a reviewer sent it back proves it had already been submitted by then.
function firstSubmission(t, deps) {
  if (t.firstSubmittedAt) return { at: t.firstSubmittedAt, exact: true };
  if (t.submissions && t.submissions.length) return { at: t.submissions[0].at, exact: true };
  const proofs = [...(t.reviewEvents || []).filter(e => e.type === 'returned').map(e => e.at), ...(t.reworkHistory || []).map(h => h.startedAt)].filter(Boolean).sort();
  if (proofs.length) return { at: proofs[0], exact: false };
  return t.completedAt ? { at: t.completedAt, exact: true } : null;
}
// The employee's OWN commitment (submitting by the internal date). A reviewer's delay — or a reviewer sending the work back — is never an employee breach.
function commitmentTag(t, st, today, deps) {
  const na = { key: 'na', label: 'Not applicable' };
  if (!isClientTask(t) || !t.clientDate) return na;
  const dueByEmployee = internalDueOf(t, deps) || t.clientDate;
  const first = firstSubmission(t, deps), firstOn = first ? deps.nzDay(first.at) : null;
  const metOn = d => ({ key: 'met', label: 'Commitment met', detail: 'Submitted ' + d + ' — due ' + dueByEmployee });
  if (['In Review', 'Approved', 'Completed', 'Correction Required'].includes(st)) {
    if (firstOn && firstOn <= dueByEmployee) return metOn(firstOn);          // handed in on time at the first attempt — stays met through any rework
    if (st === 'Correction Required' && !(first && first.exact)) return { key: 'na', label: 'First submission time not recorded' };
    const submittedOn = firstOn || (t.completedAt ? deps.nzDay(t.completedAt) : null);
    if (!submittedOn) return na;
    return submittedOn <= dueByEmployee ? metOn(submittedOn) : { key: 'breached', label: 'Commitment breached', detail: 'Submitted ' + submittedOn + ' — due ' + dueByEmployee };
  }
  if (st === 'On Hold' && EXEMPT_HOLDS.has(t.holdReasonCode)) return { key: 'waiting_client', label: 'Waiting on client' };
  if (firstOn && firstOn <= dueByEmployee) return metOn(firstOn);
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
    clientId: t.clientId || null, clientName: (t.clientName && String(t.clientName).trim().toLowerCase() !== 'internal') ? t.clientName : null, taskType: t.scope && t.scope !== '—' ? t.scope : null,
    status: st, subState: subState(t, st), waitingOn: w,
    commitment: commitmentTag(t, st, deps.today, deps), clientRisk: risk,
    clientDate: t.clientDate || null, internalDeadline: t.internalDeadline || null, internalDue: internalDueOf(t, deps), daysRemaining: risk.days,
    assigneeId: t.assignedTo || null, assigneeName: t.assignedTo ? deps.nameOf(t.assignedTo) : null,
    reviewerId: t.reviewerId || t.assignedReviewerId || null, reviewerName: (t.reviewerId || t.assignedReviewerId) ? deps.nameOf(t.reviewerId || t.assignedReviewerId) : null,
    reviewRequired: t.reviewRequired === undefined ? null : t.reviewRequired, noReviewAuthorized: !!t.noReviewAuthorizedAt,
    allocatedHours: t.productivityAllocatedHoursSnapshot != null ? t.productivityAllocatedHoursSnapshot : (t.tat != null ? t.tat : null),
    reworkCount: t.reworkCount || 0, priority: t.priority || null,
    escalation: openEscalation(t) ? { toId: t.escalation.toId, toName: deps.nameOf(t.escalation.toId), reason: t.escalation.reason, decisionDate: t.escalation.decisionDate, at: t.escalation.at } : null,
    correction: t.correction ? { category: t.correction.category, responsibility: t.correction.responsibility, dueDate: t.correction.dueDate } : null,
    reviewWaiting: reviewWaiting(t, st, deps.today, deps, deps.nowMs),
    tracker: tracker(t, st), nextAction: nextAction(t, st, w, deps),
    sheetLink: t.sheetLink || null, cashbookLink: t.cashbookLink || null,
    hasSheet: !!(t.sheetLink || (t.sheetFiles || []).length), hasCashbook: !!(t.cashbookLink || (t.cashbookFiles || []).length),
    attachmentCount: (t.reviewAttachments || []).length + (t.sheetFiles || []).length + (t.cashbookFiles || []).length,
    holdStart: t.heldAt || null, holdFollowUp: t.holdFollowUp || null, submittedAt: t.completedAt || null,
    sortAt: latestOf([t.createdAt, t.assignedAt, t.completedAt, t.reviewedAt, t.heldAt, t.escalation && t.escalation.at, t.sentToClientAt]),
  };
}
// The most recent of several ISO timestamps — what "newest first" sorts on (latest activity on the task).
function latestOf(list) { return list.filter(Boolean).sort().pop() || null; }

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
  for (const t of open) if (t.profitConfirmStatus === 'pending' && me.id === (deps.profitOwnerOf ? deps.profitOwnerOf(t) : deps.profitOwnerId)) add(t, 'profit_confirm', 'Profit confirmation needs you', t.profitConfirmRequestedAt);
  for (const t of open) if (cards[t.id].status === 'Approved' && t.awaitingClientDecision && t.reportSendOwner === me.id) add(t, 'send_report', 'Report ready for you to send', t.reviewedAt);
  for (const t of open) if (t.assignedTo === me.id && t.status === 'awaiting_acceptance') add(t, 'accept', cards[t.id].status === 'Correction Required' ? 'Sent back to you — accept it to start the correction' : 'Assigned to you — accept it to start', t.assignedAt);
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
    overdue: ids(t => cards[t.id].waitingOn.kind === 'employee' && ['Assigned', 'In Progress'].includes(cards[t.id].status) && internalDueOf(t, deps) && internalDueOf(t, deps) < deps.today),
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
  const modes = buildModes({ cards, open, tasks, me, deps, needs, doneToday, waiting, finishedIds });
  const modeIds = new Set(['today', 'manager', 'review'].flatMap(k => [...modes[k].tiles.flatMap(x => x.ids), ...modes[k].default.primary.ids, ...modes[k].default.secondary.flatMap(x => x.ids)]));
  modeIds.forEach(id => { if (cards[id]) outCards[id] = cards[id]; });
  return { counts, filters, review, reviewCounts, modes, sections: { needs: needs.map(({ id, type, why }) => ({ id, type, why })), waiting, completed: doneToday }, cards: outCards };
}

// ---------------------------------------------------------------------------------------------------------------------------
// THE THREE DASHBOARD VIEWS. Each view owns its OWN tiles and each tile is nothing but a list of task ids: the number on the
// tile IS ids.length (unique), and the list it opens IS those ids — so a tile and its list can never disagree. Nothing here is
// stored; it is derived from the same cards as everything else. deps adds: reviewSlaHours (default 48), attentionIds (the
// manager exceptions, computed by the caller), and a task lookup via `tasks`.
// ---------------------------------------------------------------------------------------------------------------------------
const RISK_STATES = ['overdue', 'due_today', 'at_risk'];
const DEFAULT_REVIEW_SLA_HOURS = 48;
const uniq = a => [...new Set(a)];
const byNewest = cards => ids => uniq(ids).sort((a, b) => String((cards[b] || {}).sortAt || '').localeCompare(String((cards[a] || {}).sortAt || '')));

function buildModes({ cards, open, tasks, me, deps, needs, doneToday, waiting, finishedIds }) {
  const sla = Number(deps.reviewSlaHours) > 0 ? Number(deps.reviewSlaHours) : DEFAULT_REVIEW_SLA_HOURS;
  const newest = byNewest(cards);
  const tileOf = (key, label, scope, ids, empty, extra) => { const u = newest(ids); return Object.assign({ key, label, scope, count: u.length, ids: u, empty }, extra || {}); };
  const inRisk = id => RISK_STATES.includes(cards[id].clientRisk.state);
  const slaBreached = id => !!(cards[id].reviewWaiting && cards[id].reviewWaiting.hours > sla);
  const needsIds = new Set(needs.map(n => n.id));
  const taskOf = id => tasks.find(t => t.id === id) || {};

  // ---- reviews that are MINE (named reviewer = me)
  const myReviews = open.filter(t => cards[t.id].status === 'In Review' && !cards[t.id].escalation && t.reviewerId === me.id).map(t => t.id);
  const myResubmitted = myReviews.filter(id => cards[id].subState === 'Correction resubmitted');
  const myNew = myReviews.filter(id => cards[id].subState !== 'Correction resubmitted');
  const ownsNext = id => cards[id].waitingOn.ownerId === me.id || needsIds.has(id);
  const myWorkIds = open.filter(t => t.assignedTo === me.id && ['Assigned', 'In Progress', 'On Hold', 'Correction Required'].includes(cards[t.id].status)).map(t => t.id);

  // ================= TODAY — only what I personally must act on
  const todayTiles = [
    tileOf('needs_review', 'Needs My Review', 'Personal', myReviews, 'No reviews are waiting for you.'),
    tileOf('risk_mine', 'Client Delivery at Risk', 'Where I own the next action', open.map(t => t.id).filter(id => inRisk(id) && ownsNext(id)), 'No client deadlines at risk on your side.'),
    tileOf('decisions', 'Waiting for My Decision', 'Personal', needs.filter(n => ['decision', 'escalation', 'profit_confirm', 'unassigned'].includes(n.type)).map(n => n.id), 'Nothing is waiting for your decision.'),
    tileOf('reports_mine', 'Reports I Must Send', 'Personal', open.filter(t => cards[t.id].status === 'Approved' && isClientTask(t) && t.awaitingClientDecision && t.profitConfirmStatus !== 'pending' && (t.reportSendOwner || t.assignedTo) === me.id).map(t => t.id), 'No reports are waiting for you to send.'),
    tileOf('overdue_mine', 'My Overdue Actions', 'Where I own the next action', open.map(t => t.id).filter(id => {
      const c = cards[id], t = taskOf(id);
      if (!ownsNext(id) || ['client', 'external', 'profit'].includes(c.waitingOn.kind)) return false;
      if (c.waitingOn.kind === 'employee' && internalDueOf(t, deps) && internalDueOf(t, deps) < deps.today && c.waitingOn.ownerId === me.id) return true;
      return c.clientRisk.state === 'overdue' || slaBreached(id);
    }), 'You have no overdue actions.'),
    tileOf('actions_done', 'Actions Completed Today', 'Actions, not tasks', doneToday.map(d => d.id), 'No actions completed yet today.'),
    // everything assigned to ME that is not a review: to accept, in progress, on hold, being corrected
    tileOf('my_work', 'My Work', 'Assigned to me', myWorkIds, 'Nothing is assigned to you right now.'),
  ];
  const mkDefault = (primary, secondary) => ({ primary, secondary });
  const sec = (key, title, ids, empty) => ({ key, title, ids: newest(ids), empty: empty || '' });
  const waitSecs = waiting.map(g => sec('wait_' + g.kind, 'Waiting on ' + g.label.toLowerCase(), g.ids));
  const todayDefault = mkDefault(
    sec('needs_now', 'Needs your action now', needs.map(n => n.id), 'Nothing requires your action right now.'),
    [sec('my_work', 'My work — assigned to me', myWorkIds, 'Nothing is assigned to you right now.'), ...waitSecs, sec('done_today', 'Actions completed today', doneToday.map(d => d.id), 'Nothing completed yet today.')]);

  // ================= MANAGER — the team's delivery picture
  const reportsOpen = open.filter(t => cards[t.id].status === 'Approved' && isClientTask(t));
  const rState = t => { const c = cards[t.id]; if (t.profitConfirmStatus === 'pending') return 'profit'; if (!t.clientDate) return 'later'; return c.clientRisk.state === 'overdue' ? 'overdue' : c.clientRisk.state === 'due_today' ? 'today' : 'later'; };
  const reportBreakdown = { overdue: 0, today: 0, later: 0, profit: 0 };
  reportsOpen.forEach(t => { reportBreakdown[rState(t)]++; });
  const managerTiles = [
    tileOf('team_risk', 'Team Delivery at Risk', 'Whole team', open.map(t => t.id).filter(inRisk), 'No client deadlines are currently at risk.'),
    tileOf('team_overdue', 'Team Overdue', 'Employee-owned only', open.filter(t => { const c = cards[t.id]; return c.waitingOn.kind === 'employee' && ['Assigned', 'In Progress'].includes(c.status) && internalDueOf(t, deps) && internalDueOf(t, deps) < deps.today; }).map(t => t.id), 'No team tasks are overdue.'),
    tileOf('reviews_blocking', 'Reviews Blocking Delivery', 'Reviewer owns the next action', open.map(t => t.id).filter(id => cards[id].status === 'In Review' && cards[id].waitingOn.kind === 'reviewer' && (inRisk(id) || slaBreached(id))), 'No reviews are blocking delivery.'),
    tileOf('reports_team', 'Reports Not Sent', 'Whole team', reportsOpen.map(t => t.id), 'All approved reports have been sent.', { breakdown: reportBreakdown }),
    tileOf('waiting_client', 'Waiting on Client', 'Authorised holds', open.map(t => t.id).filter(id => cards[id].waitingOn.kind === 'client'), 'Nothing is waiting on a client.'),
    tileOf('needs_attention', 'Needs Manager Attention', 'Open exceptions', (deps.attentionIds || []).filter(id => cards[id]), 'No exceptions need attention.'),
  ];
  const managerDefault = mkDefault(
    sec('risk', 'Client delivery at risk', managerTiles[0].ids, 'No client deadlines are currently at risk.'),
    waitSecs);

  // ================= REVIEW — my reviewing queue
  const urgentRv = myReviews.filter(id => inRisk(id) || slaBreached(id));
  const returnedByMe = open.filter(t => cards[t.id].status === 'Correction Required' && (t.reviewedBy === me.id || t.reviewerId === me.id)).map(t => t.id);
  const completedReviews = doneToday.filter(d => /approved|Returned|scalated/.test(d.action)).map(d => d.id);
  const reviewTiles = [
    tileOf('urgent', 'Urgent Reviews', 'Personal', urgentRv, 'No urgent reviews.'),
    tileOf('new_sub', 'New Submissions', 'Personal', myNew, 'No new submissions are waiting.'),
    tileOf('resubmitted', 'Corrections Resubmitted', 'Personal', myResubmitted, 'No corrections have come back.'),
    tileOf('waiting_corr', 'Waiting on Employee Correction', 'Returned by me', returnedByMe, 'No corrections are waiting on employees.'),
    tileOf('rv_done', 'Reviews Completed Today', 'Review actions, not tasks', completedReviews, 'No reviews completed yet today.'),
    tileOf('sla', 'Review SLA Breached', 'Waiting over ' + sla + ' h', myReviews.filter(slaBreached), 'No reviews are past the review SLA.'),
  ];
  const shownUnderUrgent = myResubmitted.filter(id => urgentRv.includes(id)).length;
  const reviewDefault = mkDefault(
    sec('urgent', 'Urgent — client deadline at risk or review SLA breached', urgentRv, 'No urgent reviews.'),
    [sec('new', 'New submissions', myNew, 'No new submissions are waiting.'),
     sec('resub', 'Corrections resubmitted', myResubmitted, 'No corrections have come back.'),
     sec('corr', 'Waiting on employee correction', returnedByMe),
     sec('done', 'Reviews completed today', completedReviews)]);
  reviewDefault.note = shownUnderUrgent ? shownUnderUrgent + (shownUnderUrgent === 1 ? ' resubmission is' : ' resubmissions are') + ' displayed under Urgent.' : '';

  return {
    sla,
    today: { tiles: todayTiles, default: todayDefault },
    manager: { tiles: managerTiles, default: managerDefault },
    review: { tiles: reviewTiles, default: reviewDefault },
  };
}

// "Good morning / afternoon / evening" from the BUSINESS clock (hour 0–23 in the company timezone).
function greetingFor(hour) { return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'; }

module.exports = { internalDueOf, firstSubmission, buildModes, DEFAULT_REVIEW_SLA_HOURS, status, subState, waitingOn, clientRisk, commitmentTag, reviewWaiting, tracker, nextAction, card, buildToday, greetingFor, daysBetween, taskKindLabel, isClientTask, needsOrder, EXEMPT_HOLDS };
