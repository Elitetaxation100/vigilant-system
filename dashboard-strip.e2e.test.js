// The dashboard strip (commitment breaches, late / at risk, time worked, continue today) on a throwaway server, for an employee, a colleague and the founder.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dstrip-'));
let child;
const enc = encodeURIComponent;
const T = id => '/api/tasks/' + enc(id);
const nzToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const day = n => new Date(Date.parse(nzToday() + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

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
async function stop() { if (!child) return; await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); child = null; }
test.after(async () => { await stop(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, RJ, KH, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const strip = tok => http('GET', '/api/dashboard-strip', { token: tok });
const ids = {};
async function sessions() {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  KH = await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
}
async function mk(name, who, tok) {
  const c = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId: client.id, assignedTo: emp(who).id, tat: 4, internalDeadline: day(3), clientDate: day(9) } });
  assert.equal(c.status, 201, JSON.stringify(c.j));
  assert.equal((await http('POST', T(c.j.task.id) + '/accept', { token: tok })).status, 200);
  return c.j.task.id;
}

test('setup: one task stuck in review (its commitment date is made past), one task still being worked', async () => {
  await start(); await sessions();
  client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Strip Ltd', email: 'st' + Date.now() + '@t.co' } })).j.client;
  ids.review = await mk('Stuck in review', 'ranjit', RJ);
  assert.equal((await http('POST', T(ids.review) + '/complete', { token: RJ, body: { reviewerId: emp('disha').id, sheetLink: 'https://docs.google.com/spreadsheets/d/a', cashbookLink: 'https://example.com/c' } })).status, 200);
  ids.work = await mk('Working on it', 'ranjit', RJ);
  ids.kh = await mk('Khushi work', 'khushi', KH);
  await stop();
  const f = path.join(dir, 'db.json'), st = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.assign(st.tasks.find(x => x.id === ids.review), { clientDate: day(-3) });
  Object.assign(st.tasks.find(x => x.id === ids.work), { resumeOn: day(0), internalDeadline: day(-2) });
  fs.writeFileSync(f, JSON.stringify(st));
  await start(); await sessions();
});

test('an employee sees their own breaches, late / at-risk work, time worked today and what to continue today', async () => {
  const r = await strip(RJ);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.scope, 'mine');
  assert.equal(r.j.watch.breaches, 1, 'the task stuck in review past its commitment date');
  assert.ok(r.j.watch.late >= 2, 'the breach (review not done) and the task not handed in by its due date: ' + JSON.stringify(r.j.watch));
  assert.equal(r.j.watch.rule, 250);
  assert.equal(r.j.resumeToday, 1);
  assert.equal(r.j.time.today, 0); assert.equal(r.j.time.week, 0);
  assert.equal('team' in r.j, false, 'no team figures for an employee');
  // logging work moves the time figure
  const log = await http('POST', '/api/time-ledger/log', { token: RJ, body: { day: day(0), entries: [{ taskId: ids.work, hours: 2.5 }] } });
  assert.equal(log.status, 201, JSON.stringify(log.j));
  const after = (await strip(RJ)).j;
  assert.equal(after.time.today, 2.5); assert.ok(after.time.week >= 2.5);
  assert.ok(after.time.standard === 0 || after.time.standard === 7, 'the 7 h day, or 0 on a day off');
  assert.equal(after.resumeToday, 0, 'working on it again clears "continue today"');
});

test('a colleague only sees their own; the founder sees the firm and the team time', async () => {
  const k = (await strip(KH)).j;
  assert.equal(k.watch.breaches, 0); assert.equal(k.scope, 'mine'); assert.equal(k.time.today, 0);
  const f = (await strip(SA)).j;
  assert.equal(f.scope, 'firm'); assert.ok(f.watch.breaches >= 1, 'the founder sees the firm breach');
  assert.ok(f.team && f.team.people >= 2, JSON.stringify(f.team)); assert.equal(f.team.workedToday, 2.5); assert.equal(f.team.working, 1);
  assert.equal((await http('GET', '/api/dashboard-strip')).status, 401);
  // the strip agrees with the full list it opens
  const list = (await http('GET', '/api/commitment-watch', { token: RJ })).j;
  assert.equal(list.breaches.length, (await strip(RJ)).j.watch.breaches, 'the tile count equals the list');
});
