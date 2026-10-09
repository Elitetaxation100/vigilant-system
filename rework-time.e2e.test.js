// "Time in rework" is the time the work clock actually ran on the correction — never wall-clock time, never time on hold or paused.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-rework-'));
let child;
const enc = encodeURIComponent;
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

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const day = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const T = id => '/api/tasks/' + enc(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('the correction clock counts only running time: idle, held and paused time are not counted, and resubmitting does not add wall-clock hours', async () => {
  const SA = await login('shubham', 'Shubham@2026', 'admin'), PA = await login('parvinder', 'Parvinder@2026', 'admin'), RJ = await login('ranjit', 'Ranjit@2026', 'employee');
  const E = (await http('GET', '/api/employees', { token: SA })).j.employees, emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'RW Ltd', email: 'rw@t.co' } })).j.client.id;
  const t = (await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'Rework clock', taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(2), clientDate: day(9), reviewerId: emp('parvinder').id } })).j.task;
  const mine = async () => (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(x => x.id === t.id);
  assert.equal((await http('POST', T(t.id) + '/accept', { token: RJ })).status, 200);
  assert.equal((await http('POST', T(t.id) + '/complete', { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } })).status, 200);
  assert.equal((await http('POST', T(t.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'q1', category: 'Other', responsibility: 'Employee', dueDate: day(3), note: 'redo' } })).status, 200);
  assert.equal((await http('POST', T(t.id) + '/accept', { token: RJ })).status, 200);
  // accepted but the clock never started: 1.5 s later it still reads zero (it used to count wall-clock from acceptance)
  await sleep(1500);
  let x = await mine();
  assert.equal(x.status, 'rework'); assert.equal(x.reworkElapsedHours, 0, 'idle time is not working time');
  // run the clock briefly
  assert.equal((await http('POST', T(t.id) + '/resume', { token: RJ })).status, 200);
  await sleep(1200);
  x = await mine();
  assert.ok(x.reworkElapsedHours > 0.0002 && x.reworkElapsedHours < 0.02, 'running time counts: ' + x.reworkElapsedHours);
  // put it on hold: the figure stops
  const h = await http('POST', T(t.id) + '/hold', { token: RJ, body: { reasonCode: 'BLOCKED_OTHER', detail: 'waiting for a file', responsibility: 'employee', followUpDate: day(1) } });
  assert.equal(h.status, 200, JSON.stringify(h.j));
  const frozen = (await mine()).reworkElapsedHours;
  await sleep(1500);
  const later = await mine();
  assert.equal(later.status, 'on_hold');
  assert.equal(later.reworkElapsedHours, frozen, 'time on hold does not count');
  // back to work, resubmit: only the running time is recorded, once
  assert.equal((await http('POST', T(t.id) + '/unhold', { token: RJ })).status, 200);
  const beforeLogged = (await mine()).logged;
  assert.equal((await http('POST', T(t.id) + '/resubmit', { token: RJ })).status, 200);
  x = await mine();
  const round = x.reworkHistory.at(-1);
  assert.ok(round.durationHours < 0.02, 'the round is not wall-clock hours: ' + round.durationHours);
  assert.ok(x.logged - beforeLogged < 0.02, 'resubmitting does not add the idle/held time to the logged hours');
  assert.equal(x.reworkElapsedHours, null);
});

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
test('the screen words it as working time, not "time in rework"', () => {
  assert.match(html, /Working time on this correction:<\/b>/); assert.match(html, /counts only while your timer is running, not while on hold or paused/);
  assert.ok(!html.includes('Time in rework so far'));
});
