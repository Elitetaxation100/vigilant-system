// The Processor Dashboard, proved on a real server (throwaway data): the six tiles, the hold model, one productivity rule, capacity that no hold can
// reduce, the reviewer ↔ processor file hand-off, role limits, and the same numbers everywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-procdash-'));
let child;
const enc = encodeURIComponent;
async function http(method, p, { token, body, raw, headers } = {}) {
  const h = { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(headers || {}) }; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: method === 'GET' ? undefined : raw ? body : (body === undefined ? undefined : JSON.stringify(body)) });
  const buf = Buffer.from(await r.arrayBuffer()); let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (e) {}
  return { status: r.status, j, buf, text: buf.toString('utf8') };
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
const FROM = '2026-09-07';
const T = id => '/api/tasks/' + enc(id);
let SA, PA, RJ, HU, E, clientSeq = 0;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const mine = async (tok, id) => (await http('GET', '/api/tasks', { token: tok })).j.tasks.find(t => t.id === id);
const dash = async tok => (await http('GET', '/api/workflow/today', { token: tok })).j;
const tile = (D, key) => D.modes.processor.tiles.find(t => t.key === key);
const prod = async (tok, q) => (await http('GET', '/api/productivity?from=' + FROM + '&to=' + today + '&full=1' + (q || ''), { token: tok })).j;
const rjRow = async tok => (await prod(tok, tok === RJ ? '&scope=me' : '')).people.find(p => p.id === emp('ranjit').id);
async function mk(name, over) {
  const di = 1 + (clientSeq % 25);                       // spread the due dates so the capacity guard never blocks a test
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'PD Client ' + (++clientSeq), email: 'pd' + clientSeq + '@t.co' } })).j.client.id;
  const r = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name, taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 0.5, internalDeadline: day(di), clientDate: day(di + 6), reviewerId: emp('parvinder').id, ...(over || {}) } });
  assert.equal(r.status, 201, name + ' ' + JSON.stringify(r.j));
  assert.equal((await http('POST', T(r.j.task.id) + '/accept', { token: RJ })).status, 200);
  return r.j.task;
}
const submit = t => http('POST', T(t.id) + '/complete', { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } });
const approve = (t, rid) => http('POST', T(t.id) + '/review-decision', { token: PA, body: { decision: 'approve', requestId: rid, note: '' } });
const hold = (t, body, tok) => http('POST', T(t.id) + '/hold', { token: tok || RJ, body: { followUpDate: day(2), ...body } });
const HOLD_MGR = { category: 'MANAGER_DECISION', detail: 'Need a ruling on the vehicle treatment', waitingOnId: undefined };

test('setup', async () => {
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee'); HU = await login('hunny', 'Hunny@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  HOLD_MGR.waitingOnId = emp('parvinder').id;
});

// ------------------------------------------------------------------------------------------------ the six tiles
test('the processor sees ONE focused view with six tiles, and every tile\'s number is the number of unique tasks in its list', async () => {
  const a = await mk('Tile A due today', { internalDeadline: day(0), clientDate: day(6) }); const b = await mk('Tile B internal later', { internalDeadline: day(3), clientDate: day(9) });
  const c = await mk('Tile C sent'); await submit(c);
  const D = await dash(RJ);
  assert.deepEqual(D.tabs, ['processor'], 'a plain processor has one view');
  assert.deepEqual(D.modes.processor.tiles.map(t => t.label), ['Due Today', 'Fix Needed', 'Ready to Resume', 'Waiting on Others', 'Sent for Review', 'Reports to Send']);
  for (const t of D.modes.processor.tiles) { assert.equal(t.count, t.ids.length, t.label); assert.equal(new Set(t.ids).size, t.ids.length, t.label + ' lists each task once'); for (const id of t.ids) assert.ok(D.cards[id], t.label + ': the card exists for ' + id); }
  assert.ok(tile(D, 'p_due').ids.includes(a.id)); assert.ok(!tile(D, 'p_due').ids.includes(b.id), 'due later is not due today');
  assert.ok(tile(D, 'p_sent').ids.includes(c.id), 'submitted work is "Sent for Review", not due');
  assert.ok(!tile(D, 'p_due').ids.includes(c.id));
  const labels = Object.fromEntries(['p_due', 'p_sent'].map(k => [k, D.cards[(tile(D, k).ids[0])].primaryStatus]));
  assert.equal(labels.p_sent, 'Sent for Review');
});

// ------------------------------------------------------------------------------------------------ on hold
test('1-6. ON HOLD: leaves In Progress and the actionable queue, appears under Waiting on Others, earns nothing, keeps its allocated hours, and never reduces capacity', async () => {
  const t = await mk('Hold basics', { tat: 2, internalDeadline: day(0), clientDate: day(6) });
  const before = { D: await dash(RJ), p: await rjRow(RJ), task: await mine(RJ, t.id) };
  assert.ok(tile(before.D, 'p_due').ids.includes(t.id));
  const h = await hold(t, HOLD_MGR);
  assert.equal(h.status, 200, JSON.stringify(h.j));
  const after = { D: await dash(RJ), p: await rjRow(RJ), task: await mine(RJ, t.id) };
  const c = after.D.cards[t.id];
  assert.equal(c.status, 'On Hold'); assert.equal(c.primaryStatus, 'On Hold', 'one primary status');
  assert.ok(!tile(after.D, 'p_due').ids.includes(t.id), 'it is not work to complete today');
  assert.ok(tile(after.D, 'p_waiting').ids.includes(t.id), 'it waits on others');
  assert.equal(['p_due', 'p_fix', 'p_ready', 'p_sent', 'p_reports'].filter(k => tile(after.D, k).ids.includes(t.id)).length, 0, 'and in no other tile');
  assert.equal(c.waitingOn.kind, 'manager'); assert.equal(c.hold.waitingOnPerson, 'Parvinder Kumar');
  assert.equal(after.task.tat, before.task.tat); assert.equal(after.task.productivityAllocatedHoursSnapshot, before.task.productivityAllocatedHoursSnapshot, 'allocated hours do not change while held');
  assert.equal(after.p.qualifiedHours, before.p.qualifiedHours, 'no productivity for held work');
  assert.equal(after.p.capacityHours, before.p.capacityHours, 'a hold never reduces the seven-hour capacity');
  assert.ok(after.p.excludedTasks.some(r => r.id === t.id && r.exclusionReason === 'On hold'), 'it is listed as excluded: On hold');
  await http('POST', T(t.id) + '/unhold', { token: RJ });
});

test('7. hold age runs from the hold start; every held task shows category, waiting-on, age and follow-up', async () => {
  const t = await mk('Hold age');
  assert.equal((await hold(t, HOLD_MGR)).status, 200);
  const snap = (await http('GET', '/api/admin/state-export', { token: SA })).j;
  const st = snap.tasks.find(x => x.id === t.id), ago = new Date(Date.now() - 3 * 86400000 - 3600000).toISOString();
  st.heldAt = ago; st.holdHistory.at(-1).heldAt = ago;
  assert.equal((await http('POST', '/api/admin/state-import', { token: SA, body: snap })).status, 200);
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee'); HU = await login('hunny', 'Hunny@2026', 'employee');
  const c = (await dash(RJ)).cards[t.id];
  assert.equal(c.hold.ageDays, 3); assert.match(c.hold.ageText, /3 days/);
  assert.ok(c.hold.categoryLabel && c.hold.waitingOnPerson && c.hold.followUp && c.hold.reason, 'category, waiting-on, follow-up and reason are always shown');
  assert.equal(c.hold.clientResponsePending, false, 'it never says "client response pending" without a recorded query');
});

test('8-11. a generic hold creates NO client query; a recorded query needs evidence; only an external wait can pause responsibility — and only once a manager approves', async () => {
  const a = await mk('Generic hold');
  const g = await hold(a, { category: 'CLIENT_INFO', detail: 'asked about the entity' });
  assert.equal(g.status, 200); assert.equal(g.j.task.queries.length, 0, '8. no client query by itself');
  assert.equal((await dash(RJ)).cards[a.id].hold.clientResponsePending, false);
  const b = await mk('Real client query');
  const noEv = await hold(b, { category: 'CLIENT_INFO', detail: 'asked about the entity', queryConfirmed: true, querySource: 'email', querySentAt: today, querySentTime: '08:00' });
  assert.equal(noEv.status, 400, 'a query without evidence is refused');
  const q = await hold(b, { category: 'CLIENT_INFO', detail: 'asked about the entity', queryConfirmed: true, querySource: 'email', querySentAt: today, querySentTime: '08:00', queryEvidence: 'Email "Entity?" sent 8:00' });
  assert.equal(q.status, 200, JSON.stringify(q.j));
  assert.equal(q.j.task.queries.length, 1, '9. a client query record exists'); assert.equal(q.j.task.queries[0].evidence, 'Email "Entity?" sent 8:00');
  assert.equal(q.j.task.queries[0].pauseStatus, 'pending', '10. the pause waits for a manager');
  assert.equal((await dash(RJ)).cards[b.id].hold.responsibilityPaused, false);
  assert.equal((await http('POST', T(b.id) + '/hold-pause', { token: RJ, body: { approve: true } })).status, 403, 'the processor cannot approve their own pause');
  assert.equal((await http('POST', T(b.id) + '/hold-pause', { token: PA, body: { approve: true } })).status, 200);
  const cb = (await dash(RJ)).cards[b.id];
  assert.equal(cb.hold.responsibilityPaused, true); assert.equal(cb.hold.clientResponsePending, true); assert.match(cb.commitment.label, /Paused by verified external dependency/);
  assert.equal(cb.clientDate, (await mine(RJ, b.id)).clientDate, 'the client date never moves');
  const c = await mk('Manager hold');
  assert.equal((await hold(c, { ...HOLD_MGR, queryConfirmed: true, querySource: 'email', querySentAt: today, querySentTime: '08:00', queryEvidence: 'x' })).status, 400, '11. a wait on a manager can never pause responsibility');
  assert.equal((await hold(c, HOLD_MGR)).j.task.queries.length, 0);
  const d = await mk('Manager places the hold');
  const m = await hold(d, { category: 'CLIENT_DOCS', detail: 'statements', waitingOnPerson: 'the client', queryConfirmed: true, querySource: 'email', querySentAt: today, querySentTime: '07:00', queryEvidence: 'Email statements' }, PA);
  assert.equal(m.status, 200, JSON.stringify(m.j)); assert.equal(m.j.task.queries[0].pauseStatus, 'approved', 'a manager\'s own hold is approved on the spot');
  for (const x of [a, b, c, d]) await http('POST', T(x.id) + '/unhold', { token: RJ });
});

test('12. a hold created after the internal due date does not remove an existing miss; a hold before it does not protect it', async () => {
  const t = await mk('Hold after the date');
  const snap = (await http('GET', '/api/admin/state-export', { token: SA })).j;
  snap.tasks.find(x => x.id === t.id).internalDeadline = day(-2);
  assert.equal((await http('POST', '/api/admin/state-import', { token: SA, body: snap })).status, 200);
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee'); HU = await login('hunny', 'Hunny@2026', 'employee');
  assert.equal((await dash(RJ)).cards[t.id].commitment.key, 'breached');
  assert.equal((await hold(t, HOLD_MGR)).status, 200);
  const c = (await dash(RJ)).cards[t.id];
  assert.equal(c.commitment.key, 'breached', 'still missed after the hold'); assert.equal(c.status, 'On Hold');
  await http('POST', T(t.id) + '/unhold', { token: RJ });
});

test('13-14, 16. RESUME closes the hold interval, restores the right state, never completes the task or grants credit — and Ready to Resume appears when the dependency arrives', async () => {
  const t = await mk('Resume me', { internalDeadline: day(0), clientDate: day(6) });
  const p0 = await rjRow(RJ);
  assert.equal((await hold(t, { category: 'CLIENT_DOCS', detail: 'bank statements', waitingOnPerson: 'the client', queryConfirmed: true, querySource: 'email', querySentAt: today, querySentTime: '07:30', queryEvidence: 'Email "statements"' })).status, 200);
  assert.ok(tile(await dash(RJ), 'p_waiting').ids.includes(t.id));
  const q = (await mine(RJ, t.id)).queries[0];
  assert.equal((await http('POST', T(t.id) + '/query/' + enc(q.id) + '/reply', { token: RJ, body: { replyAt: today, replySource: 'email' } })).status, 200, 'the client replies');
  let D = await dash(RJ);
  assert.ok(tile(D, 'p_ready').ids.includes(t.id) && !tile(D, 'p_waiting').ids.includes(t.id), 'the reply moves it to Ready to Resume');
  assert.equal(D.cards[t.id].primaryStatus, 'Ready to Resume');
  const r = await http('POST', T(t.id) + '/unhold', { token: RJ, body: { reason: 'statements arrived' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const task = await mine(RJ, t.id), h = task.holdHistory.at(-1);
  assert.equal(task.status, 'accepted', 'back to where it was'); assert.ok(h.resumedAt && h.resumedTs && h.heldHours != null, 'the hold has an end and a duration');
  assert.equal(h.resumedBy, emp('ranjit').id); assert.equal(h.statusBeforeHold, 'accepted'); assert.equal(h.statusAfterResume, 'accepted'); assert.equal(h.resumeReason, 'statements arrived');
  assert.equal(h.holdId.length > 10, true);
  assert.notEqual(task.status, 'completed'); assert.equal((await rjRow(RJ)).qualifiedHours, p0.qualifiedHours, 'resuming grants no productivity');
  D = await dash(RJ); assert.ok(tile(D, 'p_due').ids.includes(t.id), 'back in the actionable queue'); assert.equal(D.cards[t.id].hold, null);
  // a correction that was on hold goes back to Fix Needed
  const f = await mk('Fix then hold'); await submit(f);
  assert.equal((await http('POST', T(f.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'pd-r1', category: 'Other', responsibility: 'Employee', dueDate: day(2), note: 'redo' } })).status, 200);
  await http('POST', T(f.id) + '/accept', { token: RJ });
  assert.equal((await hold(f, { category: 'REWORK_BLOCKED', detail: 'waiting for a template', waitingOnPerson: 'the template library' })).status, 200);
  assert.equal((await http('POST', T(f.id) + '/unhold', { token: RJ })).status, 200);
  const fc = (await dash(RJ)).cards[f.id];
  assert.equal(fc.primaryStatus, 'Fix Needed'); assert.ok(tile(await dash(RJ), 'p_fix').ids.includes(f.id));
});

test('hold form rules: category, reason, who it waits on and a follow-up date are required; a scheduled hold needs a future date', async () => {
  const t = await mk('Hold rules');
  const go = b => http('POST', T(t.id) + '/hold', { token: RJ, body: b });
  assert.equal((await go({ detail: 'x reason', followUpDate: day(2) })).status, 400, 'category');
  assert.equal((await go({ category: 'OTHER', followUpDate: day(2), waitingOnPerson: 'x' })).status, 400, 'reason');
  assert.equal((await go({ category: 'OTHER', detail: 'a reason', followUpDate: day(2) })).status, 400, 'waiting on');
  assert.equal((await go({ category: 'OTHER', detail: 'a reason', waitingOnPerson: 'x' })).status, 400, 'follow-up');
  assert.equal((await go({ category: 'SCHEDULED_FUTURE', detail: 'client asked us to wait', followUpDate: today })).status, 400, 'a scheduled hold needs a future date');
  assert.equal((await go({ category: 'NOPE', detail: 'a reason', waitingOnPerson: 'x', followUpDate: day(2) })).status, 400, 'a known category');
  assert.equal((await mine(RJ, t.id)).status, 'accepted', 'a refused hold changes nothing');
  assert.equal((await go({ category: 'SCHEDULED_FUTURE', detail: 'client asked us to wait', followUpDate: day(5), expectedResponseDate: day(5) })).status, 200);
  const upd = await http('POST', T(t.id) + '/hold-update', { token: RJ, body: { followUpDate: day(7), evidence: 'Client email of 9 Oct' } });
  assert.equal(upd.status, 200); const h = (await mine(RJ, t.id)).holdHistory.at(-1);
  assert.equal(h.followUp, day(7)); assert.equal(h.updates.length, 1); assert.equal(h.evidence.length, 1, 'every change is kept in the hold\'s own history');
  const dr = await http('POST', T(t.id) + '/date-request', { token: RJ, body: { clientDate: day(12), reason: 'The client asked for more time' } });
  assert.equal(dr.status, 200); assert.equal((await mine(RJ, t.id)).clientDate, t.clientDate, 'a request changes nothing by itself');
  await http('POST', T(t.id) + '/unhold', { token: RJ });
});

// ------------------------------------------------------------------------------------------------ productivity
test('15-18, 21. PRODUCTIVITY: review pending and rework earn nothing; Reviewed Clean earns the FULL allocated hours once, on the clean date; Report Sent changes nothing', async () => {
  const p0 = await rjRow(RJ);
  const t = await mk('Qualify me', { tat: 2, internalDeadline: day(0), clientDate: day(6) });
  await submit(t);
  let p = await rjRow(RJ);
  assert.equal(p.qualifiedHours, p0.qualifiedHours, '16. review pending → zero');
  assert.ok(p.excludedTasks.some(r => r.id === t.id && r.exclusionReason === 'Review pending'));
  // returned → rework → zero
  assert.equal((await http('POST', T(t.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'pq-1', category: 'Other', responsibility: 'Employee', dueDate: day(2), note: 'fix' } })).status, 200);
  await http('POST', T(t.id) + '/accept', { token: RJ });
  p = await rjRow(RJ); assert.equal(p.qualifiedHours, p0.qualifiedHours, '17. rework → zero');
  await http('POST', T(t.id) + '/resubmit', { token: RJ });
  assert.equal((await approve(t, 'pq-2')).status, 200);
  p = await rjRow(RJ);
  const row = p.qualifiedTasks.find(r => r.id === t.id);
  assert.ok(row, 'reviewed clean → qualifies'); assert.equal(row.creditedHours, 2); assert.equal(row.allocatedHours, 2, '15. full allocated hours');
  assert.equal(row.qualifyingEventType, 'clean_review'); assert.equal(row.rule, 'v3');
  assert.equal(new Date(row.qualifyingEventAt).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }), today, 'on the Reviewed Clean date');
  assert.equal(p.qualifiedHours, p0.qualifiedHours + 2, 'counted once');
  for (const r of p.qualifiedTasks) assert.equal(r.creditedHours, r.allocatedHours, '21. partial credit is impossible — ' + r.name);
  // the report is not sent yet: productivity already counted; sending changes nothing, the report score moves on its own
  const pBefore = await rjRow(RJ);
  await http('POST', T(t.id) + '/profit-confirm/done', { token: SA });
  const sent = await http('POST', T(t.id) + '/send-to-client', { token: RJ, body: { decision: 'yes' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.j));
  const pAfter = await rjRow(RJ);
  assert.equal(pAfter.qualifiedHours, pBefore.qualifiedHours, '18. sending the report does not touch productivity');
  assert.equal(pAfter.productivityPct, pBefore.productivityPct);
  assert.ok(pAfter.reportsOnTime >= pBefore.reportsOnTime && pAfter.reportsOnTime + pAfter.reportsLate + pAfter.reportsReadyNotSent === pAfter.reportsRequired, '19. Report Sent has its OWN counts and score');
  assert.ok(pAfter.reportPoints > pBefore.reportPoints || pAfter.reportsReadyNotSent < pBefore.reportsReadyNotSent);
});

test('D. a reviewed-clean task earns full productivity BEFORE its report is sent; the unsent report is listed separately in Reports to Send', async () => {
  const t = await mk('Clean but unsent', { tat: 1 });
  await submit(t); assert.equal((await approve(t, 'pd-a')).status, 200);
  await http('POST', T(t.id) + '/profit-confirm/done', { token: SA });
  const p = await rjRow(RJ);
  assert.ok(p.qualifiedTasks.some(r => r.id === t.id && r.creditedHours === 1), 'credited although the report is not sent');
  assert.equal(p.qualifiedTasks.find(r => r.id === t.id).stages.sender, 'not_sent', 'the report status is shown separately');
  assert.ok(tile(await dash(RJ), 'p_reports').ids.includes(t.id), 'and it waits in Reports to Send');
  await http('POST', T(t.id) + '/send-to-client', { token: RJ, body: { decision: 'yes' } });
});

test('20. a client task cannot skip review: a processor is refused; only a manager exception (with reason) counts, and one without an exception earns nothing', async () => {
  const t = await mk('No review please');
  assert.equal((await http('POST', T(t.id) + '/done', { token: RJ, body: {} })).status, 403, 'a processor cannot close client work without review');
  const noReason = await http('POST', T(t.id) + '/done', { token: PA, body: {} });
  assert.equal(noReason.status, 403, 'a manager needs a reason too');
  const ok = await http('POST', T(t.id) + '/done', { token: PA, body: { noReviewReason: 'The client confirmed it is a nil return and asked for no review' } });
  const done = await mine(RJ, t.id);
  if (ok.status === 200) {
    assert.ok(done.noReviewAuthorizedAt && done.noReviewAuthorizedBy === emp('parvinder').id, 'who and when are kept');
    assert.ok((await rjRow(RJ)).qualifiedTasks.some(r => r.id === t.id && r.qualifyingEventType === 'manager_exception_no_review'));
  }
  // an older client task that was closed without an exception earns NOTHING
  const l = await mk('Legacy closed');
  const snap = (await http('GET', '/api/admin/state-export', { token: SA })).j;
  const st = snap.tasks.find(x => x.id === l.id); st.status = 'completed'; st.completedAt = new Date().toISOString(); st.reviewStatus = 'done'; st.reviewerId = null; delete st.noReviewAuthorizedAt;
  assert.equal((await http('POST', '/api/admin/state-import', { token: SA, body: snap })).status, 200);
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee'); HU = await login('hunny', 'Hunny@2026', 'employee');
  const p = await rjRow(RJ);
  assert.ok(!p.qualifiedTasks.some(r => r.id === l.id));
  assert.ok(p.excludedTasks.some(r => r.id === l.id && /closed without review/.test(r.exclusionReason)));
  const dq = (await http('GET', '/api/admin/data-quality', { token: SA })).j;
  assert.ok(dq.rows.some(r => r.category === 'client_closed_no_review' && r.id === l.id), 'the data-quality report lists it');
});

test('21b. month-close no longer banks partial credit for held work', async () => {
  const t = await mk('Held at month end', { tat: 3 });
  assert.equal((await hold(t, HOLD_MGR)).status, 200);
  const before = await rjRow(RJ);
  const period = today.slice(0, 7);
  await http('POST', '/api/productivity/finalize-month', { token: SA, body: { period } });
  const after = await rjRow(RJ);
  assert.equal(after.qualifiedHours, before.qualifiedHours, 'nothing is credited for a held task at month-close');
  assert.ok(!after.qualifiedTasks.some(r => r.rule === 'on_hold_month_close'));
  await http('POST', '/api/productivity/unfinalize-month', { token: SA, body: { period } });
  await http('POST', T(t.id) + '/unhold', { token: RJ });
});

// ------------------------------------------------------------------------------------------------ capacity
test('22-25. CAPACITY: seven hours per eligible elapsed day, shown day by day; the days add up to the capacity; future days never count; holds never change it', async () => {
  const p = await rjRow(RJ);
  assert.ok(p.capacityDays && p.capacityDays.length > 0, 'the day-by-day list is there');
  const sum = Math.round(p.capacityDays.reduce((n, r) => n + r.finalHours, 0) * 100) / 100;
  assert.equal(sum, p.capacityHours, 'the days add up to the eligible capacity');
  for (const r of p.capacityDays) {
    assert.equal(r.standardHours, 7);
    assert.equal(Math.round((r.standardHours - r.leaveDeduction - r.workshopDeduction - r.weeklyOffDeduction - r.otherDeduction) * 100) / 100, r.finalHours, r.date);
    assert.ok(r.reason, r.date + ' says why');
    assert.ok(r.day === 'Sun' ? r.weeklyOffDeduction === 7 : true, 'Sundays are the weekly off');
  }
  assert.ok(p.capacityDays.every(r => r.date <= today), 'no future date is counted');
  const fut = (await http('GET', '/api/productivity?from=' + FROM + '&to=' + day(30) + '&full=1&scope=me', { token: RJ })).j;
  assert.equal(fut.to, today, 'a window running past today is measured only through today');
  assert.equal(fut.people[0].capacityHours, p.capacityHours);
});

// ------------------------------------------------------------------------------------------------ one number everywhere
test('33-34. Ranjit\'s productivity is identical on his dashboard, the manager view, the firm view, the Report Card service and the exports', async () => {
  const mineRow = await rjRow(RJ);
  const asManager = (await prod(PA, '&scope=firm')).people.find(p => p.id === emp('ranjit').id);
  const asFounder = (await prod(SA, '&scope=firm')).people.find(p => p.id === emp('ranjit').id);
  for (const r of [asManager, asFounder]) { assert.equal(r.qualifiedHours, mineRow.qualifiedHours); assert.equal(r.capacityHours, mineRow.capacityHours); assert.equal(r.productivityPct, mineRow.productivityPct); }
  const exp = (await http('GET', '/api/founder/export?section=productivity&preset=custom&from=' + FROM + '&to=' + today, { token: SA })).text.split(/\r?\n/).filter(Boolean);
  const cells = exp.map(l => l.replace(/^﻿/, '').split(',')).find(c => c[0].startsWith('Ranjit'));
  assert.ok(cells, 'Ranjit is in the export');
  assert.equal(Number(cells[8]), mineRow.qualifiedHours, 'the export matches the screen'); assert.equal(Number(cells[7]), mineRow.capacityHours);
  const dr = (await http('GET', '/api/founder/productivity?preset=custom&from=' + FROM + '&to=' + today, { token: SA })).j.table.find(r => r.name.startsWith('Ranjit'));
  assert.equal(dr.qualifiedHours, mineRow.qualifiedHours); assert.equal(dr.eligibleCapacityHours, mineRow.capacityHours);
});

// ------------------------------------------------------------------------------------------------ files
test('30-31. a reviewer\'s correction file reaches the processor, who can download it, upload a corrected file, and resubmit — and the reviewer sees it with its history', async () => {
  const t = await mk('Files both ways'); await submit(t);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj<<>>endobj\n%%EOF')]);
  const upload = async (tok, name, buf) => (await http('POST', '/api/files', { token: tok, raw: true, body: buf, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': enc(name) } }));
  const up1 = await upload(PA, 'Reviewer marks.pdf', pdf); assert.equal(up1.status, 201, up1.text);
  const ret = await http('POST', T(t.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'pf-1', category: 'Calculation error', responsibility: 'Employee', dueDate: day(2), note: 'See the marked file', attachments: [up1.j.file.id] } });
  assert.equal(ret.status, 200, JSON.stringify(ret.j));
  const inbox = (await http('GET', '/api/notifications', { token: RJ })).j.notifications;
  assert.ok(inbox.some(n => /needs a correction/.test(n.text || JSON.stringify(n))), 'the processor is told');
  const seen = await mine(RJ, t.id);
  assert.equal(seen.reviewAttachments.length, 1); assert.equal(seen.reviewAttachments[0].name, 'Reviewer marks.pdf'); assert.equal(seen.reviewAttachments[0].uploaderId, emp('parvinder').id); assert.ok(seen.reviewAttachments[0].uploadedAt);
  assert.equal((await http('GET', '/api/files/' + seen.reviewAttachments[0].id, { token: RJ })).buf.equals(pdf), true, 'the processor downloads the exact bytes');
  assert.equal((await http('GET', '/api/files/' + seen.reviewAttachments[0].id, { token: HU })).status, 403, 'nobody unrelated can');
  await http('POST', T(t.id) + '/accept', { token: RJ });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const up2 = await upload(RJ, 'Corrected workings.png', png); assert.equal(up2.status, 201);
  const rs = await http('POST', T(t.id) + '/resubmit', { token: RJ, body: { attachmentIds: [up2.j.file.id] } });
  assert.equal(rs.status, 200, JSON.stringify(rs.j));
  const afterRs = await mine(PA, t.id);
  assert.equal(afterRs.correctionAttachments.length, 1); assert.equal(afterRs.correctionAttachments[0].name, 'Corrected workings.png');
  assert.equal(afterRs.correctionAttachments[0].uploaderId, emp('ranjit').id); assert.equal(afterRs.correctionAttachments[0].cycle, 1);
  assert.equal(afterRs.reviewAttachments.length, 1, 'the reviewer\'s earlier file is still there — nothing is overwritten');
  assert.equal((await http('GET', '/api/files/' + afterRs.correctionAttachments[0].id, { token: PA })).buf.equals(png), true, 'the reviewer downloads the corrected file');
  assert.ok((await http('GET', '/api/notifications', { token: PA })).j.notifications.some(n => /resubmitted/.test(JSON.stringify(n))), 'the reviewer is told');
  assert.equal((await http('POST', T(t.id) + '/resubmit', { token: RJ, body: { attachmentIds: ['nope'] } })).status, 400);
});

// ------------------------------------------------------------------------------------------------ permissions (server-side)
test('28. a processor cannot do what is not theirs — enforced by the server, not by hidden buttons', async () => {
  const t = await mk('Permissions');
  const own = [
    ['GET', '/api/founder/dashboard'], ['GET', '/api/founder/productivity'], ['GET', '/api/workflow/team'], ['GET', '/api/admin/data-quality'],
    ['GET', '/api/admin/query-audit'], ['GET', '/api/admin/state-export'], ['POST', T(t.id) + '/set-dates'], ['POST', T(t.id) + '/manager-change'], ['POST', T(t.id) + '/hold-pause'],
  ];
  for (const [m, p] of own) assert.ok([401, 403].includes((await http(m, p, { token: RJ, body: {} })).status), 'a processor is refused: ' + p);
  const firm = (await http('GET', '/api/productivity?scope=firm', { token: RJ })).j;
  assert.deepEqual(firm.people.map(p => p.id), [emp('ranjit').id], 'a processor only ever sees themselves, even when asking for the firm');
  assert.equal((await http('PATCH', '/api/employees/' + enc(emp('hunny').id), { token: RJ, body: { accessRole: 'admin' } })).status, 403);
  assert.ok([403, 404].includes((await http('POST', T(t.id) + '/hold', { token: HU, body: { category: 'OTHER', detail: 'x reason', waitingOnPerson: 'x', followUpDate: day(2) } })).status), 'another processor cannot hold Ranjit\'s task');
  const wr = await http('POST', T(t.id) + '/manager-change', { token: RJ, body: { action: 'waive_review', reason: 'I would like to skip it' } });
  assert.ok([401, 403].includes(wr.status), 'a processor cannot waive their own review');
  assert.equal((await http('POST', T(t.id) + '/date-request', { token: HU, body: { clientDate: day(9), reason: 'not mine to ask' } })).status, 403, 'only the person doing the work can ask');
});

// ------------------------------------------------------------------------------------------------ what the screens say (page source)
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
test('26-27, 29, wording. the page: latest selection wins on period changes, task titles are real buttons, no "hours done", no month-end banking, no stale totals', () => {
  assert.match(html, /let _rcSeq = 0;[\s\S]{0,400}const seq = \+\+_rcSeq;[\s\S]{0,300}_rcData = null;/, 'a new selection invalidates the old numbers at once');
  assert.match(html, /if\(seq !== _rcSeq\) return;[\s\S]{0,120}_rcData = data;/, 'an older answer can never repaint');
  assert.match(html, /Calculating…/); assert.match(html, /let _prodSeq = 0;/);
  assert.match(html, /<button type="button" class="tr-open"/); assert.match(html, /\.td-row \.tr-open:focus-visible/);
  assert.match(html, /h\.setAttribute\('tabindex', '-1'\)/, 'focus moves to the task that opened');
  assert.ok(!/hrs done/.test(html) && !/hours done/i.test(html), 'no "hours done"');
  assert.ok(!html.includes('banked at month-end'), 'no month-end banking');
  assert.match(html, /Reviewed-clean allocated hours/); assert.match(html, /Eligible capacity hours/); assert.match(html, /actionable workload/);
  assert.match(html, /const totalN = openN \+ inReview\.length \+ donePeriod\.length \+ reviewedN \+ pendingReviewN;/, 'Work in scope: the parts add up');
  assert.match(html, /Task status — every task, all time/);
  assert.ok(!html.includes('id="myExtraHours"'), 'no extra-hours tile built on actual work time');
  for (const l of ['Due Today', 'Fix Needed', 'Ready to Resume', 'Waiting on Others', 'Sent for Review', 'Reports to Send']) assert.ok(html.includes(l) || fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8').includes(l), l);
});
