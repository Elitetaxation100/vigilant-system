// Productivity V3 end to end: Report Sent neither unlocks nor moves the credit; system logins are not in the numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');

async function withServer(v3At, fn) {
  const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-pv3-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test', PRODUCTIVITY_V3_AT_TEST: v3At }, stdio: 'ignore' });
  const http = async (method, p, { token, body } = {}) => {
    const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j };
  };
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
    return await fn(http);
  } finally { child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
}
const login = async (http, e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
const q = id => encodeURIComponent(id);

async function scenario(http) {
  const SA = await login(http, 'shubham', 'Shubham@2026', 'admin'), PA = await login(http, 'parvinder', 'Parvinder@2026', 'admin'), RJ = await login(http, 'ranjit', 'Ranjit@2026', 'employee');
  const E = (await http('GET', '/api/employees', { token: SA })).j.employees, emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'PV3 Ltd', email: 'pv3@t.co' } })).j.client.id;
  const mk = async name => {
    const t = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId, assignedTo: emp('ranjit').id, tat: 2, internalDeadline: '2026-12-30' } });
    const id = t.j.task.id;
    await http('POST', `/api/tasks/${q(id)}/accept`, { token: RJ });
    await http('POST', `/api/tasks/${q(id)}/complete`, { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x' } });
    return id;
  };
  const cleanOne = await mk('Reviewed and sent'), cleanTwo = await mk('Reviewed, not sent');
  for (const id of [cleanOne, cleanTwo]) assert.equal((await http('POST', `/api/tasks/${q(id)}/review-decision`, { token: PA, body: { decision: 'approve', clean: true, profitRequired: false, requestId: 'r' + id } })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${q(cleanOne)}/send-to-client`, { token: RJ, body: { decision: 'yes' } })).status, 200);
  const prod = (await http('GET', '/api/productivity?from=2026-10-01&to=2026-12-31&scope=firm', { token: SA })).j;
  const me = prod.people.find(p => p.id === emp('ranjit').id);
  const row = id => me.qualifiedTasks.find(x => x.id === id);
  return { prod, me, sentRow: row(cleanOne), unsentRow: row(cleanTwo), emp };
}

test('V3 (work completed on/after the cutoff): reviewed clean is the credit — sent or not, same rule, credited at the review', async () => {
  await withServer('2020-01-01T00:00:00.000Z', async http => {
    const { me, sentRow, unsentRow, prod } = await scenario(http);
    assert.ok(unsentRow && unsentRow.qualifies, 'a reviewed-clean task is credited although its report was never sent');
    assert.equal(unsentRow.rule, 'v3'); assert.equal(unsentRow.qualifyingEventType, 'clean_review');
    assert.equal(sentRow.rule, 'v3'); assert.equal(sentRow.qualifyingEventType, 'clean_review', 'sending the report changes nothing');
    assert.equal(sentRow.qualifyingEventAt, sentRow.reviewedAt, 'credited at the review, not the dispatch');
    assert.equal(me.qualifiedHours, 4);
    assert.ok(prod.v3EffectiveAt);
  });
});
test('before the cutoff the earlier rule is untouched (nothing is recalculated retroactively)', async () => {
  await withServer('2099-01-01T00:00:00.000Z', async http => {
    const { sentRow, unsentRow } = await scenario(http);
    assert.equal(sentRow.rule, 'v2'); assert.equal(sentRow.qualifyingEventType, 'report_dispatched', 'old behaviour preserved for old work');
    assert.equal(unsentRow.rule, 'v2'); assert.equal(unsentRow.qualifyingEventType, 'clean_review');
  });
});
test('shared, test and placeholder logins are not in Productivity; real people are; the breakdown adds up', async () => {
  await withServer('2020-01-01T00:00:00.000Z', async http => {
    const { prod, me, emp } = await scenario(http);
    const ids = prod.people.map(p => p.id);
    assert.ok(!ids.includes(emp('hr').id), 'the shared HR Administrator login is not a productive employee');
    assert.ok(ids.includes(emp('ranjit').id) && ids.includes(emp('disha').id));
    const b = me.capacityBreakdown;
    assert.ok(b.reconciles, 'capacity days reconcile with capacity hours');
    assert.equal(b.dayHours, 7); assert.equal(b.finalEligibleDays * 7, me.capacityHours);
    const n = me.notConvertedBreakdown;
    assert.ok(n.reconciles); assert.equal(Math.round((n.openAllocated + n.nonQualifyingCompleted + n.unallocated) * 100) / 100, n.total);
    assert.equal(n.total, me.capacityNotConverted);
    const t = prod.totals.notConvertedBreakdown;
    assert.ok(t.reconciles); assert.equal(Math.round((t.openAllocated + t.nonQualifyingCompleted + t.unallocated) * 100) / 100, t.total);
  });
});
