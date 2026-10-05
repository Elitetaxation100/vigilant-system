// One person on two teams at a time — end to end on a real server (throwaway data folder).
// Seed: Disha (admin, GST Team) manages GST Team; Ranjit is on Rental Team. Hunny is made the manager of Rideshare Team for the test
// (Parvinder and Vishal are superadmins, who see everyone anyway).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-teams-'));
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

let SA, DI, HU, RJ, E;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const refresh = async () => { E = (await http('GET', '/api/employees', { token: SA })).j.employees; };
const people = async token => ((await http('GET', '/api/productivity', { token })).j.people || []).map(p => p.id || p.employeeId || p.empId);
const tasksSeen = async token => (await http('GET', '/api/tasks', { token })).j.tasks.map(t => t.id);
const leaveSeen = async token => (await http('GET', '/api/leave', { token })).j.leave.map(l => l.employeeId);
let taskId;

test('setup: a task and a leave for Ranjit (Rental Team) that Disha (GST Team) cannot see', async () => {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  await refresh();
  await http('PATCH', `/api/employees/${emp('hunny').id}`, { token: SA, body: { accessRole: 'admin', team: 'Rideshare Team' } });
  HU = await login('hunny@elitetaxation.co.nz', 'Hunny@2026', 'admin');
  await refresh();
  assert.equal(emp('ranjit').team, 'Rental Team'); assert.equal(emp('disha').team, 'GST Team');
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Team Test Ltd', email: 'tt' + Date.now() + '@t.co' } })).j.client;
  const due = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const t = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Ranjit work', clientId: client.id, assignedTo: emp('ranjit').id, tat: 2, internalDeadline: due } });
  assert.equal(t.status, 201); taskId = t.j.task.id;
  const l = await http('POST', '/api/leave', { token: SA, body: { employeeId: emp('ranjit').id, from: '2026-12-02', to: '2026-12-02', type: 'ANNUAL' } });
  assert.equal(l.status, 201);
});

test('BEFORE: one team each — Disha cannot see, manage or assign to Ranjit', async () => {
  assert.ok(!(await people(DI)).includes(emp('ranjit').id));
  assert.ok(!(await tasksSeen(DI)).includes(taskId));
  assert.ok(!(await leaveSeen(DI)).includes(emp('ranjit').id));
  assert.equal((await http('GET', `/api/leave/conflicts?employeeId=${emp('ranjit').id}&from=2026-12-02`, { token: DI })).status, 403);
  assert.ok(!(await http('GET', '/api/workload', { token: DI })).j.workload.some(w => w.id === emp('ranjit').id));
});

test('only a superadmin can give someone a second team; the input is cleaned', async () => {
  assert.equal((await http('PATCH', `/api/employees/${emp('ranjit').id}`, { token: RJ, body: { extraTeams: ['GST Team'] } })).status, 403);
  assert.equal((await http('PATCH', `/api/employees/${emp('ranjit').id}`, { token: DI, body: { extraTeams: ['GST Team'] } })).status, 403, 'a manager cannot do it through Manage Access');
  const r = await http('PATCH', `/api/employees/${emp('ranjit').id}`, { token: SA, body: { extraTeams: ['GST Team', ' Rideshare Team ', 'GST Team', '', 'Unassigned', 'Rental Team'] } });
  assert.equal(r.status, 200);
  await refresh();
  assert.deepEqual(emp('ranjit').extraTeams, ['GST Team', 'Rideshare Team'], 'blanks, duplicates, Unassigned and his own primary team are dropped');
  assert.equal(emp('ranjit').team, 'Rental Team', 'the primary team is untouched');
  // comma-separated text works too (what the Manage Access box sends)
  await http('PATCH', `/api/employees/${emp('anjana').id}`, { token: SA, body: { extraTeams: 'GST Team, Rideshare Team' } });
  await refresh();
  assert.deepEqual(emp('anjana').extraTeams, ['GST Team', 'Rideshare Team']);
  await http('PATCH', `/api/employees/${emp('anjana').id}`, { token: SA, body: { extraTeams: [] } });
});

test('AFTER: the managers of BOTH of his teams see him, can assign to him and review his work; his own team still does', async () => {
  const id = emp('ranjit').id;
  for (const [name, tok] of [['Disha (GST Team)', DI], ['Hunny (Rideshare Team)', HU]]) {
    assert.ok((await people(tok)).includes(id), name + ' sees him in productivity');
    assert.ok((await tasksSeen(tok)).includes(taskId), name + ' sees his tasks');
    assert.ok((await leaveSeen(tok)).includes(id), name + ' sees his leave');
    assert.equal((await http('GET', `/api/leave/conflicts?employeeId=${id}&from=2026-12-02`, { token: tok })).status, 200, name + ' can manage him');
    assert.ok((await http('GET', '/api/workload', { token: tok })).j.workload.some(w => w.id === id), name + ' can assign to him (workload list)');
  }
  assert.ok(await tasksSeen(RJ).then(l => l.includes(taskId)), 'he still sees his own work');
  // someone on neither team still cannot
  const VI = await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee');
  assert.ok(!(await tasksSeen(VI)).includes(taskId), 'a plain colleague still cannot see it');
});

test('a manager can NOT see someone just because that person has a team of their own they do not manage', async () => {
  // Suneha is on GST Team (Disha's). Hunny (Rideshare) must not gain her.
  assert.ok(!(await people(HU)).includes(emp('suneha').id));
});

test('MY TEAM: adding someone who is on another team keeps them there too; a free person simply joins; removing returns them', async () => {
  const add = await http('POST', '/api/team/add', { token: DI, body: { employeeId: emp('anjana').id } });
  assert.equal(add.status, 200); assert.equal(add.j.mode, 'also'); assert.deepEqual(add.j.alsoOn, ['Rental Team']);
  await refresh();
  assert.equal(emp('anjana').team, 'Rental Team', 'Anjana stays on Rental Team'); assert.deepEqual(emp('anjana').extraTeams, ['GST Team']);
  assert.ok((await people(DI)).includes(emp('anjana').id));

  assert.equal((await http('POST', '/api/team/add', { token: DI, body: { employeeId: emp('anjana').id } })).j.mode, 'already', 'adding twice is a no-op');

  const free = await http('POST', '/api/team/add', { token: DI, body: { employeeId: emp('smita').id } });
  assert.equal(free.j.mode, 'moved'); await refresh(); assert.equal(emp('smita').team, 'GST Team');

  const rm = await http('POST', '/api/team/remove', { token: DI, body: { employeeId: emp('anjana').id } });
  assert.equal(rm.j.mode, 'removed'); await refresh();
  assert.deepEqual(emp('anjana').extraTeams, []); assert.equal(emp('anjana').team, 'Rental Team');
  assert.ok(!(await people(DI)).includes(emp('anjana').id));

  assert.equal((await http('POST', '/api/team/remove', { token: DI, body: { employeeId: emp('smita').id } })).j.mode, 'removed');
  await refresh(); assert.equal(emp('smita').team, 'Unassigned');
});

test('removing someone from their PRIMARY team promotes their other team (they are not dropped to Unassigned)', async () => {
  await http('PATCH', `/api/employees/${emp('nitish').id}`, { token: SA, body: { extraTeams: ['Rental Team'] } });
  assert.equal(emp('nitish').team, 'GST Team');
  const rm = await http('POST', '/api/team/remove', { token: DI, body: { employeeId: emp('nitish').id } });
  assert.equal(rm.j.mode, 'removed'); await refresh();
  assert.equal(emp('nitish').team, 'Rental Team', 'the other team becomes the primary'); assert.deepEqual(emp('nitish').extraTeams, []);
});

test('changing the primary team to one of the extras does not leave a duplicate', async () => {
  await http('PATCH', `/api/employees/${emp('ranjit').id}`, { token: SA, body: { team: 'GST Team' } });
  await refresh();
  assert.equal(emp('ranjit').team, 'GST Team'); assert.deepEqual(emp('ranjit').extraTeams, ['Rideshare Team']);
});
