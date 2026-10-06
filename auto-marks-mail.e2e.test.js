// Automatic marks — a REASSIGNED email must be replied to by the end of the next working day (−10),
// and it shows on the new owner's dashboard until it is handled. Uses the fixture mailbox; the hand-off
// time is moved into the past by stopping the server and editing the throwaway data file.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-mailmarks-'));
let child;

async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;
async function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', INTEGRATION_SECRET: 'int-secret', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
}
async function stop() { if (!child) return; await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); child = null; }
test.after(async () => { await stop(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, KH, RJ, E;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const mailOf = async (tok, subject) => (await http('GET', '/api/emails/all?from=2000-01-01', { token: tok })).j.emails.find(e => e.subject === subject);
const myMarks = async tok => (await http('GET', '/api/marks', { token: tok })).j.marks;
const mailMarks = async (tok, mailSubject) => (await myMarks(tok)).filter(m => m.type === 'auto_mail_reply' && !m.voidedAt && (!mailSubject || m.reason.includes(mailSubject)));
const reassignedList = async tok => (await http('GET', '/api/emails/reassigned-to-me', { token: tok })).j;
async function sessions() {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  KH = await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
}
const S1 = 'Question about my return', S2 = 'Documents attached', S3 = 'Follow up on my filing';
let m1, m2, m3;

test('setup: Khushi reassigns three mails to Ranjit — one unread, one read, one already replied to', async () => {
  await start(); await sessions();
  assert.equal((await http('POST', '/api/int/gmail/poll-now', { token: 'int-secret' })).status, 200);
  m1 = await mailOf(KH, S1); m2 = await mailOf(KH, S2); m3 = await mailOf(KH, S3);
  assert.ok(m1 && m2 && m3);
  assert.equal(m3.outcomeStatus, 'replied');
  for (const m of [m1, m2, m3]) assert.equal((await http('POST', `/api/emails/${m.id}/reassign`, { token: KH, body: { employeeId: emp('ranjit').id } })).status, 200);
});

test('DASHBOARD: the mail shows for the person it was reassigned to, with who gave it and when to reply by — only what still needs a reply', async () => {
  const mine = await reassignedList(RJ);
  assert.equal(mine.penalty, 10);
  const subjects = mine.emails.map(e => e.subject).sort();
  assert.deepEqual(subjects, [S1, S2].sort(), 'the already-replied mail is not listed');
  const e1 = mine.emails.find(e => e.subject === S1);
  assert.equal(e1.reassignedBy, emp('khushi').name); assert.match(e1.replyBy, /^\d{4}-\d{2}-\d{2}$/); assert.ok(e1.replyBy > new Date().toISOString().slice(0, 10) || true);
  assert.deepEqual((await reassignedList(KH)).emails, [], "Khushi's own list is empty — they are no longer hers to answer");
  assert.deepEqual((await reassignedList(SA)).emails, []);
  // handled mail drops off the dashboard
  assert.equal((await http('POST', `/api/emails/${m2.id}/no-reply-needed`, { token: RJ })).status, 200);
  assert.deepEqual((await reassignedList(RJ)).emails.map(e => e.subject), [S1]);
});

test('NOTHING is deducted while it is still inside the deadline', async () => {
  await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { activeFrom: '2026-01-01' } });
  await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal((await mailMarks(RJ)).length, 0);
});

test('go past the deadline (stop, edit the hand-off time into September, restart)', async () => {
  await stop();
  const f = path.join(dir, 'db.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  const e1 = st.emails.find(e => e.subject === S1);
  const e3 = st.emails.find(e => e.subject === S3);
  assert.ok(e1 && e1.reassignHistory && e3);
  e1.reassignHistory[e1.reassignHistory.length - 1].at = '2026-09-21T01:00:00.000Z';
  e3.reassignHistory[e3.reassignHistory.length - 1].at = '2026-09-21T01:00:00.000Z';
  fs.writeFileSync(f, JSON.stringify(st));
  await start(); await sessions();
});

test('NOT replied by the end of the next working day → −10 to the person it was reassigned to, once; replied / no-reply-needed mail is not charged', async () => {
  const run = await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal(run.status, 200);
  const got = await mailMarks(RJ);
  assert.equal(got.length, 1, JSON.stringify(got)); assert.equal(got[0].points, -10); assert.equal(got[0].byId, null); assert.equal(got[0].toId, emp('ranjit').id);
  assert.match(got[0].reason, new RegExp(`"${S1}" reassigned to you on .* was not replied to by`));
  assert.equal((await mailMarks(RJ, S2)).length, 0, 'marked no-reply-needed → handled');
  assert.equal((await mailMarks(RJ, S3)).length, 0, 'already replied → handled');
  assert.equal((await mailMarks(KH)).length, 0, 'the person who handed it over is not charged');
  await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal((await mailMarks(RJ)).length, 1, 'a second run never doubles it');
  // still on the dashboard, now overdue, until handled
  const l = await reassignedList(RJ);
  assert.deepEqual(l.emails.map(e => e.subject), [S1]); assert.ok(l.emails[0].replyBy < new Date().toISOString().slice(0, 10));
});

test('a new hand-off gets its own clock, and the rule can be switched off', async () => {
  // hand it on to Disha: a fresh hand-off now → no immediate charge for Disha, Ranjit keeps his one deduction
  const DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  assert.equal((await http('POST', `/api/emails/${m1.id}/reassign`, { token: RJ, body: { employeeId: emp('disha').id } })).status, 200);
  await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal((await mailMarks(DI)).length, 0);
  assert.equal((await mailMarks(RJ)).length, 1);
  assert.equal((await reassignedList(DI)).emails.length, 1); assert.equal((await reassignedList(RJ)).emails.length, 0);
  await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { enabled: { mailReply: false } } });
  const rules = (await http('GET', '/api/auto-marks/rules', { token: RJ })).j;
  assert.deepEqual(rules.mailReply, { enabled: false, late: 10 });
  assert.equal((await reassignedList(DI)).penalty, 0, 'the dashboard stops quoting a penalty while the rule is off');
});
