// Task history + the employee's own (internal) commitment: every hand-in is kept with its time, the commitment is judged on the FIRST hand-in,
// a client-query wait is not counted against the employee, and a query shows the moment it was raised — not a made-up 05:30.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const workflow = require('./workflow');
const cal = require('./calendar');

// ---- the rule itself (no server): commitmentTag
const nzDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const deps = (shift = 0) => ({ nzDay, queryShiftDays: () => shift, addWorkingDays: cal.addWorkingDays });
const base = over => ({ kind: 'client', clientId: 'c1', clientDate: '2026-10-09', internalDeadline: '2026-10-05', ...over });

test('submitted on time at the first attempt stays MET through a reviewer sending it back — and through the resubmission', () => {
  const t = base({ firstSubmittedAt: '2026-10-05T01:00:00Z', completedAt: '2026-10-08T01:00:00Z', reworkCount: 1 });
  for (const st of ['Correction Required', 'In Review', 'Approved', 'Completed']) {
    const c = workflow.commitmentTag(t, st, '2026-10-09', deps());
    assert.equal(c.key, 'met', st); assert.match(c.detail, /Submitted 2026-10-05 — due 2026-10-05/);
  }
});
test('a task really handed in late is a breach — judged on the first hand-in', () => {
  const t = base({ firstSubmittedAt: '2026-10-07T01:00:00Z', completedAt: '2026-10-07T01:00:00Z' });
  assert.equal(workflow.commitmentTag(t, 'In Review', '2026-10-09', deps()).key, 'breached');
});
test('not yet handed in and the date has passed → breached; the date not yet reached → on track', () => {
  assert.equal(workflow.commitmentTag(base(), 'In Progress', '2026-10-09', deps()).key, 'breached');
  assert.notEqual(workflow.commitmentTag(base({ internalDeadline: '2026-10-12', clientDate: '2026-10-20' }), 'In Progress', '2026-10-09', deps()).key, 'breached');
});
test('time spent waiting for the client moves the internal date, so it is not the employee\'s miss', () => {
  const t = base({ internalDeadline: '2026-10-05' });             // due Mon 5 Oct; the file waited 3 working days on a client query
  const due = workflow.internalDueOf(t, deps(3));
  assert.equal(due, cal.addWorkingDays('2026-10-05', 3));
  assert.notEqual(workflow.commitmentTag(t, 'In Progress', '2026-10-08', deps(3)).key, 'breached', 'inside the moved date');
  assert.equal(workflow.commitmentTag(t, 'In Progress', '2026-10-08', deps(0)).key, 'breached', 'without the freeze it would have been late');
  assert.equal(workflow.card(t, { ...deps(3), today: '2026-10-08', nowMs: Date.now(), nameOf: () => null, canApprove: () => false }).internalDue, due, 'the card carries the date the employee is held to');
});
test('an older task that lost its first submission time: proven on time by the first return, otherwise not claimed as a breach', () => {
  const sent = base({ status: 'rework', reviewEvents: [{ type: 'returned', at: '2026-10-05T03:00:00Z' }], reworkCount: 1 });
  assert.equal(workflow.commitmentTag(sent, 'Correction Required', '2026-10-09', deps()).key, 'met', 'it was already with the reviewer by the due date');
  const unknown = base({ status: 'rework', reviewEvents: [{ type: 'returned', at: '2026-10-08T03:00:00Z' }], reworkCount: 1 });
  const c = workflow.commitmentTag(unknown, 'Correction Required', '2026-10-09', deps());
  assert.equal(c.key, 'na'); assert.match(c.label, /not recorded/);
});

// ---- on a real server
const port = 3100 + Math.floor(Math.random() * 800), baseUrl = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-hist-'));
let child;
const enc = encodeURIComponent;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j };
}
const login = async (e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(baseUrl + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const day = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
let SA, PA, RJ, E, task;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const T = id => '/api/tasks/' + enc(id);
const mine = async () => (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(t => t.id === task.id);

test('every hand-in is kept with its exact time and the dates in force; the first one stays first through rework', async () => {
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'Hist Ltd', email: 'h@t.co' } })).j.client.id;
  task = (await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'History job', taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: today, clientDate: day(9), reviewerId: emp('parvinder').id } })).j.task;
  assert.equal((await http('POST', T(task.id) + '/accept', { token: RJ })).status, 200);
  const before = Date.now();
  assert.equal((await http('POST', T(task.id) + '/complete', { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } })).status, 200);
  let t = await mine();
  assert.equal(t.submissions.length, 1);
  const s1 = t.submissions[0];
  assert.equal(s1.kind, 'review'); assert.equal(s1.byId, emp('ranjit').id); assert.equal(s1.reviewerId, emp('parvinder').id);
  assert.equal(s1.internalDue, today); assert.equal(s1.clientDue, day(9));
  assert.ok(Date.parse(s1.at) >= before - 1000 && Date.parse(s1.at) <= Date.now() + 1000, 'a real time, not a day');
  assert.equal(t.firstSubmittedAt, s1.at);
  // the reviewer sends it back; Ranjit accepts, fixes and resubmits
  assert.equal((await http('POST', T(task.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'r1', category: 'Other', responsibility: 'Employee', dueDate: day(3), note: 'Please redo' } })).status, 200);
  assert.equal((await http('POST', T(task.id) + '/accept', { token: RJ })).status, 200);
  assert.equal((await http('POST', T(task.id) + '/resubmit', { token: RJ })).status, 200);
  t = await mine();
  assert.deepEqual(t.submissions.map(x => x.kind), ['review', 'resubmit']);
  assert.equal(t.firstSubmittedAt, s1.at, 'the first hand-in is never overwritten');
  assert.ok(Date.parse(t.completedAt) >= Date.parse(s1.at));
});

test('a query shows the moment it was raised and taking it off hold shows its time; the internal date is held back by the wait', async () => {
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'Query Ltd', email: 'q@t.co' } })).j.client.id;
  const mk0 = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'Query job', taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(1), clientDate: day(9), reviewerId: emp('parvinder').id } }); assert.equal(mk0.status, 201, JSON.stringify(mk0.j)); const t0 = mk0.j.task;
  assert.equal((await http('POST', T(t0.id) + '/accept', { token: RJ })).status, 200);
  const before = Date.now();
  const h = await http('POST', T(t0.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_QUERY', responsibility: 'client', followUpDate: day(2), detail: 'asked', querySource: 'email' } });
  assert.equal(h.status, 200, JSON.stringify(h.j));
  const q = h.j.task.queries[0];
  assert.ok(q.sentTs && Math.abs(Date.parse(q.sentTs) - before) < 15000, 'exact time of the query: ' + q.sentTs);
  assert.equal(q.sentAt, today, 'the day marker the calendar maths uses is unchanged');
  assert.equal((await http('POST', T(t0.id) + '/unhold', { token: RJ })).status, 200);
  const t1 = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(x => x.id === t0.id);
  assert.ok(t1.holdHistory[0].resumedTs, 'taking it off hold is stamped with its time');
  assert.ok(t1.queries[0].resumedTs);
  assert.ok('effectiveInternalDate' in t1);
});

test('the same-day backdated query keeps the day only (no invented clock time)', async () => {
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'Back Ltd', email: 'b@t.co' } })).j.client.id;
  const t0 = (await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'Backdated job', taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(1), clientDate: day(9), reviewerId: emp('parvinder').id } })).j.task;
  assert.equal((await http('POST', T(t0.id) + '/accept', { token: RJ })).status, 200);
  const h = await http('POST', T(t0.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_QUERY', responsibility: 'client', followUpDate: day(2), querySentAt: day(-1) } });
  assert.equal(h.status, 200, JSON.stringify(h.j));
  assert.equal(h.j.task.queries[0].sentAt, day(-1)); assert.equal(h.j.task.queries[0].sentTs, null);
});

// ---- what the screen shows (page source)
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
test('the history shows each send-for-review with its time and the internal commitment date; queries never show a made-up time', () => {
  assert.match(html, /function fmtStamp\(iso\)\{[^}]*\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(iso\)\) return fmtDate\(iso\)/, 'a date-only value prints the day alone');
  assert.match(html, /timeZone:'Pacific\/Auckland' \}\) \+ ', ' \+ d\.toLocaleTimeString\('en-NZ', \{ hour:'numeric', minute:'2-digit', timeZone:'Pacific\/Auckland' \}\)/, 'always New Zealand time');
  assert.match(html, /const dt = fmtStamp;/);
  const tl = html.slice(html.indexOf('function taskTimelineEvents'), html.indexOf('function taskNewest'));
  assert.match(tl, /Internal commitment <b>\$\{origInternal/, 'the assignment line carries the internal commitment date');
  assert.match(tl, /for review\.' \+ internalNote\(x\.at, first\)/, 'sent for review shows the internal commitment and whether it was on time');
  assert.match(tl, /submitted on time/); assert.match(tl, /submitted after it/);
  assert.match(tl, /sentStamp = q\.sentTs \|\|/); assert.match(tl, /push\(h\.resumedTs \|\| h\.resumedAt/);
  assert.ok(!/push\(q\.sentAt,/.test(tl), 'no query is stamped with a bare day');
  assert.match(html, /Timeline <span[^>]*>\(New Zealand time\)/);
});
test('the details panel offers Reopen for re-review to whoever may do it (the assignee, the assigner, a manager, the reviewer)', () => {
  const panel = html.slice(html.indexOf('function tdDetailHtml'), html.indexOf('MANAGER VIEWS (v2)'));
  assert.match(panel, /iCanSendForReview\(t\) \? '<button type="button" class="btn td-act" onclick="openSendForReviewModal/);
  assert.match(panel, /Reopen for re-review/);
  assert.match(panel, /Internal commitment date/); assert.match(panel, /held to /);
});
