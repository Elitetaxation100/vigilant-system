// The person doing the work can choose who re-reviews when resubmitting, and can move a task that is waiting for review to another reviewer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-chrev-'));
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
let SA, PA, RJ, HU, E, clientId;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const T = id => '/api/tasks/' + enc(id);
const get = async (tok, id) => (await http('GET', '/api/tasks', { token: tok })).j.tasks.find(t => t.id === id);
const inbox = async tok => (await http('GET', '/api/notifications', { token: tok })).j.notifications;
async function submitted(name) {
  const r = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name, taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(2), clientDate: day(9), reviewerId: emp('parvinder').id } });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  const t = r.j.task;
  assert.equal((await http('POST', T(t.id) + '/accept', { token: RJ })).status, 200);
  assert.equal((await http('POST', T(t.id) + '/complete', { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } })).status, 200);
  return t;
}

test('setup', async () => {
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee'); HU = await login('hunny', 'Hunny@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'Rev Ltd', email: 'r@t.co' } })).j.client.id;
});

test('2. the person doing the work moves a task that is waiting for review to another reviewer — kept in the history, the new reviewer told, the waiting time not reset', async () => {
  const t = await submitted('Move me');
  const before = await get(RJ, t.id);
  assert.equal(before.reviewerId, emp('parvinder').id);
  assert.equal((await http('POST', T(t.id) + '/change-reviewer', { token: HU, body: { reviewerId: emp('shubham').id } })).status, 403, 'someone else cannot');
  assert.equal((await http('POST', T(t.id) + '/change-reviewer', { token: RJ, body: { reviewerId: emp('ranjit').id } })).status, 400, 'not himself');
  assert.equal((await http('POST', T(t.id) + '/change-reviewer', { token: RJ, body: { reviewerId: emp('parvinder').id } })).status, 400, 'a different person');
  assert.equal((await http('POST', T(t.id) + '/change-reviewer', { token: RJ, body: { reviewerId: 'nobody' } })).status, 400);
  const ok = await http('POST', T(t.id) + '/change-reviewer', { token: RJ, body: { reviewerId: emp('shubham').id, reason: 'Parvinder is on leave' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  const after = await get(RJ, t.id);
  assert.equal(after.reviewerId, emp('shubham').id);
  assert.equal(after.completedAt, before.completedAt, 'the time it has waited is not reset');
  assert.equal(after.reviewerHistory.length, 1);
  assert.deepEqual({ from: after.reviewerHistory[0].from, to: after.reviewerHistory[0].to, by: after.reviewerHistory[0].by, via: after.reviewerHistory[0].via, reason: after.reviewerHistory[0].reason }, { from: emp('parvinder').id, to: emp('shubham').id, by: emp('ranjit').id, via: 'change', reason: 'Parvinder is on leave' });
  assert.ok((await inbox(SA)).some(n => /sent "Move me" to you for review/.test(n.text || n.message || JSON.stringify(n))), 'the new reviewer is told');
  assert.ok(!(await inbox(PA)).some(n => /Move me/.test(JSON.stringify(n))), 'the old reviewer no longer has it waiting in their inbox');
});

test('2b. it cannot be moved once reviewed or escalated — only while it is waiting', async () => {
  const t = await submitted('Reviewed already');
  assert.equal((await http('POST', T(t.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'r0', category: 'Other', responsibility: 'Employee', dueDate: day(3), note: 'redo' } })).status, 200);
  assert.equal((await http('POST', T(t.id) + '/change-reviewer', { token: RJ, body: { reviewerId: emp('shubham').id } })).status, 400);
  const n = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'Not submitted', taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(2), clientDate: day(9), reviewerId: emp('parvinder').id } });
  assert.equal((await http('POST', T(n.j.task.id) + '/change-reviewer', { token: RJ, body: { reviewerId: emp('shubham').id } })).status, 400, 'nothing to move before it is submitted');
});

test('1. resubmitting a returned task: the same reviewer by default, or a different one chosen by the person doing the work', async () => {
  // default: same reviewer
  const a = await submitted('Resubmit same');
  assert.equal((await http('POST', T(a.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'a1', category: 'Other', responsibility: 'Employee', dueDate: day(3), note: 'redo' } })).status, 200);
  assert.equal((await http('POST', T(a.id) + '/accept', { token: RJ })).status, 200);
  assert.equal((await http('POST', T(a.id) + '/resubmit', { token: RJ })).status, 200);
  let t = await get(RJ, a.id);
  assert.equal(t.reviewerId, emp('parvinder').id); assert.equal((t.reviewerHistory || []).length, 0);
  // a different reviewer
  const b = await submitted('Resubmit other');
  assert.equal((await http('POST', T(b.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'b1', category: 'Other', responsibility: 'Employee', dueDate: day(3), note: 'redo' } })).status, 200);
  assert.equal((await http('POST', T(b.id) + '/accept', { token: RJ })).status, 200);
  const bad = await http('POST', T(b.id) + '/resubmit', { token: RJ, body: { reviewerId: emp('ranjit').id } });
  assert.equal(bad.status, 400, 'not himself');
  assert.equal((await get(RJ, b.id)).status, 'rework', 'a refused resubmit changes nothing');
  const ok = await http('POST', T(b.id) + '/resubmit', { token: RJ, body: { reviewerId: emp('shubham').id, reason: 'Needs the founder to look' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  t = await get(RJ, b.id);
  assert.equal(t.status, 'completed'); assert.equal(t.reviewerId, emp('shubham').id);
  assert.equal(t.reviewerHistory.length, 1); assert.equal(t.reviewerHistory[0].via, 'resubmit');
  assert.equal(t.submissions.at(-1).kind, 'resubmit'); assert.equal(t.submissions.at(-1).reviewerId, emp('shubham').id, 'the hand-in record names the reviewer it went to');
  assert.ok((await inbox(SA)).some(n => /Resubmit other/.test(JSON.stringify(n))));
});

// ---- what the screen offers
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
test('the screens offer both: a "Send for re-review to" choice when resubmitting, and "Change reviewer" on his own task while it waits; the history shows it', () => {
  assert.match(html, /<select id="rsReviewer">\$\{reviewerOptionsHtml\(t, t\.reviewerId\)\}<\/select>/);
  assert.match(html, /if\(sel && sel\.value && t && sel\.value !== t\.reviewerId\) body\.reviewerId = sel\.value/);
  assert.match(html, /function iCanChangeReviewer\(t\)\{\s*return !!\(t && t\.status === 'completed' && !t\.reviewStatus && t\.reviewerId && !\(t\.escalation && t\.escalation\.status === 'open'\) && t\.assignedTo === currentViewerId\)/);
  assert.equal((html.match(/iCanChangeReviewer\(t\)/g) || []).length >= 4, true, 'on the classic rows and in the details panel');
  assert.match(html, /\/change-reviewer', \{ method:'POST'/);
  assert.match(html, /changed the reviewer from <b>/);
});
