// Commitment watch, end to end on a throwaway server: stage timestamps, notifications, late / at-risk flags, the commitment breach list,
// and the automatic marks (work submitted late −50, client commitment breach −250). Dates that must be in the past are set by stopping the
// server, editing the throwaway data file, and starting it again (the same technique as auto-marks-reports.e2e.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cwatch-'));
let child;
const enc = encodeURIComponent;
const T = id => '/api/tasks/' + enc(id);
// the app runs on the New Zealand calendar day, so the test does too
const nzToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const day = n => new Date(Date.parse(nzToday() + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

async function http(method, p, { token, body, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: r.status, text: await r.text(), type: r.headers.get('content-type') };
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;
async function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
}
async function stop() {
  if (!child) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  child = null;
}
test.after(async () => { await stop(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, RJ, DI, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
async function sessions() {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
}
const sheet = 'https://docs.google.com/spreadsheets/d/abc', cash = 'https://example.com/cashbook';
const inbox = async tok => (await http('GET', '/api/notifications', { token: tok })).j.notifications;
const marksOf = async (tok, type) => (await http('GET', '/api/marks', { token: tok })).j.marks.filter(m => m.type === type && !m.voidedAt);

async function mk(name, extra) {
  const c = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(3), clientDate: day(9), ...(extra || {}) } });
  assert.equal(c.status, 201, JSON.stringify(c.j));
  return c.j.task;
}
const accept = async t => assert.equal((await http('POST', T(t.id) + '/accept', { token: RJ })).status, 200);
const complete = async t => assert.equal((await http('POST', T(t.id) + '/complete', { token: RJ, body: { reviewerId: emp('disha').id, sheetLink: sheet, cashbookLink: cash } })).status, 200);
const approve = async t => assert.equal((await http('POST', T(t.id) + '/review-decision', { token: DI, body: { decision: 'approve', note: 'ok' } })).status, 200);
const ids = {};

test('setup: tasks at every stage', async () => {
  await start(); await sessions();
  client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Watch Ltd', email: 'w' + Date.now() + '@t.co' } })).j.client;
  // T1 will be handed in LATE (its date is made past below); T2 on time
  ids.late = (await mk('Late hand-in')).id; ids.ontime = (await mk('On-time hand-in')).id;
  for (const k of ['late', 'ontime']) await accept({ id: ids[k] });
  // T3 sits in review past its commitment date; T4 is approved and waiting to be sent past its commitment date
  ids.inReview = (await mk('Stuck in review')).id; await accept({ id: ids.inReview }); await complete({ id: ids.inReview });
  ids.toSend = (await mk('Report waiting')).id; await accept({ id: ids.toSend }); await complete({ id: ids.toSend }); await approve({ id: ids.toSend });
  // T5 is never handed in; T6 is quiet before its commitment date; T7 is in review on its commitment date
  ids.notSub = (await mk('Never handed in')).id; await accept({ id: ids.notSub });
  ids.quiet = (await mk('Quiet task')).id; await accept({ id: ids.quiet });
  ids.reviewDay = (await mk('Review on the day')).id; await accept({ id: ids.reviewDay }); await complete({ id: ids.reviewDay });
  // a breach from BEFORE the rules started: still listed as a breach, but never charged
  ids.oldBreach = (await mk('Old breach')).id; await accept({ id: ids.oldBreach }); await complete({ id: ids.oldBreach });
  // an on-time, fully sent task must never appear anywhere
  ids.clean = (await mk('Finished and sent')).id; await accept({ id: ids.clean }); await complete({ id: ids.clean }); await approve({ id: ids.clean });
  assert.equal((await http('POST', T(ids.clean) + '/send-to-client', { token: RJ, body: { decision: 'yes' } })).status, 200);
});

test('notifications: the reviewer is told when work is submitted; the processor when it is sent back or ready', async () => {
  const rev = await inbox(DI);
  assert.ok(rev.some(n => n.type === 'review' && n.taskId === ids.inReview), 'the reviewer is told about the submission');
  const mine = await inbox(RJ);
  assert.ok(mine.some(n => n.type === 'send_report' && n.taskId === ids.toSend), 'the processor is told the work is approved and the report is ready to send');
  // sent back
  const back = await mk('Sent back'); await accept(back); await complete(back);
  const r = await http('POST', T(back.id) + '/review-decision', { token: DI, body: { decision: 'return', note: 'Fix the totals', category: 'Calculation error', responsibility: 'Employee', dueDate: day(2) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok((await inbox(RJ)).some(n => n.type === 'rework' && n.taskId === back.id), 'the processor is told it was sent back');
  // an admin task that needs no report: approval itself tells the processor it is finished
  const adm = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Admin chore', taskKind: 'admin', assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(3) } });
  assert.equal(adm.status, 201, JSON.stringify(adm.j));
  await accept(adm.j.task); await complete(adm.j.task); await approve(adm.j.task);
  assert.ok((await inbox(RJ)).some(n => n.type === 'reviewed' && n.taskId === adm.j.task.id), 'approved admin work: the processor hears it is finished');
});

test('stage timestamps: submitted, reviewed, ready for report are recorded; sent back and report sent stay empty until they happen', async () => {
  const w = (await http('GET', T(ids.toSend) + '/watch', { token: RJ })).j;
  const s = Object.fromEntries(w.stages.map(x => [x.key, x]));
  assert.ok(s.submitted.at && s.reviewed.at && s.ready_for_report.at, JSON.stringify(w.stages));
  assert.equal(s.submitted.byName, 'Ranjit Choudhary'); assert.equal(s.reviewed.outcome, 'approved');
  assert.ok(s.submitted.at <= s.reviewed.at && s.reviewed.at <= s.ready_for_report.at, 'in the order they happened');
  assert.equal(s.sent_back.at, null); assert.equal(s.report_sent.at, null);
  const done = Object.fromEntries((await http('GET', T(ids.clean) + '/watch', { token: RJ })).j.stages.map(x => [x.key, x]));
  assert.ok(done.report_sent.at, 'sending the report stamps it');
  const back = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(t => t.name === 'Sent back');
  assert.ok((await http('GET', T(back.id) + '/watch', { token: RJ })).j.stages.find(x => x.key === 'sent_back').at, 'sending it back stamps it');
  assert.equal((await http('GET', T(ids.toSend) + '/watch', { token: DI })).status, 200, 'the reviewer/manager can read it');
  assert.equal((await http('GET', T('nope') + '/watch', { token: RJ })).status, 404);
});

test('make the dates past (stop, edit the data file, restart)', async () => {
  await stop();
  const f = path.join(dir, 'db.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  const set = (id, over) => { const t = st.tasks.find(x => x.id === id); assert.ok(t, id); Object.assign(t, over); return t; };
  set(ids.late, { internalDeadline: day(-3) });                                    // will be handed in 3 days late
  set(ids.inReview, { clientDate: day(-3) });                                       // in review, commitment date passed
  set(ids.toSend, { clientDate: day(-4) });                                         // approved, report not sent, commitment date passed
  set(ids.notSub, { internalDeadline: day(-2) });                                   // never handed in
  const quiet = set(ids.quiet, { clientDate: day(1) });                              // quiet: nothing recorded since long ago
  ['acceptedAt', 'startedAt', 'assignedAt', 'timerStartedAt'].forEach(k => { if (quiet[k]) quiet[k] = new Date(Date.now() - 20 * 86400000).toISOString(); });
  set(ids.oldBreach, { clientDate: day(-40) });                                     // overdue since before the rules started
  set(ids.reviewDay, { clientDate: day(0) });                                       // in review ON its commitment date
  // the rules "started" a month ago, so these dates are judged
  st.autoMarks = st.autoMarks || {};
  st.autoMarks.settings = { ...(st.autoMarks.settings || {}), activeFrom: day(-30), scale: 2, scaleFrom: day(-30), ruleFrom: { callback: day(-30), submitLate: day(-30) } };
  fs.writeFileSync(f, JSON.stringify(st));
  await start(); await sessions();
});

test('FLAGS: not submitted by the due date, review not done before the commitment date, no update before the commitment date', async () => {
  const w = (await http('GET', '/api/commitment-watch', { token: SA })).j;
  const flags = id => (w.flagged.find(r => r.id === id) || { flags: [] }).flags;
  assert.ok(flags(ids.notSub).some(f => f.code === 'not_submitted' && f.tone === 'late'), JSON.stringify(w.flagged.map(r => [r.name, r.flags.map(f => f.code)])));
  assert.ok(flags(ids.late).some(f => f.code === 'not_submitted'), 'the one still to be handed in late is flagged');
  assert.ok(flags(ids.inReview).some(f => f.code === 'review_not_done' && f.tone === 'late'), 'in review after its commitment date');
  assert.ok(flags(ids.reviewDay).some(f => f.code === 'review_not_done' && f.tone === 'at_risk'), 'in review on the commitment date itself');
  assert.ok(flags(ids.quiet).some(f => f.code === 'no_update'), 'nothing recorded since long ago, commitment tomorrow');
  assert.equal(flags(ids.clean).length, 0, 'a finished, sent task is never flagged'); assert.equal(flags(ids.ontime).length, 0, 'an on-track task is not flagged');
  assert.equal(flags(ids.toSend).some(f => f.code === 'review_not_done'), false, 'it is already reviewed');
  // one task's detail agrees with the list
  const one = (await http('GET', T(ids.notSub) + '/watch', { token: SA })).j;
  assert.deepEqual(one.flags.map(f => f.code), flags(ids.notSub).map(f => f.code));
});

test('BREACH LIST: the commitment date has passed and the report is not sent — at any stage — and nothing else', async () => {
  const w = (await http('GET', '/api/commitment-watch', { token: SA })).j;
  const got = w.breaches.map(b => b.id).sort();
  assert.deepEqual(got, [ids.inReview, ids.toSend, ids.oldBreach].sort(), JSON.stringify(w.breaches.map(b => [b.name, b.daysOver])));
  const b = Object.fromEntries(w.breaches.map(x => [x.id, x]));
  assert.equal(b[ids.toSend].daysOver, 4); assert.equal(b[ids.inReview].daysOver, 3);
  assert.equal(b[ids.inReview].stage, 'In Review'); assert.match(b[ids.inReview].owner, /Disha/, 'the reviewer owns the next step');
  assert.match(b[ids.toSend].owner, /Ranjit/); assert.ok(b[ids.toSend].readyForReportAt, 'its stage times ride along');
  assert.equal(w.breaches[0].id, ids.oldBreach, 'longest overdue first'); assert.equal(w.breaches[1].id, ids.toSend);
  assert.equal(w.rules.breachMarks, 250);
  // scoping: a processor sees only their own; the same two are theirs here, and nobody else's work leaks
  const mine = (await http('GET', '/api/commitment-watch', { token: RJ })).j;
  assert.ok(mine.breaches.every(x => x.processorId === emp('ranjit').id));
  const csv = await http('GET', '/api/commitment-watch?format=csv&kind=breaches', { token: SA, raw: true });
  assert.equal(csv.status, 200); assert.match(csv.type, /text\/csv/);
  const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines.length, 4, 'header + the three breaches — the same rows as the list'); assert.match(lines[0], /^Task,Client,Processor,Reviewer,Status,Commitment date,Days over/);
  const fcsv = await http('GET', '/api/commitment-watch?format=csv&kind=flags', { token: SA, raw: true });
  assert.equal(fcsv.text.replace(/^﻿/, '').trim().split(/\r?\n/).length - 1, w.flagged.length, 'flags CSV = flags list');
  assert.equal((await http('GET', '/api/commitment-watch')).status, 401, 'signed-in only');
});

test('MARKS: a client commitment breach costs −250 once, to whoever owns the next step; none for sent work, or for dates before the rules started', async () => {
  const run = await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal(run.status, 200);
  const dMarks = await marksOf(DI, 'auto_report_late'), rMarks = await marksOf(RJ, 'auto_report_late');
  const dm = dMarks.filter(m => m.taskId === ids.inReview), rm = rMarks.filter(m => m.taskId === ids.toSend);
  assert.equal(dm.length, 1, 'in review → the reviewer'); assert.equal(dm[0].points, -250); assert.match(dm[0].reason, /client commitment breach/i);
  assert.equal(rm.length, 1, 'approved, waiting to send → the report sender'); assert.equal(rm[0].points, -250);
  assert.equal(dMarks.concat(rMarks).filter(m => m.taskId === ids.oldBreach).length, 0, 'overdue since before the rules started — listed, never charged');
  assert.equal(rMarks.filter(m => m.taskId === ids.clean || m.taskId === ids.ontime || m.taskId === ids.quiet).length, 0);
  await http('POST', '/api/admin/auto-marks/run', { token: SA });
  assert.equal((await marksOf(DI, 'auto_report_late')).filter(m => m.taskId === ids.inReview).length, 1, 'running again never doubles it');
  // sending the report late afterwards does not add a second deduction
  assert.equal((await http('POST', T(ids.toSend) + '/send-to-client', { token: RJ, body: { decision: 'yes' } })).status, 200);
  assert.equal((await marksOf(RJ, 'auto_report_late')).filter(m => m.taskId === ids.toSend).length, 1, 'one per task');
  const after = (await http('GET', '/api/commitment-watch', { token: SA })).j;
  assert.equal(after.breaches.some(b => b.id === ids.toSend), false, 'once it is sent it leaves the breach list');
  assert.ok(after.breaches.some(b => b.id === ids.inReview));
});

test('MARKS: work submitted after its due date costs −50, once; on time costs nothing', async () => {
  await complete({ id: ids.late });                                                 // 3 days after its internal date
  const m = (await marksOf(RJ, 'auto_submit_late')).filter(x => x.taskId === ids.late);
  assert.equal(m.length, 1); assert.equal(m[0].points, -50); assert.equal(m[0].byId, null); assert.match(m[0].reason, /3 days after its due date/);
  await complete({ id: ids.ontime });
  assert.equal((await marksOf(RJ, 'auto_submit_late')).filter(x => x.taskId === ids.ontime).length, 0, 'handed in on time');
  // its stage timestamp and the flag follow: no longer "not submitted"
  const w = (await http('GET', T(ids.late) + '/watch', { token: SA })).j;
  assert.equal(w.flags.some(f => f.code === 'not_submitted'), false);
  assert.ok(w.stages.find(x => x.key === 'submitted').at);
  // a correction handed back after the reviewer's date, when it was the employee's own correction, is also late
  const resub = await http('POST', T(ids.late) + '/review-decision', { token: DI, body: { decision: 'return', note: 'Totals are off', category: 'Calculation error', responsibility: 'Employee', dueDate: day(0) } });
  assert.equal(resub.status, 200, JSON.stringify(resub.j));
  assert.equal((await marksOf(RJ, 'auto_submit_late')).filter(x => x.taskId === ids.late).length, 1, 'sending it back is not a new late hand-in');
});

test('RULES: everyone can read the new amounts; the rules are on by default and a superadmin can switch them off', async () => {
  const r = (await http('GET', '/api/auto-marks/rules', { token: RJ })).j;
  assert.deepEqual([r.acknowledgement.perItem, r.reports.late, r.callback.late, r.submitLate.late], [50, 250, 50, 50]);
  assert.equal((await http('POST', '/api/admin/auto-marks/settings', { token: RJ, body: { points: { submitLate: 5 } } })).status, 403);
  const off = await http('POST', '/api/admin/auto-marks/settings', { token: SA, body: { enabled: { callback: false, submitLate: false } } });
  assert.equal(off.status, 200); assert.equal(off.j.settings.enabled.callback, false); assert.equal(off.j.settings.enabled.submitLate, false);
  assert.equal(off.j.settings.points.reportLate, 250, 'the amounts are untouched by switching rules off');
});

test('ALERTS: the flags and the breach raise one notification each, to the right people, and only for dates after the rules started', async () => {
  const run = await http('POST', '/api/admin/manager-alerts/run', { token: SA });
  assert.equal(run.status, 200);
  const att = async (tok, id) => (await inbox(tok)).filter(n => n.type === 'attention' && n.taskId === id);
  assert.ok((await att(RJ, ids.notSub)).length >= 1, 'the processor is told it was not submitted');
  assert.ok((await att(DI, ids.reviewDay)).length >= 1, 'the reviewer is told the review is not done by the commitment date');
  assert.ok((await att(SA, ids.inReview)).some(n => /commitment breached/i.test(n.text)), 'the founder sees the breach');
  const before = (await att(RJ, ids.notSub)).length;
  await http('POST', '/api/admin/manager-alerts/run', { token: SA });
  assert.equal((await att(RJ, ids.notSub)).length, before, 'raised once per episode, never a flood');
});
