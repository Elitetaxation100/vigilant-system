// New Task (Client Task / Admin Task): priority, instructions, the delivery choices made at creation, and how they carry through review.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-nt-'));
let child;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j };
}
const login = async (e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, PA, RJ, DI, E, clientId;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const q = id => encodeURIComponent(id);
const mk = (body, tok) => http('POST', '/api/tasks', { token: tok || PA, body: { mode: 'team', name: 'NT ' + Math.random().toString(36).slice(2, 6), assignedTo: emp('ranjit').id, tat: 1, internalDeadline: '2026-12-30', taskKind: 'client', clientId, reviewerId: emp('parvinder').id, ...body } });
async function submit(id, body) {
  assert.equal((await http('POST', `/api/tasks/${q(id)}/accept`, { token: RJ })).status, 200);
  return http('POST', `/api/tasks/${q(id)}/complete`, { token: RJ, body: { sheetLink: 'https://docs.google.com/spreadsheets/d/x', ...body } });
}
const approve = (id, o) => http('POST', `/api/tasks/${q(id)}/review-decision`, { token: PA, body: { decision: 'approve', clean: true, profitRequired: false, requestId: 'r' + Math.random(), ...o } });

test('setup', async () => {
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee'); DI = await login('disha', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'NT Ltd', email: 'nt@t.co' } })).j.client.id;
});
test('priority and instructions are saved; a bad priority is refused', async () => {
  const ok = await mk({ priority: 'high', instructions: '  Use the 2025 workbook.  ' });
  assert.equal(ok.status, 201, JSON.stringify(ok.j)); assert.equal(ok.j.task.priority, 'high'); assert.equal(ok.j.task.instructions, 'Use the 2025 workbook.');
  assert.equal((await mk({ priority: 'whenever' })).status, 400);
  const def = await mk({}); assert.equal(def.status, 201); assert.equal(def.j.task.priority, null);
});
test('delivery choices are kept on a client task and are absent on an Admin Task', async () => {
  const c = await mk({ reportRequired: true, reportSenderId: emp('disha').id, profitRequired: true });
  assert.equal(c.status, 201, JSON.stringify(c.j));
  assert.equal(c.j.task.reportRequired, true); assert.equal(c.j.task.reportSenderId, emp('disha').id); assert.equal(c.j.task.profitRequiredDefault, true);
  const a = await mk({ taskKind: 'admin', clientId: undefined, reviewRequired: false, reportRequired: true, reportSenderId: emp('disha').id, profitRequired: true });
  assert.equal(a.status, 201, JSON.stringify(a.j));
  assert.ok(a.j.task.reportRequired === undefined && a.j.task.reportSenderId === undefined, 'an Admin Task has no report sender');
  assert.equal((await mk({ reportSenderId: 'nobody' })).status, 400);
});
test('on approval the report goes to the sender chosen at creation, not automatically the processor', async () => {
  const t = (await mk({ reportSenderId: emp('disha').id })).j.task;
  assert.equal((await submit(t.id, {})).status, 200);
  const a = await approve(t.id, {});
  assert.equal(a.status, 200, JSON.stringify(a.j));
  assert.equal(a.j.task.reportSendOwner, emp('disha').id); assert.equal(a.j.task.awaitingClientDecision, true);
});
test('"no report needed" at creation closes the task at approval instead of leaving a report to send', async () => {
  const t = (await mk({ reportRequired: false })).j.task;
  assert.equal((await submit(t.id, {})).status, 200);
  const a = await approve(t.id, {});
  assert.equal(a.status, 200, JSON.stringify(a.j));
  assert.equal(a.j.task.awaitingClientDecision, false); assert.equal(a.j.task.reportDeliveryStatus, 'sending_not_required');
  const row = (await http('GET', `/api/workflow/tasks?ids=${q(t.id)}`, { token: PA })).j.rows[0];
  assert.equal(row.status, 'Completed');
});
test('a task that looks like client work but is typed Admin shows up as a classification exception', async () => {
  const t = (await mk({ taskKind: 'admin', clientId: undefined, reviewRequired: false, cashbookLink: 'https://cashbook.example.com/customer/9' })).j.task;
  const team = (await http('GET', '/api/workflow/team', { token: PA })).j;
  assert.ok(team.attention.some(a => a.id === t.id && a.type === 'bad_classification'));
});
