// Phase 6 rules on a REAL server: the new-task form's Client / Admin split, the review requirement and its waiver, link validation
// and link history, commitment-date history that preserves the originals, and the hold record (who is responsible, follow-up date,
// which clocks stopped).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-rules-'));
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
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const T = id => `/api/tasks/${enc(id)}`;
async function create(tok, body) {
  return http('POST', '/api/tasks', { token: tok, body: { mode: 'team', name: 'Rule task ' + Math.random().toString(36).slice(2, 6), assignedTo: emp('ranjit').id, tat: 0.25, internalDeadline: day(3), clientDate: day(9), ...body } });
}
const mine = async (tok, id) => (await http('GET', '/api/tasks', { token: tok })).j.tasks.find(t => t.id === id);

test('setup', async () => {
  SH = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  PK = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SH })).j.employees;
  client = (await http('POST', '/api/clients', { token: SH, body: { name: 'Rules Ltd', email: 'ru' + Date.now() + '@t.co' } })).j.client;
});

test('Client Task and Admin Task: a client task needs a client; an admin task does not and is not reviewed unless asked', async () => {
  assert.equal((await create(PK, { taskKind: 'client' })).status, 400, 'client task without a client');
  const c = await create(PK, { taskKind: 'client', clientId: client.id, reviewerId: emp('parvinder').id });
  assert.equal(c.status, 201, JSON.stringify(c.j));
  assert.equal(c.j.task.kind, 'client'); assert.equal(c.j.task.reviewRequired, true); assert.equal(c.j.task.assignedReviewerId, emp('parvinder').id);
  assert.equal(c.j.task.originalInternalDeadline, day(3)); assert.equal(c.j.task.originalClientDate, day(9), 'the dates it started with are recorded');
  const a = await create(PK, { taskKind: 'admin', name: 'Filing day', clientDate: undefined });
  assert.equal(a.status, 201, JSON.stringify(a.j));
  assert.equal(a.j.task.kind, 'internal'); assert.equal(a.j.task.reviewRequired, false); assert.equal(a.j.task.clientDate, null);
  const a2 = await create(PK, { taskKind: 'admin', reviewRequired: true });
  assert.equal(a2.j.task.reviewRequired, true, 'an admin task can still ask for review');
  assert.equal((await create(PK, { taskKind: 'client', clientId: client.id, reviewerId: emp('ranjit').id })).status, 400, 'reviewer must be a manager');
  assert.equal((await create(PK, { taskKind: 'client', clientId: client.id, reviewerId: 'nobody' })).status, 400);
});

test('waiving the review at creation: only a manager, only with a reason, and it is kept on the record', async () => {
  const body = { taskKind: 'client', clientId: client.id, reviewRequired: false };
  assert.equal((await create(RJ, { ...body, mode: undefined, assignedTo: undefined })).status, 403, 'an employee cannot waive review');
  assert.equal((await create(PK, body)).status, 400, 'no reason');
  assert.equal((await create(PK, { ...body, noReviewReason: 'ok' })).status, 400, 'a reason has to be a real sentence');
  const r = await create(PK, { ...body, noReviewReason: 'Repeat of last month, already checked by the founder' });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  assert.equal(r.j.task.reviewRequired, false); assert.equal(r.j.task.noReviewAuthorizedBy, emp('parvinder').id);
  assert.match(r.j.task.noReviewAuthorizedReason, /Repeat of last month/); assert.ok(r.j.task.noReviewAuthorizedAt);
});

test('closing a required-review client task without review: an employee is refused, the attempt is recorded and managers are told; a manager can waive with a reason', async () => {
  const t = (await create(PK, { taskKind: 'client', clientId: client.id, reviewerId: emp('parvinder').id })).j.task;
  assert.equal((await http('POST', T(t.id) + '/accept', { token: RJ })).status, 200);
  const d = await http('POST', T(t.id) + '/done', { token: RJ, body: {} });
  assert.equal(d.status, 403); assert.equal(d.j.code, 'REVIEW_REQUIRED');
  const after = await mine(SH, t.id);
  assert.equal(after.status, 'accepted', 'still open'); assert.equal(after.noReviewAttempts.length, 1); assert.equal(after.noReviewAttempts[0].by, emp('ranjit').id);
  const notes = (await http('GET', '/api/notifications', { token: PK })).j.notifications;
  assert.ok(notes.some(n => /without a review/.test(n.text) && n.taskId === t.id), 'the manager was told');
  const team = (await http('GET', '/api/workflow/team', { token: PK })).j;
  assert.ok(team.attention.some(a => a.id === t.id && a.type === 'no_review_attempt'), 'and it shows under Needs Manager Attention');
  assert.equal((await http('POST', T(t.id) + '/done', { token: PK, body: {} })).status, 403, 'even a manager needs a reason');
  assert.equal((await http('POST', T(t.id) + '/done', { token: PK, body: { noReviewReason: 'hi' } })).status, 403);
  const ok = await http('POST', T(t.id) + '/done', { token: PK, body: { noReviewReason: 'Client asked for a same-day copy; founder agreed' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.task.status, 'completed'); assert.ok(ok.j.task.noReviewAuthorizedAt); assert.match(ok.j.task.noReviewAuthorizedReason, /same-day/);
});

test('the review rule only governs tasks made with the new form — existing tasks and admin tasks behave as before', async () => {
  const legacy = (await create(SH, { kind: 'client', clientId: client.id })).j.task;
  assert.equal(legacy.reviewRequired === undefined || legacy.reviewRequired === null, true);
  assert.equal((await http('POST', T(legacy.id) + '/accept', { token: RJ })).status, 200);
  assert.equal((await http('POST', T(legacy.id) + '/done', { token: RJ, body: {} })).status, 200, 'legacy tasks can still be closed without review');
  const admin = (await create(PK, { taskKind: 'admin', name: 'Admin chore', clientDate: undefined })).j.task;
  assert.equal((await http('POST', T(admin.id) + '/accept', { token: RJ })).status, 200);
  assert.equal((await http('POST', T(admin.id) + '/done', { token: RJ, body: {} })).status, 200, 'admin tasks need no review');
});

test('submitting for review uses the reviewer chosen at creation when none is named', async () => {
  const t = (await create(PK, { taskKind: 'client', clientId: client.id, reviewerId: emp('parvinder').id })).j.task;
  await http('POST', T(t.id) + '/accept', { token: RJ });
  const c = await http('POST', T(t.id) + '/complete', { token: RJ, body: { sheetLink: 'https://docs.google.com/spreadsheets/d/1', cashbookLink: 'https://example.com/cb' } });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  assert.equal(c.j.task.reviewerId, emp('parvinder').id);
  const td = (await http('GET', '/api/workflow/today', { token: PK })).j;
  assert.ok(td.sections.needs.some(n => n.id === t.id && n.type === 'review'), 'it reaches that reviewer\'s queue');
  const none = (await create(PK, { taskKind: 'client', clientId: client.id })).j.task;
  await http('POST', T(none.id) + '/accept', { token: RJ });
  assert.equal((await http('POST', T(none.id) + '/complete', { token: RJ, body: {} })).status, 400, 'with no reviewer anywhere the employee must still choose');
});

test('links are real links: bad schemes, embedded passwords and host-less addresses are refused; every change is kept in the link history', async () => {
  const bad = ['javascript:alert(1)', 'ftp://files.example.com/x', 'https://user:secret@docs.google.com/x', 'https://localhost/x', 'not a link', 'https://'];
  for (const link of bad) assert.equal((await create(PK, { taskKind: 'client', clientId: client.id, sheetLink: link })).status, 400, 'refused: ' + link);
  const t = (await create(PK, { taskKind: 'client', clientId: client.id, sheetLink: 'https://docs.google.com/spreadsheets/d/1' })).j.task;
  assert.equal(t.sheetLink, 'https://docs.google.com/spreadsheets/d/1');
  assert.deepEqual(t.linkHistory.map(h => [h.slot, h.from, h.to, h.via]), [['sheet', null, 'https://docs.google.com/spreadsheets/d/1', 'created']]);
  const p = await http('PATCH', T(t.id) + '/links', { token: PK, body: { sheetLink: 'https://docs.google.com/spreadsheets/d/2', cashbookLink: 'https://go.xero.com/cb' } });
  assert.equal(p.status, 200, JSON.stringify(p.j));
  const hist = p.j.task.linkHistory;
  assert.equal(hist.length, 3); assert.equal(hist[1].from, 'https://docs.google.com/spreadsheets/d/1'); assert.equal(hist[1].to, 'https://docs.google.com/spreadsheets/d/2');
  assert.ok(hist.every(h => h.by && h.at && h.byId), 'who and when on every entry');
  const same = await http('PATCH', T(t.id) + '/links', { token: PK, body: { sheetLink: 'https://docs.google.com/spreadsheets/d/2' } });
  assert.equal(same.j.task.linkHistory.length, 3, 'saving the same link again adds nothing');
  assert.equal((await http('PATCH', T(t.id) + '/links', { token: PK, body: { sheetLink: 'javascript:alert(1)' } })).status, 400);
});

test('the approved-sites policy is the founder\'s switch, off by default, and rejects look-alike hosts when on', async () => {
  const pol = (await http('GET', '/api/admin/workflow-settings', { token: SH })).j;
  assert.equal(pol.settings.linkDomainsEnforced, false);
  assert.equal((await create(PK, { taskKind: 'client', clientId: client.id, cashbookLink: 'https://example.org/anything' })).status, 201, 'off: any real site works');
  assert.equal((await http('POST', '/api/admin/workflow-settings', { token: DI, body: { linkDomainsEnforced: true } })).status, 403, 'a manager who is not the founder cannot change it');
  assert.equal((await http('GET', '/api/admin/workflow-settings', { token: RJ })).status, 403);
  assert.equal((await http('POST', '/api/admin/workflow-settings', { token: SH, body: { linkDomainsEnforced: true } })).status, 200);
  for (const ok of ['https://docs.google.com/spreadsheets/d/1', 'https://go.xero.com/x', 'https://drive.google.com/file/1']) assert.equal((await create(PK, { taskKind: 'client', clientId: client.id, sheetLink: ok })).status, 201, ok);
  for (const no of ['https://example.org/x', 'https://docs.google.com.evil.example/x', 'https://notgoogle.com/x']) {
    const r = await create(PK, { taskKind: 'client', clientId: client.id, sheetLink: no });
    assert.equal(r.status, 400, no); assert.match(r.j.error, /approved site/);
  }
  assert.equal((await http('POST', '/api/admin/workflow-settings', { token: SH, body: { linkDomains: ['example.org'] } })).status, 200, 'the list is editable');
  assert.equal((await create(PK, { taskKind: 'client', clientId: client.id, sheetLink: 'https://example.org/x' })).status, 201);
  assert.equal((await http('POST', '/api/admin/workflow-settings', { token: SH, body: { linkDomains: ['not a domain'] } })).status, 400);
  assert.equal((await http('POST', '/api/admin/workflow-settings', { token: SH, body: { linkDomainsEnforced: false } })).status, 200);
});

test('commitment dates: the originals never change, every change is a history row with a reason, and the people affected are told', async () => {
  const t = (await create(PK, { taskKind: 'client', clientId: client.id, reviewerId: emp('parvinder').id })).j.task;
  const set = (body, tok) => http('POST', T(t.id) + '/set-dates', { token: tok || PK, body });
  assert.equal((await set({ internalDeadline: day(2), note: '' })).status, 400, 'pulling a date in needs a reason');
  const r = await set({ internalDeadline: day(5), clientDate: day(12), note: 'Client sent bank statements late' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.task.originalInternalDeadline, day(3)); assert.equal(r.j.task.originalClientDate, day(9));
  assert.equal(r.j.task.dateHistory[0].note, 'Client sent bank statements late'); assert.equal(r.j.task.dateHistory[0].category, 'manager_edit');
  const r2 = await set({ internalDeadline: day(6), clientDate: day(13), note: 'Reviewer on leave' });
  assert.equal(r2.j.task.originalInternalDeadline, day(3), 'still the very first date'); assert.equal(r2.j.task.dateHistory.length, 2);
  assert.equal(r2.j.task.dateHistory[1].from.internal, day(5));
  const notes = (await http('GET', '/api/notifications', { token: RJ })).j.notifications;
  assert.ok(notes.filter(n => n.taskId === t.id && /changed the dates/.test(n.text)).length >= 1, 'the assignee is told');
  assert.ok((await http('GET', '/api/notifications', { token: SH })).j.notifications.every(n => n.taskId !== t.id || !/changed the dates/.test(n.text)), 'the person who made the change is not told about their own edit');
});

test('putting work on hold records who is responsible, the follow-up date, and exactly which clocks stopped', async () => {
  const t = (await create(PK, { taskKind: 'client', clientId: client.id })).j.task;
  assert.equal((await http('POST', T(t.id) + '/accept', { token: RJ })).status, 200);
  const hold = (body, tok) => http('POST', T(t.id) + '/hold', { token: tok || RJ, body });
  assert.equal((await hold({ reasonCode: 'CLIENT_DOCS', responsibility: 'nobody', followUpDate: day(2) })).status, 400, 'unknown responsibility');
  assert.equal((await hold({ reasonCode: 'CLIENT_DOCS', responsibility: 'client' })).status, 400, 'a follow-up date is required');
  assert.equal((await hold({ reasonCode: 'CLIENT_DOCS', responsibility: 'client', followUpDate: day(-1) })).status, 400, 'not in the past');
  const ok = await hold({ reasonCode: 'CLIENT_DOCS', responsibility: 'client', followUpDate: day(2), detail: 'Waiting for the bank statements' });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  const h = ok.j.task.holdHistory.at(-1);
  assert.equal(ok.j.task.holdResponsibility, 'client'); assert.equal(ok.j.task.holdFollowUp, day(2));
  assert.deepEqual(h.clocksStopped, { workTimer: true, clientCommitment: true }, 'a client wait pauses the client commitment clock too');
  const card = (await http('GET', '/api/workflow/tasks?ids=' + enc(t.id), { token: PK })).j.rows[0];
  assert.equal(card.status, 'On Hold'); assert.equal(card.waitingOn.kind, 'client'); assert.equal(card.holdFollowUp, day(2));
  assert.equal((await http('POST', T(t.id) + '/unhold', { token: RJ })).status, 200);
  const back = await mine(SH, t.id);
  assert.equal(back.holdFollowUp, null); assert.equal(back.holdResponsibility, null);
  // an internal wait stops the work timer only — the client's clock keeps running
  const ok2 = await hold({ reasonCode: 'INTERNAL_REVIEW', responsibility: 'reviewer', followUpDate: day(1) });
  assert.deepEqual(ok2.j.task.holdHistory.at(-1).clocksStopped, { workTimer: true, clientCommitment: false });
  assert.equal((await hold({ reasonCode: 'CLIENT_DOCS' }, PK)).status, 400, 'already on hold');
});

test('old callers of /hold (no responsibility, no follow-up) still work exactly as before', async () => {
  const t = (await create(PK, { kind: 'client', clientId: client.id })).j.task;
  await http('POST', T(t.id) + '/accept', { token: RJ });
  const r = await http('POST', T(t.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_QUERY', detail: 'asked' } });
  assert.equal(r.status, 200); assert.equal(r.j.task.holdResponsibility, 'client'); assert.equal(r.j.task.holdFollowUp, null);
});

test('waive_review as a manager action: reason required, client tasks only, audited', async () => {
  const t = (await create(PK, { taskKind: 'client', clientId: client.id })).j.task;
  const go = body => http('POST', T(t.id) + '/manager-change', { token: PK, body });
  assert.equal((await go({ action: 'waive_review' })).status, 400);
  assert.equal((await go({ action: 'waive_review', reason: 'ok' })).status, 400);
  const r = await go({ action: 'waive_review', reason: 'Founder already reviewed it offline' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.task.reviewRequired, false); assert.equal(r.j.task.managerActions.at(-1).action, 'waive_review');
  const admin = (await create(PK, { taskKind: 'admin', name: 'x admin', clientDate: undefined })).j.task;
  assert.equal((await http('POST', T(admin.id) + '/manager-change', { token: PK, body: { action: 'waive_review', reason: 'not needed here' } })).status, 400);
});
