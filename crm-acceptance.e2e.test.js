// ET-CRM ACCEPTANCE — leave capacity and policy compliance, proven on a REAL server
// started on a throwaway data folder with a fixture employee. No real employee,
// leave or policy record is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRET = 'e2e-secret';
const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-e2e-'));
let child;

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
  child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, CRM_WEBHOOK_SECRET: SECRET, LOGIN_RATE_LIMIT: '10000', CRM_API_KEY: '', NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/webhooks/health'); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, KH, fx;
const FX = 'crm-u-acceptance-fixture';
const lv = o => ({ crm_leave_request_id: 'acc-lv-1', crm_user_id: FX, start_date: '2026-10-14', end_date: '2026-10-14', days_count: 1, is_half_day: false, status: 'approved', ...o });
async function capacity(date) {
  const r = await http('GET', `/api/productivity?from=${date}&to=${date}`, { token: SA });
  assert.equal(r.status, 200);
  const p = (r.j.people || []).find(x => x.id === fx.id || x.employeeId === fx.id || x.empId === fx.id);
  assert.ok(p, 'fixture is in the productivity report');
  return p.capacityHours;
}
const records = async id => (await http('GET', '/api/leave', { token: SA })).j.leave.filter(l => l.crmLeaveRequestId === id);
const policy = (userId, pending, compliant) => ({ version: 1, event: 'policy.compliance.updated', employee: { crm_user_id: userId, email: '' }, compliance: { pending_count: pending, compliant }, policy: { version_id: 'v1', name: 'Code of conduct' } });
const pol = (userId, pending, compliant) => http('POST', '/webhooks/crm-policy-compliance', { secret: SECRET, body: policy(userId, pending, compliant) });

test('setup: a fixture employee arrives from ET-CRM (nobody real is touched)', async () => {
  SA = (await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin')).j.token;
  const c = await hook('user', { crm_user_id: FX, full_name: 'Acceptance Fixture', email: 'acceptance.fixture@elitetaxation.co.nz', is_active: true, employment_status: 'active' });
  assert.equal(c.status, 200);
  fx = (await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.crmUserId === FX);
  assert.ok(fx);
});
test('FULL-DAY LEAVE: approved → capacity reduced by exactly 7 h', async () => {
  const before = await capacity('2026-10-14');
  assert.equal((await hook('leave', lv())).status, 200);
  assert.equal(before - await capacity('2026-10-14'), 7);
});
test('HALF-DAY LEAVE: approved → capacity reduced by exactly 3.5 h', async () => {
  const before = await capacity('2026-10-15');
  assert.equal((await hook('leave', lv({ crm_leave_request_id: 'acc-lv-half', start_date: '2026-10-15', end_date: '2026-10-15', days_count: 0.5, is_half_day: true, half_day_period: 'morning' }))).status, 200);
  assert.equal(before - await capacity('2026-10-15'), 3.5);
});
test('LEAVE CANCELLATION: the exact removed capacity is restored (7 h and 3.5 h)', async () => {
  assert.equal((await hook('leave', lv({ status: 'cancelled' }), 'UPDATE')).status, 200);
  assert.equal(await capacity('2026-10-14'), 7);
  assert.equal((await hook('leave', lv({ crm_leave_request_id: 'acc-lv-half', start_date: '2026-10-15', end_date: '2026-10-15', is_half_day: true, status: 'cancelled' }), 'UPDATE')).status, 200);
  assert.equal(await capacity('2026-10-15'), 7);
});
test('PENDING / REJECTED LEAVE: no capacity reduction', async () => {
  assert.equal((await hook('leave', lv({ crm_leave_request_id: 'acc-pending', start_date: '2026-10-16', end_date: '2026-10-16', status: 'pending' }))).status, 200);
  assert.equal(await capacity('2026-10-16'), 7);
  assert.equal((await hook('leave', lv({ crm_leave_request_id: 'acc-rejected', start_date: '2026-10-19', end_date: '2026-10-19', status: 'rejected' }))).status, 200);
  assert.equal(await capacity('2026-10-19'), 7);
});
test('LEAVE IDEMPOTENCY: the same crm_leave_request_id updates one record, never duplicates', async () => {
  for (let i = 0; i < 3; i++) assert.ok([200, 202].includes((await hook('leave', lv({ crm_leave_request_id: 'acc-idem', start_date: '2026-10-20', end_date: '2026-10-20', status: 'approved' }), i ? 'UPDATE' : 'INSERT')).status));
  assert.equal((await records('acc-idem')).length, 1);
  assert.equal(await capacity('2026-10-20'), 0);
  await hook('leave', lv({ crm_leave_request_id: 'acc-idem', start_date: '2026-10-20', end_date: '2026-10-20', status: 'cancelled' }), 'UPDATE');
  assert.equal((await records('acc-idem')).length, 1);
  assert.equal(await capacity('2026-10-20'), 7);
  assert.equal((await records('acc-lv-1')).length, 1);
});
test('POLICY BLOCK: a non-compliant normal employee is blocked (423 policy_acknowledgement_required); the lock screen still works', async () => {
  KH = (await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee')).j.token;
  assert.equal((await hook('user', { crm_user_id: 'crm-u-khushi', full_name: 'Khushi', email: 'khushi@elitetaxation.co.nz', is_active: true }, 'UPDATE')).status, 200);
  assert.equal((await http('GET', '/api/tasks', { token: KH })).status, 200);
  assert.equal((await pol('crm-u-khushi', 2, false)).status, 200);
  const b = await http('GET', '/api/tasks', { token: KH });
  assert.equal(b.status, 423); assert.equal(b.j.error, 'policy_acknowledgement_required');
  assert.equal((await http('GET', '/api/auth/me', { token: KH })).status, 200);
});
test('POLICY: the same event repeated is harmless (still blocked, no error)', async () => {
  for (let i = 0; i < 3; i++) assert.ok([200, 202].includes((await pol('crm-u-khushi', 2, false)).status));
  assert.equal((await http('GET', '/api/tasks', { token: KH })).status, 423);
});
test('ADMIN EMERGENCY ACCESS: an admin flagged non-compliant keeps access', async () => {
  assert.equal((await hook('user', { crm_user_id: 'crm-u-founder', full_name: 'Shubam Sharma', email: 'shubham@elitetaxation.co.nz', is_active: true }, 'UPDATE')).status, 200);
  assert.equal((await pol('crm-u-founder', 1, false)).status, 200);
  assert.equal((await http('GET', '/api/tasks', { token: SA })).status, 200);
  assert.equal((await http('GET', '/api/admin/crm-sync', { token: SA })).status, 200);
});
test('POLICY UNBLOCK: compliant → access restored; a repeat of that event is harmless', async () => {
  assert.equal((await pol('crm-u-khushi', 0, true)).status, 200);
  assert.equal((await http('GET', '/api/tasks', { token: KH })).status, 200);
  assert.ok([200, 202].includes((await pol('crm-u-khushi', 0, true)).status));
  assert.equal((await http('GET', '/api/tasks', { token: KH })).status, 200);
  await pol('crm-u-founder', 0, true);
});
