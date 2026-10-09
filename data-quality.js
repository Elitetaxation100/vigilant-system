// A read-only data-quality report. It FINDS things and says what to do about them — it never changes, merges or deletes anything.
// Every finding names the record, why it was flagged, and a suggested fix for a person to decide.

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) {                                 // edit distance with adjacent swaps counted as ONE edit (retrun → return)
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s()-]{7,}\d)/;          // 9+ digits with spaces / dashes / brackets allowed
const FAKE_CLIENT = /^(internal|admin task|admin|n\/a|na|none|test|testing|xxx+|tbc|unknown|-+|\?+)$/i;
// Words the firm uses all the time. A name word one letter away from one of these (but not equal) is a likely typo.
const VOCAB = ['return', 'returns', 'payroll', 'invoice', 'invoices', 'accounts', 'account', 'bookkeeping', 'reconciliation', 'statement', 'statements', 'rental', 'rideshare', 'company', 'submission', 'provisional', 'annual', 'review', 'filing', 'client', 'income', 'expenses', 'depreciation', 'schedule', 'amendment', 'assessment', 'summary'];

function build(state, opts) {
  const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
  const isSystem = (opts && opts.isSystemAccount) || (() => false);
  const rows = [];
  const add = (category, severity, recordType, id, label, detail, suggestion) => rows.push({ category, severity, recordType, id, label, detail, suggestion });
  const emps = state.employees || [], tasks = state.tasks || [], clients = state.clients || [];

  // ---- people
  for (let i = 0; i < emps.length; i++) for (let j = i + 1; j < emps.length; j++) {
    const a = emps[i], b = emps[j], na = norm(a.name), nb = norm(b.name); if (!na || !nb) continue;
    const fa = na.split(' ')[0], fb = nb.split(' ')[0];
    const same = na === nb || (fa.length >= 4 && fb.length >= 4 && lev(fa, fb) <= 1) || (Math.min(na.length, nb.length) >= 5 && lev(na, nb) <= 2);
    if (same) add('duplicate_user', 'review', 'employee', a.id + '|' + b.id, a.name + ' / ' + b.name, 'Two accounts with very similar names (' + (a.email || '—') + ' and ' + (b.email || '—') + ').', 'Check whether these are one person. If so, keep one login and re-point the other\'s tasks; do not delete either until their history is moved.');
  }
  for (const e of emps) {
    if (isSystem(e)) add('system_or_test_user', 'review', 'employee', e.id, e.name, 'Looks like a placeholder, test or shared login (' + (e.email || 'no email') + ').', 'Keep it out of Productivity and capacity (it already is by default). Rename it, disable it, or mark it countsInProductivity only if it really is a person.');
    if (String(e.email || '').toLowerCase() === 'hr@elitetaxation.co.nz') add('hr_in_productivity', 'info', 'employee', e.id, e.name, 'The shared HR login is excluded from Productivity and capacity by default.', 'Nothing to do unless HR does productive work under this login; then set countsInProductivity: true on it.');
  }

  // ---- tasks
  for (const t of tasks) {
    const isClient = t.kind !== 'internal', nm = String(t.name || ''), cn = String(t.clientName || '').trim();
    const label = '#' + String(t.id).replace('#', '') + ' ' + nm;
    if (isClient && !t.clientId) add('missing_client', 'fix', 'task', t.id, label, 'A Client Task with no client record.', 'Link the real client (Tasks → ⋯ → Edit), or change the task to an Admin Task.');
    if (isClient && cn && FAKE_CLIENT.test(cn)) add('fake_client_value', 'fix', 'task', t.id, label, 'The client is "' + cn + '", which is not a client.', 'Replace it with the real client, or change the task to an Admin Task.');
    if (t.kind === 'internal' && (t.clientId || t.cashbookLink)) add('wrong_classification', 'fix', 'task', t.id, label, 'Typed Admin Task, but it carries a client' + (t.cashbookLink ? ' / Cashbook link' : '') + '.', 'If it is client work, switch it to a Client Task (this also gives it a report to send and profit confirmation).');
    if (isClient && cn.toLowerCase() === 'internal') add('wrong_classification', 'fix', 'task', t.id, label, 'Typed Client Task, but the client is "Internal".', 'Make it an Admin Task, or pick the real client.');
    if (t.status !== 'completed' || t.reviewStatus !== 'done') {
      const h = t.productivityAllocatedHoursSnapshot != null ? Number(t.productivityAllocatedHoursSnapshot) : Number(t.tat);
      if (!(h > 0)) add('zero_allocated_hours', 'fix', 'task', t.id, label, 'Allocated hours are ' + (Number.isFinite(h) ? h : 'missing') + '.', 'Set the agreed hours. A zero-hour task earns nothing in Productivity.');
    }
    // client work closed WITHOUT a review and without a manager exception: it earned (or would earn) productivity it should not have
    if (isClient && t.status === 'completed' && t.reviewStatus === 'done' && !t.noReviewAuthorizedAt) {
      add('client_closed_no_review', 'fix', 'task', t.id, label, 'Client task closed with no review, no reviewer on record' + (t.reviewerId ? '' : ' (none was ever chosen)') + ' and no manager exception. It earns NO productivity until a manager records an exception.', 'Send it for review (Reopen for re-review), or have an authorised manager record the exception with a reason. Nothing is changed automatically.');
    }
    if (!t.internalDeadline && t.status !== 'completed') add('missing_internal_due', 'fix', 'task', t.id, label, 'No internal due date.', 'Give it a due date so it can be planned and measured.');
    if (EMAIL_RE.test(nm)) add('email_in_title', 'privacy', 'task', t.id, label, 'The title contains an email address (' + (nm.match(EMAIL_RE) || [''])[0].replace(/(.).*@/, '$1***@') + ').', 'Remove the address from the title and put it in the instructions or the client record.');
    if (PHONE_RE.test(nm.replace(EMAIL_RE, ''))) add('phone_in_title', 'privacy', 'task', t.id, label, 'The title contains a phone number.', 'Remove the number from the title; keep it on the client record.');
    const words = norm(nm).split(' ').filter(w => w.length >= 5);
    const typos = [...new Set(words.filter(w => !VOCAB.includes(w) && VOCAB.some(v => Math.abs(v.length - w.length) <= 1 && lev(w, v) === 1)))];
    if (typos.length || /(.)\1{2,}/.test(nm)) add('possible_misspelling', 'info', 'task', t.id, label, typos.length ? 'Possible typo: ' + typos.join(', ') + '.' : 'Repeated letters in the name.', 'Fix the spelling so reports and searches find it. (A guess — ignore it if the name is right.)');
  }

  // ---- task types (department / service): the same thing spelled two ways
  const seen = {};
  for (const d of ((state.taxonomy || {}).departments || [])) {
    const k = norm(d.name); (seen[k] = seen[k] || []).push(d.name);
    const sv = {}; for (const s of (d.services || [])) (sv[norm(s)] = sv[norm(s)] || []).push(s);
    for (const [k2, list] of Object.entries(sv)) if (list.length > 1) add('duplicate_task_type', 'review', 'taxonomy', d.name + '/' + k2, d.name + ' › ' + list[0], 'The service is listed more than once (' + list.join(' / ') + ').', 'Merge the duplicates in Task Types — existing tasks keep working.');
  }
  for (const [k, list] of Object.entries(seen)) if (list.length > 1) add('duplicate_task_type', 'review', 'taxonomy', k, list[0], 'The department is listed more than once (' + list.join(' / ') + ').', 'Merge the duplicates in Task Types.');
  const scopes = {};
  for (const t of tasks) { const s = String(t.scope || '').trim(); if (s && s !== '—') (scopes[norm(s)] = scopes[norm(s)] || new Set()).add(s); }
  for (const [k, set] of Object.entries(scopes)) if (set.size > 1) add('duplicate_task_type', 'info', 'task_scope', k, [...set][0], 'The same task type is spelled ' + set.size + ' ways: ' + [...set].join(' | ') + '.', 'Pick one spelling and use the Task Types list.');

  // ---- clients with placeholder names
  for (const c of clients) if (FAKE_CLIENT.test(String(c.name || '').trim())) add('fake_client_value', 'fix', 'client', c.id, c.name, 'The client record itself is named "' + c.name + '".', 'Rename it to the real client or retire it.');

  const order = { fix: 0, privacy: 1, review: 2, info: 3 };
  rows.sort((a, b) => (order[a.severity] - order[b.severity]) || a.category.localeCompare(b.category) || String(a.id).localeCompare(String(b.id)));
  const counts = {}; rows.forEach(r => counts[r.category] = (counts[r.category] || 0) + 1);
  return { generatedAt: today, readOnly: true, total: rows.length, counts, rows };
}

const csvCell = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCsv(report) {
  const head = ['category', 'severity', 'record type', 'record id', 'record', 'what we found', 'suggested fix', 'decision (yours)'];
  return [head, ...report.rows.map(r => [r.category, r.severity, r.recordType, r.id, r.label, r.detail, r.suggestion, ''])].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
module.exports = { build, toCsv, lev, norm };
