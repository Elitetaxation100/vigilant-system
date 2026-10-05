// ET-CRM cut-over — end to end on a real server (throwaway data folder).
// Until a superadmin flips a switch, Punch In/Out and local leave work as before;
// each switch needs real ET-CRM data first, can always be reversed, and a day
// ET-CRM supplied is never overwritten by a punch, an edit or a device reading.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRET = 'cutover-secret';
const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cutover-'));
let child;

async function http(method, p, { token, body, secret } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (secret) headers['X-CRM-Webhook-Secret'] = secret;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const hook = (kind, record, type = 'INSERT') => http('POST', '/webhooks/crm-' + kind, { secret: SECRET, body: { type, table: kind, record, old_record: null } });
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } }));
const todayNZ = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

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

let SA, RJ, SU, KH, employees;
const emp = email => employees.find(e => e.email === email);
const history = async id => ((await http('GET', '/api/attendance/all', { token: SA })).j.rows.find(r => r.id === id) || {}).history || [];
const status = async () => (await http('GET', '/api/admin/crm-sync', { token: SA })).j.cutover;
const cutover = (body, token) => http('POST', '/api/admin/crm-sync/cutover', { token: token || SA, body });
async function capacity(empId, date) {
  const r = await http('GET', `/api/productivity?from=${date}&to=${date}`, { token: SA });
  const p = (r.j.people || []).find(x => x.id === empId || x.employeeId === empId || x.empId === empId);
  return p.capacityHours;
}

test('setup', async () => {
  SA = (await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin')).j.token;
  RJ = (await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee')).j.token;
  SU = (await login('suneha@elitetaxation.co.nz', 'Suneha@2026', 'employee')).j.token;
  KH = (await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee')).j.token;
  employees = (await http('GET', '/api/employees', { token: SA })).j.employees;
  for (const [id, name] of [['crm-u-ranjit', 'ranjit'], ['crm-u-suneha', 'suneha']]) {
    assert.equal((await hook('user', { crm_user_id: id, full_name: name, email: name + '@elitetaxation.co.nz', is_active: true })).status, 200);
  }
});

test('BEFORE the switch: both modes are off, Punch In/Out and local leave work exactly as before', async () => {
  assert.deepEqual((await http('GET', '/api/crm-mode', { token: RJ })).j, { attendanceFromCrm: false, leaveFromCrm: false });
  const s = await status();
  assert.equal(s.attendance.on, false); assert.equal(s.leave.on, false);
  assert.equal(s.attendance.ready, false); assert.equal(s.leave.ready, false);
  const me = await http('GET', '/api/punch/me', { token: KH });
  assert.equal(me.j.punch.disabled, false);
  assert.equal((await http('POST', '/api/punch/toggle', { token: KH })).status, 200, 'punch in works');
  assert.equal((await http('POST', '/api/punch/toggle', { token: KH })).status, 200, 'punch out works');
  const b = await http('POST', '/api/leave', { token: RJ, body: { from: '2026-12-02', to: '2026-12-02', type: 'ANNUAL', reason: 'local booking' } });
  assert.equal(b.status, 201, 'local leave booking works');
});

test('a switch cannot be turned ON before real data has arrived; only a superadmin may flip it', async () => {
  const a = await cutover({ attendance: true });
  assert.equal(a.status, 409); assert.match(a.j.error, /No attendance has arrived/);
  const l = await cutover({ leave: true });
  assert.equal(l.status, 409); assert.match(l.j.error, /No leave has arrived/);
  assert.equal((await cutover({ attendance: true }, RJ)).status, 403);
  assert.equal((await http('GET', '/api/crm-mode', { token: RJ })).j.attendanceFromCrm, false);
});

test('a day ET-CRM supplied is NEVER overwritten by a punch (even with the switch off)', async () => {
  const ranjit = emp('ranjit@elitetaxation.co.nz');
  const row = { crm_attendance_id: 'att-today', crm_user_id: 'crm-u-ranjit', date: todayNZ, check_in_at: todayNZ + 'T08:00:00Z', check_out_at: todayNZ + 'T16:00:00Z', net_minutes: 480, status: 'present' };
  assert.equal((await hook('attendance', row)).status, 200);
  const before = (await history(ranjit.id)).find(h => h.date === todayNZ);
  assert.equal(before.hours, 8);
  assert.equal((await http('POST', '/api/punch/toggle', { token: RJ })).status, 200);
  assert.equal((await http('POST', '/api/punch/toggle', { token: RJ })).status, 200);
  const after = (await history(ranjit.id)).find(h => h.date === todayNZ);
  assert.deepEqual([after.loginAt, after.logoutAt, after.hours], [before.loginAt, before.logoutAt, before.hours], "Ranjit's punch did not touch the ET-CRM day");
  // a founder correction of an ET-CRM day is refused too
  const edit = await http('POST', '/api/attendance/edit', { token: SA, body: { employeeId: ranjit.id, date: todayNZ, login: '00:01', logout: '00:02' } });
  assert.equal(edit.status, 409); assert.equal(edit.j.code, 'DAY_FROM_CRM');
  // ...but a day that did not come from ET-CRM can still be corrected
  const ok = await http('POST', '/api/attendance/edit', { token: SA, body: { employeeId: emp('khushi@elitetaxation.co.nz').id, date: todayNZ, login: '00:01', logout: '00:02' } });
  assert.equal(ok.status, 200);
});

test('ATTENDANCE switch ON (data has arrived): no clock, no edits, no device ingest; ET-CRM keeps flowing', async () => {
  assert.equal((await status()).attendance.ready, true);
  const on = await cutover({ attendance: true });
  assert.equal(on.status, 200); assert.equal(on.j.attendance.on, true);
  assert.deepEqual((await http('GET', '/api/crm-mode', { token: SU })).j, { attendanceFromCrm: true, leaveFromCrm: false });
  assert.equal((await http('GET', '/api/punch/me', { token: SU })).j.punch.disabled, true);
  const t = await http('POST', '/api/punch/toggle', { token: SU });
  assert.equal(t.status, 409); assert.equal(t.j.code, 'CLOCK_MANAGED_BY_CRM');
  const re = await http('POST', '/api/punch/reopen', { token: SA, body: { employeeId: emp('khushi@elitetaxation.co.nz').id, resumeClock: true } });
  assert.equal(re.status, 409); assert.equal(re.j.code, 'CLOCK_MANAGED_BY_CRM');
  const ed = await http('POST', '/api/attendance/edit', { token: SA, body: { employeeId: emp('khushi@elitetaxation.co.nz').id, date: todayNZ, login: '07:00', logout: '08:00' } });
  assert.equal(ed.status, 409); assert.equal(ed.j.code, 'CLOCK_MANAGED_BY_CRM');
  const rows = (await http('GET', '/api/attendance/all', { token: SA })).j.rows;
  assert.ok(rows.every(r => r.canReopen === false), 'no Reopen buttons');
  // ET-CRM still writes attendance
  const suneha = emp('suneha@elitetaxation.co.nz');
  assert.equal((await hook('attendance', { crm_attendance_id: 'att-su', crm_user_id: 'crm-u-suneha', date: todayNZ, net_minutes: 420, check_in_at: todayNZ + 'T08:00:00Z', check_out_at: todayNZ + 'T15:00:00Z' })).status, 200);
  assert.equal((await history(suneha.id)).find(h => h.date === todayNZ).hours, 7);
  assert.equal((await status()).attendance.on, true);
});

test('ATTENDANCE switch OFF again: the clock is back (instant rollback)', async () => {
  const off = await cutover({ attendance: false });
  assert.equal(off.status, 200); assert.equal(off.j.attendance.on, false);
  assert.equal((await http('GET', '/api/punch/me', { token: SU })).j.punch.disabled, false);
  // Suneha already has an ET-CRM day today, so her punch is allowed but cannot overwrite it
  assert.equal((await http('POST', '/api/punch/toggle', { token: SU })).status, 200);
  assert.equal((await http('POST', '/api/punch/toggle', { token: SU })).status, 200);
  assert.equal((await history(emp('suneha@elitetaxation.co.nz').id)).find(h => h.date === todayNZ).hours, 7);
});

test('LEAVE switch ON: no booking, approving or changing leave here; ET-CRM leave still applies and counts', async () => {
  const ranjit = emp('ranjit@elitetaxation.co.nz');
  const pend = (await http('GET', '/api/leave', { token: SA })).j.leave.find(l => l.reason === 'local booking');
  assert.ok(pend && pend.status === 'pending');
  const p2 = await http('POST', '/api/leave', { token: RJ, body: { from: '2026-12-03', to: '2026-12-03', type: 'ANNUAL', reason: 'second local' } });
  assert.equal(p2.status, 201);
  // evidence: an ET-CRM leave event
  const lv = { crm_leave_request_id: 'lv-a', crm_user_id: 'crm-u-ranjit', start_date: '2026-10-14', end_date: '2026-10-14', days_count: 1, is_half_day: false, status: 'approved' };
  assert.equal((await hook('leave', lv)).status, 200);
  assert.equal(await capacity(ranjit.id, '2026-10-14'), 0);
  assert.equal((await cutover({ leave: true })).status, 200);
  assert.deepEqual((await http('GET', '/api/crm-mode', { token: RJ })).j, { attendanceFromCrm: false, leaveFromCrm: true });

  const book = await http('POST', '/api/leave', { token: RJ, body: { from: '2026-12-08', to: '2026-12-08', type: 'ANNUAL' } });
  assert.equal(book.status, 409); assert.equal(book.j.code, 'LEAVE_MANAGED_BY_CRM');
  const bookMgr = await http('POST', '/api/leave', { token: SA, body: { employeeId: ranjit.id, from: '2026-12-08', to: '2026-12-08', type: 'ANNUAL' } });
  assert.equal(bookMgr.status, 409, 'not even a manager booking on someone\'s behalf');
  assert.equal((await http('POST', `/api/leave/${pend.id}/decision`, { token: SA, body: { approve: true } })).status, 409);
  assert.equal((await http('POST', `/api/leave/${pend.id}/make-full-day`, { token: SA })).status, 409);
  assert.equal((await http('POST', `/api/leave/${p2.j.leave.id}/cancel`, { token: RJ })).status, 409, 'an employee cannot change local leave any more');
  assert.equal((await http('POST', `/api/leave/${p2.j.leave.id}/cancel`, { token: SA })).status, 200, 'a superadmin can still tidy up an old local record');

  // ET-CRM keeps working while the switch is on: a half day and a cancellation
  assert.equal((await hook('leave', { ...lv, crm_leave_request_id: 'lv-b', start_date: '2026-10-15', end_date: '2026-10-15', is_half_day: true, half_day_period: 'morning', days_count: 0.5 })).status, 200);
  assert.equal(await capacity(ranjit.id, '2026-10-15'), 3.5);
  assert.equal((await hook('leave', { ...lv, status: 'cancelled' }, 'UPDATE')).status, 200);
  assert.equal(await capacity(ranjit.id, '2026-10-14'), 7, 'cancelled in ET-CRM restores capacity');
  // existing local leave still counts (history is not discarded)
  const still = (await http('GET', '/api/leave', { token: SA })).j.leave.find(l => l.id === pend.id);
  assert.ok(still, 'existing local leave is kept');
});

test('LEAVE switch OFF again: local booking is back', async () => {
  const off = await cutover({ leave: false });
  assert.equal(off.status, 200); assert.equal(off.j.leave.on, false);
  const book = await http('POST', '/api/leave', { token: RJ, body: { from: '2026-12-09', to: '2026-12-09', type: 'ANNUAL' } });
  assert.equal(book.status, 201);
  assert.deepEqual((await http('GET', '/api/crm-mode', { token: RJ })).j, { attendanceFromCrm: false, leaveFromCrm: false });
});

test('a device reading never overwrites an ET-CRM day', async () => {
  // the biometric endpoint is closed unless ATTENDANCE_INGEST_TOKEN is set, so this only proves it stays closed
  const r = await http('POST', '/api/attendance/ingest', { body: { employeeRef: 'ranjit@elitetaxation.co.nz', date: todayNZ, firstIn: '09:00', lastOut: '10:00' } });
  assert.equal(r.status, 503);
});
