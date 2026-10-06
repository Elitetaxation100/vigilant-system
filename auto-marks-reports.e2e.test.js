// Automatic marks — "report not sent to the client by the committed date" (−10 to whoever sends it).
// To get a committed date that is already in the past, the test stops the server, edits the data
// file of the throwaway folder, and starts the server again.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-reportmarks-'));
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
async function stop() {
  if (!child) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  child = null;
}
test.after(async () => { await stop(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, RJ, DI, E;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const marksOf = async tok => (await http('GET', '/api/marks', { token: tok })).j.marks;
const lateMarks = async (tok, taskId) => (await marksOf(tok)).filter(m => m.type === 'auto_report_late' && m.taskId === taskId && !m.voidedAt);
const sheet = 'https://docs.google.com/spreadsheets/d/abc', cash = 'https://example.com/cashbook';
const ids = [];

async function sessions() {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
}
// a client task, completed WITH links, reviewed clean and returned to Ranjit to send — i.e. "awaiting send"
async function awaitingSend(name, client) {
  const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const clientDate = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const c = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: due, clientDate } });
  assert.equal(c.status, 201, JSON.stringify(c.j));
  const t = c.j.task;
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: RJ })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetLink: sheet, cashbookLink: cash } })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/review`, { token: DI, body: { status: 'clean' } })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/return-to-processor`, { token: DI })).status, 200);
  return t;
}

test('setup: three reports awaiting send, rules started long ago', async () => {
  await start(); await sessions();
  await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { activeFrom: '2026-01-01' } });
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Reports Ltd', email: 'rp' + Date.now() + '@t.co' } })).j.client;
  for (const n of ['Late report A', 'Late report B', 'On time report', 'Before the rules started', 'Late, sent by Disha']) ids.push((await awaitingSend(n, client)).id);
  const rules = (await http('GET', '/api/auto-marks/rules', { token: RJ })).j;
  assert.deepEqual(rules.reports, { enabled: true, late: 10 });
});

test('make the committed dates past (stop, edit the data file, restart)', async () => {
  await stop();
  const f = path.join(dir, 'db.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  const set = (id, d) => { const t = st.tasks.find(x => x.id === id); assert.ok(t); t.clientDate = d; };
  set(ids[0], '2026-09-20');   // overdue, after the rules started
  set(ids[1], '2026-09-21');   // overdue — will be sent late by Disha
  // ids[2] keeps a date 9 days away → on time
  set(ids[3], '2025-12-01');   // overdue, but BEFORE the rules started (activeFrom 2026-01-01)
  set(ids[4], '2026-09-22');   // overdue — Disha will send it before any check has run
  fs.writeFileSync(f, JSON.stringify(st));
  await start(); await sessions();
});

test('a late report sent BEFORE any check has run is charged to whoever sends it', async () => {
  assert.equal((await lateMarks(DI, ids[4])).length, 0);
  assert.equal((await http('POST', `/api/tasks/${enc(ids[4])}/send-to-client`, { token: DI, body: { decision: 'yes' } })).status, 200);
  const m = await lateMarks(DI, ids[4]);
  assert.equal(m.length, 1); assert.equal(m[0].points, -10); assert.equal(m[0].toId, emp('disha').id, 'charged to the sender, not the original processor');
  assert.equal((await lateMarks(RJ, ids[4])).length, 0);
});

test('the daily check charges the person who has the report to send — once — and only for dates after the rules started', async () => {
  const run = await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal(run.status, 200); assert.ok(run.j.reports >= 2, JSON.stringify(run.j));
  const a = await lateMarks(RJ, ids[0]);
  assert.equal(a.length, 1); assert.equal(a[0].points, -10); assert.equal(a[0].toId, emp('ranjit').id); assert.equal(a[0].byId, null);
  assert.match(a[0].reason, /report for "Late report A" was not sent to the client by the committed date \(2026-09-20\)/);
  assert.equal((await lateMarks(RJ, ids[2])).length, 0, 'not due yet');
  assert.equal((await lateMarks(RJ, ids[3])).length, 0, 'it was already overdue before the rules started — no retroactive deduction');
  await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal((await lateMarks(RJ, ids[0])).length, 1, 'running it again never doubles up');
  assert.equal((await lateMarks(RJ, ids[4])).length + (await lateMarks(DI, ids[4])).length, 1, 'the report already sent late is not charged a second time');
});

test('the amount follows the "whoever is sending it" — after the report is handed to someone else, they carry it', async () => {
  // B is handed to Disha to send; the check has already charged Ranjit (the owner at the time), so a late send by Disha does not charge twice
  assert.equal((await http('POST', `/api/tasks/${enc(ids[1])}/report-owner`, { token: SA, body: { ownerId: emp('disha').id } })).status, 200);
  assert.equal((await lateMarks(RJ, ids[1])).length, 1, 'the first check charged the owner at the time');
  assert.equal((await http('POST', `/api/tasks/${enc(ids[1])}/send-to-client`, { token: DI, body: { decision: 'yes' } })).status, 200);
  assert.equal((await lateMarks(DI, ids[1])).length + (await lateMarks(RJ, ids[1])).length, 1, 'one deduction per task, not one per person');
});

test('sending a report late, before any check has run, charges the sender', async () => {
  // C (on time so far) is sent by Ranjit: no deduction. D is a new overdue report sent late at once.
  assert.equal((await http('POST', `/api/tasks/${enc(ids[2])}/send-to-client`, { token: RJ, body: { decision: 'yes' } })).status, 200);
  assert.equal((await lateMarks(RJ, ids[2])).length, 0, 'sent before the committed date → nothing');
  assert.equal((await http('POST', `/api/tasks/${enc(ids[3])}/send-to-client`, { token: RJ, body: { decision: 'yes' } })).status, 200);
  assert.equal((await lateMarks(RJ, ids[3])).length, 0, 'a date before the rules started never counts, even when sent now');
});

test('switching the rule off stops it', async () => {
  await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { enabled: { reports: false } } });
  assert.equal((await http('GET', '/api/auto-marks/rules', { token: RJ })).j.reports.enabled, false);
  const log = (await http('GET', '/api/admin/auto-marks', { token: SA })).j;
  assert.equal(log.settings.enabled.reports, false); assert.equal(log.settings.points.reportLate, 10);
});
