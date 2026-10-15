// Client ownership and the client profile.
//   - a financial year for every piece of work (NZ tax year by default: 1 April – 31 March; a client can have another balance date)
//   - a standard yearly checklist for each client type, built per client from the work that has been done
//   - one owner per client, accountable for every row of that checklist
// Pure functions: the server passes in the tasks and the work cards it has already scoped for the person asking.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DEFAULT_BALANCE = '03-31';

// ---------------------------------------------------------------- financial years
function parseBalance(b) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(b || ''));
  if (!m) return { month: 3, day: 31 };
  const month = Number(m[1]), day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day } : { month: 3, day: 31 };
}
function balanceLabel(b) { const p = parseBalance(b); return p.day + ' ' + MONTHS[p.month - 1]; }
const fyLabel = endYear => (endYear - 1) + '–' + String(endYear).slice(2);
function endYearOfLabel(label) {
  const m = /^(\d{4})\s*[–-]\s*(\d{2})$/.exec(String(label || '').trim());
  if (!m) return null;
  const start = Number(m[1]);
  return (start + 1) % 100 === Number(m[2]) ? start + 1 : null;
}
const validFY = label => endYearOfLabel(label) !== null;
const normalFY = label => { const e = endYearOfLabel(label); return e === null ? null : fyLabel(e); };
// the year that ends on the first balance date on or after this day
function fyEndYearOf(dayISO, balance) {
  const b = parseBalance(balance), y = Number(String(dayISO).slice(0, 4)), m = Number(String(dayISO).slice(5, 7)), d = Number(String(dayISO).slice(8, 10));
  return (m > b.month || (m === b.month && d > b.day)) ? y + 1 : y;
}
const fyOfDay = (dayISO, balance) => fyLabel(fyEndYearOf(dayISO, balance));
const currentFY = (today, balance) => fyOfDay(today, balance);
function fyRange(label, balance) {
  const e = endYearOfLabel(label), b = parseBalance(balance);
  if (e === null) return null;
  const pad = n => String(n).padStart(2, '0');
  const end = e + '-' + pad(b.month) + '-' + pad(b.day);
  const prevEnd = (e - 1) + '-' + pad(b.month) + '-' + pad(b.day);
  const start = new Date(Date.parse(prevEnd + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  return { start, end };
}
// Work that is for the year just ended but done after it (tax returns, annual accounts) belongs to the earlier year.
const ANNUAL_WORK = /annual accounts|income tax|\bir[ -]?3\b|\bir[ -]?4\b|\bir[ -]?6\b|annual return|financial statements|year[- ]end/i;
function isAnnualWork(task) { return ANNUAL_WORK.test(String((task && task.name) || '') + ' ' + String((task && task.service) || '')); }
function defaultFY(task, client, dayOf) {
  const bal = client && client.balanceDate;
  const ref = (task && (task.clientDate || task.internalDeadline)) || (task && task.createdAt ? dayOf(task.createdAt) : null);
  if (!ref) return null;
  let end = fyEndYearOf(ref, bal);
  if (isAnnualWork(task)) {                                // due in the first six months after a year closed → it is for that closed year
    const r = fyRange(fyLabel(end), bal), from = r && Date.parse(r.start + 'T12:00:00Z'), at = Date.parse(ref + 'T12:00:00Z');
    if (r && at - from < 183 * 86400000) end -= 1;
  }
  return fyLabel(end);
}
const fyOfTask = (task, client, dayOf) => normalFY(task && task.financialYear) || defaultFY(task, client, dayOf);

// ---------------------------------------------------------------- the standard yearly checklist, by client type
// group: the kind of work, so several rows can share one pool of tasks (the first GST return found is period 1, the next period 2…)
// match: words in the task name or job type that say it is that work · dueMonthsAfterYearEnd: when the row is due if nothing has been started
const DEFAULT_CHECKLISTS = {
  Rideshare: [
    { group: 'gst', label: 'GST return, period {n}', match: 'gst', count: 3 },
    { group: 'annual', label: 'Annual accounts + income tax', match: 'annual accounts|income tax|ir[ -]?3|ir[ -]?4|financial statements', dueMonthsAfterYearEnd: 4 },
  ],
  Company: [
    { group: 'gst', label: 'GST return, period {n}', match: 'gst', count: 3 },
    { group: 'annual', label: 'Annual accounts + income tax', match: 'annual accounts|income tax|ir[ -]?4|financial statements', dueMonthsAfterYearEnd: 4 },
    { group: 'return', label: 'Annual return (Companies Office)', match: 'annual return|companies office', dueMonthsAfterYearEnd: 5 },
  ],
  Rental: [
    { group: 'schedule', label: 'Rental schedule', match: 'rental schedule|rental income|rental statement' },
    { group: 'annual', label: 'Income tax return', match: 'income tax|ir[ -]?3|ir[ -]?4', dueMonthsAfterYearEnd: 4 },
  ],
};
function expandTemplate(items) {
  const out = [];
  for (const it of items || []) {
    const n = Math.max(1, Number(it.count) || 1);
    for (let i = 1; i <= n; i++) out.push({ group: it.group, label: String(it.label).replace('{n}', i), match: it.match, dueMonthsAfterYearEnd: it.dueMonthsAfterYearEnd || null, index: i - 1 });
  }
  return out;
}
function templateFor(type, custom) {
  const t = String(type || '').trim();
  const src = (custom && custom[t]) || DEFAULT_CHECKLISTS[t];
  return src ? expandTemplate(src) : null;
}
function validateTemplates(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'Send an object of client type → list of rows.';
  for (const [type, rows] of Object.entries(obj)) {
    if (!type.trim() || type.length > 60) return 'Each client type needs a short name.';
    if (!Array.isArray(rows) || rows.length > 30) return 'Each client type needs a list of up to 30 rows.';
    for (const r of rows) {
      if (!r || !r.group || !r.label || !r.match) return 'Each row needs a group, a label and words to match.';
      try { new RegExp(String(r.match), 'i'); } catch (e) { return 'The words to match must be a valid pattern: ' + r.match; }
    }
  }
  return null;
}

// ---------------------------------------------------------------- one row's state, from the work card
const TONE = { ok: 'ok', warn: 'warn', bad: 'bad', info: 'info', grey: 'grey' };
function stateOfCard(card) {
  if (!card) return { key: 'none', label: 'No work', tone: TONE.grey };
  if (card.status === 'Completed') return card.primaryStatus === 'Cancelled' ? { key: 'cancelled', label: 'Cancelled', tone: TONE.grey } : { key: 'done', label: 'Done', tone: TONE.ok };
  if (card.status === 'Approved') return card.primaryStatus === 'Ready to Send' ? { key: 'approved_unsent', label: 'Approved, not sent', tone: TONE.bad } : { key: 'profit', label: 'Profit check', tone: TONE.warn };
  if (card.status === 'Correction Required') return { key: 'fix', label: 'Fix needed', tone: TONE.bad };
  const risk = (card.clientRisk || {}).state;
  if (risk === 'overdue') return { key: 'late', label: 'Not sent', tone: TONE.bad };
  if (risk === 'due_today') return { key: 'due_today', label: 'Due today', tone: TONE.warn };
  if (card.status === 'On Hold') return card.waitingOn && card.waitingOn.kind === 'client' ? { key: 'waiting_client', label: 'Waiting on client', tone: TONE.warn } : { key: 'hold', label: 'On hold', tone: TONE.warn };
  if (risk === 'at_risk') return { key: 'at_risk', label: 'At risk', tone: TONE.warn };
  if (card.status === 'In Review') return { key: 'in_review', label: 'In review', tone: TONE.info };
  return { key: 'on_track', label: 'On track', tone: TONE.ok };
}
const BAD_KEYS = new Set(['approved_unsent', 'fix', 'late']);

// ---------------------------------------------------------------- the yearly checklist for one client and one year
// tasks: this client's tasks (not removed). cardOf(task) → the work card. dayOf(timestamp) → NZ day.
function buildChecklist({ client, fy, tasks, cardOf, dayOf, custom }) {
  const rows = templateFor(client && client.type, custom);
  if (!rows) return null;
  const bal = client.balanceDate;
  const inYear = tasks.filter(t => fyOfTask(t, client, dayOf) === fy && (cardOf(t) || {}).primaryStatus !== 'Cancelled');
  const when = t => String(t.clientDate || t.internalDeadline || (t.createdAt ? dayOf(t.createdAt) : '') || '');
  const pools = {}, taken = new Set();
  // finished work fills the first rows (in the order it was done), then what is still open
  const finished = t => Number((cardOf(t) || {}).status === 'Completed');
  for (const t of inYear.slice().sort((a, b) => (finished(b) - finished(a)) || when(a).localeCompare(when(b)) || String(a.id).localeCompare(String(b.id)))) {
    const text = String(t.name || '') + ' ' + String(t.service || '') + ' ' + String(t.scope || '');
    const row = rows.find(r => new RegExp(r.match, 'i').test(text));
    if (!row) continue;
    (pools[row.group] = pools[row.group] || []).push(t);
  }
  const end = fyRange(fy, bal);
  const items = rows.map(r => {
    const t = (pools[r.group] || [])[r.index] || null;
    if (t) taken.add(t.id);
    if (!t) {
      let due = null;
      if (r.dueMonthsAfterYearEnd && end) { const e = new Date(Date.parse(end.end + 'T12:00:00Z')); e.setUTCMonth(e.getUTCMonth() + r.dueMonthsAfterYearEnd); due = MONTHS[e.getUTCMonth()] + ' ' + e.getUTCFullYear(); }
      return { label: r.label, group: r.group, taskId: null, state: 'todo', pill: due ? 'Due ' + due : 'Not started', tone: TONE.grey, done: false, due: null };
    }
    const st = stateOfCard(cardOf(t));
    return { label: r.label, group: r.group, taskId: t.id, state: st.key, pill: st.label, tone: st.tone, done: st.key === 'done', due: t.clientDate || t.internalDeadline || null };
  });
  return { fy, total: items.length, done: items.filter(i => i.done).length, items, otherWork: inYear.filter(t => !taken.has(t.id)).length };
}

// ---------------------------------------------------------------- a client's status, from its open work
function clientStatus({ openCards, checklist }) {
  const states = openCards.map(c => ({ c, s: stateOfCard(c) }));
  const order = ['approved_unsent', 'fix', 'late', 'due_today', 'waiting_client', 'hold', 'at_risk', 'in_review', 'on_track'];
  const worst = states.sort((a, b) => order.indexOf(a.s.key) - order.indexOf(b.s.key))[0];
  if (worst) return { key: worst.s.key, label: worst.s.label, tone: worst.s.tone, late: BAD_KEYS.has(worst.s.key), waiting: worst.s.key === 'waiting_client' };
  if (checklist && checklist.total && checklist.done >= checklist.total) return { key: 'up_to_date', label: 'Up to date', tone: TONE.ok, late: false, waiting: false };
  return { key: 'no_open', label: 'No open work', tone: TONE.grey, late: false, waiting: false };
}

module.exports = {
  MONTHS, DEFAULT_BALANCE, DEFAULT_CHECKLISTS, parseBalance, balanceLabel, fyLabel, endYearOfLabel, validFY, normalFY, fyEndYearOf, fyOfDay, currentFY, fyRange,
  isAnnualWork, defaultFY, fyOfTask, expandTemplate, templateFor, validateTemplates, stateOfCard, buildChecklist, clientStatus, BAD_KEYS,
};
