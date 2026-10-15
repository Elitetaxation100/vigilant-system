// Once the report is sent the task is finished: it leaves the everyday lists for everyone, and shows up again (as Report Sent) only when someone searches for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-closed-'));
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
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(async () => { if (child) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, PK, RJ, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const ids = {};
const list = async (tok, q) => (await http('GET', '/api/workflow/tasks' + (q || ''), { token: tok })).j.rows.map(r => r.id);
const mine = async (tok, q) => (await http('GET', '/api/workflow/my-tasks' + (q || ''), { token: tok })).j.rows.map(r => r.id);

test('setup: one task finished (report sent), one still waiting to be sent', async () => {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  PK = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Closed Ltd', email: 'cl' + Date.now() + '@t.co' } })).j.client;
  const make = async name => {
    const c = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, taskKind: 'client', clientId: client.id, assignedTo: emp('ranjit').id, tat: 0.25, internalDeadline: day(3), clientDate: day(9) } });
    assert.equal(c.status, 201, JSON.stringify(c.j));
    const t = c.j.task;
    assert.equal((await http('POST', T(t.id) + '/accept', { token: RJ })).status, 200);
    assert.equal((await http('POST', T(t.id) + '/complete', { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/1', cashbookLink: 'https://example.com/cb' } })).status, 200);
    assert.equal((await http('POST', T(t.id) + '/review-decision', { token: PK, body: { decision: 'approve', next: 'report', note: 'ok' } })).status, 200);
    return t.id;
  };
  ids.sent = await make('Alpha closed job'); ids.waiting = await make('Bravo waiting job');
  const s = await http('POST', T(ids.sent) + '/send-to-client', { token: RJ, body: { decision: 'yes' } });
  assert.equal(s.status, 200, JSON.stringify(s.j));
});

test('the finished task is gone from the everyday lists — for the processor, the manager and the founder — while work still to do stays', async () => {
  for (const [who, tok] of [['processor', RJ], ['manager', PK], ['founder', SA]]) {
    const l = who === 'processor' ? await mine(tok) : await list(tok);
    assert.ok(!l.includes(ids.sent), who + ' does not see the finished task');
    assert.ok(l.includes(ids.waiting), who + ' still sees the one waiting to be sent');
  }
});

test('search finds it, and it says Report Sent — and so do the filters that ask for finished work', async () => {
  for (const [who, tok, fn] of [['processor', RJ, mine], ['manager', PK, list], ['founder', SA, list]]) {
    assert.ok((await fn(tok, '?q=' + enc('Alpha closed'))).includes(ids.sent), who + ' finds it by searching');
  }
  const r = (await http('GET', '/api/workflow/tasks?q=' + enc('Alpha closed'), { token: PK })).j.rows.find(x => x.id === ids.sent);
  assert.equal(r.primaryStatus, 'Report Sent'); assert.equal(r.status, 'Completed');
  assert.ok((await list(PK, '?primary=' + enc('Report Sent'))).includes(ids.sent), 'asking for Report Sent shows it');
  assert.ok((await list(PK, '?status=Completed')).includes(ids.sent), 'asking for Completed shows it');
  assert.ok((await list(PK, '?ids=' + enc(ids.sent))).includes(ids.sent), 'an exact list behind a count still shows it');
  assert.ok((await mine(RJ, '?primary=' + enc('Report Sent'))).includes(ids.sent));
});
