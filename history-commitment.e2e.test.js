// Task history + the employee's own (internal) commitment: every hand-in is kept with its time, the commitment is judged on the FIRST hand-in,
// a client-query wait is not counted against the employee, and a query shows the moment it was raised — not a made-up 05:30.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const workflow = require('./workflow');
const cal = require('./calendar');

// ---- the rule itself (no server): commitmentTag
const nzDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const deps = (shift = 0) => ({ nzDay, queryShiftDays: () => shift, addWorkingDays: cal.addWorkingDays });
const base = over => ({ kind: 'client', clientId: 'c1', clientDate: '2026-10-09', internalDeadline: '2026-10-05', ...over });

test('submitted on time at the first attempt stays MET through a reviewer sending it back — and through the resubmission', () => {
  const t = base({ firstSubmittedAt: '2026-10-05T01:00:00Z', completedAt: '2026-10-08T01:00:00Z', reworkCount: 1 });
  for (const st of ['Correction Required', 'In Review', 'Approved', 'Completed']) {
    const c = workflow.commitmentTag(t, st, '2026-10-09', deps());
    assert.equal(c.key, 'met', st); assert.match(c.detail, /Submitted 2026-10-05 — due 2026-10-05/);
  }
});
test('a task really handed in late is a breach — judged on the first hand-in', () => {
  const t = base({ firstSubmittedAt: '2026-10-07T01:00:00Z', completedAt: '2026-10-07T01:00:00Z' });
  assert.equal(workflow.commitmentTag(t, 'In Review', '2026-10-09', deps()).key, 'breached');
});
test('not yet handed in and the date has passed → breached; the date not yet reached → on track', () => {
  assert.equal(workflow.commitmentTag(base(), 'In Progress', '2026-10-09', deps()).key, 'breached');
  assert.notEqual(workflow.commitmentTag(base({ internalDeadline: '2026-10-12', clientDate: '2026-10-20' }), 'In Progress', '2026-10-09', deps()).key, 'breached');
});
test('time spent waiting for the client moves the internal date, so it is not the employee\'s miss', () => {
  const t = base({ internalDeadline: '2026-10-05' });             // due Mon 5 Oct; the file waited 3 working days on a client query
  const due = workflow.internalDueOf(t, deps(3));
  assert.equal(due, cal.addWorkingDays('2026-10-05', 3));
  assert.notEqual(workflow.commitmentTag(t, 'In Progress', '2026-10-08', deps(3)).key, 'breached', 'inside the moved date');
  assert.equal(workflow.commitmentTag(t, 'In Progress', '2026-10-08', deps(0)).key, 'breached', 'without the freeze it would have been late');
  assert.equal(workflow.card(t, { ...deps(3), today: '2026-10-08', nowMs: Date.now(), nameOf: () => null, canApprove: () => false }).internalDue, due, 'the card carries the date the employee is held to');
});
test('an older task that lost its first submission time: proven on time by the first return, otherwise not claimed as a breach', () => {
  const sent = base({ status: 'rework', reviewEvents: [{ type: 'returned', at: '2026-10-05T03:00:00Z' }], reworkCount: 1 });
  assert.equal(workflow.commitmentTag(sent, 'Correction Required', '2026-10-09', deps()).key, 'met', 'it was already with the reviewer by the due date');
  const unknown = base({ status: 'rework', reviewEvents: [{ type: 'returned', at: '2026-10-08T03:00:00Z' }], reworkCount: 1 });
  const c = workflow.commitmentTag(unknown, 'Correction Required', '2026-10-09', deps());
  assert.equal(c.key, 'na'); assert.match(c.label, /not recorded/);
});

// ---- on a real server
const port = 3100 + Math.floor(Math.random() * 800), baseUrl = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-hist-'));
let child;
const enc = encodeURIComponent;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j };
}
const login = async (e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(baseUrl + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const day = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const nowHM = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nzHM = iso => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ASK = (extra) => ({ queryConfirmed: true, querySource: 'email', querySentAt: today, querySentTime: nowHM(), queryEvidence: 'Email "Missing bank statements" to the client', ...(extra || {}) });
let SA, PA, RJ, E, task;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const T = id => '/api/tasks/' + enc(id);
const mine = async () => (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(t => t.id === task.id);

test('every hand-in is kept with its exact time and the dates in force; the first one stays first through rework', async () => {
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'Hist Ltd', email: 'h@t.co' } })).j.client.id;
  task = (await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'History job', taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: today, clientDate: day(9), reviewerId: emp('parvinder').id } })).j.task;
  assert.equal((await http('POST', T(task.id) + '/accept', { token: RJ })).status, 200);
  const before = Date.now();
  assert.equal((await http('POST', T(task.id) + '/complete', { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } })).status, 200);
  let t = await mine();
  assert.equal(t.submissions.length, 1);
  const s1 = t.submissions[0];
  assert.equal(s1.kind, 'review'); assert.equal(s1.byId, emp('ranjit').id); assert.equal(s1.reviewerId, emp('parvinder').id);
  assert.equal(s1.internalDue, today); assert.equal(s1.clientDue, day(9));
  assert.ok(Date.parse(s1.at) >= before - 1000 && Date.parse(s1.at) <= Date.now() + 1000, 'a real time, not a day');
  assert.equal(t.firstSubmittedAt, s1.at);
  // the reviewer sends it back; Ranjit accepts, fixes and resubmits
  assert.equal((await http('POST', T(task.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'r1', category: 'Other', responsibility: 'Employee', dueDate: day(3), note: 'Please redo' } })).status, 200);
  assert.equal((await http('POST', T(task.id) + '/accept', { token: RJ })).status, 200);
  assert.equal((await http('POST', T(task.id) + '/resubmit', { token: RJ })).status, 200);
  t = await mine();
  assert.deepEqual(t.submissions.map(x => x.kind), ['review', 'resubmit']);
  assert.equal(t.firstSubmittedAt, s1.at, 'the first hand-in is never overwritten');
  assert.ok(Date.parse(t.completedAt) >= Date.parse(s1.at));
});

test('a query shows the moment it was raised and taking it off hold shows its time; the internal date is held back by the wait', async () => {
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'Query Ltd', email: 'q@t.co' } })).j.client.id;
  const mk0 = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'Query job', taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(1), clientDate: day(9), reviewerId: emp('parvinder').id } }); assert.equal(mk0.status, 201, JSON.stringify(mk0.j)); const t0 = mk0.j.task;
  assert.equal((await http('POST', T(t0.id) + '/accept', { token: RJ })).status, 200);
  const typed = nowHM();
  const h = await http('POST', T(t0.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_QUERY', responsibility: 'client', followUpDate: day(2), detail: 'asked', ...ASK({ querySentTime: typed }) } });
  assert.equal(h.status, 200, JSON.stringify(h.j));
  const q = h.j.task.queries[0];
  assert.ok(q.sentTs && nzHM(q.sentTs) === typed, 'the stored time is the time the owner typed: ' + q.sentTs + ' vs ' + typed);
  assert.equal(q.sentAt, today, 'the day marker the calendar maths uses is unchanged');
  assert.equal((await http('POST', T(t0.id) + '/unhold', { token: RJ })).status, 200);
  const t1 = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(x => x.id === t0.id);
  assert.ok(t1.holdHistory[0].resumedTs, 'taking it off hold is stamped with its time');
  assert.ok(t1.queries[0].resumedTs);
  assert.ok('effectiveInternalDate' in t1);
});

test('a hold alone opens NO query and pauses nothing; a query needs the date AND time typed by the owner (never midnight, never filled in)', async () => {
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'Manual Ltd', email: 'm@t.co' } })).j.client.id;
  const mkT = async name => { const r = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name, taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(1), clientDate: day(9), reviewerId: emp('parvinder').id } }); assert.equal(r.status, 201, JSON.stringify(r.j)); await http('POST', T(r.j.task.id) + '/accept', { token: RJ }); return r.j.task; };
  const t0 = await mkT('Plain hold');
  const h = await http('POST', T(t0.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_QUERY', detail: 'asked about the entity', responsibility: 'client', followUpDate: day(2) } });
  assert.equal(h.status, 200, JSON.stringify(h.j));
  assert.equal(h.j.task.queries.length, 0, 'no query record'); assert.equal(h.j.task.queryShiftDays, 0); assert.equal(h.j.task.effectiveClientDate, h.j.task.clientDate);
  assert.deepEqual(h.j.task.holdHistory.at(-1).clocksStopped, { workTimer: true, clientCommitment: false, processorResponsibility: false });
  // ticking "I sent a query" without the details is refused, and changes nothing
  const t1 = await mkT('Half filled');
  for (const bad of [{ querySentTime: '' }, { querySentAt: '' }, { querySource: '' }, { querySentAt: day(1), querySentTime: '10:00' }, { querySentTime: '99:99' }]) {
    const r = await http('POST', T(t1.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_QUERY', detail: 'asked about the entity', responsibility: 'client', followUpDate: day(2), ...ASK(bad) } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(x => x.id === t1.id).status, 'accepted', 'a refused hold changes nothing');
  // a backdated query keeps the exact time that was typed
  const ok = await http('POST', T(t1.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_QUERY', detail: 'asked about the entity', responsibility: 'client', followUpDate: day(2), ...ASK({ querySentAt: day(-1), querySentTime: '10:30' }) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.task.queries[0].sentAt, day(-1)); assert.equal(nzHM(ok.j.task.queries[0].sentTs), '10:30');
  // the owner can also record it afterwards, on the plain hold
  const late = await http('POST', T(t0.id) + '/query', { token: RJ, body: { querySource: 'phone', querySentAt: today, querySentTime: nowHM(), queryEvidence: 'Phone call to the client at reception' } });
  assert.equal(late.status, 200, JSON.stringify(late.j)); assert.equal(late.j.task.queries.length, 1);
});

// ---- what the screen shows (page source)
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
test('the history shows each send-for-review with its time and the internal commitment date; queries never show a made-up time', () => {
  assert.match(html, /function fmtStamp\(iso\)\{[^}]*\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(iso\)\) return fmtDate\(iso\)/, 'a date-only value prints the day alone');
  assert.match(html, /timeZone:'Pacific\/Auckland' \}\) \+ ', ' \+ d\.toLocaleTimeString\('en-NZ', \{ hour:'numeric', minute:'2-digit', timeZone:'Pacific\/Auckland' \}\)/, 'always New Zealand time');
  assert.match(html, /const dt = fmtStamp;/);
  const tl = html.slice(html.indexOf('function taskTimelineEvents'), html.indexOf('function taskNewest'));
  assert.match(tl, /Internal commitment <b>\$\{origInternal/, 'the assignment line carries the internal commitment date');
  assert.match(tl, /for review\.' \+ internalNote\(x\.at, first\)/, 'sent for review shows the internal commitment and whether it was on time');
  assert.match(tl, /submitted on time/); assert.match(tl, /submitted after it/);
  assert.match(tl, /sentStamp = q\.sentTs \|\|/); assert.match(tl, /push\(h\.resumedTs \|\| h\.resumedAt/);
  assert.ok(!/push\(q\.sentAt,/.test(tl), 'no query is stamped with a bare day');
  assert.match(html, /Timeline <span[^>]*>\(New Zealand time\)/);
});
test('the details panel offers Reopen for re-review to whoever may do it (the assignee, the assigner, a manager, the reviewer)', () => {
  const panel = html.slice(html.indexOf('function tdDetailHtml'), html.indexOf('MANAGER VIEWS (v2)'));
  assert.match(panel, /iCanSendForReview\(t\) \? '<button type="button" class="btn td-act" onclick="openSendForReviewModal/);
  assert.match(panel, /Reopen for re-review/);
  assert.match(panel, /Internal commitment date/); assert.match(panel, /held to /);
});

// ---- the audit: queries that were never really queries
test('audit: a client-wait with no detail and no reply is flagged; only a superadmin can dismiss; dismissing lifts the freeze, keeps the record and says why', async () => {
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'Audit Ltd', email: 'a@t.co' } })).j.client.id;
  const mkT = async name => { const r = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name, taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(1), clientDate: day(4), reviewerId: emp('parvinder').id } }); assert.equal(r.status, 201, JSON.stringify(r.j)); await http('POST', T(r.j.task.id) + '/accept', { token: RJ }); return r.j.task; };
  const fake = await mkT('Fake query'), real = await mkT('Real query'), live = await mkT('Still waiting');
  const hold = (t, body) => http('POST', T(t.id) + '/hold', { token: RJ, body: { responsibility: 'client', followUpDate: day(2), detail: 'waiting on the client', ...body } });
  assert.equal((await hold(fake, { reasonCode: 'CLIENT_QUERY', detail: 'Awaiting client answer to a query', ...ASK() })).status, 200);       // nothing typed — what the old default produced
  assert.equal((await hold(real, { reasonCode: 'CLIENT_QUERY', ...ASK({ querySource: 'phone' }), detail: 'Which entity owns the vehicle?' })).status, 200);
  assert.equal((await hold(live, { reasonCode: 'CLIENT_QUERY', ...ASK() })).status, 200);
  for (const t of [fake, real]) assert.equal((await http('POST', T(t.id) + '/unhold', { token: RJ })).status, 200);
  const A = (await http('GET', '/api/admin/query-audit', { token: SA })).j;
  const row = n => A.rows.find(r => r.taskName === n);
  assert.equal(row('Fake query').suspect, true); assert.ok(row('Fake query').flags.includes('no_detail'));
  assert.equal(row('Real query').suspect, false, 'a typed detail is a real query');
  assert.equal(row('Still waiting').suspect, false, 'still open, nothing proven');
  assert.equal(row('Fake query').typedDetail, null); assert.ok(row('Fake query').sentTs, 'shows the exact time');
  assert.equal((await http('GET', '/api/admin/query-audit', { token: RJ })).status, 403, 'only a superadmin can open the audit');
  const item = { taskId: fake.id, queryId: row('Fake query').queryId };
  assert.equal((await http('POST', '/api/admin/query-audit/dismiss', { token: RJ, body: { items: [item], reason: 'not a real query' } })).status, 403);
  assert.equal((await http('POST', '/api/admin/query-audit/dismiss', { token: SA, body: { items: [item], reason: 'no' } })).status, 400, 'a reason is required');
  const d = await http('POST', '/api/admin/query-audit/dismiss', { token: SA, body: { items: [item, item], reason: 'Hold was recorded as a query by default' } });
  assert.equal(d.j.dismissed, 1); assert.equal(d.j.skipped.length, 1, 'dismissing twice does nothing the second time');
  const after = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(x => x.id === fake.id);
  assert.equal(after.queries.length, 1, 'the record is kept'); assert.ok(after.queries[0].dismissedAt); assert.match(after.queries[0].dismissedReason, /by default/);
  assert.equal(after.queryShiftDays, 0, 'the freeze is lifted'); assert.equal(after.effectiveClientDate, after.clientDate);
  // a task still on hold under a dismissed query becomes an ordinary internal hold
  const liveRow = (await http('GET', '/api/admin/query-audit', { token: SA })).j.rows.find(r => r.taskName === 'Still waiting');
  assert.equal((await http('POST', '/api/admin/query-audit/dismiss', { token: SA, body: { items: [{ taskId: live.id, queryId: liveRow.queryId }], reason: 'Was never a query' } })).j.dismissed, 1);
  const lt = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(x => x.id === live.id);
  assert.equal(lt.holdReasonCode, 'BLOCKED_OTHER'); assert.equal(lt.holdHistory.at(-1).reasonWas, 'CLIENT_QUERY');
  const A2 = (await http('GET', '/api/admin/query-audit', { token: SA })).j;
  assert.equal(A2.dismissed, 2);
});

test('the Hold box pre-chooses nothing and records no query on its own: it needs a ticked box and a typed date, time and way of asking', () => {
  assert.match(html, /<select id="holdReasonCode" onchange="_holdReasonChanged\(\)"><option value="" selected disabled>— Choose the category —<\/option>/);
  assert.match(html, /<select id="qSource"><option value="" selected disabled>— Choose —<\/option>/);
  assert.match(html, /<input type="checkbox" id="qConfirm" style="margin-top:3px;" onchange=/); assert.ok(!/id="qConfirm"[^>]*\schecked\b/.test(html), 'unticked by default');
  assert.match(html, /<input type="date" id="qSentAt" max="' \+ esc\(todayISO\(\)\) \+ '"><\/div>/, 'the date is not pre-filled');
  assert.match(html, /<input type="time" id="qSentTime">/);
  assert.match(html, /function openRecordQueryModal\(id\)/); assert.match(html, /Record query/);
  assert.ok(html.includes("if(!reasonCode) return fail('Choose why the task is going on hold.');"));
  assert.ok(html.includes("qsf.style.display = code === 'EXTERNAL_AUTHORITY' ? 'none' : ''"));
});
test('the history words each wait for what it was, and a dismissed query is shown as not real', () => {
  const tl = html.slice(html.indexOf('function taskTimelineEvents'), html.indexOf('function taskNewest'));
  assert.match(tl, /Query to the client raised' \+ via/); assert.match(tl, /Documents requested from the client' \+ via/); assert.match(tl, /Waiting on IRD \/ bank \/ a third party/);
  assert.match(tl, /later dismissed: it was not a real client query/);
  assert.match(html, /id="qaPanel"/); assert.match(html, /function openQueryAudit\(\)/); assert.match(html, /\/api\/admin\/query-audit\/dismiss/);
});

// ---- a task on hold is not counted as late, at risk or breached
test('a task on hold is never counted as overdue, at risk or breached — whatever the hold reason', () => {
  for (const code of ['CLIENT_QUERY', 'BLOCKED_OTHER', 'INTERNAL_REVIEW', 'CAPACITY']) {
    const t = base({ status: 'on_hold', holdReasonCode: code, clientDate: '2026-10-01', internalDeadline: '2026-09-28' });
    const d = { ...deps(), today: '2026-10-09', nowMs: Date.now(), nameOf: () => null, canApprove: () => false };
    const c = workflow.card(t, d);
    assert.equal(c.status, 'On Hold', code);
    assert.equal(c.clientRisk.state, 'waiting_client', code + ' is not "overdue"');
    assert.equal(c.commitment.key, 'waiting_client', code + ' is not "breached"');
    assert.equal(c.clientRisk.label, code === 'CLIENT_QUERY' ? 'Waiting on client' : 'On hold');
  }
  // …but once it is off hold the dates count again
  const live = workflow.card(base({ status: 'accepted', clientDate: '2026-10-01', internalDeadline: '2026-09-28' }), { ...deps(), today: '2026-10-09', nowMs: Date.now(), nameOf: () => null, canApprove: () => false });
  assert.equal(live.clientRisk.state, 'overdue'); assert.equal(live.commitment.key, 'breached');
});
test('the server reports an on-hold task as "on_hold", not missed', async () => {
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'Hold Ltd', email: 'hl@t.co' } })).j.client.id;
  const r = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'Held job', taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: day(1), clientDate: day(4), reviewerId: emp('parvinder').id } });
  await http('POST', T(r.j.task.id) + '/accept', { token: RJ });
  assert.equal((await http('POST', T(r.j.task.id) + '/hold', { token: RJ, body: { reasonCode: 'BLOCKED_OTHER', detail: 'Waiting on my laptop', waitingOnPerson: 'IT', responsibility: 'employee', followUpDate: day(2) } })).status, 200);
  const t = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(x => x.id === r.j.task.id);
  assert.equal(t.commitmentOutcome, 'on_hold');
});

test('the Client-query audit has a menu entry in both layouts (superadmin only) and sits at the top of the Admin page', () => {
  assert.match(html, /id="qaNavItemV2" onclick="openQueryAudit\(\)"/);
  assert.match(html, /id="qaNavItem" style="display:none;" onclick="openQueryAudit\(\)"/);
  assert.match(html, /getElementById\('qaNavItem'\); if\(q\) q\.style\.display = isSuperAdmin \? '' : 'none'/);
  assert.ok(html.indexOf('id="qaPanel"') < html.indexOf('id="adminStatGrid"'), 'the audit panel is above the stats and the task table');
});
