// Founder dashboard — ONE shared metric layer. Every number, tile, list, drill-down and export on the Founder dashboard comes from
// build() below, and every productivity figure comes from the very same productivityFor() service the employee, reviewer and manager
// dashboards use (hours ÷ hours, never an average of percentages). Nothing here writes.
//
// Each metric declares: the SCOPE (whose tasks), the DATE field that puts a task in the period, the statuses it includes, who is
// eligible, its numerator and denominator, and what it does when the denominator is missing (value = null → "Not available", never 0%).
//
//   Productivity            reviewed-clean date     qualified allocated hours ÷ elapsed eligible capacity (7 h/day)
//   Internal commitment     internal due date       submitted by the employee's own date ÷ tasks internally due (and due, or submitted)
//   Client delivery         client commitment date  reports sent by that date ÷ reports due (date passed, or already sent)
//   First-pass approval     first review date       approved clean at the first review ÷ first reviews completed
//   Open work               as of today             open tasks right now (not a period figure)
//   Backlog change          created / completed     tasks created in the period − tasks completed in the period
const wf = require('./workflow');
const mgr = require('./manager-views');

const HOURS_GROUPS = ['processor', 'marketing'];          // measured by hours; the Admin / Management groups are measured by calls and emails
const REVIEW_SLA_HOURS = 48;
const PROFIT_OVERDUE_DAYS = 2;
const HOLD_BLOCKED_DAYS = 5;
const SEVERITY = { critical: 0, high: 1, medium: 2 };
const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium' };

const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const lastOfMonth = iso => { const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const pct = (n, d) => d > 0 ? Math.round(n / d * 1000) / 10 : null;
const r2 = n => Math.round(n * 100) / 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayLabel = iso => Number(iso.slice(8, 10)) + ' ' + MONTHS[Number(iso.slice(5, 7)) - 1];

// ---------------------------------------------------------------- period
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['quarter', 'This quarter'], ['year', 'This year'], ['last30', 'Last 30 days'], ['last90', 'Last 90 days'], ['custom', 'Custom range']];
// requested = what was asked for · elapsed = only the days that have actually happened (and, from the go-live date on). Actual productivity
// and every other period KPI use the ELAPSED window; the planned end is kept for information only.
function resolvePeriod(inp, d) {
  inp = inp || {};
  const today = d.today, preset = PERIODS.some(p => p[0] === inp.preset) ? inp.preset : 'month';
  const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
  let from, to;
  if (preset === 'today') from = to = today;
  else if (preset === 'week') { from = addDays(today, -dow); to = addDays(from, 6); }
  else if (preset === 'month') { from = today.slice(0, 8) + '01'; to = lastOfMonth(today); }
  else if (preset === 'quarter') { const m = Number(today.slice(5, 7)), q0 = Math.floor((m - 1) / 3) * 3 + 1; from = today.slice(0, 5) + String(q0).padStart(2, '0') + '-01'; to = lastOfMonth(today.slice(0, 5) + String(q0 + 2).padStart(2, '0') + '-01'); }
  else if (preset === 'year') { from = d.fiscalYearStart(today); to = addDays((Number(from.slice(0, 4)) + 1) + '-04-01', -1); }
  else if (preset === 'last30') { from = addDays(today, -29); to = today; }
  else if (preset === 'last90') { from = addDays(today, -89); to = today; }
  else {
    const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    from = ok(inp.from) ? inp.from : today.slice(0, 8) + '01'; to = ok(inp.to) ? inp.to : today;
    if (to < from) [from, to] = [to, from];
  }
  const requested = { from, to };
  const eTo = to > today ? today : to;
  const eFrom = (eTo >= d.goLive && from < d.goLive) ? d.goLive : from;
  const empty = eFrom > eTo;
  const days = empty ? 0 : daysBetween(eFrom, eTo) + 1;
  const pTo = addDays(eFrom, -1), pFrom = addDays(pTo, -(Math.max(days, 1) - 1));
  const prevOk = !empty && pTo >= d.goLive;
  const name = (PERIODS.find(p => p[0] === preset) || [])[1];
  const through = to > today ? ' through ' + dayLabel(today) : '';
  return {
    preset, label: name + (preset === 'custom' ? ' (' + dayLabel(from) + ' – ' + dayLabel(to) + ')' : through), requested,
    from: eFrom, to: eTo, empty, days, elapsedOnly: to !== eTo, plannedTo: to,
    prev: prevOk ? { from: pFrom < d.goLive ? d.goLive : pFrom, to: pTo } : null,
  };
}

// ---------------------------------------------------------------- who counts
function eligibility(state, d) {
  return state.employees.map(e => {
    const reason = d.productivityExclusionReason(state, e);
    const group = d.prodGroupOf(e);
    const why = reason || (HOURS_GROUPS.includes(group) ? null : 'Measured by calls and emails (' + group + ' group), not hours');
    return { id: e.id, name: e.name, team: e.team || '—', email: e.email, group, included: !why, reason: why };
  });
}
// Likely duplicate profiles: the same first name, or one name containing the other. Suggestions only — a superadmin confirms.
function suspectedDuplicates(state) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  const list = state.employees.filter(e => !e.duplicateOf).map(e => ({ e, n: norm(e.name) })).filter(x => x.n);
  const out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const sameFirst = a.n.split(' ')[0] === b.n.split(' ')[0];
    const contains = a.n.includes(b.n) || b.n.includes(a.n);
    if (sameFirst && (contains || a.n === b.n || (a.n.split(' ').length === 1 || b.n.split(' ').length === 1))) out.push({ a: { id: a.e.id, name: a.e.name, email: a.e.email, team: a.e.team || '—' }, b: { id: b.e.id, name: b.e.name, email: b.e.email, team: b.e.team || '—' } });
  }
  return out;
}

// ---------------------------------------------------------------- scope
function resolveScope(state, inp, d) {
  inp = inp || {};
  const el = eligibility(state, d), ok = new Set(el.filter(x => x.included).map(x => x.id));
  const kind = ['firm', 'team', 'manager', 'employee'].includes(inp.kind) ? inp.kind : 'firm', value = inp.value || '';
  let members = null, label = 'Whole firm';
  if (kind === 'team') { members = state.employees.filter(e => d.teamsOf(e).includes(value)); label = 'Team: ' + value; }
  else if (kind === 'manager') { const m = d.findEmployee(state, value); members = m ? d.teamRoster(state, m).filter(e => e.id !== m.id) : []; label = 'Manager: ' + (m ? m.name : '—'); }
  else if (kind === 'employee') { const e = d.findEmployee(state, value); members = e ? [e] : []; label = 'Employee: ' + (e ? e.name : '—'); }
  const memberIds = members ? members.filter(e => !e.duplicateOf).map(e => e.id) : null;       // null = everyone
  const eligibleIds = (memberIds || state.employees.map(e => e.id)).filter(id => ok.has(id));
  const ownsTask = memberIds ? (t => memberIds.includes(d.ownerOf(state, t))) : (() => true);
  return { kind, value, label, memberIds, eligibleIds, ownsTask, firm: !memberIds, eligibility: el };
}

// ---------------------------------------------------------------- per-task facts (one place, reused by every metric)
const submittedOn = (t, d) => t.completedAt ? d.nzDay(t.completedAt) : null;
function firstReview(t, d) {
  const ev = (t.reviewEvents || []).filter(e => ['approved', 'returned'].includes(e.type)).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  if (ev) return { day: d.nzDay(ev.at), clean: ev.type === 'approved' };
  if (t.reviewStatus === 'clean' && !(t.reworkCount > 0)) return t.reviewedAt ? { day: d.nzDay(t.reviewedAt), clean: true } : null;
  if (t.reworkCount > 0) { const h = (t.reworkHistory || [])[0]; const at = (h && (h.startedAt || h.endedAt)) || t.reviewedAt; return at ? { day: d.nzDay(at), clean: false, approx: true } : null; }
  if (t.reviewStatus === 'error' && t.reviewedAt) return { day: d.nzDay(t.reviewedAt), clean: false };
  return null;
}
const createdDay = (t, d) => d.nzDay(t.createdAt || ((t.reassignHistory || [])[0] || {}).at || t.assignedAt || '');
const completedDay = t => {
  if (t.status !== 'completed') return null;
  if (t.reviewStatus === 'clean' && t.reviewedAt) return t.reviewedAt;
  if (t.reviewStatus === 'done') return t.closedAt || t.completedAt || null;
  return null;
};

// ---------------------------------------------------------------- metric objects
function metric(key, label, o) {
  const den = o.denominator, value = den == null ? o.value : (den > 0 ? o.value : null);
  return {
    key, label, unit: o.unit || '%', value, numerator: o.numerator == null ? null : o.numerator, denominator: den == null ? null : den,
    available: value != null, why: value == null ? (o.unavailable || 'Not available') : null, ids: o.ids || [],
    calc: o.calc, basis: o.basis || '', prev: o.prev || null, extra: o.extra || null,
  };
}
const baseIds = list => [...new Set(list.map(x => String(x.id).split(':close:')[0]))];

// ---------------------------------------------------------------- the whole dashboard
function build(state, me, params, d) {
  const period = resolvePeriod(params.period, d), scope = resolveScope(state, params.scope, d), today = d.today;
  const wfDeps = d.workflowDeps(state, me);
  const tasks = state.tasks.filter(t => t.status !== 'cancelled' && scope.ownsTask(t));
  const byId = Object.fromEntries(state.tasks.map(t => [t.id, t]));
  const cardCache = {}, cardOf = t => cardCache[t.id] || (cardCache[t.id] = mgr.enrich(wf.card(t, wfDeps), t, wfDeps));
  const inP = (day, p) => !!day && day >= p.from && day <= p.to;
  const nameOf = id => (d.findEmployee(state, id) || {}).name || null;

  // ---- productivity (the shared service), and the groups it feeds
  const productivityIn = (ids, p) => (p && p.from <= p.to && ids.length) ? d.productivityFor(state, ids, p.from, p.to) : [];
  const people = productivityIn(scope.eligibleIds, period);
  const prevPeople = period.prev ? productivityIn(scope.eligibleIds, period.prev) : [];
  const agg = ppl => d.aggregateTotals(ppl);
  const totals = agg(people), prevTotals = prevPeople.length ? agg(prevPeople) : null;

  // ---- per-task period facts for the eligible employees
  const eligSet = new Set(scope.eligibleIds);
  const mine = tasks.filter(t => eligSet.has(d.ownerOf(state, t)));
  const dueIn = (p) => mine.filter(t => t.internalDeadline && inP(t.internalDeadline, p));
  const internalOutcome = (t) => {                           // met / missed / null (not yet due and not submitted)
    const sub = submittedOn(t, d);
    if (sub) return sub <= t.internalDeadline ? 'met' : 'missed';
    return t.internalDeadline < today ? 'missed' : null;
  };
  const internalFor = (p, subset) => {
    const rows = dueIn(p).filter(t => !subset || subset.has(d.ownerOf(state, t))).map(t => ({ t, o: internalOutcome(t) })).filter(x => x.o);
    const met = rows.filter(x => x.o === 'met').length;
    return { met, total: rows.length, ids: rows.map(x => x.t.id), missedIds: rows.filter(x => x.o === 'missed').map(x => x.t.id) };
  };
  const deliveryOutcome = (t) => {                            // onTime / late / notSent / null (not due yet)
    if (wf.isClientTask(t) === false || t.kind === 'internal') return null;
    if (t.reportDeliveryStatus === 'sending_not_required' || t.reportRequired === false) return null;
    const cd = d.effectiveClientDate(t); if (!cd) return null;
    if (t.sentToClient === true && t.sentToClientAt) return d.nzDay(t.sentToClientAt) <= cd ? 'onTime' : 'late';
    return cd < today ? 'notSent' : null;
  };
  const deliveryFor = (p, subset) => {
    const rows = mine.filter(t => (!subset || subset.has(d.ownerOf(state, t)))).map(t => ({ t, cd: d.effectiveClientDate(t), o: deliveryOutcome(t) })).filter(x => x.o && x.cd && inP(x.cd, p));
    const c = k => rows.filter(x => x.o === k).length;
    const noDate = mine.filter(t => (!subset || subset.has(d.ownerOf(state, t))) && t.kind !== 'internal' && t.status === 'completed' && ['clean', 'done'].includes(t.reviewStatus) && !t.clientDate && inP(d.nzDay(t.reviewedAt || t.completedAt || ''), p)).length;
    return { due: rows.length, onTime: c('onTime'), late: c('late'), notSent: c('notSent'), noDate, ids: rows.map(x => x.t.id), notSentIds: rows.filter(x => x.o === 'notSent' || x.o === 'late').map(x => x.t.id) };
  };
  const firstPassFor = (p, subset) => {
    const rows = mine.filter(t => (!subset || subset.has(d.ownerOf(state, t)))).map(t => ({ t, fr: firstReview(t, d) })).filter(x => x.fr && inP(x.fr.day, p));
    return { clean: rows.filter(x => x.fr.clean).length, total: rows.length, ids: rows.map(x => x.t.id) };
  };
  const internal = internalFor(period), delivery = deliveryFor(period), firstPass = firstPassFor(period);
  const pInternal = period.prev ? internalFor(period.prev) : null, pDelivery = period.prev ? deliveryFor(period.prev) : null, pFirst = period.prev ? firstPassFor(period.prev) : null;

  // ---- open work (as of today) and backlog change (created − completed in the period)
  const openTasks = tasks.filter(t => cardOf(t).status !== 'Completed');
  const createdIn = (p) => tasks.filter(t => inP(createdDay(t, d), p));
  const completedIn = (p) => tasks.filter(t => inP(d.nzDay(completedDay(t) || ''), p));
  const created = period.empty ? [] : createdIn(period), completed = period.empty ? [] : completedIn(period);
  const pCreated = period.prev ? createdIn(period.prev).length : null, pCompleted = period.prev ? completedIn(period.prev).length : null;

  const asOf = 'Current open position as of ' + dayLabel(today);
  const prevPct = (cur, prev) => (cur == null || prev == null) ? null : r2(cur - prev);
  const rawPct = t => t == null ? null : (t.capacityHours > 0 ? Math.round(t.qualifiedHours / t.capacityHours * 1000) / 10 : null);
  const productivity = metric('productivity', 'Reviewed-Clean Productivity', {
    unit: '%', value: rawPct(totals), numerator: totals.qualifiedHours, denominator: totals.capacityHours,
    unavailable: period.empty ? 'No elapsed working days in this period yet' : 'Productivity cannot be calculated because there is no eligible capacity for this scope and period',
    ids: baseIds(people.flatMap(p => p.qualifiedTasks)),
    calc: 'Qualified allocated hours (tasks reviewed clean in the period) ÷ elapsed eligible capacity hours (7 h per eligible working day) × 100. Never actual hours worked, time clock or Report Sent.',
    prev: prevTotals ? { value: rawPct(prevTotals), numerator: prevTotals.qualifiedHours, denominator: prevTotals.capacityHours, delta: prevPct(rawPct(totals), rawPct(prevTotals)) } : null,
    extra: { qualifiedTasks: people.reduce((n, p) => n + p.qualifiedTasks.length, 0), excludedTasks: people.reduce((n, p) => n + p.excludedTasks.length, 0), cappedPct: totals.productivityPct, additionalHours: totals.additionalHours, eligibleEmployees: people.length },
  });
  const kpis = [
    productivity,
    metric('internal', 'Internal Commitment Met', { value: pct(internal.met, internal.total), numerator: internal.met, denominator: internal.total, ids: internal.ids, unavailable: 'No tasks were internally due in this period',
      calc: 'Tasks submitted by their internal due date ÷ tasks whose internal due date falls in the period (and has passed, or that were already submitted).', prev: pInternal ? { value: pct(pInternal.met, pInternal.total), numerator: pInternal.met, denominator: pInternal.total, delta: prevPct(pct(internal.met, internal.total), pct(pInternal.met, pInternal.total)) } : null }),
    metric('delivery', 'Client Delivery On Time', { value: pct(delivery.onTime, delivery.due), numerator: delivery.onTime, denominator: delivery.due, ids: delivery.ids, unavailable: 'No client reports were due in this period',
      calc: 'Reports sent on or before the client commitment date ÷ reports whose client commitment date falls in the period (and has passed, or that were already sent). Report Sent never changes productivity.',
      prev: pDelivery ? { value: pct(pDelivery.onTime, pDelivery.due), numerator: pDelivery.onTime, denominator: pDelivery.due, delta: prevPct(pct(delivery.onTime, delivery.due), pct(pDelivery.onTime, pDelivery.due)) } : null,
      extra: { due: delivery.due, onTime: delivery.onTime, late: delivery.late, notSent: delivery.notSent, noDate: delivery.noDate } }),
    metric('firstPass', 'First-Pass Approval', { value: pct(firstPass.clean, firstPass.total), numerator: firstPass.clean, denominator: firstPass.total, ids: firstPass.ids, unavailable: 'No first reviews were completed in this period',
      calc: 'Tasks approved clean at the first completed review ÷ tasks whose first review was completed in the period.', prev: pFirst ? { value: pct(pFirst.clean, pFirst.total), numerator: pFirst.clean, denominator: pFirst.total, delta: prevPct(pct(firstPass.clean, firstPass.total), pct(pFirst.clean, pFirst.total)) } : null }),
    metric('open', 'Open Work', { unit: 'tasks', value: openTasks.length, numerator: openTasks.length, denominator: null, ids: openTasks.map(t => t.id), basis: asOf,
      calc: 'Tasks in this scope that are not finished — a position as of today, not a period figure.' }),
    metric('backlog', 'Backlog Change', { unit: 'tasks', value: created.length - completed.length, numerator: created.length, denominator: null, ids: [...new Set([...created, ...completed].map(t => t.id))],
      calc: 'Tasks created in the period minus tasks completed in the period (clean-review or done date).', prev: pCreated == null ? null : { value: pCreated - pCompleted, created: pCreated, completed: pCompleted },
      extra: { created: created.length, completed: completed.length, createdIds: created.map(t => t.id), completedIds: completed.map(t => t.id) } }),
  ];

  // ---- the action tiles, each defined ONCE as a filter over the same task universe
  const open = openTasks.map(t => ({ t, c: cardOf(t) }));
  const risky = c => ['overdue', 'due_today', 'at_risk'].includes(c.clientRisk.state);
  const overdueEmp = c => c.waitingOn.kind === 'employee' && ['Assigned', 'In Progress'].includes(c.status);
  const blockers = (t, c) => {
    const b = [];
    if (!t.assignedTo) b.push('No assignee');
    if (wf.isClientTask(t) && !t.clientId) b.push('No client');
    if (!(Number(t.tat) > 0) && !(Number(t.productivityAllocatedHoursSnapshot) > 0)) b.push('No allocated hours');
    if (!t.internalDeadline) b.push('No internal due date');
    if (c.kindLabel === 'Client Task' && !t.clientDate) b.push('No client commitment date');
    if (t.reviewRequired === true && !(t.reviewerId || t.assignedReviewerId) && ['In Review', 'Approved'].includes(c.status)) b.push('No reviewer');
    if (c.status === 'On Hold' && t.heldAt && daysBetween(d.nzDay(t.heldAt), today) > HOLD_BLOCKED_DAYS) b.push('On hold for ' + daysBetween(d.nzDay(t.heldAt), today) + ' days');
    return b;
  };
  const ids = f => open.filter(x => f(x.t, x.c)).map(x => x.t.id);
  const actionTiles = [
    { key: 'at_risk', label: 'Client Deliveries at Risk', scope: 'Client commitment approaching or breached, not ready to deliver', ids: ids((t, c) => c.kindLabel === 'Client Task' && risky(c) && !['Approved', 'Completed'].includes(c.status)) },
    { key: 'reviews_overdue', label: 'Reviews Overdue', scope: 'In review longer than ' + REVIEW_SLA_HOURS + ' h, or past the internal due date', ids: ids((t, c) => c.status === 'In Review' && (!!(c.reviewWaiting && c.reviewWaiting.hours > REVIEW_SLA_HOURS) || (t.internalDeadline && t.internalDeadline < today))) },
    { key: 'reports_not_sent', label: 'Reports Not Sent', scope: 'Reviewed / approved client work, report not yet sent', ids: ids((t, c) => c.kindLabel === 'Client Task' && c.status === 'Approved') },
    { key: 'profit_pending', label: 'Profit Confirmations Pending', scope: 'Waiting for profit confirmation', ids: ids(t => t.profitConfirmStatus === 'pending') },
    { key: 'team_overdue', label: 'Team Overdue', scope: 'Employee tasks past their internal due date', ids: ids((t, c) => overdueEmp(c) && t.internalDeadline && t.internalDeadline < today) },
    { key: 'blocked', label: 'Unassigned or Blocked', scope: 'Missing assignee, reviewer, client, hours or date — or on hold too long', ids: ids((t, c) => blockers(t, c).length > 0) },
  ].map(x => ({ ...x, hint: asOf }));

  // ---- the "needs founder attention" queue: one row per task, its most serious problem first
  const issuesOf = (t, c) => {
    const out = [], days = iso => Math.max(0, daysBetween(iso, today));
    if (c.kindLabel === 'Client Task' && c.clientRisk.state === 'overdue' && !['Approved', 'Completed'].includes(c.status)) out.push(['critical', 'Client commitment breached', days(t.clientDate), 'Deliver or agree a new date with the client']);
    if (t.profitConfirmStatus === 'pending' && t.profitConfirmRequestedAt && daysBetween(d.nzDay(t.profitConfirmRequestedAt), today) > PROFIT_OVERDUE_DAYS) out.push(['critical', 'Profit confirmation overdue', daysBetween(d.nzDay(t.profitConfirmRequestedAt), today), 'Confirm profit']);
    if (c.status === 'Approved' && c.kindLabel === 'Client Task' && t.clientDate && t.clientDate < today) out.push(['critical', 'Report not sent — client date passed', days(t.clientDate), 'Send the report to the client']);
    if (c.kindLabel === 'Client Task' && ['due_today', 'at_risk'].includes(c.clientRisk.state) && !['Approved', 'Completed'].includes(c.status)) out.push(['high', 'Client commitment at risk', 0, 'Make sure it is delivered by ' + (t.clientDate || 'the client date')]);
    if (c.status === 'In Review' && ((c.reviewWaiting && c.reviewWaiting.hours > REVIEW_SLA_HOURS) || (t.internalDeadline && t.internalDeadline < today))) out.push(['high', 'Review overdue', c.reviewWaiting ? c.reviewWaiting.days : 0, 'Review it, or reassign the reviewer']);
    if (c.status === 'Approved' && c.kindLabel === 'Client Task' && !(t.clientDate && t.clientDate < today)) out.push(['high', 'Report not sent', 0, 'Send the report to the client']);
    const b = blockers(t, c);
    if (b.some(x => /^On hold for/.test(x))) out.push(['high', 'Blocked too long', daysBetween(d.nzDay(t.heldAt), today), 'Resolve the blocker or reassign']);
    if (!t.assignedTo) out.push(['high', 'No assignee', 0, 'Assign an owner']);
    if (b.includes('No reviewer')) out.push(['high', 'No reviewer', 0, 'Choose a reviewer']);
    if (b.includes('No client')) out.push(['medium', 'Missing client', 0, 'Add the client']);
    if (b.includes('No allocated hours')) out.push(['medium', 'Missing allocated hours', 0, 'Set the allocated hours']);
    if (b.includes('No internal due date')) out.push(['medium', 'Missing internal due date', 0, 'Set the internal due date']);
    if (b.includes('No client commitment date')) out.push(['medium', 'Missing client commitment date', 0, 'Set the client commitment date']);
    if ((t.reworkCount || 0) >= 2 && c.status !== 'Completed') out.push(['medium', 'Excessive rework', 0, 'Returned ' + t.reworkCount + ' times — look at the root cause']);
    if ((t.status === 'completed' && !t.completedAt) || (t.reviewStatus === 'clean' && t.status !== 'completed')) out.push(['critical', 'Invalid status transition', 0, 'Data check needed — status and review do not agree']);
    return out;
  };
  const attention = [];
  for (const { t, c } of open.concat(tasks.filter(t => cardOf(t).status === 'Completed' && ((t.status === 'completed' && !t.completedAt) || (t.reviewStatus === 'clean' && t.status !== 'completed'))).map(t => ({ t, c: cardOf(t) })))) {
    const issues = issuesOf(t, c).sort((a, b) => SEVERITY[a[0]] - SEVERITY[b[0]] || b[2] - a[2]);
    if (!issues.length) continue;
    const [sev, label, daysOver, action] = issues[0];
    attention.push({ id: t.id, severity: sev, severityLabel: SEVERITY_LABEL[sev], issue: label, daysOverdue: daysOver, requiredAction: action, also: issues.slice(1).map(x => x[1]),
      name: t.name, clientName: c.clientName, employee: c.assigneeName, reviewer: c.reviewerName, manager: ((t.assignedTo && d.managersOfEmployee(state, t.assignedTo)) || []).map(m => m.name).join(', ') || null,
      internalDeadline: t.internalDeadline || null, clientDate: t.clientDate || null, status: c.status, blocker: blockers(t, c).join('; ') || null });
  }
  attention.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.daysOverdue - a.daysOverdue || String(a.id).localeCompare(String(b.id)));

  // ---- capacity and bottlenecks
  const bottleneck = (key, label, list, hoursOf) => ({ key, label, count: list.length, hours: r2(list.reduce((s, t) => s + hoursOf(t), 0)), ids: list.map(t => t.id),
    oldestDays: list.length ? Math.max(...list.map(t => Math.max(0, daysBetween(d.nzDay(t.completedAt || t.profitConfirmRequestedAt || t.reviewedAt || t.assignedAt || ''), today)))) : 0 });
  const hrs = t => Number(t.productivityAllocatedHoursSnapshot) || Number(t.tat) || 0;
  const cap = {
    eligibleCapacityHours: totals.capacityHours, reviewedCleanHours: totals.qualifiedHours, openAllocatedHours: totals.notConvertedBreakdown.openAllocated,
    nonQualifyingCompletedHours: totals.notConvertedBreakdown.nonQualifyingCompleted, unallocatedCapacityHours: totals.notConvertedBreakdown.unallocated, reconciles: totals.notConvertedBreakdown.reconciles,
    note: 'Open allocated hours are workload still to be delivered — they are not productivity. The three parts add up to the capacity that was not converted into reviewed-clean hours.',
    bottlenecks: [
      bottleneck('review', 'Review', open.filter(x => x.c.status === 'In Review').map(x => x.t), hrs),
      bottleneck('correction', 'Correction', open.filter(x => x.c.status === 'Correction Required').map(x => x.t), hrs),
      bottleneck('profit', 'Profit confirmation', open.filter(x => x.t.profitConfirmStatus === 'pending').map(x => x.t), hrs),
      bottleneck('report', 'Report sending', open.filter(x => x.c.status === 'Approved' && x.c.kindLabel === 'Client Task').map(x => x.t), hrs),
    ],
  };

  // ---- performance table: by team / manager / employee — every cell from the same per-person facts
  const groupRow = (key, label, memberIds, extra) => {
    const set = new Set(memberIds), eligible = memberIds.filter(id => eligSet.has(id));
    const rows = people.filter(p => set.has(p.id)), t = agg(rows);
    const inT = tasks.filter(x => set.has(d.ownerOf(state, x)));
    const idsIn = f => open.filter(x => set.has(d.ownerOf(state, x.t)) && f(x.t, x.c)).map(x => x.t.id);
    const int = internalFor(period, set), del = deliveryFor(period, set), fp = firstPassFor(period, set);
    const att = attention.filter(a => set.has(d.ownerOf(state, byId[a.id]))).map(a => a.id);
    const cell = (value, num, den) => ({ value, numerator: num, denominator: den });
    const notSentIds = idsIn((x, c) => c.kindLabel === 'Client Task' && c.status === 'Approved');
    const overdueIds = idsIn((x, c) => overdueEmp(c) && x.internalDeadline && x.internalDeadline < today);
    const blockedIds = idsIn((x, c) => blockers(x, c).length > 0);
    return { key, label, ...(extra || {}), people: eligible.length, memberIds,
      productivity: cell(rawPct(t), t.qualifiedHours, t.capacityHours), internal: cell(pct(int.met, int.total), int.met, int.total), delivery: cell(pct(del.onTime, del.due), del.onTime, del.due),
      firstPass: cell(pct(fp.clean, fp.total), fp.clean, fp.total), reportsNotSent: { count: notSentIds.length, ids: notSentIds }, overdue: { count: overdueIds.length, ids: overdueIds },
      blocked: { count: blockedIds.length, ids: blockedIds }, attention: { count: att.length, ids: att }, openTasks: inT.filter(x => cardOf(x).status !== 'Completed').length };
  };
  const eligEmps = scope.eligibleIds.map(id => d.findEmployee(state, id)).filter(Boolean);
  const byTeam = [...new Set(eligEmps.flatMap(e => d.teamsOf(e)))].sort().map(team => groupRow('team:' + team, team, eligEmps.filter(e => d.teamsOf(e).includes(team)).map(e => e.id)));
  const managerIds = [...new Set(eligEmps.flatMap(e => d.managersOfEmployee(state, e.id).map(m => m.id)))];
  const byManager = managerIds.map(mid => { const m = d.findEmployee(state, mid); return groupRow('manager:' + mid, m.name, eligEmps.filter(e => d.managersOfEmployee(state, e.id).some(x => x.id === mid)).map(e => e.id)); }).sort((a, b) => a.label.localeCompare(b.label));
  const byEmployee = eligEmps.map(e => groupRow('employee:' + e.id, e.name, [e.id], { team: e.team || '—' })).sort((a, b) => a.label.localeCompare(b.label));

  // ---- Today (the founder's own responsibilities) and Review & Decisions
  const myTasks = state.tasks.filter(t => t.status !== 'cancelled' && d.ownerOf(state, t) === me.id);
  const myOpen = myTasks.filter(t => cardOf(t).status !== 'Completed');
  const escalatedToMe = state.tasks.filter(t => t.escalation && t.escalation.status === 'open' && t.escalation.toId === me.id);
  const decisionsMe = state.tasks.filter(t => (t.escalation && t.escalation.status === 'open' && t.escalation.toId === me.id) || ((t.status === 'window_proposed' || t.status === 'pending_approval') && t.assignedTo && wfDeps.canApprove(t)));
  const profitMe = state.tasks.filter(t => t.profitConfirmStatus === 'pending' && me.id === wfDeps.profitOwnerId);
  const reportsMe = state.tasks.filter(t => cardOf(t).status === 'Approved' && t.awaitingClientDecision && t.reportSendOwner === me.id);
  const doneToday = state.tasks.filter(t => (t.reviewedBy === me.id && t.reviewedAt && d.nzDay(t.reviewedAt) === today) || (t.profitConfirmBy === me.id && t.profitConfirmAt && d.nzDay(t.profitConfirmAt) === today)
    || (t.escalation && t.escalation.status === 'resolved' && t.escalation.resolvedBy === me.id && t.escalation.resolvedAt && d.nzDay(t.escalation.resolvedAt) === today) || (t.sentToClient === true && t.sentToClientBy === me.id && t.sentToClientAt && d.nzDay(t.sentToClientAt) === today));
  const tl = (key, label, scopeText, list) => ({ key, label, scope: scopeText, ids: [...new Set(list.map(t => t.id))] });
  const todayTiles = [
    tl('my_today', 'My Tasks Today', 'Assigned to me, due today', myOpen.filter(t => t.internalDeadline === today)),
    tl('my_overdue', 'My Overdue Tasks', 'Assigned to me, past their due date', myOpen.filter(t => t.internalDeadline && t.internalDeadline < today)),
    tl('profit_mine', 'Profit Confirmations Waiting', 'Waiting for my confirmation', profitMe),
    tl('decisions', 'Decisions Waiting', 'Escalations and date decisions for me', decisionsMe),
    tl('reports_mine', 'Reports Requiring My Action', 'Cannot proceed until I act', [...reportsMe, ...profitMe.filter(t => cardOf(t).kindLabel === 'Client Task')]),
    tl('done_today', 'Actions Completed Today', 'Reviews, confirmations, escalations and reports I completed today', doneToday),
  ];
  const reviewTiles = [
    tl('review_mine', 'Waiting for My Review', 'Sent to me for review', open.map(x => x.t).filter(t => cardOf(t).status === 'In Review' && (t.reviewerId === me.id || t.assignedReviewerId === me.id))),
    tl('decisions2', 'Decisions Waiting', 'Escalations and date decisions for me', decisionsMe),
    tl('profit2', 'Profit Confirmations Waiting', 'Waiting for my confirmation', profitMe),
    tl('reviews_overdue2', 'Reviews Overdue (firm)', 'In review longer than ' + REVIEW_SLA_HOURS + ' h', open.map(x => x.t).filter(t => { const c = cardOf(t); return c.status === 'In Review' && c.reviewWaiting && c.reviewWaiting.hours > REVIEW_SLA_HOURS; })),
    tl('corrections', 'Corrections Outstanding', 'Returned to the employee, not yet resubmitted', open.map(x => x.t).filter(t => cardOf(t).status === 'Correction Required')),
    tl('rework2', 'Repeated Returns', 'Returned two or more times', open.map(x => x.t).filter(t => (t.reworkCount || 0) >= 2)),
  ];

  // ---- "more insights" (collapsed): all from the same scoped tasks and the same period
  const reworkCases = tasks.filter(t => (t.reworkHistory || []).length || (t.reviewEvents || []).some(e => e.type === 'returned')).filter(t => {
    const evs = (t.reviewEvents || []).filter(e => e.type === 'returned').map(e => d.nzDay(e.at));
    const hs = (t.reworkHistory || []).map(h => d.nzDay(h.startedAt || h.endedAt || ''));
    return [...evs, ...hs].some(day => inP(day, period));
  });
  const FAULT = { processor: 'Processing error', sop: 'Process / procedure', client: 'Client-caused', other: 'Other' };
  const failures = Object.entries(reworkCases.reduce((m, t) => { const k = FAULT[t.faultType] || 'Other'; (m[k] = m[k] || []).push(t.id); return m; }, {})).map(([label, ids2]) => ({ label, count: ids2.length, ids: ids2 }));
  const sources = Object.entries(created.reduce((m, t) => { const k = !t.source || t.source === 'manual' ? 'Created in the app' : t.source === 'call' ? 'From a call' : t.source === 'slack_message' ? 'From Slack' : String(t.source); (m[k] = m[k] || []).push(t.id); return m; }, {})).map(([label, ids2]) => ({ label, count: ids2.length, ids: ids2 }));
  const ownerCounts = {}; (state.clients || []).forEach(c => { const o = c.ownerId ? nameOf(c.ownerId) || 'Unknown' : 'No owner'; ownerCounts[o] = (ownerCounts[o] || 0) + 1; });
  const insights = {
    failures, sources, createdNote: created.length + ' tasks created in this period',
    clientOwnership: Object.entries(ownerCounts).sort((a, b) => b[1] - a[1]).map(([owner, count]) => ({ owner, count })),
    recentActivity: (state.activityLog || []).slice(-12).reverse().map(a => ({ at: a.ts, text: String(a.text || '').replace(/<[^>]+>/g, '') })),
  };

  // ---- one compact row per task that any list refers to (the detail panel fetches the full card when a row is opened)
  const refIds = new Set([...actionTiles, ...todayTiles, ...reviewTiles].flatMap(x => x.ids));
  attention.forEach(a => refIds.add(a.id)); kpis.forEach(k => k.ids.forEach(i => refIds.add(i)));
  [...byTeam, ...byManager, ...byEmployee].forEach(g => ['reportsNotSent', 'overdue', 'blocked', 'attention'].forEach(k => g[k].ids.forEach(i => refIds.add(i))));
  cap.bottlenecks.forEach(b => b.ids.forEach(i => refIds.add(i))); failures.concat(sources).forEach(x => x.ids.forEach(i => refIds.add(i)));
  const rows = {};
  refIds.forEach(id => { const t = byId[id]; if (!t) return; const c = cardOf(t);
    rows[id] = { id, name: c.name, clientName: c.clientName, kindLabel: c.kindLabel, taskType: c.taskType, status: c.status, waitingOn: c.waitingOn.label, assigneeId: c.assigneeId, assigneeName: c.assigneeName, reviewerName: c.reviewerName,
      clientDate: c.clientDate, internalDeadline: c.internalDeadline, clientRisk: c.clientRisk, sheetLink: c.sheetLink, cashbookLink: c.cashbookLink, hasSheet: c.hasSheet, hasCashbook: c.hasCashbook, allocatedHours: c.allocatedHours, reworkCount: c.reworkCount }; });

  return {
    asOf: today, scope: { kind: scope.kind, value: scope.value, label: scope.label },
    period: { preset: period.preset, label: period.label, from: period.from, to: period.to, requested: period.requested, empty: period.empty, elapsedOnly: period.elapsedOnly, plannedTo: period.plannedTo, prev: period.prev, days: period.days },
    eligibleEmployees: eligEmps.map(e => ({ id: e.id, name: e.name, team: e.team || '—' })),
    views: { today: { tiles: todayTiles }, founder: { actionTiles, kpis, attention: { shown: attention.slice(0, 12), total: attention.length, all: attention }, performance: { byTeam, byManager, byEmployee }, capacity: cap, insights }, review: { tiles: reviewTiles } },
    totals, rows,
  };
}

// ---------------------------------------------------------------- productivity drill-down: the per-employee table and one employee's tasks
const REASON = (r, status, t) => {
  if (!r) return '';
  if (/Review pending/i.test(r)) return 'Excluded — waiting for review';
  if (/Review contains errors|Needs rework/i.test(r)) return 'Excluded — returned for correction';
  if (/On hold/i.test(r)) return 'Excluded — on hold';
  if (/Missing allocated/i.test(r)) return 'Excluded — missing allocated hours';
  if (/Awaiting acceptance|In progress|Window proposed|Not yet delivered/i.test(r)) return 'Excluded — not yet delivered (' + r.toLowerCase() + ')';
  if (/Invalid completion/i.test(r)) return 'Excluded — invalid completion timestamp';
  return 'Excluded — ' + r;
};
function drilldown(state, params, d) {
  const period = resolvePeriod(params.period, d), scope = resolveScope(state, params.scope, d);
  const people = (period.from <= period.to && scope.eligibleIds.length) ? d.productivityFor(state, scope.eligibleIds, period.from, period.to) : [];
  const weeklyOffs = (from, to) => { let n = 0; for (let x = from; x <= to; x = addDays(x, 1)) if (new Date(x + 'T00:00:00Z').getUTCDay() === 0) n++; return n; };
  const table = people.map(p => {
    const b = p.capacityBreakdown || {};
    return { id: p.id, name: p.name, team: p.team, eligibleWorkingDays: b.finalEligibleDays != null ? b.finalEligibleDays : null, approvedLeaveDays: p.leaveDays, weeklyOffs: weeklyOffs(period.from, period.to),
      workshopSaturdays: p.workshopDays, otherExclusions: r2((b.publicHolidays || 0) + (b.customHoursOff || 0) / (b.dayHours || 7)), eligibleCapacityHours: p.capacityHours, qualifiedHours: p.qualifiedHours,
      productivityPct: p.capacityHours > 0 ? Math.round(p.qualifiedHours / p.capacityHours * 1000) / 10 : null, qualifyingTasks: p.qualifiedTasks.length, excludedTasks: p.excludedTasks.length };
  });
  const totals = d.aggregateTotals(people);
  let detail = null;
  if (params.employee) {
    const p = people.find(x => x.id === params.employee);
    if (p) {
      const taskRow = (r, qualified) => {
        const id = String(r.id).split(':close:')[0], t = state.tasks.find(x => x.id === id) || {};
        const rep = t.sentToClient === true ? 'Sent' + (t.sentToClientAt ? ' ' + d.nzDay(t.sentToClientAt) : '') : (r.reportStatus === 'sending_not_required' ? 'Not required' : 'Not sent');
        return { id, name: r.name, clientName: r.clientName, taskType: t.scope && t.scope !== '—' ? t.scope : (t.service || null), assignee: p.name, reviewer: (d.findEmployee(state, t.reviewerId || t.reviewedBy) || {}).name || null,
          allocatedHours: r.allocatedHours, internalDeadline: r.internalDeadline || null, clientDate: r.clientDate || null, submittedAt: t.completedAt || null, reviewCompletedAt: t.reviewedAt || null,
          reviewDecision: t.reviewStatus === 'clean' ? 'Reviewed clean' : t.reviewStatus === 'error' ? 'Returned for correction' : t.reviewStatus === 'done' ? 'No review required' : (t.status === 'completed' ? 'Waiting for review' : '—'),
          reviewedCleanAt: t.reviewStatus === 'clean' ? t.reviewedAt || null : null, reportStatus: rep, reportSentAt: t.sentToClientAt || null,
          qualification: qualified ? 'Included' : 'Excluded', reason: qualified ? 'Included — ' + (r.noReviewAuthorized ? 'no review required (authorised)' : r.rule === 'on_hold_month_close' ? 'on-hold month-close credit' : r.reviewedAt || t.reviewStatus === 'clean' ? 'reviewed clean in selected period' : 'completed in selected period') : REASON(r.exclusionReason, r.status, t), creditedHours: r.creditedHours };
      };
      detail = { id: p.id, name: p.name, qualifying: p.qualifiedTasks.map(r => taskRow(r, true)), excluded: p.excludedTasks.map(r => taskRow(r, false)) };
    }
  }
  return { scope: { kind: scope.kind, value: scope.value, label: scope.label }, period: { preset: period.preset, label: period.label, from: period.from, to: period.to, empty: period.empty, elapsedOnly: period.elapsedOnly, plannedTo: period.plannedTo }, table, totals, detail,
    formula: 'Productivity % = qualified allocated hours (reviewed clean in the period) ÷ eligible capacity hours (7 h × elapsed eligible working days) × 100.', excludedPeople: scope.eligibility.filter(x => !x.included).map(x => ({ id: x.id, name: x.name, reason: x.reason })) };
}

const csvCell = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (head, rows) => '﻿' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');

module.exports = { build, drilldown, resolvePeriod, resolveScope, eligibility, suspectedDuplicates, firstReview, createdDay, completedDay, toCsv, PERIODS, HOURS_GROUPS, REVIEW_SLA_HOURS, pct };
