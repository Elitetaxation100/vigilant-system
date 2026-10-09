// Manager views — the pure rules behind My Team, "Needs Manager Attention", the paginated Tasks list, the Calendar and the
// Timeline. Everything is DERIVED from tasks and workflow.js cards: nothing here writes, and each rule is easy to test.
const wf = require('./workflow');
const autoMarks = require('./auto-marks');

const PAGE_SIZES = [25, 50, 100];
const HOLD_BLOCKED_DAYS = 5;        // a hold longer than this needs a manager's attention
const PROFIT_OVERDUE_DAYS = 2;      // profit confirmation waiting longer than this is overdue
const REPORT_UNSENT_DAYS = 1;       // an approved report still unsent this many days after approval
const DATE_CHANGE_WINDOW_DAYS = 7;  // "commitment date changed" is flagged for this long

const clientLinkDomains = ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'xero.com', 'go.xero.com', 'myob.com', 'login.myob.com', 'qbo.intuit.com', 'quickbooks.intuit.com', 'reckon.com'];
function hostOf(url) { try { return new URL(String(url)).hostname.toLowerCase(); } catch (e) { return null; } }
function domainAllowed(url, allowed) { const h = hostOf(url); return !!h && (allowed || clientLinkDomains).some(d => h === d || h.endsWith('.' + d)); }

// The same task as the card, plus the extra attributes the manager views filter and sort on.
function enrich(card, t, deps) {
  const info = deps.reportInfo ? deps.reportInfo(t) : null;
  const reportSent = card.kind === 'internal' && !t.clientId ? 'na'
    : info ? (info.eligible ? info.outcome : 'na')
    : (card.status === 'Approved' ? 'not_sent' : card.status === 'Completed' ? (t.sentToClient === false ? 'na' : 'not_sent') : 'pending');
  const reviewState = card.status === 'Correction Required' ? 'correction'
    : card.status === 'In Review' ? 'awaiting' : card.status === 'Approved' ? 'approved'
    : card.status === 'Completed' ? (t.reviewStatus === 'done' ? 'closed_no_review' : 'approved') : 'not_submitted';
  const dh = t.dateHistory || [];
  const firstFrom = dh.length ? (dh[0].from || {}) : {};
  const lastChange = dh.length ? dh[dh.length - 1] : null;
  return {
    ...card, reportSent, reviewState,
    holdFollowUp: t.holdFollowUp || null, holdResponsibility: t.holdResponsibility || null, heldAt: t.heldAt || null,
    originalInternal: t.originalInternalDeadline || firstFrom.internal || t.internalDeadline || null,
    originalClient: t.originalClientDate || firstFrom.client || t.clientDate || null,
    dateChanged: dh.length > 0, lastDateChange: lastChange ? { at: lastChange.at, by: lastChange.by, note: lastChange.note || null, from: lastChange.from, to: lastChange.to } : null,
    createdAt: t.assignedAt || t.createdAt || null,
  };
}

// ---------------------------------------------------------------- filters + pagination
function applyFilters(rows, f) {
  f = f || {};
  const today = f.today;
  const q = String(f.q || '').trim().toLowerCase();
  const idSet = f.ids ? new Set(String(f.ids).split('|').filter(Boolean)) : null;   // exact records behind a count ("|" — task ids contain commas? no, but never "|")
  return rows.filter(r => {
    if (idSet && !idSet.has(r.id)) return false;
    if (f.employee && r.assigneeId !== f.employee) return false;
    if (f.client && r.clientId !== f.client && String(r.clientName || '').toLowerCase() !== String(f.client).toLowerCase()) return false;
    if (f.type) { if (f.type === 'client' ? r.kindLabel !== 'Client Task' : f.type === 'admin' ? r.kindLabel !== 'Admin Task' : r.taskType !== f.type) return false; }
    if (f.status && r.status !== f.status) return false;
    if (f.primary && r.primaryStatus !== f.primary) return false;
    if (f.dateFrom || f.dateTo) {                       // a date range on the chosen date: client commitment, internal due (default), or when it was created
      const d = f.dateBy === 'client' ? r.clientDate : f.dateBy === 'created' ? String((f.nzDay ? f.nzDay(r.createdAt) : String(r.createdAt || '').slice(0, 10)) || '') : r.internalDeadline;
      if (!d) return false;
      if (f.dateFrom && d < String(f.dateFrom).slice(0, 10)) return false;
      if (f.dateTo && d > String(f.dateTo).slice(0, 10)) return false;
    }
    if (f.risk && (r.clientRisk || {}).state !== f.risk) return false;
    if (f.waitingOn && r.waitingOn.kind !== f.waitingOn) return false;
    if (f.reviewer && r.reviewerId !== f.reviewer) return false;
    if (f.reviewState && r.reviewState !== f.reviewState) return false;
    if (f.commitment && r.commitment.key !== f.commitment) return false;
    if (f.reportSent && r.reportSent !== f.reportSent) return false;
    if (f.rework) { const n = r.reworkCount || 0; if (f.rework === '2+' ? n < 2 : n !== Number(f.rework)) return false; }
    if (f.due && today) {
      const d = r.internalDeadline;
      if (f.due === 'none') { if (d) return false; }
      else if (!d) return false;
      else if (f.due === 'overdue') { if (!(d < today) || r.status === 'Completed') return false; }
      else if (f.due === 'today') { if (d !== today) return false; }
      else if (f.due === 'week') { if (!(d >= today && wf.daysBetween(today, d) <= 7)) return false; }
    }
    if (q && !(String(r.name).toLowerCase().includes(q) || String(r.clientName || '').toLowerCase().includes(q) || String(r.id).toLowerCase().includes(q) || String(r.assigneeName || '').toLowerCase().includes(q))) return false;
    return true;
  });
}
const RISK_ORDER = { overdue: 0, due_today: 1, at_risk: 2, waiting_client: 3, ok: 4, na: 5, done: 6 };
function sortRows(rows, sort) {
  const by = {
    // newest first: the latest-assigned task on top; task numbers rise with every new task, so they break ties
    newest: (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id)),
    risk: (a, b) => (RISK_ORDER[a.clientRisk.state] - RISK_ORDER[b.clientRisk.state]) || String(a.internalDeadline || '9999').localeCompare(String(b.internalDeadline || '9999')) || String(a.id).localeCompare(String(b.id)),
    internal: (a, b) => String(a.internalDeadline || '9999').localeCompare(String(b.internalDeadline || '9999')) || String(a.id).localeCompare(String(b.id)),
    client: (a, b) => String(a.clientDate || '9999').localeCompare(String(b.clientDate || '9999')) || String(a.id).localeCompare(String(b.id)),
    employee: (a, b) => String(a.assigneeName || '~').localeCompare(String(b.assigneeName || '~')) || String(a.id).localeCompare(String(b.id)),
    hours: (a, b) => (Number(b.allocatedHours) || 0) - (Number(a.allocatedHours) || 0) || String(a.id).localeCompare(String(b.id)),
  };
  return rows.slice().sort(by[sort] || by.newest);
}
function paginate(rows, page, size) {
  const pageSize = PAGE_SIZES.includes(Number(size)) ? Number(size) : PAGE_SIZES[0];
  const total = rows.length, pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
  return { rows: rows.slice((p - 1) * pageSize, p * pageSize), total, page: p, pageSize, pages };
}

// ---------------------------------------------------------------- My Team
// deps: { today, workloadOf(empId) → { freeCapacityNext5wd } }
function teamSummary(rows, people, deps) {
  return people.map(p => {
    const mine = rows.filter(r => r.assigneeId === p.id && r.status !== 'Completed');
    const employeeOwned = mine.filter(r => r.waitingOn.kind === 'employee');
    const overdue = employeeOwned.filter(r => ['Assigned', 'In Progress'].includes(r.status) && (r.internalDue || r.internalDeadline) && (r.internalDue || r.internalDeadline) < deps.today);
    const oldest = mine.filter(r => r.createdAt).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    const w = deps.workloadOf ? (deps.workloadOf(p.id) || {}) : {};
    return {
      id: p.id, name: p.name,
      openActionable: employeeOwned.length,
      overdueByEmployee: overdue.length,
      waitingOnClient: mine.filter(r => r.waitingOn.kind === 'client').length,
      waitingOnReviewer: mine.filter(r => ['reviewer', 'manager', 'founder'].includes(r.waitingOn.kind) && r.status === 'In Review').length,
      corrections: mine.filter(r => r.status === 'Correction Required').length,
      allocatedOpenHours: Math.round(mine.reduce((s, r) => s + (Number(r.allocatedHours) || 0), 0) * 100) / 100,
      availableCapacityHours: w.freeCapacityNext5wd != null ? w.freeCapacityNext5wd : null,
      oldest: oldest ? { id: oldest.id, name: oldest.name, ageDays: Math.max(0, wf.daysBetween(String(oldest.createdAt).slice(0, 10), deps.today)) } : null,
      ids: { open: employeeOwned.map(r => r.id), overdue: overdue.map(r => r.id), client: mine.filter(r => r.waitingOn.kind === 'client').map(r => r.id), reviewer: mine.filter(r => ['reviewer', 'manager', 'founder'].includes(r.waitingOn.kind) && r.status === 'In Review').map(r => r.id), corrections: mine.filter(r => r.status === 'Correction Required').map(r => r.id) },
    };
  });
}

// ---------------------------------------------------------------- Needs Manager Attention
// rows: enriched cards; tasks: id → task. Only things that need a manager — never healthy or finished work.
function exceptions(rows, tasks, deps) {
  const out = [], today = deps.today, nowMs = deps.nowMs;
  const add = (r, type, label, detail) => out.push({ id: r.id, type, label, detail: detail || null, name: r.name, clientName: r.clientName, assigneeName: r.assigneeName });
  const dayDiff = iso => iso ? wf.daysBetween(String(iso).slice(0, 10), today) : 0;
  for (const r of rows) {
    if (r.status === 'Completed') continue;
    const t = tasks[r.id]; if (!t) continue;
    const open = true, isClient = r.kindLabel === 'Client Task';
    if (!r.assigneeId) add(r, 'unassigned', 'Unassigned task');
    if (t.kind !== 'internal' && !t.clientId) add(r, 'no_client', 'Client work with no client');
    if (!r.internalDeadline) add(r, 'no_due_date', 'No internal due date');
    if (!(Number(r.allocatedHours) > 0)) add(r, 'zero_hours', 'No allocated hours');
    if ((r.reworkCount || 0) >= 2) add(r, 'repeated_return', 'Returned ' + r.reworkCount + ' times', 'Rework cycle ' + r.reworkCount);
    if (r.status === 'On Hold' && r.holdFollowUp && r.holdFollowUp <= today) add(r, 'followup_due', 'Hold follow-up is due', 'Follow up ' + (r.holdFollowUp === today ? 'today' : 'was due ' + r.holdFollowUp) + (r.holdResponsibility ? ' · ' + r.holdResponsibility.replace('_', ' ') : ''));
    if (r.status === 'On Hold' && r.heldAt && dayDiff(r.heldAt) > HOLD_BLOCKED_DAYS) add(r, 'blocked_long', 'On hold for ' + dayDiff(r.heldAt) + ' days', r.waitingOn.label);
    // A recorded query is waiting for a manager to approve (or refuse) pausing the processor's responsibility.
    if (r.status === 'On Hold' && r.hold && r.hold.pauseRequested) add(r, 'pause_pending', 'Pause of responsibility awaiting your approval', (r.assigneeName || 'The processor') + ' — ' + (r.hold.categoryLabel || 'on hold'));
    // On hold for the client / an authority but no query evidence was ever recorded: nothing is paused — flagged for review.
    if (r.status === 'On Hold' && r.hold && /^(CLIENT_|EXTERNAL_|THIRD_PARTY)/.test(r.hold.category || '') && !r.hold.queryRecorded) add(r, 'hold_no_evidence', 'On hold for the client with no query evidence recorded', 'Nothing is paused · ' + (r.hold.categoryLabel || ''));
    if (r.status === 'Approved' && isClient && r.reportSent === 'not_sent' && t.reviewedAt && dayDiff(t.reviewedAt) >= REPORT_UNSENT_DAYS) add(r, 'report_unsent', 'Client report not sent', 'Approved ' + dayDiff(t.reviewedAt) + ' day(s) ago');
    if (t.profitConfirmStatus === 'pending' && t.profitConfirmRequestedAt && dayDiff(t.profitConfirmRequestedAt) > PROFIT_OVERDUE_DAYS) add(r, 'profit_overdue', 'Profit confirmation overdue', 'Waiting ' + dayDiff(t.profitConfirmRequestedAt) + ' days');
    if ((t.noReviewAttempts || []).length && ['Assigned', 'In Progress', 'On Hold'].includes(r.status)) add(r, 'no_review_attempt', 'No-review override attempted', (t.noReviewAttempts.length) + ' attempt(s)');
    if (isClient && ['In Review', 'Approved', 'Correction Required'].includes(r.status) && autoMarks.missingLinks(t).length) add(r, 'missing_links', 'Missing ' + autoMarks.missingLinks(t).join(' and '));
    // A date change is an exception only while it is recent AND nobody gave a reason — a documented change is history, not a problem.
    if (r.lastDateChange && !String(r.lastDateChange.note || '').trim() && dayDiff(r.lastDateChange.at) <= DATE_CHANGE_WINDOW_DAYS) add(r, 'date_changed', 'Commitment date changed without a reason', 'by ' + (r.lastDateChange.by || '—'));
    // Review is required, nobody has been named, and the task was created with "Assign reviewer later".
    if (t.reviewerLater && !t.assignedReviewerId && !t.reviewerId && t.reviewRequired !== false) add(r, 'missing_reviewer', 'No reviewer assigned', 'Left for later: ' + String(t.reviewerLater.reason || '').slice(0, 80));
    // Classification that contradicts itself: an Admin Task that carries a client or client links, or client work whose client is "Internal".
    const nm = String(t.clientName || '').trim().toLowerCase();
    if ((t.kind === 'internal' && (t.clientId || t.cashbookLink)) || (t.kind !== 'internal' && nm === 'internal')) add(r, 'bad_classification', t.kind === 'internal' ? 'Admin Task that looks like client work' : 'Client Task whose client is "Internal"');
    const badLink = [t.sheetLink, t.cashbookLink].filter(Boolean).find(u => !hostOf(u) || (deps.enforceDomains && !domainAllowed(u, deps.allowedDomains)));
    if (badLink) add(r, 'bad_link', 'Link is invalid or not on an approved site');
  }
  return out;
}

// ---------------------------------------------------------------- Calendar + Timeline
const TONE_LABEL = { red: 'Overdue', amber: 'At risk', blue: 'In progress', purple: 'In review', green: 'Approved / completed', grey: 'Waiting on an external dependency' };
function toneFor(r, date, today) {
  if (['Approved', 'Completed'].includes(r.status)) return 'green';
  if (r.waitingOn.kind === 'client' || r.waitingOn.kind === 'external') return 'grey';
  if (date && date < today) return 'red';
  if (r.status === 'In Review') return 'purple';
  if (['due_today', 'at_risk'].includes(r.clientRisk.state)) return 'amber';
  return 'blue';
}
function calendarEvents(rows, deps) {
  const out = [], today = deps.today;
  const push = (r, date, kind, label) => { if (!date) return; out.push({ id: r.id, date, kind, label, name: r.name, clientName: r.clientName, assigneeId: r.assigneeId, assigneeName: r.assigneeName, status: r.status, tone: toneFor(r, date, today), clientDate: r.clientDate, internalDeadline: r.internalDeadline, sheetLink: r.sheetLink || null, cashbookLink: r.cashbookLink || null, hasSheet: !!r.hasSheet, hasCashbook: !!r.hasCashbook }); };
  for (const r of rows) {
    push(r, r.internalDeadline, 'internal', 'Internal due');
    push(r, r.clientDate, 'client', 'Client commitment');
    if (r.status === 'Correction Required' && r.correction && r.correction.dueDate) push(r, r.correction.dueDate, 'correction', 'Correction due');
    if (r.status === 'On Hold' && r.holdFollowUp) push(r, r.holdFollowUp, 'followup', 'Follow-up');
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
}
function timelineRows(rows, tasks, deps) {
  return rows.map(r => {
    const t = tasks[r.id] || {};
    const start = String(t.assignedAt || t.createdAt || r.internalDeadline || deps.today).slice(0, 10);
    const end = [r.internalDeadline, r.clientDate].filter(Boolean).sort().pop() || start;
    // the delayed stretch: from the earliest passed date to today, for work that is overdue and still open
    const passed = [r.internalDeadline, r.clientDate].filter(d => d && d < deps.today).sort()[0] || null;
    return { id: r.id, name: r.name, clientName: r.clientName, assigneeName: r.assigneeName, reviewerName: r.reviewerName || null, status: r.status, kindLabel: r.kindLabel, risk: (r.clientRisk || {}).state || null,
      start: start > end ? end : start, internalDeadline: r.internalDeadline, clientDate: r.clientDate, end, delayedFrom: passed, tone: toneFor(r, r.internalDeadline, deps.today) };
  }).sort((a, b) => a.start.localeCompare(b.start) || String(a.id).localeCompare(String(b.id)));
}

// ---------------------------------------------------------------- reporting measures
// Each measure answers ONE question and is never blended into another: the client's deadline, the employee's own internal date,
// report sending, correction rate and reviewer turnaround. Productivity (hours) is a different system and is not touched here.
const pct = (n, d) => d ? Math.round(n / d * 1000) / 10 : null;
function measures(tasks, deps, days) {
  const today = deps.today, span = Math.min(Math.max(Number(days) || 30, 1), 365);
  const from = new Date(Date.parse(today + 'T00:00:00Z') - (span - 1) * 86400000).toISOString().slice(0, 10);
  const inDay = ts => ts && deps.nzDay(ts) >= from && deps.nzDay(ts) <= today;
  const finished = tasks.filter(t => t.status === 'completed' && inDay(t.completedAt));   // delivery measures: work that reached the end of the employee's part
  const reviewed = tasks.filter(t => t.reviewedBy && inDay(t.reviewedAt));                  // review measures: reviews decided in the window, whatever happened next
  const blank = () => ({ clientCommitment: { met: 0, missed: 0 }, internalCommitment: { met: 0, breached: 0 }, reportSending: { onTime: 0, late: 0, notSent: 0 }, corrections: { reviewed: 0, returned: 0, rounds: 0, serious: 0 } });
  const firm = blank(), per = {}, rev = {};
  const bucket = t => per[t.assignedTo || '-'] = per[t.assignedTo || '-'] || blank();
  for (const t of finished) {
    const card = wf.card(t, deps), e = bucket(t);
    if (!wf.isClientTask(t)) continue;
    for (const b of [firm, e]) {
      const o = deps.commitmentOutcome ? deps.commitmentOutcome(t) : null;
      if (o === 'met') b.clientCommitment.met++; else if (o === 'missed') b.clientCommitment.missed++;
      if (card.commitment.key === 'met') b.internalCommitment.met++; else if (card.commitment.key === 'breached') b.internalCommitment.breached++;
      const ri = deps.reportInfo ? deps.reportInfo(t) : null;
      if (ri && ri.eligible) { if (ri.outcome === 'sent_on_time') b.reportSending.onTime++; else if (ri.outcome === 'sent_late') b.reportSending.late++; else b.reportSending.notSent++; }
    }
  }
  for (const t of reviewed) {
    const e = bucket(t), rounds = t.reworkCount || 0, returned = t.reviewStatus === 'error' || rounds > 0;
    for (const b of [firm, e]) {
      b.corrections.reviewed++;
      if (returned) { b.corrections.returned++; b.corrections.rounds += Math.max(1, rounds); }
      if (rounds >= 3) b.corrections.serious++;     // "serious" = returned three or more times
    }
    const d = Math.max(0, wf.daysBetween(deps.nzDay(t.completedAt || t.reviewedAt), deps.nzDay(t.reviewedAt)));
    const r = rev[t.reviewedBy] = rev[t.reviewedBy] || { count: 0, totalDays: 0, maxDays: 0, within1: 0 };
    r.count++; r.totalDays += d; r.maxDays = Math.max(r.maxDays, d); if (d <= 1) r.within1++;
  }
  const fin = b => ({
    clientCommitment: { ...b.clientCommitment, total: b.clientCommitment.met + b.clientCommitment.missed, pct: pct(b.clientCommitment.met, b.clientCommitment.met + b.clientCommitment.missed) },
    internalCommitment: { ...b.internalCommitment, total: b.internalCommitment.met + b.internalCommitment.breached, pct: pct(b.internalCommitment.met, b.internalCommitment.met + b.internalCommitment.breached) },
    reportSending: { ...b.reportSending, total: b.reportSending.onTime + b.reportSending.late + b.reportSending.notSent, pct: pct(b.reportSending.onTime, b.reportSending.onTime + b.reportSending.late + b.reportSending.notSent) },
    corrections: { ...b.corrections, pct: pct(b.corrections.returned, b.corrections.reviewed), avgRounds: b.corrections.returned ? Math.round(b.corrections.rounds / b.corrections.returned * 10) / 10 : 0 },
  });
  const turn = ([id, r]) => ({ id, name: deps.nameOf(id) || '—', count: r.count, avgDays: Math.round(r.totalDays / r.count * 10) / 10, maxDays: r.maxDays, within1DayPct: pct(r.within1, r.count) });
  return {
    days: span, from, to: today, firm: fin(firm),
    byEmployee: Object.entries(per).filter(([id]) => id !== '-').map(([id, b]) => ({ id, name: deps.nameOf(id) || '—', ...fin(b) })).sort((a, b) => a.name.localeCompare(b.name)),
    byReviewer: Object.entries(rev).map(turn).sort((a, b) => b.count - a.count),
    reviewerTurnaround: (() => { const all = Object.values(rev); const c = all.reduce((n, r) => n + r.count, 0); return { count: c, avgDays: c ? Math.round(all.reduce((n, r) => n + r.totalDays, 0) / c * 10) / 10 : null, within1DayPct: pct(all.reduce((n, r) => n + r.within1, 0), c) }; })(),
  };
}

module.exports = { measures,  enrich, applyFilters, sortRows, paginate, teamSummary, exceptions, calendarEvents, timelineRows, toneFor, domainAllowed, hostOf, PAGE_SIZES, HOLD_BLOCKED_DAYS, PROFIT_OVERDUE_DAYS, TONE_LABEL, clientLinkDomains };
