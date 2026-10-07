const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dq-'));
let child;
async function http(method, p, { token, body, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return r;
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j };
}
const login = async (e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

test('the data-quality report: superadmin only, finds the real seed issues, and changes nothing', async () => {
  const SA = await login('shubham', 'Shubham@2026', 'admin'), DI = await login('disha', 'Disha@2026', 'admin'), RJ = await login('ranjit', 'Ranjit@2026', 'employee');
  const E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
  await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Call 021 555 1234 re payroll', kind: 'internal', assignedTo: emp('ranjit').id, tat: 1, internalDeadline: '2026-12-30' } });
  const before = JSON.stringify((await http('GET', '/api/tasks', { token: SA })).j.tasks) + JSON.stringify(E);
  assert.equal((await http('GET', '/api/admin/data-quality', { token: DI })).status, 403, 'an admin cannot');
  assert.equal((await http('GET', '/api/admin/data-quality', { token: RJ })).status, 403);
  const r = (await http('GET', '/api/admin/data-quality', { token: SA })).j;
  assert.equal(r.readOnly, true); assert.ok(r.counts.phone_in_title >= 1);
  assert.ok(r.counts.hr_in_productivity >= 1 && r.counts.duplicate_user >= 1, 'the shared HR login and the Diksha / Disha pair are reported');
  const csv = await http('GET', '/api/admin/data-quality?format=csv', { token: SA, raw: true });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.headers.get('content-disposition'), /attachment; filename="data-quality-/);
  assert.match((await csv.text()).split('\n')[0], /suggested fix,decision \(yours\)/);
  const after = JSON.stringify((await http('GET', '/api/tasks', { token: SA })).j.tasks) + JSON.stringify((await http('GET', '/api/employees', { token: SA })).j.employees);
  assert.equal(after, before, 'reading the report changed nothing');
});
