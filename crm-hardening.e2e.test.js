// ET-CRM connection hardening — end to end on a REAL server (throwaway data), with ET-CRM deliberately UNREACHABLE (a dead API
// address and a junk key): the health panel, the read-only one-click check, the explicit "no leave" cut-over, inactive people
// never receiving new work (assignee AND reviewer), history keeping their names, and core task APIs staying up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRET = 'e2e-hardening-secret', API_KEY = 'junk-api-key-123';
const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-harden-'));
let child;
const enc = encodeURIComponent;

async function http(method, p, { token, body, secret } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (secret !== undefined && secret !== null) headers['X-CRM-Webhook-Secret'] = secret;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const hook = (kind, record, type = 'INSERT', secret = SECRET) => http('POST', '/webhooks/crm-' + kind, { secret, body: { type, table: kind, record, old_record: type === 'DELETE' ? record : null } });
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } }));

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, CRM_WEBHOOK_SECRET: SECRET, CRM_API_KEY: API_KEY, CRM_API_URL: 'https://127.0.0.1:9/crm-api', LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, RJ, DI, E;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const panel = async () => (await http('GET', '/api/admin/crm-sync', { token: SA })).j;

test('setup', async () => {
  SA = (await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin')).j.token;
  RJ = (await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee')).j.token;
  DI = (await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin')).j.token;
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
});

test('PANEL: ownership labels, link health, secret and API status, staleness — and no secret anywhere', async () => {
  const d = await panel();
  assert.deepEqual(d.ownership.map(o => o.area + ':' + o.source), ['Employees:ET-CRM', 'Customers:ET-CRM', 'Attendance:ET-CRM', 'Leave:ET-CRM', 'Policy compliance:ET-CRM', 'Tasks:Task Manager']);
  const h = d.health;
  assert.ok(h.employees.linked >= 0 && Array.isArray(h.employees.unlinkedEmployees) && Array.isArray(h.employees.duplicateEmails));
  assert.ok(h.employees.unlinkedEmployees.every(u => u.crmUserId === null && 'candidate' in u));
  assert.ok('linkBack' in h.customers && 'skipReasons' in h.customers);
  assert.equal(h.secret.configured, true); assert.equal(h.api.keyConfigured, true); assert.equal(h.api.urlConfigured, true);
  assert.deepEqual(h.api.actions, ['link-task-manager-client', 'get-policy-compliance', 'list-pipeline']);
  assert.equal(h.staleness.attendance.status, 'never'); assert.equal(h.staleness.leave.status, 'never');
  assert.equal(d.legacyTask.disabled, true);
  const text = JSON.stringify(d);
  assert.ok(!text.includes(SECRET) && !text.includes(API_KEY), 'neither the secret nor the API key is ever shown');
});

test('a refused webhook call is recorded safely as a bad secret — and the secret itself is never logged', async () => {
  assert.equal((await hook('user', { id: 'u-x', email: 'x@y.nz' }, 'INSERT', 'WRONG-SECRET-VALUE')).status, 401);
  const d = await panel();
  assert.equal(d.health.secret.recentRefused24h, 1);
  const ev = d.events.find(e => /rejected/.test(e.note));
  assert.ok(ev && /bad secret|rejected/.test(ev.note)); assert.ok(!JSON.stringify(d).includes('WRONG-SECRET-VALUE'));
});

test('ONE-CLICK CHECK: superadmin only, honest, READ-ONLY, and ET-CRM being down does not break it', async () => {
  assert.equal((await http('POST', '/api/admin/crm-sync/check', { token: DI })).status, 403, 'an admin is not enough');
  assert.equal((await http('POST', '/api/admin/crm-sync/check', { token: RJ })).status, 403);
  const before = JSON.stringify((await panel()));
  const t0 = Date.now();
  const r = await http('POST', '/api/admin/crm-sync/check', { token: SA });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(Date.now() - t0 < 20000, 'an unreachable ET-CRM does not hang the check');
  assert.equal(r.j.status, 'needs_attention'); assert.equal(r.j.label, 'Needs Attention');
  const by = k => r.j.checks.find(c => c.key === k);
  assert.equal(by('secret').status, 'ok'); assert.equal(by('legacy_task').status, 'ok');
  assert.equal(by('api_pipeline').status, 'fail', 'the unreachable ET-CRM is reported, not hidden');
  assert.match(by('api_linkback').detail, /Not testable without writing/);
  const text = JSON.stringify(r.j);
  assert.ok(!text.includes(SECRET) && !text.includes(API_KEY), 'no secret in the answer');
  const after = JSON.stringify((await panel()));
  assert.equal(after, before, 'READ-ONLY: running the check changed nothing the panel shows');
});

test('CUT-OVER: leave may be switched on with no leave only if a founder CONFIRMS it; attendance never without data', async () => {
  const no = await http('POST', '/api/admin/crm-sync/cutover', { token: SA, body: { leave: true } });
  assert.equal(no.status, 409); assert.equal(no.j.code, 'CONFIRM_NO_LEAVE_POSSIBLE'); assert.match(no.j.error, /confirm that there is currently no leave/);
  assert.equal((await http('POST', '/api/admin/crm-sync/cutover', { token: DI, body: { leave: true, confirmNoLeave: true } })).status, 403, 'only a superadmin');
  const att = await http('POST', '/api/admin/crm-sync/cutover', { token: SA, body: { attendance: true, confirmNoLeave: true } });
  assert.equal(att.status, 409, 'there is no "confirm" way round attendance'); assert.equal(att.j.code, 'NO_EVIDENCE');
  const st = (await panel()).cutover;
  assert.equal(st.attendance.ready, false); assert.equal(st.leave.ready, false);
  assert.ok('linkedEmployees' in st.attendance && 'unlinkedEmployees' in st.attendance && Array.isArray(st.attendance.recentErrors));
  const ok = await http('POST', '/api/admin/crm-sync/cutover', { token: SA, body: { leave: true, confirmNoLeave: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.leave.on, true); assert.equal(ok.j.leave.confirmedNoLeave, true);
  assert.deepEqual((await http('GET', '/api/crm-mode', { token: RJ })).j, { attendanceFromCrm: false, leaveFromCrm: true });
  assert.equal((await http('POST', '/api/admin/crm-sync/cutover', { token: SA, body: { leave: false } })).j.leave.on, false, 'and it can always be switched back');
});

test('INACTIVE: never offered new work — not as an assignee, not as a reviewer — and history keeps their name', async () => {
  // Disha gets a task (history), then ET-CRM says she has left
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Inactive Ltd', email: 'in' + Date.now() + '@t.co' } })).j.client;
  const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), cd = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const old = (await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Disha historic task', clientId: client.id, assignedTo: emp('disha').id, tat: 1, internalDeadline: due, clientDate: cd } })).j.task;
  const gone = await hook('user', { crm_user_id: 'crm-disha', email: 'disha@elitetaxation.co.nz', full_name: 'Disha Chaudhary', is_active: false, employment_status: 'resigned' });
  assert.equal(gone.status, 200, JSON.stringify(gone.j));
  // a new task for her is refused
  const fresh = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'For the leaver', clientId: client.id, assignedTo: emp('disha').id, tat: 1, internalDeadline: due, clientDate: cd } });
  assert.ok(fresh.status >= 400 && fresh.status < 500, 'new work for an inactive person is refused (' + fresh.status + ')');
  // she is refused as a reviewer too
  const t = (await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Needs a reviewer', clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: due, clientDate: cd } })).j.task;
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: RJ })).status, 200);
  const rv = await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } });
  assert.equal(rv.status, 400); assert.match(rv.j.error, /no longer active/);
  assert.equal((await http('GET', '/api/tasks', { token: SA })).j.tasks.find(x => x.id === t.id).status, 'accepted', 'the refused attempt changed nothing');
  // history is intact: she is still in the list with her name, and the old task still points at her
  const E2 = (await http('GET', '/api/employees', { token: SA })).j.employees;
  const d = E2.find(e => e.email === 'disha@elitetaxation.co.nz');
  assert.equal(d.name, 'Disha Chaudhary'); assert.ok(d.accessDisabled, 'login is off');
  assert.equal((await http('GET', '/api/tasks', { token: SA })).j.tasks.find(x => x.id === old.id).assignedTo, d.id, 'the historic task still belongs to her');
  assert.equal((await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin')).status, 403, 'and she cannot log in');
});

test('CORE TASK APIS STAY UP while ET-CRM is down (dead API address, junk key, failing link-back, refused webhooks)', async () => {
  // a customer webhook triggers a link-back to an unreachable ET-CRM — it must not take anything down
  const c = await hook('customer', { id: 'k-down-1', name: 'Down Plumbing Ltd', email: 'down' + Date.now() + '@dp.nz', authority_signed: true, pbq_done_at: '2026-09-01T00:00:00Z' });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  await new Promise(r => setTimeout(r, 1500));
  const lb = (await panel()).sections.customers.linkBack;
  assert.ok(lb.errors >= 1 || lb.conflicts >= 1 || lb.lastFailure, 'the failed link-back is recorded for the founder: ' + JSON.stringify(lb));
  // …and every core task API still works
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Still Works Ltd', email: 'sw' + Date.now() + '@t.co' } })).j.client;
  const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), cd = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const t = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Created while ET-CRM is down', clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: due, clientDate: cd } });
  assert.equal(t.status, 201, JSON.stringify(t.j));
  assert.equal((await http('POST', `/api/tasks/${enc(t.j.task.id)}/accept`, { token: RJ })).status, 200);
  assert.ok((await http('GET', '/api/tasks', { token: RJ })).j.tasks.some(x => x.id === t.j.task.id));
  assert.equal((await http('GET', '/api/productivity', { token: SA })).status, 200);
  // a refused / garbage webhook never throws a 5xx
  assert.equal((await hook('attendance', { nonsense: true })).status < 500, true);
  assert.equal((await http('POST', '/webhooks/crm-user', { secret: SECRET, body: 'not json at all' })).status < 500, true);
  // the legacy task webhook is still refused
  assert.equal((await http('POST', '/webhooks/crm-task', { secret: SECRET, body: { type: 'INSERT', record: { id: 't1', title: 'x' } } })).status, 410);
});
