// The simplified manager layout: Disha is switched on once, the Today numbers and the "needs action now" list come from the real task data, Mark sent and
// Nudge work (a nudge on work waiting for review goes to the reviewer), and nobody outside the manager roles gets the layout or the screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-simple-'));
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
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(async () => { if (child) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, PK, DI, KH, NI, RJ, E, ids = {};
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const today = async () => (await http('GET', '/api/simple/today', { token: DI })).j;

test('setup: Disha manages Khushi, Diksha and Nitish; one task is approved and waiting to be sent, one is with the reviewer, one is to do', async () => {
  const d = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin'); DI = d.token;
  assert.equal(d.employee.simpleLayout, true, 'Disha is switched on to the simple layout');
  SA = (await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin')).token;
  PK = (await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin')).token;
  KH = (await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee')).token;
  NI = (await login('nitish@elitetaxation.co.nz', 'Nitish@2026', 'employee')).token;
  RJ = (await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee')).token;
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  const client = async name => (await http('POST', '/api/clients', { token: SA, body: { name, email: name.split(' ')[0].toLowerCase() + Date.now() + '@t.co' } })).j.client.id;
  const make = async (who, tok, name, clientName, over) => {
    const body = { mode: 'team', name, taskKind: clientName ? 'client' : 'admin', assignedTo: emp(who).id, tat: 1, internalDeadline: day(0), reviewerId: emp('parvinder').id, ...(clientName ? { clientId: await client(clientName), clientDate: day(5) } : {}), ...(over || {}) };
    const c = await http('POST', '/api/tasks', { token: DI, body });
    assert.equal(c.status, 201, JSON.stringify(c.j));
    assert.equal((await http('POST', T(c.j.task.id) + '/accept', { token: tok })).status, 200);
    return c.j.task.id;
  };
  const submit = (id, tok) => http('POST', T(id) + '/complete', { token: tok, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/1', cashbookLink: 'https://example.com/cb' } });
  ids.approved = await make('khushi', KH, 'GST return', 'Sandeep Boparai');
  assert.equal((await submit(ids.approved, KH)).status, 200);
  assert.equal((await http('POST', T(ids.approved) + '/review-decision', { token: PK, body: { decision: 'approve', next: 'report', note: 'ok' } })).status, 200);
  ids.review = await make('nitish', NI, 'Updation', 'Herry Sharma', { clientDate: day(1) });
  assert.equal((await submit(ids.review, NI)).status, 200);
  ids.todo = await make('khushi', KH, 'Ravikash IRD reply', null);
});

test('Today: the numbers and the needs-action list come from the real tasks, with the right button for each', async () => {
  const t = await today();
  assert.equal(t.stats.approvedNotSent, 1);
  assert.equal(t.stats.waitingReview, 0, 'the work is with Parvinder, not Disha');
  const send = t.needsAction.items.find(i => i.id === ids.approved);
  assert.ok(send && send.action === 'send' && send.client === 'Sandeep Boparai', 'approved work offers Mark sent');
  const chase = t.needsAction.items.find(i => i.id === ids.review);
  assert.ok(!chase || (chase.action === 'nudge' && chase.toId === emp('parvinder').id), 'work with a reviewer is nudged to the reviewer');
  assert.ok(Array.isArray(t.team) && t.team.some(p => p.name.startsWith('Khushi')), 'the team list names the people');
  assert.ok(t.today && t.name);
});

test('Nudge on work waiting for review goes to the reviewer and stays open until the review is done', async () => {
  const r = await http('POST', T(ids.review) + '/nudge', { token: DI, body: { toId: emp('parvinder').id } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const n = (await http('GET', '/api/notifications', { token: PK })).j.notifications.find(x => x.taskId === ids.review && /nudged you to review/.test(x.text));
  assert.ok(n, 'Parvinder is told');
  const bad = await http('POST', T(ids.review) + '/nudge', { token: DI, body: { toId: emp('ranjit').id } });
  assert.equal(bad.status, 400, 'nudging someone who is not the reviewer is refused: that task is already handed in');
});

test('Mark sent records the report as sent and the task leaves the needs-action list', async () => {
  const r = await http('POST', T(ids.approved) + '/send-to-client', { token: DI, body: { decision: 'yes' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const t = await today();
  assert.equal(t.stats.approvedNotSent, 0);
  assert.ok(!t.needsAction.items.some(i => i.id === ids.approved));
});

test('only managers get the screen, and only a superadmin can switch the layout on or off', async () => {
  assert.equal((await http('GET', '/api/simple/today', { token: RJ })).status, 403);
  assert.equal((await http('GET', '/api/simple/today')).status, 401);
  assert.ok(!(await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee')).employee.simpleLayout, 'a processor never has it');
  const off = await http('PATCH', '/api/employees/' + enc(emp('disha').id), { token: SA, body: { simpleLayout: false } });
  assert.equal(off.status, 200, JSON.stringify(off.j));
  assert.equal((await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin')).employee.simpleLayout, false, 'switched off');
  const on = await http('PATCH', '/api/employees/' + enc(emp('disha').id), { token: SA, body: { simpleLayout: true } });
  assert.equal(on.status, 200);
  assert.equal((await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin')).employee.simpleLayout, true, 'switched back on');
  const mine = await http('PATCH', '/api/employees/' + enc(emp('disha').id), { token: DI, body: { simpleLayout: false } });
  assert.notEqual(mine.status, 200, 'a manager cannot change their own layout switch');
});
