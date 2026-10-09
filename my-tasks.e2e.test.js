// "My Tasks" for every processor, and the exact tasks behind "Internal commitment met".
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-mytasks-'));
let child;
const enc = encodeURIComponent;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: method === 'GET' ? undefined : (body === undefined ? undefined : JSON.stringify(body)) });
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
const T = id => '/api/tasks/' + enc(id);
let SA, PA, RJ, HU, E, ids = {};
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const relogin = async () => { SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee'); HU = await login('hunny', 'Hunny@2026', 'employee'); };

test('setup: Ranjit has tasks in many states (and Hunny has one of his own)', async () => {
  await relogin();
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  let n = 0;
  const mk = async (name, who, over) => {
    const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'MT Client ' + (++n), email: 'mt' + n + '@t.co' } })).j.client.id;
    const r = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name, taskKind: 'client', clientId, assignedTo: emp(who).id, tat: 0.5, internalDeadline: day(2 + n), clientDate: day(9 + n), reviewerId: emp('parvinder').id, ...(over || {}) } });
    assert.equal(r.status, 201, JSON.stringify(r.j));
    return r.j.task;
  };
  const acc = async (t, tok) => http('POST', T(t.id) + '/accept', { token: tok });
  const submit = (t, tok) => http('POST', T(t.id) + '/complete', { token: tok, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } });
  ids.todo = await mk('MT to do', 'ranjit'); await acc(ids.todo, RJ);
  ids.onTime = await mk('MT handed in on time', 'ranjit'); await acc(ids.onTime, RJ); await submit(ids.onTime, RJ);
  ids.late = await mk('MT handed in late', 'ranjit'); await acc(ids.late, RJ); await submit(ids.late, RJ);
  ids.open = await mk('MT still open past due', 'ranjit'); await acc(ids.open, RJ);
  ids.held = await mk('MT held', 'ranjit'); await acc(ids.held, RJ);
  assert.equal((await http('POST', T(ids.held.id) + '/hold', { token: RJ, body: { category: 'MANAGER_DECISION', detail: 'need a ruling', waitingOnId: emp('parvinder').id, followUpDate: day(2) } })).status, 200);
  ids.hunny = await mk('MT Hunny only', 'hunny'); await acc(ids.hunny, HU);
  // shape the dates: one hand-in well before its due date, one after, one open task past its date
  const snap = (await http('GET', '/api/admin/state-export', { token: SA })).j;
  const g = id => snap.tasks.find(t => t.id === id.id);
  const submittedAt = new Date().toISOString();
  g(ids.onTime).internalDeadline = day(0); g(ids.late).internalDeadline = day(-3); g(ids.open).internalDeadline = day(-2);
  g(ids.onTime).clientDate = day(6); g(ids.late).clientDate = day(4); g(ids.open).clientDate = day(5);
  assert.equal((await http('POST', '/api/admin/state-import', { token: SA, body: snap })).status, 200);
  await relogin();
});

test('My Tasks: every task of the person, and only theirs — counted by status, filterable, paged', async () => {
  const r = (await http('GET', '/api/workflow/my-tasks', { token: RJ })).j;
  assert.equal(r.all, 5, 'five tasks assigned to Ranjit'); assert.ok(!r.rows.some(x => x.name === 'MT Hunny only'), 'never someone else\'s');
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.all, 'the status counts add up to every task');
  assert.equal(r.counts['On Hold'], 1); assert.equal(r.counts['Sent for Review'], 2);
  const held = r.rows.find(x => x.id === ids.held.id); assert.equal(held.primaryStatus, 'On Hold'); assert.ok(held.hold && held.hold.ageText, 'a held task shows its hold');
  const f = (await http('GET', '/api/workflow/my-tasks?primary=' + enc('Sent for Review'), { token: RJ })).j;
  assert.equal(f.total, 2); assert.ok(f.rows.every(x => x.primaryStatus === 'Sent for Review'));
  const q = (await http('GET', '/api/workflow/my-tasks?q=still%20open', { token: RJ })).j; assert.equal(q.total, 1);
  const dueFilter = (await http('GET', '/api/workflow/my-tasks?due=overdue', { token: RJ })).j; assert.ok(dueFilter.rows.some(x => x.id === ids.open.id));
  const p = (await http('GET', '/api/workflow/my-tasks?pageSize=25&page=1&sort=internal', { token: RJ })).j; assert.equal(p.page, 1); assert.ok(p.pages >= 1);
  // asking for someone else's tasks changes nothing
  const sneaky = (await http('GET', '/api/workflow/my-tasks?employee=' + enc(emp('hunny').id), { token: RJ })).j;
  assert.ok(sneaky.rows.every(x => x.assigneeId === emp('ranjit').id));
  assert.equal((await http('GET', '/api/workflow/my-tasks')).status, 401);
  const hn = (await http('GET', '/api/workflow/my-tasks', { token: HU })).j; assert.deepEqual(hn.rows.map(x => x.name), ['MT Hunny only']);
});

test('Internal commitment: the exact tasks behind the percentage — met, not met (late by N days) and still open past the date', async () => {
  const from = '2026-09-07', url = '/api/productivity?scope=me&full=1&from=' + from + '&to=' + today;
  const row = (await http('GET', url, { token: RJ })).j.people[0];
  const C = row.commitmentTasks;
  assert.ok(C && Array.isArray(C.counted) && Array.isArray(C.openPastDue), 'the lists are in the calculation');
  assert.equal(C.counted.length, row.commitmentTotal, 'the list IS the denominator');
  assert.equal(C.counted.filter(x => x.met).length, row.commitmentMet, 'and the met ones ARE the numerator');
  const late = C.counted.find(x => x.id === ids.late.id), ok = C.counted.find(x => x.id === ids.onTime.id);
  assert.ok(late && late.met === false, 'handed in after its internal date'); assert.equal(late.daysLate, 3); assert.equal(late.internalDue, day(-3));
  assert.ok(ok && ok.met === true && ok.daysLate === 0);
  assert.deepEqual(C.counted.map(x => x.met), [...C.counted.map(x => x.met)].sort((a, b) => a - b), 'the ones not met come first');
  const open = C.openPastDue.find(x => x.id === ids.open.id);
  assert.ok(open && open.daysLate === 2, 'open work past its internal date is listed separately');
  assert.ok(!C.openPastDue.some(x => x.id === ids.held.id) || C.openPastDue.find(x => x.id === ids.held.id).onHold, 'a held task is shown as held, never hidden');
  assert.ok(!C.openPastDue.some(x => x.id === ids.todo.id), 'work not yet due is not listed');
  // a manager sees the same list for the same person
  const asMgr = (await http('GET', url.replace('scope=me&', '') + '&scope=firm', { token: SA })).j.people.find(p => p.id === emp('ranjit').id);
  assert.equal(asMgr.commitmentTasks.counted.length, C.counted.length);
});

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
test('the page: a My Tasks entry for processors, and the Internal commitment card opens the list', () => {
  assert.match(html, /<div class="nav-item v2-emp" data-view="mytasks"/); assert.match(html, /id="view-mytasks"/); assert.match(html, /mytasks: \['My tasks'/);
  assert.match(html, /\.v2-emp'\)\.forEach\(x => x\.style\.display = \(on && !isAdmin\)/);
  assert.match(html, /if\(id === 'mytasks'\) renderMyTasks\(\);/); assert.match(html, /\/api\/workflow\/my-tasks\?/);
  assert.match(html, /let _mkSeq = 0;[\s\S]{0,40}|const seq = \+\+_mkSeq;/, 'the latest filter wins');
  assert.match(html, /tdDetailHtml\(id, r, true\)/); assert.match(html, /commitOnclick: `openCommitmentModal\(/);
  assert.match(html, /function openCommitmentModal\(p\)/); assert.match(html, /Not met — handed in after the internal date/); assert.match(html, /Still open and past the internal date/);
  assert.match(html, /see which →/);
});
