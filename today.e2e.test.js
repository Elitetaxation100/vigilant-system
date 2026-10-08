// The Today dashboard end to end on a REAL server (throwaway data): who sees what, scoping to MY work, no duplicates, the review
// → approve / return flow moving items between sections, the business clock, and the per-person switch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-today-'));
let child;
const enc = encodeURIComponent;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SH, PK, RJ, DI, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const clientDate = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
const today = async tok => (await http('GET', '/api/workflow/today', { token: tok })).j;
async function submittedTo(reviewer, assignee, name, tok) {
  const t = (await http('POST', '/api/tasks', { token: SH, body: { mode: 'team', name, clientId: client.id, assignedTo: assignee.id, tat: 2, internalDeadline: due, clientDate } })).j.task;
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: tok })).status, 200);
  const c = await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: tok, body: { reviewerId: reviewer.id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  return t;
}
const sectionIds = r => [...r.sections.needs.map(n => n.id), ...r.sections.waiting.flatMap(g => g.ids), ...r.sections.completed.map(c => c.id)];

test('setup', async () => {
  SH = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  PK = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SH })).j.employees;
  client = (await http('POST', '/api/clients', { token: SH, body: { name: 'Today Ltd', email: 'td' + Date.now() + '@t.co' } })).j.client;
});

test('the Today dashboard is switched on for Parvinder only, and a superadmin can switch anyone on or off', async () => {
  const me = async tok => (await http('GET', '/api/auth/me', { token: tok })).j.employee;
  assert.equal((await me(PK)).dashboardV2, true, 'on for Parvinder (one-time migration)');
  assert.ok(!(await me(RJ)).dashboardV2 && !(await me(DI)).dashboardV2 && !(await me(SH)).dashboardV2, 'nobody else');
  assert.equal((await http('PATCH', `/api/employees/${enc(emp('ranjit').id)}`, { token: DI, body: { dashboardV2: true } })).status, 403, 'only a superadmin');
  assert.equal((await http('PATCH', `/api/employees/${enc(emp('ranjit').id)}`, { token: SH, body: { dashboardV2: true } })).status, 200);
  assert.equal((await me(RJ)).dashboardV2, true);
  assert.equal((await http('PATCH', `/api/employees/${enc(emp('ranjit').id)}`, { token: SH, body: { dashboardV2: false } })).status, 200);
  assert.equal((await me(RJ)).dashboardV2, false, 'and off again');
});

test('the date and greeting come from the BUSINESS clock', async () => {
  const r = await today(PK);
  const nz = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
  assert.equal(r.today, nz); assert.equal(r.timezone, 'Pacific/Auckland');
  assert.equal(r.hour, Number(new Date().toLocaleTimeString('en-GB', { timeZone: 'Pacific/Auckland', hour: '2-digit', hour12: false }).slice(0, 2)) % 24);
  assert.equal(r.greeting, r.hour < 12 ? 'Good morning' : r.hour < 17 ? 'Good afternoon' : 'Good evening');
  assert.equal(r.name, 'Parvinder Kumar');
  assert.deepEqual(Object.keys(r.counts).sort(), ['completed', 'decision', 'overdue', 'reports', 'review', 'risk']);
});

test('submitted work reaches MY queue only; the same task is never in two sections; every count opens its exact list', async () => {
  const t1 = await submittedTo(emp('parvinder'), emp('ranjit'), 'For Parvinder', RJ);
  const t2 = await submittedTo(emp('disha'), emp('ranjit'), 'For Disha', RJ);
  const r = await today(PK);
  const needs = r.sections.needs;
  assert.ok(needs.some(n => n.id === t1.id && n.type === 'review'), 'my review is in "Needs you now"');
  assert.ok(!needs.some(n => n.id === t2.id), "another reviewer's work is not mine");
  const c = r.cards[t1.id];
  assert.equal(c.status, 'In Review'); assert.equal(c.waitingOn.kind, 'reviewer'); assert.equal(c.waitingOn.ownerName, 'Parvinder Kumar');
  assert.equal(c.reviewWaiting.days, 0); assert.equal(c.clientRisk.state, 'ok'); assert.equal(c.kindLabel, 'Client Task');
  assert.equal(c.hasSheet, true); assert.equal(c.hasCashbook, true); assert.equal(c.sheetLink, 'https://docs.google.com/spreadsheets/d/x'); assert.equal(c.cashbookLink, 'https://example.com/cb'); assert.ok(c.allocatedHours === 2);
  const ids = sectionIds(r); assert.equal(new Set(ids).size, ids.length, 'no task appears twice across the sections');
  for (const [k, n] of Object.entries(r.counts)) assert.equal(n, r.filters[k].length, k + ' count = the list it opens');
  assert.ok(r.filters.review.includes(t1.id));
  Object.values(r.filters).flat().forEach(id => assert.ok(r.cards[id], 'every filtered id has its card'));
  global.__t1 = t1; global.__t2 = t2;
});

test('approving moves it out of "Needs you" and into "Completed today"; the report then waits on its sender', async () => {
  const t1 = global.__t1;
  const rv = await http('POST', `/api/tasks/${enc(t1.id)}/review`, { token: PK, body: { status: 'clean' } });
  assert.equal(rv.status, 200, JSON.stringify(rv.j));
  const r = await today(PK);
  assert.ok(!r.sections.needs.some(n => n.id === t1.id), 'it left my action list');
  assert.ok(!r.sections.waiting.some(g => g.ids.includes(t1.id)), 'a finished action moved to Completed — it is not also under waiting');
  const done = r.sections.completed.find(d => d.id === t1.id);
  assert.ok(done && done.action === 'Review approved', JSON.stringify(r.sections.completed));
  assert.equal(r.cards[t1.id].status, 'Approved'); assert.ok(r.filters.reports.includes(t1.id), 'approved but not sent: a report to send');
  assert.ok(r.counts.completed >= 1);
});

test('returning work: it is a CORRECTION owned by the employee — never "not started" and never my overdue', async () => {
  const t3 = await submittedTo(emp('parvinder'), emp('ranjit'), 'To return', RJ);
  const rv = await http('POST', `/api/tasks/${enc(t3.id)}/review`, { token: PK, body: { status: 'error', note: 'GST does not reconcile', faultType: 'processor' } });
  assert.equal(rv.status, 200, JSON.stringify(rv.j));
  const r = await today(PK);
  const c = r.cards[t3.id];
  assert.equal(c.status, 'Correction Required'); assert.equal(c.subState, 'Waiting for your correction');
  assert.equal(c.waitingOn.kind, 'employee'); assert.equal(c.waitingOn.label, 'Waiting on employee');
  assert.ok(!r.sections.needs.some(n => n.id === t3.id), 'it is not my action any more');
  assert.ok(!r.filters.overdue.includes(t3.id), 'and not counted as work overdue');
  assert.ok(r.sections.completed.some(d => d.id === t3.id && d.action === 'Returned for correction'));
  assert.ok(!r.sections.waiting.some(g => g.ids.includes(t3.id)), 'the returned task moved to Completed, not duplicated under waiting');
  assert.ok(c.tracker.steps.some(s => s.key === 'correction' && s.state === 'attention'), 'the tracker shows Correction Required');
  // the employee resubmits → it comes back to ME, labelled as a resubmission
  assert.equal((await http('POST', `/api/tasks/${enc(t3.id)}/accept`, { token: RJ })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${enc(t3.id)}/resubmit`, { token: RJ })).status, 200);
  const again = await today(PK);
  assert.ok(again.sections.needs.some(n => n.id === t3.id && n.type === 'correction_resubmitted'));
  assert.equal(again.cards[t3.id].subState, 'Correction resubmitted'); assert.equal(again.cards[t3.id].reviewWaiting.days, 0);
});

test('Today is personal: an employee sees only their own picture, never someone else\'s tasks', async () => {
  const r = await today(RJ);
  assert.ok(!r.sections.needs.some(n => n.id === global.__t2.id), 'a task Ranjit submitted to Disha is not in his actions to take');
  const ids = sectionIds(r); assert.equal(new Set(ids).size, ids.length);
  assert.equal((await http('GET', '/api/workflow/today')).status, 401, 'sign-in required');
});
