// Time ledger end to end on a throwaway server: the work clock writes dated entries, adjustments are recorded, nothing is invented for older hours,
// scoping, the team view and the CSV. A clock that started "yesterday" is set by stopping the server and editing the throwaway data file.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tl = require('./time-ledger');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-timeledger-'));
let child;
const enc = encodeURIComponent;
const T = id => '/api/tasks/' + enc(id);
const today = () => tl.nzDayMs(Date.now());
const day = n => tl.addDay(today(), n);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol || 0.02), (msg || '') + ' ' + a + ' vs ' + b);
// the first instant of today in New Zealand
function nzMidnightMs() { let lo = Date.now() - 26 * 3600000, hi = Date.now(); const d = today(); while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (tl.nzDayMs(m) === d) hi = m; else lo = m; } return hi; }

async function http(method, p, { token, body, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: r.status, text: await r.text(), type: r.headers.get('content-type') };
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

let SA, RJ, KH, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
async function sessions() {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  KH = await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
}
async function mk(name, over) {
  const c = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId: client.id, assignedTo: emp('ranjit').id, tat: 8, internalDeadline: day(5), clientDate: day(9), ...(over || {}) } });
  assert.equal(c.status, 201, JSON.stringify(c.j));
  assert.equal((await http('POST', T(c.j.task.id) + '/accept', { token: RJ })).status, 200);
  return c.j.task;
}
const ids = {};
const ledger = async (tok, q) => (await http('GET', '/api/time-ledger' + (q || ''), { token: tok }));

test('setup', async () => {
  await start(); await sessions();
  client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Time Ltd', email: 'tm' + Date.now() + '@t.co' } })).j.client;
  ids.main = (await mk('Client processing')).id;       // the 8-hour task: worked across two days
  ids.swap = (await mk('Handed over mid-run')).id;
  ids.done = (await mk('Done with actual hours', { tat: 4 })).id;
  ids.back = (await mk('Backdated start', { tat: 3 })).id;
});

test('make the clocks start in the past (stop, edit the data file, restart)', async () => {
  await stop();
  const f = path.join(dir, 'db.json'), st = JSON.parse(fs.readFileSync(f, 'utf8'));
  const set = (id, over) => Object.assign(st.tasks.find(x => x.id === id), over);
  // running since 2 hours before NZ midnight → 2 h belong to yesterday, the rest to today
  set(ids.main, { startedAt: new Date(nzMidnightMs() - 2 * 3600000).toISOString(), timerStartedAt: new Date(nzMidnightMs() - 2 * 3600000).toISOString(), logged: 1 });
  set(ids.swap, { startedAt: new Date(Date.now() - 3600000).toISOString(), timerStartedAt: new Date(Date.now() - 3600000).toISOString() });   // running for an hour, on Ranjit
  fs.writeFileSync(f, JSON.stringify(st));
  await start(); await sessions();
});

test('a running clock already counts for today, before it is paused', async () => {
  const r = (await ledger(RJ, '?from=' + day(-1) + '&to=' + day(0))).j;
  assert.ok(r.totalHours > 3, 'the clocks running now are counted: ' + r.totalHours);
  const t = (await http('GET', T(ids.main) + '/time', { token: RJ })).j;
  assert.ok(t.runningHours > 2, 'running hours are shown'); assert.equal(t.tracked, 0, 'nothing banked yet');
});

test('PAUSE writes dated entries: 2 h on yesterday, the rest on today — and they add up to what was logged', async () => {
  assert.equal((await http('POST', T(ids.main) + '/pause', { token: RJ })).status, 200);
  const t = (await http('GET', T(ids.main) + '/time', { token: RJ })).j;
  const y = t.rows.find(r => r.day === day(-1)), d = t.rows.find(r => r.day === day(0));
  assert.ok(y && d, JSON.stringify(t.rows)); near(y.hours, 2, 0.02, 'yesterday'); assert.equal(y.name, 'Ranjit Choudhary'); assert.deepEqual(y.sources, ['Work clock']);
  near(t.tracked, y.hours + d.hours, 0.02, 'tracked is the sum of the days');
  near(t.logged, 1 + t.tracked, 0.02, 'logged = the 1 h that was there before + the ledger');
  near(t.earlier, 1, 0.02, 'the 1 h that had no day recorded is shown as earlier time — not given a day');
  assert.equal(t.allocated, 8); assert.equal(t.runningHours, 0);
  assert.equal(t.byPerson.length, 1);
});

test('the person report: by day, by task, by client — and it matches the task', async () => {
  const r = (await ledger(RJ, '?from=' + day(-1) + '&to=' + day(0))).j;
  const yDay = r.days.find(x => x.day === day(-1));
  assert.equal(r.days[0].day, day(0), 'newest first'); near(yDay.hours, 2, 0.02);
  const item = yDay.items.find(i => i.name === 'Client processing'); assert.ok(item); assert.equal(item.client, 'Time Ltd');
  const bt = r.byTask.find(x => x.name === 'Client processing'); assert.equal(bt.allocated, 8); assert.equal(bt.days, 2);
  near(bt.hours, 2 + r.days.find(x => x.day === day(0)).items.find(i => i.name === 'Client processing').hours, 0.02);
  assert.equal(r.byClient[0].client, 'Time Ltd'); near(r.byClient[0].hours, r.totalHours, 0.02);
  assert.ok(r.days.every(d => 'standard' in d));
  assert.equal((await ledger(RJ, '?from=' + day(-1) + '&to=' + day(-1))).j.days.length, 1, 'a one-day range is one day');
  assert.equal((await ledger(RJ, '?from=bad&to=worse')).status, 200, 'bad dates fall back to the last 7 days');
  assert.equal((await ledger(RJ, '?from=' + day(0) + '&to=' + day(-3))).status, 400);
  assert.equal((await ledger(RJ, '?from=' + day(-200) + '&to=' + day(0))).status, 400, 'three months at most');
});

test('REASSIGN: the time already run stays with the person who did it', async () => {
  const r = await http('POST', T(ids.swap) + '/reassign', { token: SA, body: { newAssigneeId: emp('suneha').id, reason: 'covering' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const t = (await http('GET', T(ids.swap) + '/time', { token: SA })).j;
  assert.equal(t.byPerson.length, 1); assert.equal(t.byPerson[0].name, 'Ranjit Choudhary'); near(t.tracked, 1, 0.03);
  const su = (await http('GET', '/api/time-ledger?empId=' + enc(emp('suneha').id) + '&from=' + day(-1) + '&to=' + day(0), { token: SA })).j;
  assert.equal(su.byTask.some(x => x.name === 'Handed over mid-run'), false, 'not on the new assignee');
});

test('MARK DONE with actual hours, and a superadmin correction: both are recorded as dated changes (a correction can be negative)', async () => {
  assert.equal((await http('POST', T(ids.done) + '/done', { token: RJ, body: { actualHours: 4 } })).status, 200);
  let t = (await http('GET', T(ids.done) + '/time', { token: RJ })).j;
  assert.equal(t.logged, 4); assert.equal(t.tracked, 4); assert.equal(t.rows[0].day, today()); assert.deepEqual(t.rows[0].sources, ['Actual hours entered on Mark Done']);
  const c = await http('POST', T(ids.done) + '/correct-logged', { token: SA, body: { logged: 3, note: 'left the timer on at lunch' } });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  t = (await http('GET', T(ids.done) + '/time', { token: RJ })).j;
  assert.equal(t.logged, 3); assert.equal(t.tracked, 3, 'the ledger still adds up to the total'); assert.equal(t.earlier, 0);
  assert.deepEqual(t.rows[0].sources.sort(), ['Actual hours entered on Mark Done', 'Correction']);
});

test('BACKDATED hours entered at Start have no day, so they are shown apart and never spread over days', async () => {
  const r = await http('POST', T(ids.back) + '/resume', { token: RJ, body: { backdatedHours: 2 } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  await http('POST', T(ids.back) + '/pause', { token: RJ });
  const t = (await http('GET', T(ids.back) + '/time', { token: RJ })).j;
  const undated = t.rows.find(x => x.day === null); assert.ok(undated); assert.equal(undated.hours, 2); assert.deepEqual(undated.sources, ['Hours entered when starting']);
  const rep = (await ledger(RJ, '?from=' + day(-3) + '&to=' + day(0))).j;
  assert.equal(rep.undatedHours, 2, 'reported apart'); assert.equal(rep.days.every(d => d.items.every(i => i.name !== 'Backdated start' || i.hours < 0.1)), true, 'not placed on any day');
});

test('SCOPING: a person sees their own time; a colleague cannot; a manager sees the team and the whole-team view', async () => {
  assert.equal((await http('GET', '/api/time-ledger?empId=' + enc(emp('ranjit').id), { token: KH })).status, 403, 'a colleague cannot read it');
  assert.equal((await http('GET', '/api/time-ledger?empId=' + enc(emp('ranjit').id), { token: SA })).status, 200);
  assert.equal((await http('GET', '/api/time-ledger?empId=nope', { token: SA })).status, 404);
  assert.equal((await http('GET', '/api/time-ledger/team', { token: KH })).status, 403, 'the team view is for managers');
  const team = (await http('GET', '/api/time-ledger/team?from=' + day(-1) + '&to=' + day(0), { token: SA })).j;
  const rj = team.people.find(p => p.id === emp('ranjit').id);
  assert.ok(rj.hours > 4, 'Ranjit worked'); assert.equal(team.people[0].id, rj.id, 'most time first'); assert.equal(rj.topClients[0].client, 'Time Ltd');
  assert.equal((await http('GET', T(ids.main) + '/time', { token: KH })).status, 404, 'a task you cannot see has no time to read');
  assert.equal((await http('GET', '/api/time-ledger')).status, 401);
  // the ledger is not shipped with every task poll
  assert.equal('timeLedger' in (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(t => t.id === ids.main), false);
});

test('CSV: the same rows as the list, with the hours', async () => {
  const q = '?from=' + day(-1) + '&to=' + day(0);
  const list = (await ledger(RJ, q)).j, csv = await http('GET', '/api/time-ledger' + q + '&format=csv', { token: RJ, raw: true });
  assert.equal(csv.status, 200); assert.match(csv.type, /text\/csv/);
  const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines[0], 'Date,Employee,Task,Client,Hours,How recorded');
  assert.equal(lines.length - 1, list.days.reduce((n, d) => n + d.items.length, 0), 'one line per day-and-task');
  assert.ok(lines.some(l => l.startsWith(day(-1) + ',Ranjit Choudhary,Client processing,Time Ltd,')));
});
