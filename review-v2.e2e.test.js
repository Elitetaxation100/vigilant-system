// The simple review screen's engine, end to end on a REAL server (throwaway data): Approve / Return for Correction / Escalate,
// the reviewer's attachments reaching the employee (and staying), productivity credit, double-click safety and permissions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj\n<<>>\nendobj\n%%EOF\n')]);
const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-rvv2-'));
let child;
const enc = encodeURIComponent;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const upload = (token, name, buf) => fetch(base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'X-File-Name': enc(name) }, body: buf }).then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));
const download = (token, id) => fetch(base + '/api/files/' + id, { headers: { Authorization: 'Bearer ' + token } });
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SH, PK, RJ, DI, OUT, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const clientDate = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
const later = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
const mine = async (tok, id) => (await http('GET', '/api/tasks', { token: tok })).j.tasks.find(t => t.id === id);
const today = async tok => (await http('GET', '/api/workflow/today', { token: tok })).j;
const notes = async tok => JSON.stringify((await http('GET', '/api/notifications', { token: tok })).j);
const decide = (tid, body, tok) => http('POST', `/api/tasks/${enc(tid)}/review-decision`, { token: tok || PK, body });
let rid = 0; const R = () => 'req-' + Date.now() + '-' + (++rid);
async function submitted(name, links = true) {
  const t = (await http('POST', '/api/tasks', { token: SH, body: { mode: 'team', name, clientId: client.id, assignedTo: emp('ranjit').id, tat: 2, internalDeadline: due, clientDate } })).j.task;
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: RJ })).status, 200);
  const body = { reviewerId: emp('parvinder').id, ...(links ? { sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } : {}) };
  const c = await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  return t;
}
const credited = async (id) => {
  const r = (await http('GET', '/api/productivity', { token: SH })).j;
  const p = (r.people || []).find(x => x.id === emp('ranjit').id) || {};
  const prod = p.productivity || p;
  return ((prod.qualifiedTasks) || []).filter(q => q.id === id).reduce((s, q) => s + q.creditedHours, 0);
};

test('setup', async () => {
  SH = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  PK = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SH })).j.employees;
  client = (await http('POST', '/api/clients', { token: SH, body: { name: 'Review V2 Ltd', email: 'rv' + Date.now() + '@t.co' } })).j.client;
  for (const e of E.filter(x => x.accessRole === 'employee' && x.team !== emp('ranjit').team && x.team !== emp('parvinder').team)) {
    const first = e.email.split('@')[0]; const r = await http('POST', '/api/auth/login', { body: { email: e.email, password: first[0].toUpperCase() + first.slice(1) + '@2026', expectedTab: 'employee' } });
    if (r.j && r.j.token) { OUT = r.j.token; break; }
  }
  assert.ok(OUT, 'an unrelated employee');
});

test('APPROVE: reviewed clean, ready to send — NOT marked sent — and the allocated hours are credited to Productivity', async () => {
  const t = await submitted('Approve me');
  const before = await mine(RJ, t.id);
  assert.equal(await credited(t.id), 0, 'not credited while it is only in review');
  const r = await decide(t.id, { decision: 'approve', clean: true, profitRequired: false, note: 'All reconciled.', requestId: R() });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const a = r.j.task;
  assert.equal(a.reviewStatus, 'clean'); assert.equal(a.reviewedBy, emp('parvinder').id); assert.ok(a.reviewedAt);
  assert.equal(a.completedAt, before.completedAt, "the employee's original submission time is preserved");
  assert.ok(a.sentToClient === null || a.sentToClient === undefined, 'approval never marks the report as sent');
  assert.equal(a.awaitingClientDecision, true); assert.equal(a.reportSendOwner, emp('ranjit').id, 'ready to send, owned by the report sender');
  assert.equal(a.reviewEvents.length, 1); assert.equal(a.reviewEvents[0].type, 'approved'); assert.equal(a.reviewEvents[0].note, 'All reconciled.');
  const c = (await today(PK)).cards[t.id];
  assert.equal(c.status, 'Approved'); assert.equal(c.waitingOn.label, 'Ready to send'); assert.equal(c.tracker.steps.find(s => s.key === 'ready').state, 'current');
  assert.equal(await credited(t.id), 2, 'reviewed clean → the full frozen allocated hours qualify');
  // sending the report later changes nothing about Productivity
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/send-to-client`, { token: RJ, body: { decision: 'yes' } })).status, 200);
  assert.equal(await credited(t.id), 2, 'Report Sent is separate from Productivity');
});

test('APPROVE with profit confirmation: it goes to Shubam; without a Sheet / Cashbook / file it is refused and nothing changes', async () => {
  const bare = await submitted('No links', false);
  const refused = await decide(bare.id, { decision: 'approve', profitRequired: true, requestId: R() });
  assert.equal(refused.status, 400); assert.match(refused.j.error, /Sheet or Cashbook/);
  assert.equal((await mine(PK, bare.id)).reviewStatus, null, 'a refused decision changes nothing');
  const t = await submitted('Profit please');
  const ok = await decide(t.id, { decision: 'approve', profitRequired: true, note: 'Check margin', requestId: R() });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.task.profitConfirmStatus, 'pending'); assert.equal(ok.j.task.reviewEvents[0].profitRequired, true);
  assert.match(await notes(SH), /sent .{0,3}Profit please.{0,3} for profit confirmation/);
  const c = (await today(PK)).cards[t.id];
  assert.equal(c.waitingOn.kind, 'profit'); assert.ok(c.tracker.steps.some(s => s.key === 'profit' && s.state === 'current'), 'profit confirmation is its own milestone before Ready');
});

test('RETURN FOR CORRECTION: every field is required, a bad attempt changes nothing, and a good one reaches the employee with the reviewer\'s PDF', async () => {
  const t = await submitted('Return me');
  const bad = body => decide(t.id, { decision: 'return', requestId: R(), ...body });
  const ok0 = { category: 'Calculation error', responsibility: 'Employee', note: 'GST total is out by $412.', dueDate: later };
  assert.equal((await bad({ ...ok0, category: 'Nonsense' })).status, 400);
  assert.equal((await bad({ ...ok0, responsibility: 'Nobody' })).status, 400);
  assert.equal((await bad({ ...ok0, note: 'x' })).status, 400, 'a correction note is required');
  assert.equal((await bad({ ...ok0, dueDate: '2020-01-01' })).status, 400, 'a due date in the past');
  assert.equal((await bad({ ...ok0, dueDate: undefined })).status, 400, 'a due date is required');
  const theirs = (await upload(DI, 'not-yours.pdf', pdf)).j.file;
  assert.equal((await bad({ ...ok0, attachments: [theirs.id] })).status, 400, "someone else's upload");
  assert.equal((await mine(PK, t.id)).reviewStatus, null, 'none of the refused attempts changed the task');
  const f = (await upload(PK, 'Corrections list.pdf', pdf)).j.file;
  const before = await mine(RJ, t.id);
  const r = await bad({ ...ok0, attachments: [f.id] });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const x = r.j.task;
  assert.equal(x.status, 'awaiting_acceptance'); assert.equal(x.reviewStatus, 'error'); assert.equal(x.reworkCount, 1);
  assert.deepEqual(x.correction, { category: 'Calculation error', responsibility: 'Employee', dueDate: later, eventId: 'rv-1', cycle: 1 });
  assert.equal(x.faultType, 'processor'); assert.equal(x.completedAt, before.completedAt, 'original submission time preserved');
  const att = x.reviewAttachments[0];
  assert.equal(att.name, 'Corrections list.pdf'); assert.equal(att.mime, 'application/pdf'); assert.equal(att.size, pdf.length);
  assert.equal(att.eventId, 'rv-1'); assert.equal(att.uploaderId, emp('parvinder').id); assert.equal(att.uploaderRole, 'superadmin'); assert.equal(att.stage, 'review_return'); assert.ok(att.uploadedAt);
  // the employee sees the note, the files, and was notified
  const seen = await mine(RJ, t.id);
  assert.equal(seen.reviewNote, 'GST total is out by $412.'); assert.equal(seen.reviewAttachments.length, 1);
  assert.match(await notes(RJ), /needs a correction: Calculation error — due /);
  assert.deepEqual(Buffer.from(await (await download(RJ, att.id)).arrayBuffer()), pdf, 'the employee downloads the exact file');
  assert.equal((await download(OUT, att.id)).status, 403, 'an unrelated employee cannot');
  // the employee cannot delete or replace the reviewer's file
  assert.ok([404, 405].includes((await http('DELETE', `/api/files/${att.id}`, { token: RJ })).status), 'there is no way to delete a file');
  const mine2 = await upload(RJ, 'mine.pdf', pdf);
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/review-files`, { token: RJ, body: { attachments: [mine2.j.file.id] } })).status, 403, 'the employee cannot add to the reviewer\'s files either');
  assert.equal((await mine(PK, t.id)).reviewAttachments.length, 1);
  // the derived picture: a correction owned by the employee — never "not started", not mine
  const td = await today(PK), c = td.cards[t.id];
  assert.equal(c.status, 'Correction Required'); assert.equal(c.subState, 'Waiting for your correction'); assert.equal(c.waitingOn.kind, 'employee');
  assert.deepEqual(c.correction, { category: 'Calculation error', responsibility: 'Employee', dueDate: later });
  assert.ok(!td.sections.needs.some(n => n.id === t.id));
  global.__ret = { t, f };
});

test('RESUBMIT: it returns to the SAME reviewer, and the earlier note and file are still there for the next review', async () => {
  const { t, f } = global.__ret;
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: RJ })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/resubmit`, { token: RJ })).status, 200);
  const td = await today(PK);
  assert.ok(td.sections.needs.some(n => n.id === t.id && n.type === 'correction_resubmitted'), 'back in Parvinder\'s queue as a resubmission');
  assert.ok(td.review.resubmitted.includes(t.id) || td.review.urgent.includes(t.id));
  const after = await mine(PK, t.id);
  assert.equal(after.reviewerId, emp('parvinder').id, 'the reviewer is unchanged');
  assert.equal(after.reviewAttachments.length, 1, 'the earlier file survives the resubmission');
  assert.equal((await download(PK, f.id)).status, 200, 'and the reviewer opens the same file at the next review');
  assert.equal(after.reviewEvents[0].note, 'GST total is out by $412.', 'the earlier note is preserved in the ledger');
  assert.equal(after.reworkHistory[0].attachments.length, 1, "round 1's files are recorded with round 1");
  // a SECOND return adds new files — it never replaces or removes the first
  const g = (await upload(PK, 'Second list.pdf', pdf)).j.file;
  const r2 = await decide(t.id, { decision: 'return', category: 'Missing supporting document', responsibility: 'Shared responsibility', note: 'Bank statement missing.', dueDate: later, attachments: [g.id], requestId: R() });
  assert.equal(r2.status, 200, JSON.stringify(r2.j));
  assert.deepEqual(r2.j.task.reviewAttachments.map(a => a.name + '#' + a.cycle), ['Corrections list.pdf#1', 'Second list.pdf#2']);
  assert.equal(r2.j.task.reworkCount, 2); assert.equal(r2.j.task.faultType, 'other', 'shared responsibility is not charged to the processor');
  assert.equal(r2.j.task.reviewEvents.length, 2);
});

test('DOUBLE-CLICK: the same decision twice records ONE event; a second decision on a decided task is refused', async () => {
  const t = await submitted('Double click');
  const body = { decision: 'return', category: 'Other', responsibility: 'Employee', note: 'Please fix the totals.', dueDate: later, requestId: 'same-click-1' };
  const [a, b] = await Promise.all([decide(t.id, body), decide(t.id, body)]);
  assert.deepEqual([a.status, b.status], [200, 200], 'both answers are fine');
  const x = await mine(PK, t.id);
  assert.equal(x.reviewEvents.length, 1, 'exactly one event'); assert.equal(x.reworkCount, 1, 'the rework cycle moved by one, not two');
  assert.ok(a.j.duplicate || b.j.duplicate, 'the repeat is reported as a duplicate');
  const approve = await decide(t.id, { decision: 'approve', requestId: R() });
  assert.equal(approve.status, 400, 'it is not awaiting review any more');
  const t2 = await submitted('Approve twice');
  assert.equal((await decide(t2.id, { decision: 'approve', requestId: 'one' })).status, 200);
  const again = await decide(t2.id, { decision: 'approve', requestId: 'one' });
  assert.equal(again.status, 200); assert.equal(again.j.duplicate, true);
  assert.equal((await mine(PK, t2.id)).reviewEvents.length, 1);
  assert.equal((await decide(t2.id, { decision: 'approve', requestId: 'two' })).status, 409, 'a different click on a decided task is refused');
});

test('ESCALATE: waits on the manager, the reviewer stays the reviewer, the decision comes back to the reviewer', async () => {
  const t = await submitted('Escalate me');
  const e0 = { decision: 'escalate', reason: 'Client wants a fee waiver — not my call.', assignTo: emp('shubham').id, decisionDate: later };
  assert.equal((await decide(t.id, { ...e0, reason: '' })).status, 400, 'a reason is required');
  assert.equal((await decide(t.id, { ...e0, assignTo: emp('ranjit').id })).status, 400, 'only a manager or founder can be asked to decide');
  assert.equal((await decide(t.id, { ...e0, assignTo: emp('parvinder').id })).status, 400, 'not yourself');
  assert.equal((await decide(t.id, { ...e0, decisionDate: '2020-01-01' })).status, 400, 'a decision date in the past');
  assert.equal((await mine(PK, t.id)).escalation, undefined, 'nothing changed');
  const f = (await upload(PK, 'Fee email.pdf', pdf)).j.file;
  const r = await decide(t.id, { ...e0, note: 'See attached', attachments: [f.id], requestId: R() });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.task.reviewerId, emp('parvinder').id, 'Parvinder stays the reviewer'); assert.equal(r.j.task.reviewStatus, null);
  assert.match(await notes(SH), /escalated .{0,3}Escalate me.{0,3} to you/);
  assert.equal((await download(SH, f.id)).status, 200, 'the person it was escalated to can open the file');
  const mineToday = await today(PK), c = mineToday.cards[t.id];
  assert.equal(c.status, 'In Review'); assert.equal(c.waitingOn.kind, 'founder'); assert.equal(c.waitingOn.label, 'Waiting on founder'); assert.equal(c.waitingOn.ownerId, emp('shubham').id); assert.equal(c.escalation.decisionDate, later);
  assert.ok(!mineToday.sections.needs.some(n => n.id === t.id), 'while escalated it is not in my action list');
  assert.ok(mineToday.sections.completed.some(d => d.id === t.id && /Escalated to/.test(d.action)));
  assert.ok((await today(SH)).sections.needs.some(n => n.id === t.id && n.type === 'escalation'), 'it IS in the decision-maker\'s');
  assert.equal((await decide(t.id, { decision: 'approve', requestId: R() })).status, 409, 'no review decision while it is escalated');
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/escalation/resolve`, { token: DI, body: { decision: 'Waive it.' } })).status, 403, 'only the person asked');
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/escalation/resolve`, { token: SH, body: { decision: '' } })).status, 400);
  const done = await http('POST', `/api/tasks/${enc(t.id)}/escalation/resolve`, { token: SH, body: { decision: 'Waive the fee, approve the work.', requestId: 'res-1' } });
  assert.equal(done.status, 200, JSON.stringify(done.j));
  assert.equal(done.j.task.escalation.status, 'resolved'); assert.deepEqual(done.j.task.reviewEvents.map(e => e.type), ['escalated', 'escalation_resolved']);
  assert.match(await notes(PK), /made a decision on .{0,3}Escalate me.{0,3}: Waive the fee/);
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/escalation/resolve`, { token: SH, body: { decision: 'Waive the fee, approve the work.', requestId: 'res-1' } })).j.duplicate, true, 'resolving twice is safe too');
  assert.ok((await today(PK)).sections.needs.some(n => n.id === t.id && n.type === 'review'), 'it is back in my review queue');
  assert.equal((await decide(t.id, { decision: 'approve', requestId: R() })).status, 200, 'and I can now decide');
});

test('PERMISSIONS: only the reviewer (or a manager over the employee) decides; nobody else, and the employee never reviews their own work', async () => {
  const t = await submitted('Perms');
  assert.equal((await decide(t.id, { decision: 'approve' }, RJ)).status, 403, 'the employee');
  assert.equal((await decide(t.id, { decision: 'approve' }, OUT)).status, 403, 'an unrelated employee');
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/review-decision`, { body: { decision: 'approve' } })).status, 401, 'signed out');
  assert.equal((await decide(t.id, { decision: 'maybe' })).status, 400);
  assert.equal((await decide('#does-not-exist', { decision: 'approve' })).status, 404);
  assert.equal((await mine(PK, t.id)).reviewStatus, null, 'nothing was recorded by any of these');
});

test('the Reviews queue has its five sections, each task once, with counts that match', async () => {
  const urgentT = await submitted('Queue — new');
  const td = await today(PK);
  const all = Object.values(td.review).flat();
  assert.equal(new Set(all).size, all.length, 'a task is in ONE section');
  assert.deepEqual(Object.keys(td.review).sort(), ['completed', 'fresh', 'resubmitted', 'urgent', 'waitingEmployee']);
  assert.equal(td.reviewCounts.newSubmissions, td.review.fresh.length); assert.equal(td.reviewCounts.urgent, td.review.urgent.length);
  assert.equal(td.reviewCounts.completedToday, td.review.completed.length);
  assert.ok(all.includes(urgentT.id));
  Object.values(td.review).flat().forEach(id => assert.ok(td.cards[id], 'every queue id has its card'));
  const c = td.cards[urgentT.id];
  assert.ok(c.reviewWaiting && c.hasSheet && c.hasCashbook && 'attachmentCount' in c && 'reworkCount' in c, 'the card carries what the queue shows');
});
