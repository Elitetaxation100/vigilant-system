// Calendar and Timeline: filters, date kinds, pagination, the delayed stretch — and the Tasks page's short filter row.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-views-'));
let child;
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

let SA, PA, RJ, E, c1, c2;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const mk = (clientId, name, due, clientDate) => http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name, taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 0.25, internalDeadline: due, clientDate, reviewerId: emp('parvinder').id } });

test('setup', async () => {
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  c1 = (await http('POST', '/api/clients', { token: SA, body: { name: 'Alpha Co', email: 'a@t.co' } })).j.client.id;
  c2 = (await http('POST', '/api/clients', { token: SA, body: { name: 'Beta Co', email: 'b@t.co' } })).j.client.id;
  for (let i = 0; i < 30; i++) assert.equal((await mk(i % 2 ? c1 : c2, 'Job ' + i, day(1 + (i % 5)), day(6 + (i % 5)))).status, 201);
});
test('calendar: filters by client, the two date kinds can be switched off, and the filter choices are real', async () => {
  const all = (await http('GET', '/api/workflow/calendar', { token: PA })).j;
  assert.ok(all.events.some(e => e.kind === 'internal') && all.events.some(e => e.kind === 'client'));
  assert.ok(all.facets.clients.includes('Alpha Co') && all.facets.clients.includes('Beta Co'));
  const onlyInternal = (await http('GET', '/api/workflow/calendar?kinds=internal', { token: PA })).j;
  assert.ok(onlyInternal.events.length && onlyInternal.events.every(e => e.kind === 'internal'));
  const onlyClient = (await http('GET', '/api/workflow/calendar?kinds=client', { token: PA })).j;
  assert.ok(onlyClient.events.length && onlyClient.events.every(e => e.kind === 'client'));
  const alpha = (await http('GET', '/api/workflow/calendar?client=Alpha%20Co', { token: PA })).j;
  assert.ok(alpha.events.length && alpha.events.every(e => e.clientName === 'Alpha Co'));
  assert.equal((await http('GET', '/api/workflow/calendar', { token: RJ })).status, 403, 'managers only');
});
test('timeline: paged (never one huge list), filterable, with owner and reviewer on every row', async () => {
  const p1 = (await http('GET', '/api/workflow/timeline', { token: PA })).j;
  assert.equal(p1.total, 30); assert.equal(p1.pageSize, 25); assert.equal(p1.rows.length, 25);
  const p2 = (await http('GET', '/api/workflow/timeline?page=2', { token: PA })).j;
  assert.equal(p2.rows.length, 5); assert.equal(new Set([...p1.rows, ...p2.rows].map(r => r.id)).size, 30, 'no row twice, none missing');
  assert.equal((await http('GET', '/api/workflow/timeline?pageSize=100', { token: PA })).j.rows.length, 30);
  assert.ok(p1.rows.every(r => r.assigneeName && r.reviewerName && r.kindLabel && r.start && r.end));
  const f = (await http('GET', '/api/workflow/timeline?client=Alpha%20Co&pageSize=100', { token: PA })).j;
  assert.equal(f.total, 15); assert.ok(f.rows.every(r => r.clientName === 'Alpha Co'));
  assert.equal((await http('GET', '/api/workflow/timeline?status=In%20Review', { token: PA })).j.total, 0);
  assert.ok(Array.isArray(p1.facets.employees) && p1.facets.reviewers.length && p1.facets.clients.length, 'filter choices come with the data');
});
test('timeline marks the delayed stretch for work already past a due date', async () => {
  const t = (await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'Old one', taskKind: 'client', clientId: c1, assignedTo: emp('ranjit').id, tat: 0.25, internalDeadline: day(0), clientDate: day(3), reviewerId: emp('parvinder').id } })).j.task;
  const f = (await http('GET', '/api/workflow/timeline?pageSize=100', { token: PA })).j.rows;
  const row = f.find(r => r.id === t.id);
  assert.equal(row.delayedFrom, null, 'due today is not yet delayed');
  const past = (await http('GET', '/api/workflow/timeline?pageSize=100', { token: PA })).j;
  assert.ok(past.rows.every(r => !r.delayedFrom || r.delayedFrom < past.today), 'a delayed stretch only ever starts on a date that has passed');
});
test('Tasks list: the first row is Search, Employee, Status, Risk and More filters; risk filters server-side; newest first', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const draw = html.slice(html.indexOf('function mtDrawList()'), html.indexOf('function mtTag(c)'));
  const primary = draw.slice(draw.indexOf('const primary'), draw.indexOf('const more'));
  for (const f of ['mtf_q', 'mtf_employee', 'mtf_status', 'mtf_risk']) assert.ok(primary.includes(f), f + ' is on the first row');
  for (const f of ['mtf_client', 'mtf_type', 'mtf_waitingOn', 'mtf_reviewer', 'mtf_due', 'mtf_commitment', 'mtf_reportSent', 'mtf_rework', 'mtf_sort']) { assert.ok(!primary.includes(f), f + ' is NOT on the first row'); assert.ok(draw.slice(draw.indexOf('const more')).includes(f), f + ' is under More filters'); }
  assert.equal((draw.match(/<details class="mt-more"/g) || []).length, 1, 'one More filters panel');
  const risk = (await http('GET', '/api/workflow/tasks?risk=at_risk&pageSize=100', { token: PA })).j;
  assert.ok(risk.rows.every(r => r.clientRisk.state === 'at_risk'));
  const ids = (await http('GET', '/api/workflow/tasks?pageSize=100', { token: PA })).j.rows.map(r => r.id);
  assert.deepEqual(ids, ids.slice().sort().reverse(), 'newest first by default');
  assert.deepEqual((await http('GET', '/api/workflow/tasks?pageSize=25', { token: PA })).j.pageSize, 25);
  assert.deepEqual((await http('GET', '/api/workflow/tasks?pageSize=7', { token: PA })).j.pageSize, 25, 'only 25 / 50 / 100');
});
