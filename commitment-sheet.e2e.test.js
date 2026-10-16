// The Commitment watch sheet (one row per task, every stage as a column) and managers editing the dates on their own tasks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sheet-'));
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

let SA, PK, DI, KH, RJ, E; const ids = {};
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');

test('setup: one task handed in and approved, one still open, one the manager gave to herself', async () => {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin'); PK = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin'); KH = await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee'); RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Sheet Ltd', type: 'Company', email: 'sheet' + Date.now() + '@t.co' } })).j.client.id;
  const make = async (who, tok, name, over) => {
    const c = await http('POST', '/api/tasks', { token: PK, body: { mode: 'team', name, taskKind: 'client', clientId: client, assignedTo: emp(who).id, tat: 1, internalDeadline: day(0), clientDate: day(5), reviewerId: emp('parvinder').id, ...(over || {}) } });
    assert.equal(c.status, 201, JSON.stringify(c.j));
    assert.equal((await http('POST', T(c.j.task.id) + '/accept', { token: tok })).status, 200);
    return c.j.task.id;
  };
  ids.done = await make('khushi', KH, 'GST return');
  assert.equal((await http('POST', T(ids.done) + '/complete', { token: KH, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/1', cashbookLink: 'https://example.com/cb' } })).status, 200);
  assert.equal((await http('POST', T(ids.done) + '/review-decision', { token: PK, body: { decision: 'approve', next: 'report', note: 'ok' } })).status, 200);
  ids.open = await make('khushi', KH, 'Annual accounts');
  ids.ranjit = await make('ranjit', RJ, 'Ranjit own');
  const own = await http('POST', '/api/tasks', { token: DI, body: { mode: 'self', name: 'Disha own', taskKind: 'admin', tat: 1, internalDeadline: day(2) } });
  assert.equal(own.status, 201, JSON.stringify(own.j)); ids.own = own.j.task.id;
});

test('the sheet has one row per visible task with every stage and date as its own field', async () => {
  const s = (await http('GET', '/api/commitment-watch/sheet', { token: SA })).j;
  const done = s.rows.find(r => r.id === ids.done), open = s.rows.find(r => r.id === ids.open);
  for (const k of ['client', 'name', 'processor', 'reviewer', 'status', 'internalDue', 'commitmentDate', 'createdAt', 'submittedAt', 'reviewedAt', 'sentBackAt', 'readyForReportAt', 'reportSentAt', 'lastUpdateAt', 'daysOver', 'flags', 'allocatedHours', 'loggedHours', 'fixRounds', 'fy']) assert.ok(k in done, k + ' is a column');
  assert.equal(done.client, 'Sheet Ltd'); assert.ok(done.submittedAt && done.reviewedAt, 'the stage times are there'); assert.equal(done.reportSentAt, null, 'not sent yet: blank, never guessed');
  assert.equal(open.submittedAt, null); assert.equal(open.internalDue, day(0));
  assert.ok(s.rows.length >= 4 && s.today && s.rules);
});

test('the sheet is scoped like everything else: a processor sees their own work, a manager their team\'s, the founder everyone\'s', async () => {
  const mine = (await http('GET', '/api/commitment-watch/sheet', { token: KH })).j.rows.map(r => r.id);
  assert.ok(mine.includes(ids.done) && mine.includes(ids.open) && !mine.includes(ids.ranjit), 'Khushi sees hers, not Ranjit\'s');
  const all = (await http('GET', '/api/commitment-watch/sheet', { token: SA })).j.rows.map(r => r.id);
  assert.ok(all.includes(ids.ranjit) && all.includes(ids.done));
  assert.equal((await http('GET', '/api/commitment-watch/sheet')).status, 401);
});

test('a manager can change the dates on her own task (set-dates and the manager change), without a self-edit grant; others still cannot', async () => {
  const sd = await http('POST', T(ids.own) + '/set-dates', { token: DI, body: { internalDeadline: day(4), note: 'moved' } });
  assert.equal(sd.status, 200, JSON.stringify(sd.j)); assert.equal(sd.j.task.internalDeadline, day(4));
  const mc = await http('POST', T(ids.own) + '/manager-change', { token: DI, body: { action: 'change_due', internalDeadline: day(5), reason: 'client asked for more time' } });
  assert.equal(mc.status, 200, JSON.stringify(mc.j)); assert.equal(mc.j.task.internalDeadline, day(5));
  const re = await http('POST', T(ids.own) + '/manager-change', { token: DI, body: { action: 'reassign', newAssigneeId: emp('khushi').id, reason: 'trying to hand it on' } });
  assert.equal(re.status, 403, 'on her own task a manager changes the dates only');
  // a processor with no grant cannot move their own date; a manager still cannot move a task outside their team
  const rj = await http('POST', T(ids.ranjit) + '/set-dates', { token: RJ, body: { internalDeadline: day(3), note: 'x' } });
  assert.equal(rj.status, 403); assert.equal(rj.j.code, 'SELF_EDIT_OFF');
  const other = await http('POST', T(ids.ranjit) + '/set-dates', { token: DI, body: { internalDeadline: day(3), note: 'x' } });
  assert.equal(other.status, 403, 'Ranjit is not on Disha\'s team');
});
