// Phase 7 on a REAL server: manager alerts (one per episode, auto-resolved, re-raised when the problem returns) and the reporting
// measures (each one separate, scoped to the manager's team, and read-only).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-alerts-'));
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
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SH, PK, RJ, DI, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const day = n => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });   // the business calendar, not UTC
const T = id => `/api/tasks/${enc(id)}`;
const create = (body) => http('POST', '/api/tasks', { token: PK, body: { mode: 'team', name: 'Alert ' + Math.random().toString(36).slice(2, 6), assignedTo: emp('ranjit').id, tat: 0.25, internalDeadline: day(3), clientDate: day(9), taskKind: 'client', clientId: client.id, reviewerId: emp('parvinder').id, ...body } });
const sweep = async () => (await http('POST', '/api/admin/manager-alerts/run', { token: SH })).j;
const inbox = async (tok, taskId) => (await http('GET', '/api/notifications', { token: tok })).j.notifications.filter(n => n.type === 'attention' && n.taskId === taskId);
async function finish(t, status) {
  await http('POST', T(t.id) + '/accept', { token: RJ });
  const c = await http('POST', T(t.id) + '/complete', { token: RJ, body: { sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  return (await http('POST', T(t.id) + '/review', { token: PK, body: status === 'error' ? { status: 'error', note: 'fix', faultType: 'processor' } : { status: 'clean' } })).status;
}

test('setup', async () => {
  SH = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  PK = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SH })).j.employees;
  client = (await http('POST', '/api/clients', { token: SH, body: { name: 'Alerts Ltd', email: 'al' + Date.now() + '@t.co' } })).j.client;
});

test('only the founder can run the alert sweep', async () => {
  assert.equal((await http('POST', '/api/admin/manager-alerts/run', { token: DI })).status, 403);
  assert.equal((await http('POST', '/api/admin/manager-alerts/run', { token: RJ })).status, 403);
  assert.equal((await http('POST', '/api/admin/manager-alerts/run')).status, 401);
});

test('a hold follow-up that has come due raises ONE alert, is not repeated, resolves itself, and re-raises if it happens again', async () => {
  const t = (await create({})).j.task;
  await http('POST', T(t.id) + '/accept', { token: RJ });
  const hold = () => http('POST', T(t.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_DOCS', responsibility: 'client', followUpDate: day(0) } });
  assert.equal((await hold()).status, 200);
  const r1 = await sweep(); assert.ok(r1.raised >= 1);
  const n1 = await inbox(PK, t.id); assert.equal(n1.length, 1); assert.match(n1[0].text, /follow-up is due/i);
  assert.equal((await inbox(RJ, t.id)).length, 1, 'the person holding the task is reminded too');
  const r2 = await sweep(); assert.equal(r2.raised, 0, 'a second sweep says nothing new');
  assert.equal((await inbox(PK, t.id)).length, 1, 'still one notification, not two');
  assert.equal((await http('POST', T(t.id) + '/unhold', { token: RJ })).status, 200);
  const r3 = await sweep(); assert.ok(r3.resolved >= 1);
  assert.equal((await inbox(PK, t.id)).length, 0, 'it drops out of the inbox on its own once the problem is gone');
  assert.equal((await hold()).status, 200);
  const r4 = await sweep(); assert.ok(r4.raised >= 1, 'a problem that comes back is a new episode');
  assert.equal((await inbox(PK, t.id)).length, 1);
});

test('a future follow-up date is not an alert yet', async () => {
  const t = (await create({})).j.task;
  await http('POST', T(t.id) + '/accept', { token: RJ });
  await http('POST', T(t.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_DOCS', responsibility: 'client', followUpDate: day(4) } });
  await sweep();
  assert.equal((await inbox(PK, t.id)).length, 0);
});

test('a refused no-review close alerts the managers once, however many times it is tried, and resolves when the work is reviewed', async () => {
  const t = (await create({})).j.task;
  await http('POST', T(t.id) + '/accept', { token: RJ });
  for (let i = 0; i < 3; i++) assert.equal((await http('POST', T(t.id) + '/done', { token: RJ, body: {} })).status, 403);
  assert.equal((await inbox(PK, t.id)).length, 1, 'three attempts, one alert');
  const task = (await http('GET', '/api/tasks', { token: SH })).j.tasks.find(x => x.id === t.id);
  assert.equal(task.noReviewAttempts.length, 3, 'every attempt is still on the record');
  assert.equal((await http('POST', T(t.id) + '/complete', { token: RJ, body: { sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } })).status, 200);
  await sweep();
  assert.equal((await inbox(PK, t.id)).length, 0, 'resolved once the task is no longer open');
});

test('a task returned twice is flagged to managers', async () => {
  const t = (await create({})).j.task;
  assert.equal(await finish(t, 'error'), 200);
  await http('POST', T(t.id) + '/accept', { token: RJ }); await http('POST', T(t.id) + '/resubmit', { token: RJ });
  await http('POST', T(t.id) + '/review', { token: PK, body: { status: 'error', note: 'again', faultType: 'processor' } });
  await sweep();
  const n = await inbox(PK, t.id); assert.equal(n.length, 1); assert.match(n[0].text, /returned 2 times/i);
});

test('the measures are separate: client date, the employee\'s own date, report sending, corrections and reviewer turnaround each stand alone', async () => {
  const before = (await http('GET', '/api/workflow/measures?days=30', { token: SH })).j;
  for (let i = 0; i < 3; i++) assert.equal(await finish((await create({})).j.task, 'clean'), 200);
  assert.equal(await finish((await create({})).j.task, 'error'), 200);
  const m = (await http('GET', '/api/workflow/measures?days=30', { token: SH })).j;
  const d = (a, b) => a - b;
  assert.equal(m.days, 30); assert.equal(m.to, day(0));
  assert.equal(d(m.firm.clientCommitment.met, before.firm.clientCommitment.met), 3, 'the three that were finished were submitted before the client date (the returned one is still being corrected)');
  assert.equal(d(m.firm.internalCommitment.met, before.firm.internalCommitment.met), 3, 'and before the employee\'s own date');
  assert.equal(d(m.firm.corrections.reviewed, before.firm.corrections.reviewed), 4); assert.equal(d(m.firm.corrections.returned, before.firm.corrections.returned), 1);
  assert.equal(d(m.firm.reportSending.notSent, before.firm.reportSending.notSent), 3, 'three approved reports are not sent yet — that is a report measure, not a commitment one');
  assert.equal(m.firm.clientCommitment.missed, before.firm.clientCommitment.missed, 'report sending never changes the client-commitment measure');
  const rj = m.byEmployee.find(e => e.id === emp('ranjit').id);
  assert.ok(rj && rj.clientCommitment.total >= 4 && rj.corrections.returned >= 1);
  const pk = m.byReviewer.find(r => r.id === emp('parvinder').id);
  assert.ok(pk && pk.count >= 4 && pk.avgDays >= 0 && pk.within1DayPct === 100, JSON.stringify(pk));
  assert.ok(m.reviewerTurnaround.count >= 4);
  ['clientCommitment', 'internalCommitment', 'reportSending', 'corrections'].forEach(k => assert.ok(k in m.firm, k));
});

test('measures: the window is clamped, a manager sees only their team, an employee is refused, and reading changes nothing', async () => {
  assert.equal((await http('GET', '/api/workflow/measures?days=9999', { token: SH })).j.days, 365);
  assert.equal((await http('GET', '/api/workflow/measures?days=-5', { token: SH })).j.days, 1);
  assert.equal((await http('GET', '/api/workflow/measures', { token: SH })).j.days, 30);
  assert.equal((await http('GET', '/api/workflow/measures', { token: RJ })).status, 403);
  assert.equal((await http('GET', '/api/workflow/measures')).status, 401);
  const all = (await http('GET', '/api/workflow/measures', { token: SH })).j, mine = (await http('GET', '/api/workflow/measures', { token: DI })).j;
  assert.ok(mine.firm.corrections.reviewed <= all.firm.corrections.reviewed);
  const snap = JSON.stringify((await http('GET', '/api/tasks', { token: SH })).j.tasks);
  await http('GET', '/api/workflow/measures?days=7', { token: SH });
  assert.equal(JSON.stringify((await http('GET', '/api/tasks', { token: SH })).j.tasks), snap);
});

test('the team page shows the follow-up exception, and measures never reach Today', async () => {
  const t = (await create({})).j.task;
  await http('POST', T(t.id) + '/accept', { token: RJ });
  await http('POST', T(t.id) + '/hold', { token: RJ, body: { reasonCode: 'THIRD_PARTY', detail: 'IRD reply pending', responsibility: 'third_party', followUpDate: day(0) } });
  const team = (await http('GET', '/api/workflow/team', { token: SH })).j;
  assert.ok(team.attention.some(a => a.id === t.id && a.type === 'followup_due'));
  const td = (await http('GET', '/api/workflow/today', { token: SH })).j;
  assert.ok(!('measures' in td) && !('firm' in td));
});
