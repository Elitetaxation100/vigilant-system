// Manager views end to end on a REAL server (throwaway data): My Team, Needs Manager Attention, the paginated Tasks list, the
// Calendar and Timeline, and the audited manager actions. Everything is read-only except POST /api/tasks/:id/manager-change.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-mgr-'));
let child;
const enc = encodeURIComponent;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SH, PK, RJ, DI, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const wf = (tok, p) => http('GET', '/api/workflow/' + p, { token: tok });
async function mk(name, assignee, extra) {
  const r = await http('POST', '/api/tasks', { token: SH, body: { mode: 'team', name, clientId: client.id, assignedTo: assignee.id, tat: 0.25, internalDeadline: day(3), clientDate: day(9), ...(extra || {}) } });
  assert.equal(r.status, 201, name + ' ' + JSON.stringify(r.j));
  return r.j.task;
}
async function submit(t, tok, reviewer) {
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: tok })).status, 200);
  const c = await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: tok, body: { reviewerId: reviewer.id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } });
  assert.equal(c.status, 200, JSON.stringify(c.j));
}

test('setup: thirty client tasks spread across the team', async () => {
  SH = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  PK = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SH })).j.employees;
  client = (await http('POST', '/api/clients', { token: SH, body: { name: 'Mgr Ltd', email: 'mg' + Date.now() + '@t.co' } })).j.client;
  const people = ['ranjit', 'disha', 'anjana', 'suneha', 'khushi', 'diksha'].map(emp).filter(Boolean);
  let n = 0;
  for (let i = 0; i < 30; i++) { const p = people[i % people.length]; await mk('Bulk ' + String(i).padStart(2, '0'), p, { internalDeadline: day(2 + (i % 5)) }); n++; }
  assert.equal(n, 30);
});

test('only managers reach the manager views — an employee is refused everywhere, sign-in is required', async () => {
  for (const p of ['team', 'tasks', 'calendar', 'timeline']) {
    assert.equal((await wf(RJ, p)).status, 403, p + ' for an employee');
    assert.equal((await http('GET', '/api/workflow/' + p)).status, 401, p + ' without sign-in');
  }
  const t = (await wf(PK, 'tasks?pageSize=25')).j.rows[0];
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/manager-change`, { token: RJ, body: { action: 'change_due', reason: 'x y z', internalDeadline: day(5) } })).status, 403);
});

test('Tasks list: server-side pages never repeat or skip a task, totals are exact, page numbers are clamped', async () => {
  const p1 = (await wf(PK, 'tasks?pageSize=25&sort=internal&page=1')).j;
  assert.equal(p1.pageSize, 25); assert.equal(p1.rows.length, 25); assert.ok(p1.total >= 30); assert.equal(p1.pages, Math.ceil(p1.total / 25));
  const seen = new Set(p1.rows.map(r => r.id));
  for (let p = 2; p <= p1.pages; p++) { const r = (await wf(PK, `tasks?pageSize=25&sort=internal&page=${p}`)).j; r.rows.forEach(x => { assert.ok(!seen.has(x.id), 'duplicate across pages'); seen.add(x.id); }); }
  assert.equal(seen.size, p1.total, 'every task appears on exactly one page');
  assert.equal((await wf(PK, 'tasks?page=999')).j.page, p1.pages, 'a page beyond the end lands on the last');
  assert.equal((await wf(PK, 'tasks?page=-4')).j.page, 1);
  assert.equal((await wf(PK, 'tasks?pageSize=7')).j.pageSize, 25, 'only 25 / 50 / 100 are allowed');
  assert.equal((await wf(PK, 'tasks?pageSize=100')).j.pageSize, 100);
  const sorted = (await wf(PK, 'tasks?pageSize=100&sort=internal')).j.rows.map(r => r.internalDeadline || '9999');
  assert.deepEqual(sorted, [...sorted].sort(), 'sorted by internal due date');
});

test('Tasks list: every filter narrows to exactly what it says, and filters combine', async () => {
  const rj = emp('ranjit');
  const byEmp = (await wf(PK, `tasks?employee=${enc(rj.id)}&pageSize=100`)).j;
  assert.ok(byEmp.total > 0 && byEmp.rows.every(r => r.assigneeId === rj.id));
  const st = (await wf(PK, 'tasks?status=Assigned&pageSize=100')).j;
  assert.ok(st.total > 0 && st.rows.every(r => r.status === 'Assigned'));
  const both = (await wf(PK, `tasks?status=Assigned&employee=${enc(rj.id)}&pageSize=100`)).j;
  assert.ok(both.total > 0 && both.total <= Math.min(st.total, byEmp.total) && both.rows.every(r => r.status === 'Assigned' && r.assigneeId === rj.id));
  assert.equal((await wf(PK, 'tasks?q=' + enc('bulk 07'))).j.rows[0].name, 'Bulk 07', 'search by name');
  assert.equal((await wf(PK, 'tasks?q=' + enc('nothing-matches-this'))).j.total, 0);
  const cl = (await wf(PK, 'tasks?client=' + enc('Mgr Ltd') + '&pageSize=100')).j;
  assert.ok(cl.total >= 30 && cl.rows.every(r => r.clientName === 'Mgr Ltd'));
  assert.ok((await wf(PK, 'tasks?type=admin&pageSize=100')).j.rows.every(r => r.kindLabel === 'Admin Task'));
  assert.ok((await wf(PK, 'tasks?waitingOn=employee&pageSize=100')).j.rows.every(r => r.waitingOn.kind === 'employee'));
  assert.equal((await wf(PK, 'tasks?due=overdue')).j.rows.filter(r => r.internalDeadline >= day(0)).length, 0);
  const ids = byEmp.rows.slice(0, 3).map(r => r.id);
  const exact = (await wf(PK, 'tasks?pageSize=25&ids=' + enc(ids.join('|')))).j;
  assert.deepEqual(exact.rows.map(r => r.id).sort(), [...ids].sort(), 'the exact records behind a count');
  const f = (await wf(PK, 'tasks')).j.facets;
  assert.ok(f.employees.length > 3 && f.clients.includes('Mgr Ltd'));
});

test('My Team: each number is exactly the list it opens, and the oldest task is real', async () => {
  const T = (await wf(PK, 'team')).j;
  const rj = T.team.find(p => p.id === emp('ranjit').id);
  assert.ok(rj && rj.openActionable > 0);
  assert.equal(rj.ids.open.length, rj.openActionable);
  const open = (await wf(PK, `tasks?pageSize=100&ids=${enc(rj.ids.open.join('|'))}`)).j;
  assert.equal(open.total, rj.openActionable);
  assert.ok(open.rows.every(r => r.assigneeId === rj.id && r.waitingOn.kind === 'employee'));
  assert.ok(rj.allocatedOpenHours > 0 && rj.oldest && rj.oldest.ageDays >= 0);
  assert.ok(!T.team.some(p => p.id === PK_ID()), 'the manager is not listed as their own report');
  const none = T.team.find(p => p.ids.open.length === 0);
  if (none) assert.equal(none.openActionable, 0);
});
const PK_ID = () => emp('parvinder').id;

test('Needs Manager Attention lists only real exceptions (never healthy work) and each carries what is wrong', async () => {
  let A;
  const healthy = (await mk('Healthy one', emp('disha'))).id;
  A = (await wf(PK, 'team')).j.attention;
  assert.equal(A.filter(a => a.id === healthy).length, 0, 'a healthy task is never an exception');
  const un = (await http('POST', '/api/tasks', { token: SH, body: { mode: 'team', name: 'Nobody owns me', clientId: client.id, tat: 1, internalDeadline: day(3), clientDate: day(9) } }));
  if (un.status === 201) assert.ok((await wf(PK, 'team')).j.attention.some(a => a.id === un.j.task.id && a.type === 'unassigned'));
  A.forEach(a => { assert.ok(a.label && a.type && a.id); });
});

test('repeated returns become an exception once a task has been returned twice', async () => {
  const t = await mk('Returned twice', emp('ranjit'));
  await submit(t, RJ, emp('parvinder'));
  const ret = n => http('POST', `/api/tasks/${enc(t.id)}/review`, { token: PK, body: { status: 'error', note: 'fix it ' + n, faultType: 'processor' } });
  assert.equal((await ret(1)).status, 200);
  assert.ok(!(await wf(PK, 'team')).j.attention.some(a => a.id === t.id && a.type === 'repeated_return'), 'once is not repeated');
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: RJ })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/resubmit`, { token: RJ })).status, 200);
  assert.equal((await ret(2)).status, 200);
  assert.ok((await wf(PK, 'team')).j.attention.some(a => a.id === t.id && a.type === 'repeated_return'));
});

test('manager-change: a reason is mandatory, every change is audited and the people affected are told', async () => {
  const t = await mk('Move my dates', emp('ranjit'));
  const go = (body, tok) => http('POST', `/api/tasks/${enc(t.id)}/manager-change`, { token: tok || PK, body });
  assert.equal((await go({ action: 'change_due', internalDeadline: day(6) })).status, 400, 'no reason');
  assert.equal((await go({ action: 'change_due', internalDeadline: day(6), reason: ' ' })).status, 400);
  assert.equal((await go({ action: 'nope', reason: 'because' })).status, 400, 'unknown action');
  assert.equal((await go({ action: 'change_due', internalDeadline: day(-3), reason: 'in the past' })).status, 400, 'no past dates');
  const ok = await go({ action: 'change_due', internalDeadline: day(6), clientDate: day(12), reason: 'Client sent more documents', requestId: 'req-1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  const task = ok.j.task;
  assert.equal(task.internalDeadline, day(6)); assert.equal(task.clientDate, day(12));
  assert.equal(task.originalInternalDeadline, day(3), 'the first date is kept forever'); assert.equal(task.originalClientDate, day(9));
  assert.equal(task.dateHistory.length, 1); assert.equal(task.dateHistory[0].note, 'Client sent more documents');
  assert.equal(task.managerActions.length, 1); assert.equal(task.managerActions[0].action, 'change_due'); assert.equal(task.managerActions[0].by, emp('parvinder').id);
  // a second change keeps the ORIGINAL, never replaces it
  const again = await go({ action: 'change_due', internalDeadline: day(7), reason: 'Reviewer is away' });
  assert.equal(again.j.task.originalInternalDeadline, day(3)); assert.equal(again.j.task.dateHistory.length, 2);
  // double click with the same request id is not applied twice
  const dup = await go({ action: 'change_due', internalDeadline: day(8), reason: 'double click', requestId: 'req-1' });
  assert.equal(dup.status, 200); assert.equal(dup.j.duplicate, true);
  assert.equal((await go({ action: 'change_due', internalDeadline: day(7), reason: 'x y' }, RJ)).status, 403, 'an employee cannot');
  // the assignee was told about the new dates
  const notes = (await http('GET', '/api/notifications', { token: RJ })).j.notifications || [];
  assert.ok(notes.some(n => /changed the dates/.test(n.text) && /Move my dates/.test(n.text)), 'assignee notified');
  // the manager list shows the change
  const row = (await wf(PK, `tasks?ids=${enc(t.id)}`)).j.rows[0];
  assert.equal(row.dateChanged, true); assert.equal(row.originalInternal, day(3));
  assert.ok((await wf(PK, 'team')).j.attention.some(a => a.id === t.id && a.type === 'date_changed'));
});

test('manager-change: reassign and change reviewer follow the same boundaries as the existing actions', async () => {
  const t = await mk('Hand this over', emp('ranjit'));
  const go = body => http('POST', `/api/tasks/${enc(t.id)}/manager-change`, { token: PK, body });
  assert.equal((await go({ action: 'reassign', newAssigneeId: emp('disha').id })).status, 400, 'reason first');
  const r = await go({ action: 'reassign', newAssigneeId: emp('disha').id, reason: 'Ranjit is full this week' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.task.assignedTo, emp('disha').id); assert.equal(r.j.task.reassignHistory.at(-1).reason, 'Ranjit is full this week');
  assert.equal(r.j.task.managerActions.at(-1).action, 'reassign');
  assert.equal((await go({ action: 'reassign', newAssigneeId: emp('disha').id, reason: 'same person' })).status, 400, 'already with them');
  assert.equal((await go({ action: 'reassign', newAssigneeId: 'nobody', reason: 'no such person' })).status, 400);
  const rv = await go({ action: 'change_reviewer', reviewerId: emp('shubham').id, reason: 'Founder to review this one' });
  assert.equal(rv.status, 200); assert.equal(rv.j.task.reviewerId, emp('shubham').id);
  assert.equal((await go({ action: 'change_reviewer', reviewerId: emp('ranjit').id, reason: 'an employee' })).status, 400, 'a reviewer must be a manager');
  assert.equal((await go({ action: 'change_reviewer', reviewerId: emp('disha').id, reason: 'doing the work' })).status, 400, 'not the person doing the work');
  assert.equal((await http('POST', `/api/tasks/${enc('missing')}/manager-change`, { token: PK, body: { action: 'reassign', reason: 'none' } })).status, 404);
});

test('Calendar and Timeline: internal and client dates appear, filter by employee and range, finished work is left out', async () => {
  const C = (await wf(PK, 'calendar')).j;
  assert.ok(C.events.length > 30 && C.legend.red && C.today);
  assert.ok(C.events.some(e => e.kind === 'internal') && C.events.some(e => e.kind === 'client'));
  const ordered = C.events.map(e => e.date); assert.deepEqual(ordered, [...ordered].sort());
  const rj = emp('ranjit');
  const mine = (await wf(PK, `calendar?employee=${enc(rj.id)}`)).j.events;
  assert.ok(mine.length > 0 && mine.length < C.events.length);
  const range = (await wf(PK, `calendar?from=${day(2)}&to=${day(3)}`)).j.events;
  assert.ok(range.length > 0 && range.every(e => e.date >= day(2) && e.date <= day(3)));
  C.events.forEach(e => assert.ok(['red', 'amber', 'blue', 'purple', 'green', 'grey'].includes(e.tone)));
  const T = (await wf(PK, 'timeline')).j;
  assert.ok(T.rows.length > 20); T.rows.forEach(r => { assert.ok(r.start <= r.end, 'a bar never runs backwards'); });
  assert.ok((await wf(PK, `timeline?employee=${enc(rj.id)}`)).j.rows.length < T.rows.length);
});

test('the manager views change nothing: reading them leaves every task exactly as it was', async () => {
  const before = JSON.stringify((await http('GET', '/api/tasks', { token: SH })).j.tasks);
  for (const p of ['team', 'tasks?pageSize=100', 'calendar', 'timeline']) await wf(PK, p);
  assert.equal(JSON.stringify((await http('GET', '/api/tasks', { token: SH })).j.tasks), before);
});
