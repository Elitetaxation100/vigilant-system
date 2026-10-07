// Automatic marks — end to end on a real server (throwaway data folder, fixture mailbox).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-automarks-'));
let child;

async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;
const enc = encodeURIComponent;

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', INTEGRATION_SECRET: 'int-secret', NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, RJ, DI, KH, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const due = () => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const myMarks = async tok => (await http('GET', '/api/marks', { token: tok })).j.marks;
const autoOf = (marks, taskId, type) => marks.filter(m => m.auto && m.taskId === taskId && (!type || m.type === type) && !m.voidedAt);

// a client task for Ranjit, accepted, ready to send for review
async function readyTask(name, kind) {
  if (kind === 'internal') { // an internal task is the person's own (self-assigned, so already accepted)
    const c = await http('POST', '/api/tasks', { token: RJ, body: { name, kind: 'internal', tat: 1, internalDeadline: due() } });
    assert.equal(c.status, 201, JSON.stringify(c.j));
    if (c.j.task.status !== 'accepted') await http('POST', `/api/tasks/${enc(c.j.task.id)}/accept`, { token: RJ });
    return c.j.task;
  }
  const c = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: due() } });
  assert.equal(c.status, 201, JSON.stringify(c.j));
  const t = c.j.task;
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: RJ })).status, 200);
  return t;
}
const complete = (t, links) => http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, ...(links || {}) } });
const review = t => http('POST', `/api/tasks/${enc(t.id)}/review`, { token: DI, body: { status: 'clean' } });

test('setup', async () => {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  KH = await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Marks Test Ltd', email: 'mt' + Date.now() + '@t.co' } })).j.client;
});

test('everyone can read the rules; only a superadmin can change them', async () => {
  const r = await http('GET', '/api/auto-marks/rules', { token: RJ });
  assert.deepEqual(r.j, { links: { enabled: true, processor: 20, reviewer: 30 }, acknowledgement: { enabled: true, perItem: 10 }, reports: { enabled: true, late: 10 }, mailReply: { enabled: true, late: 10 } });
  assert.equal((await http('GET', '/api/admin/auto-marks', { token: RJ })).status, 403);
  assert.equal((await http('POST', '/api/admin/auto-marks/settings', { token: DI, body: { enabled: { links: false } } })).status, 403);
  assert.equal((await http('POST', '/api/admin/auto-marks/run', { token: RJ })).status, 403);
  const a = (await http('GET', '/api/admin/auto-marks', { token: SA })).j;
  assert.match(a.settings.activeFrom, /^\d{4}-\d{2}-\d{2}$/); assert.deepEqual(a.recent, []);
});

test('PROCESSOR: both links missing → −20; one missing → −10; both attached → nothing; internal task → nothing', async () => {
  const t1 = await readyTask('No links');
  assert.equal((await complete(t1)).status, 200);
  let m = autoOf(await myMarks(RJ), t1.id, 'auto_links_processor');
  assert.equal(m.length, 1); assert.equal(m[0].points, -20); assert.equal(m[0].byId, null); assert.match(m[0].reason, /without the Sheet and Cashbook links/);
  assert.equal(m[0].toId, emp('ranjit').id);

  const t2 = await readyTask('Sheet only');
  await complete(t2, { sheetLink: 'https://docs.google.com/spreadsheets/d/abc' });
  m = autoOf(await myMarks(RJ), t2.id, 'auto_links_processor');
  assert.equal(m.length, 1); assert.equal(m[0].points, -10); assert.match(m[0].reason, /without the Cashbook link/);

  const t2b = await readyTask('Cashbook only');
  await complete(t2b, { cashbookLink: 'https://example.com/cashbook' });
  assert.equal(autoOf(await myMarks(RJ), t2b.id)[0].points, -10);
  assert.match(autoOf(await myMarks(RJ), t2b.id)[0].reason, /without the Sheet link/);

  const t3 = await readyTask('Both links');
  await complete(t3, { sheetLink: 'https://docs.google.com/spreadsheets/d/abc', cashbookLink: 'https://example.com/cashbook' });
  assert.equal(autoOf(await myMarks(RJ), t3.id).length, 0);

  const t4 = await readyTask('Internal', 'internal');
  assert.equal((await complete(t4)).status, 200);
  assert.equal(autoOf(await myMarks(RJ), t4.id).length, 0, 'internal tasks never need links');
});

test('REVIEWER: passing it on with both links missing → −30; one missing → −15; links attached first → nothing', async () => {
  // both missing, returned to the processor to send
  const a = await readyTask('Review both missing');
  await complete(a);
  assert.equal((await review(a)).status, 200);
  assert.equal(autoOf(await myMarks(DI), a.id).length, 0, 'nothing yet — the reviewer has not passed it on');
  assert.equal((await http('POST', `/api/tasks/${enc(a.id)}/return-to-processor`, { token: DI })).status, 200);
  let m = autoOf(await myMarks(SA), a.id, 'auto_links_reviewer'); // superadmin sees everyone's marks
  assert.equal(m.length, 1); assert.equal(m[0].points, -30); assert.equal(m[0].toId, emp('disha').id); assert.match(m[0].reason, /passed on after review/);

  // one missing, sent for profit confirmation
  const b = await readyTask('Review sheet only');
  await complete(b, { sheetLink: 'https://docs.google.com/spreadsheets/d/abc' });
  await review(b);
  assert.equal((await http('POST', `/api/tasks/${enc(b.id)}/profit-confirm`, { token: DI })).status, 200);
  m = autoOf(await myMarks(SA), b.id, 'auto_links_reviewer');
  assert.equal(m.length, 1); assert.equal(m[0].points, -15); assert.equal(m[0].toId, emp('disha').id);

  // the reviewer attaches the links first, then passes it on: no reviewer penalty (the processor still lost 20)
  const c = await readyTask('Reviewer fixes it');
  await complete(c);
  await review(c);
  assert.equal((await http('PATCH', `/api/tasks/${enc(c.id)}/links`, { token: DI, body: { sheetLink: 'https://docs.google.com/spreadsheets/d/abc', cashbookLink: 'https://example.com/cashbook' } })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${enc(c.id)}/return-to-processor`, { token: DI })).status, 200);
  assert.equal(autoOf(await myMarks(SA), c.id, 'auto_links_reviewer').length, 0);
  assert.equal(autoOf(await myMarks(SA), c.id, 'auto_links_processor').length, 1);

  // an error / rework review is not "passing it on": no reviewer penalty
  const d = await readyTask('Sent back for rework');
  await complete(d);
  assert.equal((await http('POST', `/api/tasks/${enc(d.id)}/review`, { token: DI, body: { status: 'error', faultType: 'processor', note: 'wrong' } })).status, 200);
  assert.equal(autoOf(await myMarks(SA), d.id, 'auto_links_reviewer').length, 0);
});

test('the person is told, the totals include it, and a superadmin can void it', async () => {
  const n = (await http('GET', '/api/notifications', { token: RJ })).j;
  assert.match(JSON.stringify(n), /marks \(automatic\)/);
  const before = (await myMarks(RJ)).filter(m => !m.voidedAt).reduce((s, m) => s + m.points, 0);
  const mk = (await myMarks(RJ)).find(m => m.auto && m.points === -20 && !m.voidedAt);
  assert.equal((await http('POST', `/api/marks/${mk.id}/void`, { token: RJ })).status, 403, 'the person cannot void their own deduction');
  assert.equal((await http('POST', `/api/marks/${mk.id}/void`, { token: SA })).status, 200);
  const after = (await myMarks(RJ)).filter(m => !m.voidedAt).reduce((s, m) => s + m.points, 0);
  assert.equal(after, before + 20);
  const log = (await http('GET', '/api/admin/auto-marks', { token: SA })).j.recent;
  assert.ok(log.find(x => x.id === mk.id).voidedAt); assert.ok(log.length >= 5);
});

test('switching the links rule off stops it; switching it on again resumes; the amounts are adjustable', async () => {
  await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { enabled: { links: false } } });
  const t = await readyTask('Rule off'); await complete(t);
  assert.equal(autoOf(await myMarks(RJ), t.id).length, 0);
  await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { enabled: { links: true }, points: { processorLinks: 8 } } });
  const t2 = await readyTask('Smaller amount'); await complete(t2);
  assert.equal(autoOf(await myMarks(RJ), t2.id)[0].points, -8);
  assert.equal((await http('GET', '/api/auto-marks/rules', { token: RJ })).j.links.processor, 8);
  await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { points: { processorLinks: 20 } } });
});

test('ACKNOWLEDGEMENT: preview shows who would lose marks, leave days are skipped, the run gives them once', async () => {
  // fixture mailbox: Khushi owns selfemployed@ + property_tax@ — 3 inbound mails on 15 Nov 2023 (NZ), 1 still unread
  const poll = await http('POST', '/api/int/gmail/poll-now', { token: 'int-secret' });
  assert.equal(poll.status, 200);
  const day = '2023-11-15';
  const pv = (await http('POST', '/api/admin/auto-marks/preview', { token: SA, body: { day } })).j.results;
  const k = pv.find(r => r.toId === emp('khushi').id && r.channel === 'emails');
  assert.ok(k, JSON.stringify(pv));
  assert.equal(k.total, 3); assert.equal(k.notAck, 1); assert.equal(k.marks, 10, '1 unacknowledged mail × 10 marks'); assert.equal(k.skipped, false);
  assert.equal((await myMarks(KH)).filter(m => m.auto).length, 0, 'a preview changes nothing');

  // on approved leave that day → skipped
  const lv = await http('POST', '/api/leave', { token: SA, body: { employeeId: emp('khushi').id, from: day, to: day, type: 'ANNUAL' } });
  assert.equal(lv.status, 201);
  const pv2 = (await http('POST', '/api/admin/auto-marks/preview', { token: SA, body: { day } })).j.results.find(r => r.toId === emp('khushi').id);
  assert.equal(pv2.skipped, true); assert.match(pv2.why, /leave/);
  await http('POST', `/api/leave/${lv.j.leave.id}/cancel`, { token: SA });

  // run from that day: the deduction is given once, with a clear reason
  await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { activeFrom: day } });
  const run = await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal(run.status, 200); assert.ok(run.j.days.some(d => d.day === day));
  const got = (await myMarks(KH)).filter(m => m.auto && m.type === 'auto_ack' && !m.voidedAt);
  assert.equal(got.length, 1); assert.equal(got[0].points, -10); assert.match(got[0].reason, /1 of 3 emails on .* not acknowledged/);
  // judging the same day again never doubles it
  await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { activeFrom: day } });
  await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal((await myMarks(KH)).filter(m => m.auto && m.type === 'auto_ack').length, 1);
});
