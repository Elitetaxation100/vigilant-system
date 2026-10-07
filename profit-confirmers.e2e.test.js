// Who confirms profit is CONFIGURED (default, team, backup, per-task) — never hard-coded to one person.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-pc-'));
let child;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const login = async (e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, PA, DI, RJ, HU, E, clientId;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const q = id => encodeURIComponent(id);
async function submitted(name) {
  const t = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId, assignedTo: emp('ranjit').id, tat: 2, internalDeadline: '2026-12-30' } });
  const id = t.j.task.id;
  assert.equal((await http('POST', `/api/tasks/${q(id)}/accept`, { token: RJ })).status, 200);
  const c = await http('POST', `/api/tasks/${q(id)}/complete`, { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x' } });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  return id;
}
const approveWithProfit = (id) => http('POST', `/api/tasks/${q(id)}/review-decision`, { token: PA, body: { decision: 'approve', clean: true, profitRequired: true, requestId: 'r' + Math.random() } });

test('setup + the original default still works when nothing is configured', async () => {
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin');
  DI = await login('disha', 'Disha@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee'); HU = await login('hunny', 'Hunny@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'PC Ltd', email: 'pc@t.co' } })).j.client.id;
  const v = (await http('GET', '/api/workflow/profit-confirmers', { token: PA })).j;
  assert.equal(v.default, null); assert.equal(v.effectiveDefault.id, emp('shubham').id); assert.equal(v.effectiveDefault.source, 'legacy');
  assert.equal(emp('shubham').isProfitConfirmer, true); assert.equal(emp('disha').isProfitConfirmer, false);
});
test('only a superadmin changes it; the people must be active managers; backup differs from default', async () => {
  const set = (token, body) => http('POST', '/api/admin/profit-confirmers', { token, body });
  assert.equal((await set(DI, { default: emp('disha').id })).status, 403);
  assert.equal((await set(SA, { default: emp('ranjit').id })).status, 400, 'an employee cannot be the confirmer');
  assert.equal((await set(SA, { default: emp('disha').id, backup: emp('disha').id })).status, 400);
  const ok = await set(SA, { default: emp('disha').id, backup: emp('parvinder').id });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.default.name, emp('disha').name); assert.equal(ok.j.effectiveDefault.source, 'default');
});
test('approval routes to the configured confirmer, who alone (or the backup) can confirm', async () => {
  const id = await submitted('Routed job');
  const r = await approveWithProfit(id);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.task.profitConfirmStatus, 'pending');
  assert.equal(r.j.task.profitConfirmerAssignedId, emp('disha').id);
  assert.equal((await http('POST', `/api/tasks/${q(id)}/profit-confirm/done`, { token: HU })).status, 403, 'an unrelated employee cannot confirm');
  const d = await http('POST', `/api/tasks/${q(id)}/profit-confirm/done`, { token: DI });
  assert.equal(d.status, 200, JSON.stringify(d.j)); assert.equal(d.j.task.profitConfirmStatus, 'confirmed');
});
test('a team confirmer beats the default; a request already sent stays with who it was sent to', async () => {
  const set = await http('POST', '/api/admin/profit-confirmers', { token: SA, body: { default: emp('disha').id, backup: emp('parvinder').id, teams: { 'Rental Team': emp('vishal').id } } });
  assert.equal(set.status, 200, JSON.stringify(set.j));
  const id = await submitted('Team job');
  const r = await approveWithProfit(id);
  assert.equal(r.j.task.profitConfirmerAssignedId, emp('vishal').id, 'Ranjit is on Rental Team');
  // config changes afterwards do not strand the request
  await http('POST', '/api/admin/profit-confirmers', { token: SA, body: { default: emp('parvinder').id, backup: emp('disha').id } });
  const VI = await login('vishal', 'Vishal@2026', 'admin');
  assert.equal((await http('POST', `/api/tasks/${q(id)}/profit-confirm/done`, { token: VI })).status, 200);
});
test('per-task override is audited and refused once confirmation has started', async () => {
  const id = await submitted('Override job');
  const o = await http('POST', `/api/tasks/${q(id)}/profit-confirmer`, { token: SA, body: { confirmerId: emp('disha').id } });
  assert.equal(o.status, 200, JSON.stringify(o.j));
  assert.equal(o.j.task.profitConfirmerId, emp('disha').id); assert.equal(o.j.task.profitConfirmerHistory.length, 1);
  const r = await approveWithProfit(id);
  assert.equal(r.j.task.profitConfirmerAssignedId, emp('disha').id);
  assert.equal((await http('POST', `/api/tasks/${q(id)}/profit-confirmer`, { token: SA, body: { confirmerId: emp('parvinder').id } })).status, 409);
});
