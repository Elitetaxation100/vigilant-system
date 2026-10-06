// Profit confirmation: the reviewer can see where it stands, is told when Shubam confirms, the history
// records it, and the founder can count what Shubam has confirmed. Real server, throwaway data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-profit-'));
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
async function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
}
test.after(async () => {
  if (child) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

let SH, RJ, DI, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const notesOf = async tok => { const j = (await http('GET', '/api/notifications', { token: tok })).j; return JSON.stringify(j.notifications || j); };
const myTask = async (tok, id) => (await http('GET', '/api/tasks', { token: tok })).j.tasks.find(t => t.id === id);
const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const clientDate = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
async function cleanReviewed(name) {
  const t = (await http('POST', '/api/tasks', { token: SH, body: { mode: 'team', name, clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: due, clientDate } })).j.task;
  await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: RJ });
  const c = await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/review`, { token: DI, body: { status: 'clean' } })).status, 200);
  return t;
}

test('setup', async () => {
  await start();
  SH = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SH })).j.employees;
  client = (await http('POST', '/api/clients', { token: SH, body: { name: 'Profit Ltd', email: 'pf' + Date.now() + '@t.co' } })).j.client;
});

test('before anything is asked, the count is zero and only founders / Shubam may see it', async () => {
  const s = await http('GET', '/api/profit-confirmations/stats', { token: SH });
  assert.equal(s.status, 200);
  assert.equal(s.j.owner.id, emp('shubham').id, 'the named owner is Shubam');
  assert.deepEqual(s.j.confirmedByOwner, { today: 0, week: 0, month: 0, total: 0 });
  assert.equal(s.j.pending.count, 0); assert.deepEqual(s.j.recent, []); assert.equal(s.j.avgTurnaroundHours, null);
  assert.equal((await http('GET', '/api/profit-confirmations/stats', { token: RJ })).status, 403, 'an employee');
  assert.equal((await http('GET', '/api/profit-confirmations/stats', { token: DI })).status, 403, 'an admin who is not Shubam');
});

test('the reviewer sees it waiting on Shubam; Shubam sees it waiting; the history records the request', async () => {
  const t = await cleanReviewed('Profit task one');
  const r = await http('POST', `/api/tasks/${enc(t.id)}/profit-confirm`, { token: DI });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const mine = await myTask(DI, t.id);                       // the reviewer still gets the task, with its profit state
  assert.equal(mine.profitConfirmStatus, 'pending'); assert.equal(mine.profitConfirmRequestedBy, emp('disha').id); assert.ok(mine.profitConfirmRequestedAt);
  const s = (await http('GET', '/api/profit-confirmations/stats', { token: SH })).j;
  assert.equal(s.pending.count, 1);
  assert.equal(s.confirmedByOwner.total, 0);
  global.__t1 = t.id;
});

test('Shubam confirms: the count goes up, and the reviewer AND the sender are told', async () => {
  const id = global.__t1;
  const before = await notesOf(DI);
  assert.ok(!before.includes('confirmed profit'), 'nothing yet');
  const ok = await http('POST', `/api/tasks/${enc(id)}/profit-confirm/done`, { token: SH });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.task.profitConfirmStatus, 'confirmed');
  assert.match(await notesOf(DI), /confirmed profit on .{0,3}Profit task one/, 'the reviewer is told');
  assert.match(await notesOf(DI), /Ranjit Choudhary will send the report/);
  assert.match(await notesOf(RJ), /confirmed profit on .{0,3}Profit task one/, 'the sender is told, as before');
  const mine = await myTask(DI, id);
  assert.equal(mine.profitConfirmStatus, 'confirmed'); assert.equal(mine.awaitingClientDecision, true); assert.ok(mine.profitConfirmAt);
  const s = (await http('GET', '/api/profit-confirmations/stats', { token: SH })).j;
  assert.deepEqual(s.confirmedByOwner, { today: 1, week: 1, month: 1, total: 1 });
  assert.equal(s.pending.count, 0);
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].name, 'Profit task one');
  assert.equal(s.recent[0].requestedBy, 'Disha Chaudhary');
  assert.equal(s.recent[0].confirmedBy, s.owner.name);
  assert.ok(s.recent[0].hours >= 0 && s.avgTurnaroundHours >= 0);
});

test('a second one is counted too, and a task asked but not yet confirmed shows as waiting', async () => {
  const a = await cleanReviewed('Profit task two');
  await http('POST', `/api/tasks/${enc(a.id)}/profit-confirm`, { token: DI });
  const b = await cleanReviewed('Profit task three');
  await http('POST', `/api/tasks/${enc(b.id)}/profit-confirm`, { token: DI });
  assert.equal((await http('POST', `/api/tasks/${enc(a.id)}/profit-confirm/done`, { token: SH })).status, 200);
  const s = (await http('GET', '/api/profit-confirmations/stats', { token: SH })).j;
  assert.equal(s.confirmedByOwner.total, 2); assert.equal(s.pending.count, 1);
  assert.deepEqual(s.recent.map(r => r.name), ['Profit task two', 'Profit task one'], 'newest first');
  // nobody else can confirm it
  assert.equal((await http('POST', `/api/tasks/${enc(b.id)}/profit-confirm/done`, { token: DI })).status, 403);
  assert.equal((await http('POST', `/api/tasks/${enc(b.id)}/profit-confirm/done`, { token: RJ })).status, 403);
});
