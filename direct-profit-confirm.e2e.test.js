// "Profit confirm" toggle — Parvinder/Simran can send their own job straight to Shubam, skipping review.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dpc-'));
let child;

async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, PA, DI, E, clientId;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const due = () => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
async function acceptedTask(assignee, name) {
  const t = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId, assignedTo: assignee.id, tat: 2, internalDeadline: due() } });
  assert.equal(t.status, 201);
  const id = t.j.task.id;
  const tokenFor = assignee === emp('parvinder') ? PA : DI;
  const a = await http('POST', `/api/tasks/${encodeURIComponent(id)}/accept`, { token: tokenFor });
  assert.equal(a.status, 200, JSON.stringify(a.j));
  return { id, tokenFor };
}

test('setup', async () => {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  PA = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'DPC Ltd', email: 'dpc' + Date.now() + '@t.co' } })).j.client.id;
  assert.equal(emp('parvinder').canDirectProfitConfirm, true);
  assert.equal(emp('disha').canDirectProfitConfirm, false);
});

test('someone not on the list cannot use the toggle', async () => {
  const { id, tokenFor } = await acceptedTask(emp('disha'), 'Disha job');
  const r = await http('POST', `/api/tasks/${encodeURIComponent(id)}/complete`, { token: tokenFor, body: { directProfitConfirm: true, sheetLink: 'https://docs.google.com/spreadsheets/d/x' } });
  assert.equal(r.status, 403);
});

test('direct profit confirm needs a link and leaves the task untouched when refused', async () => {
  const { id, tokenFor } = await acceptedTask(emp('parvinder'), 'No link job');
  const r = await http('POST', `/api/tasks/${encodeURIComponent(id)}/complete`, { token: tokenFor, body: { directProfitConfirm: true } });
  assert.equal(r.status, 400);
  const t = (await http('GET', '/api/tasks', { token: SA })).j.tasks.find(x => x.id === id);
  assert.equal(t.status, 'accepted');
});

test('Parvinder sends his own job straight to Shubam, who confirms it', async () => {
  const { id, tokenFor } = await acceptedTask(emp('parvinder'), 'Own job');
  const r = await http('POST', `/api/tasks/${encodeURIComponent(id)}/complete`, { token: tokenFor, body: { directProfitConfirm: true, sheetLink: 'https://docs.google.com/spreadsheets/d/x' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.task.status, 'completed');
  assert.equal(r.j.task.profitConfirmStatus, 'pending');
  const c = await http('POST', `/api/tasks/${encodeURIComponent(id)}/profit-confirm/done`, { token: SA });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  assert.equal(c.j.task.profitConfirmStatus, 'confirmed');
  assert.equal(c.j.task.awaitingClientDecision, true);
});

test('reopening a closed job can also go straight to profit confirmation', async () => {
  const { id, tokenFor } = await acceptedTask(emp('parvinder'), 'Reopen job');
  const d = await http('POST', `/api/tasks/${encodeURIComponent(id)}/done`, { token: tokenFor, body: {} });
  assert.equal(d.status, 200, JSON.stringify(d.j));
  const r = await http('POST', `/api/tasks/${encodeURIComponent(id)}/send-for-review`, { token: tokenFor, body: { directProfitConfirm: true, cashbookLink: 'https://example.com/cb' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.task.profitConfirmStatus, 'pending');
  assert.equal(r.j.task.cashbookLink, 'https://example.com/cb');
});

test('an internal task with no client cannot be profit-confirmed', async () => {
  const t = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', kind: 'internal', name: 'Training', assignedTo: emp('parvinder').id, tat: 1, internalDeadline: due() } });
  assert.equal(t.status, 201, JSON.stringify(t.j));
  const id = t.j.task.id;
  assert.equal((await http('POST', `/api/tasks/${encodeURIComponent(id)}/accept`, { token: PA })).status, 200);
  const r = await http('POST', `/api/tasks/${encodeURIComponent(id)}/complete`, { token: PA, body: { directProfitConfirm: true, sheetLink: 'https://docs.google.com/spreadsheets/d/x' } });
  assert.equal(r.status, 400);
});

test('an internal task that names a client and has a link can be profit-confirmed (becomes client work)', async () => {
  const t = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', kind: 'internal', internalRef: 'Some Person', name: 'Review', assignedTo: emp('parvinder').id, tat: 1, internalDeadline: due() } });
  assert.equal(t.status, 201, JSON.stringify(t.j));
  const id = t.j.task.id;
  assert.equal((await http('POST', `/api/tasks/${encodeURIComponent(id)}/accept`, { token: PA })).status, 200);
  const r = await http('POST', `/api/tasks/${encodeURIComponent(id)}/complete`, { token: PA, body: { directProfitConfirm: true, cashbookLink: 'https://cashbook.example.com/customer/1' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.task.kind, 'client');
  assert.equal(r.j.task.profitConfirmStatus, 'pending');
});
