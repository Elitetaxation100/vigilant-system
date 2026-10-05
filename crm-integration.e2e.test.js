// ET-CRM ↔ Task Manager — end to end. Starts a REAL server on a throwaway data
// folder (never the real data) and drives the five live webhooks over HTTP:
// security, employees, customers, attendance, leave (capacity!), policy
// compliance, the disabled legacy task webhook, and the admin panel's numbers.
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

let SA, employees;
const emp = email => employees.find(e => e.email === email);
const adminState = async () => (await http('GET', '/api/admin/crm-sync', { token: SA })).j;

test('setup: log in as the founder', async () => {
  const r = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  assert.equal(r.status, 200); SA = r.j.token;
  employees = (await http('GET', '/api/employees', { token: SA })).j.employees;
  assert.ok(emp('ranjit@elitetaxation.co.nz'));
});

/* ------------------------------ security & validation ------------------------------ */
test('every ET-CRM webhook needs the secret: missing or wrong → 401, nothing processed', async () => {
  for (const kind of ['user', 'customer', 'attendance', 'leave', 'task']) {
    assert.equal((await hook(kind, { id: 'x' }, 'INSERT', null)).status, 401, kind + ' without secret');
    assert.equal((await hook(kind, { id: 'x' }, 'INSERT', 'wrong')).status, 401, kind + ' with a wrong secret');
  }
  const pol = { version: 1, event: 'policy.compliance.updated', employee: { crm_user_id: 'u' }, compliance: { pending_count: 0, compliant: true } };
  assert.equal((await http('POST', '/webhooks/crm-policy-compliance', { body: pol })).status, 401);
  assert.equal((await http('POST', '/webhooks/crm-policy-compliance', { body: pol, secret: 'nope' })).status, 401);
  assert.equal(employees.length, (await http('GET', '/api/employees', { token: SA })).j.employees.length);
});
test('invalid payloads → 400 with a reason', async () => {
  assert.equal((await hook('user', { full_name: 'No id', email: 'x@y.nz' })).status, 400);
  assert.equal((await hook('customer', { name: 'No id' })).status, 400);
  assert.equal((await hook('attendance', { crm_user_id: 'u' })).status, 400);
  assert.equal((await hook('leave', { crm_leave_request_id: 'l', crm_user_id: 'u', start_date: '2026-10-14', status: 'maybe' })).status, 400);
  const r = await http('POST', '/webhooks/crm-user', { secret: SECRET, body: { type: 'INSERT' } });
  assert.equal(r.status, 400);
});

/* ------------------------------ EMPLOYEES ------------------------------ */
test('EMPLOYEE: a new ET-CRM user becomes a linked employee (200 created); again → same employee', async () => {
  const rec = { crm_user_id: 'crm-u-nina', full_name: 'Nina Park', email: 'nina@elitetaxation.co.nz', is_active: true, department: 'Tax', designation: 'Accountant', employment_type: 'full_time', employment_status: 'active', manager_id: 'crm-u-x' };
  const a = await hook('user', rec);
  assert.equal(a.status, 200); assert.equal(a.j.outcome, 'created');
  let list = (await http('GET', '/api/employees', { token: SA })).j.employees;
  const nina = list.find(e => e.email === 'nina@elitetaxation.co.nz');
  assert.equal(nina.crmUserId, 'crm-u-nina'); assert.equal(nina.accessRole, 'employee');
  const b = await hook('user', { ...rec, designation: 'Senior Accountant' }, 'UPDATE');
  assert.equal(b.status, 200); assert.equal(b.j.outcome, 'updated');
  const c = await hook('user', { ...rec, designation: 'Senior Accountant' }, 'UPDATE');
  assert.equal(c.status, 202); assert.equal(c.j.outcome, 'skipped');
  list = (await http('GET', '/api/employees', { token: SA })).j.employees;
  assert.equal(list.filter(e => e.crmUserId === 'crm-u-nina').length, 1);
  assert.equal(list.length, employees.length + 1, 'exactly one employee was added in total');
});
test('EMPLOYEE: a unique work email links an existing person; another CRM user on that email is a 409', async () => {
  const ranjit = emp('ranjit@elitetaxation.co.nz');
  const a = await hook('user', { crm_user_id: 'crm-u-ranjit', full_name: 'Ranjit Choudhary', email: 'RANJIT@elitetaxation.co.nz', is_active: true });
  assert.equal(a.status, 200); assert.equal(a.j.outcome, 'updated');
  const after = (await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.id === ranjit.id);
  assert.equal(after.crmUserId, 'crm-u-ranjit'); assert.equal(after.team, ranjit.team, 'org chart is untouched');
  const clash = await hook('user', { crm_user_id: 'crm-u-impostor', full_name: 'Someone', email: 'ranjit@elitetaxation.co.nz' });
  assert.equal(clash.status, 409); assert.equal(clash.j.outcome, 'conflict');
});
test('EMPLOYEE: inactive disables login and sessions, keeps history and open work; on_leave and returning are safe', async () => {
  const r0 = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  assert.equal(r0.status, 200);
  const RJ = r0.j.token;
  const ranjit = emp('ranjit@elitetaxation.co.nz');
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Aurora Ltd', email: 'a' + Date.now() + '@t.co' } })).j.client;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const made = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Open work', clientId: client.id, assignedTo: ranjit.id, tat: 2, internalDeadline: tomorrow } });
  assert.equal(made.status, 201, 'Task Manager task creation works as normal');
  const taskId = made.j.task.id;

  const leaveFirst = await hook('user', { crm_user_id: 'crm-u-ranjit', email: 'ranjit@elitetaxation.co.nz', full_name: 'Ranjit Choudhary', employment_status: 'on_leave', is_active: true }, 'UPDATE');
  assert.ok([200, 202].includes(leaveFirst.status));
  assert.equal((await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee')).status, 200, 'on leave does NOT disable the account');

  const gone = await hook('user', { crm_user_id: 'crm-u-ranjit', email: 'ranjit@elitetaxation.co.nz', full_name: 'Ranjit Choudhary', is_active: false, employment_status: 'resigned' }, 'UPDATE');
  assert.equal(gone.status, 200);
  const blockedLogin = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  assert.equal(blockedLogin.status, 403);
  const oldSession = await http('GET', '/api/tasks', { token: RJ });
  assert.equal(oldSession.status, 403); assert.equal(oldSession.j.error, 'account_deactivated');
  const tasks = (await http('GET', '/api/tasks', { token: SA })).j.tasks;
  const t = tasks.find(x => x.id === taskId);
  assert.ok(t, 'history is preserved'); assert.equal(t.assignedTo, ranjit.id, 'open work was NOT reassigned');
  assert.ok((await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.id === ranjit.id), 'the employee record is kept');

  const back = await hook('user', { crm_user_id: 'crm-u-ranjit', email: 'ranjit@elitetaxation.co.nz', full_name: 'Ranjit Choudhary', is_active: true, employment_status: 'active' }, 'UPDATE');
  assert.equal(back.status, 200);
  assert.equal((await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee')).status, 200, 'access is restored when ET-CRM says active again');
});
test('EMPLOYEE: a DELETE in ET-CRM never deletes anyone', async () => {
  const before = (await http('GET', '/api/employees', { token: SA })).j.employees.length;
  const d = await hook('user', { crm_user_id: 'crm-u-nina' }, 'DELETE');
  assert.equal(d.status, 202);
  assert.equal((await http('GET', '/api/employees', { token: SA })).j.employees.length, before);
});

/* ------------------------------ CUSTOMERS ------------------------------ */
const contact = o => ({ id: 'crm-c-1', name: 'Kiwi Plumbing Ltd', email: 'k@kp.nz', phone: '021 555 0001', authority_signed: true, pbq_done_at: '2026-09-01T00:00:00Z', ...o });
const clients = async () => (await http('GET', '/api/clients', { token: SA })).j.clients;
test('CUSTOMER: an eligible contact becomes a client; the same event again never duplicates', async () => {
  const n0 = (await clients()).length;
  const a = await hook('customer', contact());
  assert.equal(a.status, 200); assert.equal(a.j.outcome, 'created');
  const b = await hook('customer', contact());
  assert.ok(['updated', 'skipped'].includes(b.j.outcome));
  const list = await clients();
  assert.equal(list.length, n0 + 1); assert.equal(list.filter(c => c.crmContactId === 'crm-c-1').length, 1);
  const up = await hook('customer', contact({ name: 'Kiwi Plumbing Limited' }), 'UPDATE');
  assert.equal(up.j.outcome, 'updated');
  assert.equal((await clients()).find(c => c.crmContactId === 'crm-c-1').name, 'Kiwi Plumbing Limited');
});
test('CUSTOMER: not eligible yet → skipped (202) with the reason; the rule is configurable', async () => {
  const n0 = (await clients()).length;
  const a = await hook('customer', contact({ id: 'crm-c-2', name: 'Not Ready Co', email: 'nr@x.nz', pbq_done_at: null }));
  assert.equal(a.status, 202); assert.match(a.j.note, /PBQ not done/);
  assert.equal((await clients()).length, n0);
  const rule = await http('POST', '/api/admin/crm-sync/settings', { token: SA, body: { eligibility: { requirePbqDone: false } } });
  assert.equal(rule.status, 200); assert.equal(rule.j.description, 'authority signed');
  const b = await hook('customer', contact({ id: 'crm-c-2', name: 'Not Ready Co', email: 'nr@x.nz', pbq_done_at: null }));
  assert.equal(b.j.outcome, 'created');
  await http('POST', '/api/admin/crm-sync/settings', { token: SA, body: { eligibility: { requirePbqDone: true } } });
});
test('CUSTOMER: ambiguous is blocked (409); the firm\'s own address is never identity; a conflicting pointer is a 409', async () => {
  await http('POST', '/api/clients', { token: SA, body: { name: 'Twin One', email: 'twin@t.nz' } });
  await http('POST', '/api/clients', { token: SA, body: { name: 'Twin Two', email: 'twin@t.nz' } });
  const n0 = (await clients()).length;
  const amb = await hook('customer', contact({ id: 'crm-c-3', name: 'Twin Ltd', email: 'twin@t.nz' }));
  assert.equal(amb.status, 409); assert.equal(amb.j.outcome, 'ambiguous'); assert.equal((await clients()).length, n0);

  await http('POST', '/api/clients', { token: SA, body: { name: 'Training module', email: 'info@elitetaxation.co.nz' } });
  const own = await hook('customer', contact({ id: 'crm-c-4', name: 'Elite Taxation', email: 'info@elitetaxation.co.nz' }));
  assert.equal(own.j.outcome, 'created', 'a new client — the shared firm address matched nothing');
  assert.ok(!(await clients()).find(c => c.name === 'Training module').crmContactId);

  const taken = (await clients()).find(c => c.crmContactId === 'crm-c-1');
  const conf = await hook('customer', contact({ id: 'crm-c-5', name: 'Other Co', email: 'o@o.nz', task_manager_client_id: taken.id }));
  assert.equal(conf.status, 409); assert.equal(conf.j.outcome, 'conflict');
});
test('CUSTOMER: link-back is attempted and its failure is visible (no CRM API key in this test)', async () => {
  await new Promise(r => setTimeout(r, 500));
  const d = await adminState();
  assert.ok(d.sections.customers.linkBack.errors >= 1, 'link-back failures are counted, not silent');
  assert.equal(d.sections.customers.linkBackConfigured, false);
});
test('CUSTOMER: a DELETE keeps the client', async () => {
  const n0 = (await clients()).length;
  assert.equal((await hook('customer', contact(), 'DELETE')).status, 202);
  assert.equal((await clients()).length, n0);
});

/* ------------------------------ ATTENDANCE ------------------------------ */
const history = async (id) => { const r = await http('GET', '/api/attendance/all', { token: SA }); return (r.j.rows.find(x => x.id === id) || {}).history || []; };
test('ATTENDANCE: create → correction updates the SAME day → duplicate is safe; NZ date', async () => {
  const nina = emp('nina@elitetaxation.co.nz') || (await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.email === 'nina@elitetaxation.co.nz');
  const rec = { crm_attendance_id: 'att-1', crm_user_id: 'crm-u-nina', date: '2026-10-05', check_in_at: '2026-10-04T20:00:00Z', check_out_at: '2026-10-05T04:30:00Z', net_minutes: 480, status: 'present' };
  const a = await hook('attendance', rec);
  assert.equal(a.status, 200); assert.equal(a.j.outcome, 'created');
  let h = await history(nina.id);
  const day = h.find(x => x.date === '2026-10-05');
  assert.ok(day); assert.equal(day.hours, 8);
  assert.equal((await hook('attendance', rec)).status, 202, 'a duplicate is a safe no-op');
  const fix = await hook('attendance', { ...rec, check_out_at: '2026-10-05T05:30:00Z', net_minutes: 540 }, 'UPDATE');
  assert.equal(fix.j.outcome, 'updated');
  h = await history(nina.id);
  assert.equal(h.filter(x => x.date === '2026-10-05').length, 1); assert.equal(h.find(x => x.date === '2026-10-05').hours, 9);
  // timestamps only: the NZ day is used (20:30Z is already the next morning in NZ)
  await hook('attendance', { crm_user_id: 'crm-u-nina', check_in_at: '2026-10-06T20:30:00Z', check_out_at: '2026-10-07T04:30:00Z' });
  assert.ok((await history(nina.id)).find(x => x.date === '2026-10-07'));
});
test('ATTENDANCE: an unknown ET-CRM user is skipped safely, shown to the admin, and replayed once linked', async () => {
  const r = await hook('attendance', { crm_attendance_id: 'att-9', crm_user_id: 'crm-u-late', date: '2026-10-05', check_in_at: '2026-10-04T20:00:00Z', check_out_at: '2026-10-05T04:00:00Z', net_minutes: 420 });
  assert.equal(r.status, 202); assert.equal(r.j.outcome, 'unlinked');
  const d = await adminState();
  const w = d.unlinkedUsers.find(u => u.crmUserId === 'crm-u-late');
  assert.ok(w); assert.equal(w.waiting, 1); assert.ok(d.sections.attendance.unlinked >= 1);
  const sims = (await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.email === 'suneha@elitetaxation.co.nz');
  const link = await http('POST', '/api/admin/crm-sync/link-user', { token: SA, body: { crmUserId: 'crm-u-late', employeeId: sims.id } });
  assert.equal(link.status, 200); assert.equal(link.j.replayed.attendance, 1);
  assert.ok((await history(sims.id)).find(x => x.date === '2026-10-05'));
  assert.equal((await adminState()).unlinkedUsers.find(u => u.crmUserId === 'crm-u-late'), undefined);
  assert.equal((await http('POST', '/api/admin/crm-sync/link-user', { token: SA, body: { crmUserId: 'crm-u-late', employeeId: emp('khushi@elitetaxation.co.nz').id } })).status, 409, 'one CRM id cannot sit on two people');
});
test('ATTENDANCE: a DELETE keeps the history', async () => {
  const nina = (await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.email === 'nina@elitetaxation.co.nz');
  assert.equal((await hook('attendance', { crm_attendance_id: 'att-1', crm_user_id: 'crm-u-nina', date: '2026-10-05' }, 'DELETE')).status, 202);
  assert.ok((await history(nina.id)).find(x => x.date === '2026-10-05'));
});

/* ------------------------------ LEAVE → CAPACITY ------------------------------ */
// 14 Oct 2026 is a Wednesday, 15 Thu, 16 Fri, 19 Mon, 20 Tue — ordinary working days after go-live.
async function capacity(empId, date) {
  const r = await http('GET', `/api/productivity?from=${date}&to=${date}`, { token: SA });
  assert.equal(r.status, 200);
  const p = (r.j.people || []).find(x => x.id === empId || x.employeeId === empId || x.empId === empId);
  assert.ok(p, 'person present in the productivity report');
  return p.capacityHours;
}
const lv = o => ({ crm_leave_request_id: 'lv-1', crm_user_id: 'crm-u-nina', start_date: '2026-10-14', end_date: '2026-10-14', days_count: 1, is_half_day: false, status: 'approved', ...o });
test('LEAVE: baseline is 7h; an approved full day takes the day to 0h; a repeat is idempotent', async () => {
  const nina = (await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.email === 'nina@elitetaxation.co.nz');
  assert.equal(await capacity(nina.id, '2026-10-14'), 7);
  const a = await hook('leave', lv());
  assert.equal(a.status, 200); assert.equal(a.j.outcome, 'created');
  assert.equal(await capacity(nina.id, '2026-10-14'), 0, 'approved full day removes 7h');
  const again = await hook('leave', lv());
  assert.equal(again.status, 202); assert.equal(again.j.outcome, 'skipped');
  const mine = (await http('GET', '/api/leave', { token: SA })).j.leave.filter(l => l.crmLeaveRequestId === 'lv-1');
  assert.equal(mine.length, 1, 'no duplicate leave');
});
test('LEAVE: an approved half day takes 3.5h off (base/2), not the task hours', async () => {
  const nina = (await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.email === 'nina@elitetaxation.co.nz');
  const r = await hook('leave', lv({ crm_leave_request_id: 'lv-half', start_date: '2026-10-15', end_date: '2026-10-15', days_count: 0.5, is_half_day: true, half_day_period: 'morning' }));
  assert.equal(r.j.outcome, 'created');
  assert.equal(await capacity(nina.id, '2026-10-15'), 3.5);
});
test('LEAVE: rejected and pending do not reduce capacity', async () => {
  const nina = (await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.email === 'nina@elitetaxation.co.nz');
  await hook('leave', lv({ crm_leave_request_id: 'lv-rej', start_date: '2026-10-16', end_date: '2026-10-16', status: 'rejected' }));
  assert.equal(await capacity(nina.id, '2026-10-16'), 7);
  await hook('leave', lv({ crm_leave_request_id: 'lv-pen', start_date: '2026-10-19', end_date: '2026-10-19', status: 'pending' }));
  assert.equal(await capacity(nina.id, '2026-10-19'), 7);
  // pending → approved reduces it; approved → cancelled restores it
  await hook('leave', lv({ crm_leave_request_id: 'lv-pen', start_date: '2026-10-19', end_date: '2026-10-19', status: 'approved' }), 'UPDATE');
  assert.equal(await capacity(nina.id, '2026-10-19'), 0);
  await hook('leave', lv({ crm_leave_request_id: 'lv-pen', start_date: '2026-10-19', end_date: '2026-10-19', status: 'cancelled' }), 'UPDATE');
  assert.equal(await capacity(nina.id, '2026-10-19'), 7, 'cancelling an approved leave restores capacity');
  await hook('leave', lv({ crm_leave_request_id: 'lv-1', status: 'cancelled' }), 'UPDATE');
  assert.equal(await capacity(nina.id, '2026-10-14'), 7);
  assert.equal((await http('GET', '/api/leave', { token: SA })).j.leave.filter(l => l.crmLeaveRequestId === 'lv-1').length, 1, 'still one record');
});
test('LEAVE: leave owned by ET-CRM cannot be edited here; a DELETE cancels but keeps the record; unknown user waits', async () => {
  const l = (await http('GET', '/api/leave', { token: SA })).j.leave.find(x => x.crmLeaveRequestId === 'lv-half');
  assert.equal((await http('POST', `/api/leave/${l.id}/make-full-day`, { token: SA })).status, 409);
  assert.equal((await http('POST', `/api/leave/${l.id}/cancel`, { token: SA })).status, 409);
  const nina = (await http('GET', '/api/employees', { token: SA })).j.employees.find(e => e.email === 'nina@elitetaxation.co.nz');
  assert.equal((await hook('leave', lv({ crm_leave_request_id: 'lv-half' }), 'DELETE')).j.outcome, 'updated');
  assert.equal(await capacity(nina.id, '2026-10-15'), 7);
  assert.equal((await http('GET', '/api/leave', { token: SA })).j.leave.find(x => x.crmLeaveRequestId === 'lv-half').status, 'cancelled');
  const w = await hook('leave', lv({ crm_leave_request_id: 'lv-x', crm_user_id: 'crm-u-nobody' }));
  assert.equal(w.status, 202); assert.equal(w.j.outcome, 'unlinked');
});

/* ------------------------------ POLICY COMPLIANCE ------------------------------ */
const policy = (userId, pending, compliant) => ({ version: 1, event: 'policy.compliance.updated', employee: { crm_user_id: userId, email: '' }, compliance: { pending_count: pending, compliant }, policy: { version_id: 'v1', name: 'Code of conduct' } });
test('POLICY: a pending policy blocks an employee (423); acknowledgement unblocks; admins keep emergency access', async () => {
  const nina = (await login('nina@elitetaxation.co.nz', 'x', 'employee')); // her password is a random temp one — use a seeded employee instead
  assert.equal(nina.status, 401);
  const khushiLogin = await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee');
  const KH = khushiLogin.j.token;
  assert.equal((await hook('user', { crm_user_id: 'crm-u-khushi', full_name: 'Khushi', email: 'khushi@elitetaxation.co.nz', is_active: true }, 'UPDATE')).status, 200);
  assert.equal((await http('GET', '/api/tasks', { token: KH })).status, 200);
  const pend = await http('POST', '/webhooks/crm-policy-compliance', { secret: SECRET, body: policy('crm-u-khushi', 2, false) });
  assert.equal(pend.status, 200);
  const blocked = await http('GET', '/api/tasks', { token: KH });
  assert.equal(blocked.status, 423); assert.equal(blocked.j.error, 'policy_acknowledgement_required');
  assert.equal((await http('GET', '/api/auth/me', { token: KH })).status, 200, 'the lock screen itself still works');
  // a superadmin flagged non-compliant keeps emergency access
  assert.equal((await hook('user', { crm_user_id: 'crm-u-founder', full_name: 'Shubam Sharma', email: 'shubham@elitetaxation.co.nz', is_active: true }, 'UPDATE')).status, 200);
  assert.equal((await http('POST', '/webhooks/crm-policy-compliance', { secret: SECRET, body: policy('crm-u-founder', 1, false) })).status, 200);
  assert.equal((await http('GET', '/api/tasks', { token: SA })).status, 200, 'emergency admin access retained');
  const ack = await http('POST', '/webhooks/crm-policy-compliance', { secret: SECRET, body: policy('crm-u-khushi', 0, true) });
  assert.equal(ack.status, 200);
  assert.equal((await http('GET', '/api/tasks', { token: KH })).status, 200, 'acknowledgement unblocks');
  await http('POST', '/webhooks/crm-policy-compliance', { secret: SECRET, body: policy('crm-u-founder', 0, true) });
});
test('POLICY: unknown user → 202 (waiting); bad payload → 400', async () => {
  const r = await http('POST', '/webhooks/crm-policy-compliance', { secret: SECRET, body: policy('crm-u-ghost', 1, false) });
  assert.equal(r.status, 202); assert.equal(r.j.outcome, 'unlinked');
  assert.equal((await http('POST', '/webhooks/crm-policy-compliance', { secret: SECRET, body: { version: 1, event: 'policy.compliance.updated', employee: {} } })).status, 400);
  assert.ok((await adminState()).sections.policy.updated >= 3);
});

/* ------------------------------ TASKS ARE NOT CRM'S ------------------------------ */
test('TASK: the legacy ET-CRM task webhook is disabled — refused (410), nothing imported', async () => {
  const before = (await http('GET', '/api/tasks', { token: SA })).j.tasks.length;
  const r = await hook('task', { id: 't-1', title: 'From the CRM', assigned_to: 'crm-u-nina', due_date: '2026-11-01' });
  assert.equal(r.status, 410); assert.equal(r.j.deprecated, true);
  assert.equal((await http('GET', '/api/tasks', { token: SA })).j.tasks.length, before);
  const d = await adminState();
  assert.equal(d.legacyTask.disabled, true); assert.ok(d.legacyTask.refused >= 1);
});
test('TASK: Task Manager task creation still works normally', async () => {
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Task Test Ltd', email: 'tt' + Date.now() + '@t.co' } })).j.client;
  const ranjit = emp('ranjit@elitetaxation.co.nz');
  const r = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Normal TM task', clientId: client.id, assignedTo: ranjit.id, tat: 1, internalDeadline: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) } });
  assert.equal(r.status, 201); assert.notEqual(r.j.task.source, 'crm');
});

/* ------------------------------ ADMIN PANEL ------------------------------ */
test('PANEL: five health sections with counts, the client rule, five live endpoints, legacy task disabled', async () => {
  const d = await adminState();
  assert.deepEqual(Object.keys(d.sections).sort(), ['attendance', 'customers', 'employees', 'leave', 'policy']);
  assert.deepEqual(d.endpoints.map(e => e.kind).sort(), ['attendance', 'customer', 'leave', 'policy-compliance', 'user']);
  assert.ok(!d.endpoints.some(e => e.kind === 'task'), 'the task webhook is not an active endpoint');
  const S = d.sections;
  assert.ok(S.employees.created >= 1 && S.employees.updated >= 1 && S.employees.skipped >= 1 && S.employees.conflicts >= 1, JSON.stringify(S.employees));
  assert.ok(S.customers.created >= 1 && S.customers.skipped >= 1 && S.customers.ambiguous >= 1 && S.customers.conflicts >= 1, JSON.stringify(S.customers));
  assert.ok(S.attendance.created >= 1 && S.attendance.updated >= 1 && S.attendance.unlinkedEvents >= 1);
  assert.ok(S.leave.created >= 1 && S.leave.updated >= 1);
  assert.ok(S.employees.lastSuccess && S.employees.lastFailure, 'last successful / last failed sync are shown');
  assert.equal(S.employees.configured, true);
  assert.equal(d.eligibility.description, 'authority signed AND PBQ done');
  // only safe metadata is kept: field NAMES, never values
  const dump = JSON.stringify(d.events);
  assert.ok(!dump.includes('Kiwi Plumbing') && !dump.includes('k@kp.nz') && !dump.includes(SECRET), 'no payload values or secrets in the event log');
  assert.ok(d.events.some(e => Array.isArray(e.keys) && e.keys.includes('crm_user_id')));
  assert.equal((await http('GET', '/api/admin/crm-sync', { token: (await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee')).j.token })).status, 403);
});

/* ------------------------------ RECONCILIATION ------------------------------ */
test('RECONCILE: every area previews safely and says plainly what ET-CRM can/cannot offer', async () => {
  for (const kind of ['employees', 'attendance', 'leave', 'policy']) {
    const pre = await http('POST', '/api/admin/crm-sync/reconcile', { token: SA, body: { kind, apply: false } });
    assert.equal(pre.status, 200, kind);
    assert.equal(pre.j.result.kind, kind); assert.equal(pre.j.result.mode, 'preview');
    assert.ok(pre.j.result.local && pre.j.result.remote);
  }
  const emps = (await http('POST', '/api/admin/crm-sync/reconcile', { token: SA, body: { kind: 'employees', apply: false } })).j.result;
  assert.equal(emps.remote.available, false); assert.match(emps.remote.note, /local checks only|could not reach/);
  assert.ok(Array.isArray(emps.local.unlinked) && emps.local.duplicateCrmIds.length === 0);
  // apply is safe to repeat
  const a1 = await http('POST', '/api/admin/crm-sync/reconcile', { token: SA, body: { kind: 'policy', apply: true } });
  const a2 = await http('POST', '/api/admin/crm-sync/reconcile', { token: SA, body: { kind: 'policy', apply: true } });
  assert.equal(a1.status, 200); assert.equal(a2.status, 200);
  assert.equal((await http('POST', '/api/admin/crm-sync/reconcile', { token: SA, body: { kind: 'tasks', apply: false } })).status, 400, 'there is no task reconciliation');
  assert.equal((await http('POST', '/api/admin/crm-sync/reconcile', { token: (await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee')).j.token, body: { kind: 'leave' } })).status, 403);
});
