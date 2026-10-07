// Reviewer → employee file hand-off, proved end to end through the new review decision (Return for Correction).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const port = 3100 + Math.floor(Math.random() * 800), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-handoff-'));
let child;
const enc = encodeURIComponent;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j };
}
const upload = (token, name, buf) => fetch(base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'X-File-Name': enc(name) }, body: buf }).then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));
const download = (token, id) => fetch(base + '/api/files/' + id, { headers: { Authorization: 'Bearer ' + token } });
const login = async (e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

// real-looking bytes for each allowed type (magic numbers the validator checks)
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj<<>>endobj\n%%EOF')]);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF fake body')]);
const zipLike = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('office document body')]);   // .docx / .xlsx
const csv = Buffer.from('date,amount\n2026-10-01,12.50\n');
const FILES = [['Working paper.pdf', pdf, 'application/pdf'], ['Notes.docx', zipLike, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['Workbook.xlsx', zipLike, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['Data.csv', csv, 'text/csv'], ['Screenshot.png', png, 'image/png'], ['Photo.jpeg', jpg, 'image/jpeg']];

let SA, PA, RJ, HU, E, task;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const q = id => encodeURIComponent(id);
const myTask = async tok => (await http('GET', '/api/tasks', { token: tok })).j.tasks.find(t => t.id === task.id);

test('setup: Ranjit submits a task to Parvinder', async () => {
  SA = await login('shubham', 'Shubham@2026', 'admin'); PA = await login('parvinder', 'Parvinder@2026', 'admin'); RJ = await login('ranjit', 'Ranjit@2026', 'employee'); HU = await login('hunny', 'Hunny@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  const clientId = (await http('POST', '/api/clients', { token: SA, body: { name: 'HO Ltd', email: 'ho@t.co' } })).j.client.id;
  const t = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name: 'Handoff job', taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: '2026-12-30', reviewerId: emp('parvinder').id } });
  task = t.j.task;
  assert.equal((await http('POST', `/api/tasks/${q(task.id)}/accept`, { token: RJ })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${q(task.id)}/complete`, { token: RJ, body: { sheetLink: 'https://docs.google.com/spreadsheets/d/x' } })).status, 200);
});
test('unsafe types are blocked, names are cleaned, and a file nobody has attached is private to its uploader', async () => {
  for (const bad of ['run.exe', 'page.html', 'image.svg', 'script.js', 'archive.zip']) assert.equal((await upload(PA, bad, Buffer.from('MZ....'))).status, 400, bad);
  const r = await upload(PA, '../../etc/pa"ss<w>d?.pdf', pdf);
  assert.equal(r.status, 201, JSON.stringify(r.j)); assert.ok(!/[\\/"<>?]/.test(r.j.file.name), 'no folders or markup in the stored name: ' + r.j.file.name);
  assert.equal((await download(RJ, r.j.file.id)).status, 403);
});
let uploaded;
test('Return for Correction with one file of every allowed type: the employee is told and sees the note and every file', async () => {
  uploaded = [];
  for (const [name, buf, mime] of FILES) { const u = await upload(PA, name, buf); assert.equal(u.status, 201, name + ' ' + JSON.stringify(u.j)); assert.equal(u.j.file.mime, mime, name + ' is served with OUR content type'); uploaded.push(u.j.file); }
  // five per review: the sixth type goes in a second review round; first the allowed five
  const first = uploaded.slice(0, 5);
  const r = await http('POST', `/api/tasks/${q(task.id)}/review-decision`, { token: PA, body: { decision: 'return', requestId: 'h1', category: 'Missing supporting document', responsibility: 'Employee', dueDate: '2026-12-30', note: 'Please redo the GST workings', attachments: first.map(f => f.id) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const mine = await myTask(RJ);
  assert.equal(mine.reviewNote, 'Please redo the GST workings'); assert.equal(mine.status, 'awaiting_acceptance');
  assert.deepEqual(mine.reviewAttachments.map(a => a.name), first.map(f => f.name));
  const notes = (await http('GET', '/api/notifications', { token: RJ })).j.notifications;
  assert.ok(notes.some(n => n.taskId === task.id && /5 files attached/.test(n.text) && /Please redo the GST workings/.test(n.text)), 'the employee is notified with the note and the file count');
  for (const [i, f] of first.entries()) {
    const d = await download(RJ, f.id);
    assert.equal(d.status, 200, f.name); assert.equal(d.headers.get('content-type'), FILES[i][2]); assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await d.arrayBuffer()), FILES[i][1], f.name + ' byte for byte');
  }
});
test('every file records who, in what role, for which task and review event, its name, type, size and time', async () => {
  const mine = await myTask(RJ);
  for (const a of mine.reviewAttachments) {
    assert.equal(a.uploaderId, emp('parvinder').id); assert.ok(a.uploaderRole); assert.ok(a.eventId, 'review event'); assert.ok(a.uploadedAt);
    assert.ok(a.name && a.mime && a.size > 0); assert.equal(a.stage, 'review_return'); assert.equal(a.cycle, 1);
  }
  assert.ok((mine.reviewEvents || []).some(e => e.id === mine.reviewAttachments[0].eventId && e.type === 'returned'));
});
test('permissions: the task\'s people can open the files, an unrelated employee cannot, and nobody can delete the reviewer\'s file', async () => {
  const f = (await myTask(RJ)).reviewAttachments[0];
  assert.equal((await download(HU, f.id)).status, 403, 'an unrelated employee');
  for (const tok of [RJ, PA, SA]) for (const m of ['DELETE', 'PUT', 'PATCH']) {
    const r = await fetch(base + '/api/files/' + f.id, { method: m, headers: { Authorization: 'Bearer ' + tok } });
    assert.ok(r.status === 404 || r.status === 405, m + ' is not offered (' + r.status + ')');
  }
  assert.equal((await download(RJ, f.id)).status, 200, 'still there');
  const r2 = await http('POST', `/api/tasks/${q(task.id)}/review-decision`, { token: RJ, body: { decision: 'return', requestId: 'x', category: 'Other', responsibility: 'Employee', dueDate: '2026-12-30', note: 'nope' } });
  assert.ok([400, 403, 409].includes(r2.status), 'the employee cannot review their own work');
});
test('the employee corrects and resubmits: the files are still there; the reviewer sees them next cycle, with the new round added', async () => {
  assert.equal((await http('POST', `/api/tasks/${q(task.id)}/accept`, { token: RJ })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${q(task.id)}/resubmit`, { token: RJ })).status, 200);
  const after = await myTask(PA);
  assert.deepEqual(after.reviewAttachments.map(a => a.name), uploaded.slice(0, 5).map(f => f.name), 'nothing was removed by the resubmission');
  const r = await http('POST', `/api/tasks/${q(task.id)}/review-decision`, { token: PA, body: { decision: 'return', requestId: 'h2', category: 'Other', responsibility: 'Employee', dueDate: '2026-12-30', note: 'One more thing', attachments: [uploaded[5].id] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const t2 = await myTask(RJ);
  assert.equal(t2.reviewAttachments.length, 6); assert.equal(t2.reviewAttachments[5].cycle, 2, 'the new file is tagged with the second round');
  assert.equal(t2.reviewAttachments.filter(a => a.cycle === 1).length, 5, 'round one is kept as it was');
});
test('the UI offers Preview for PDFs and images and Download for the rest', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes("previewAttachment('${esc(a.id)}'") && html.includes('application\\/pdf|image\\/'), 'Preview is offered for PDF and image types');
  assert.match(html, /function previewAttachment\(/); assert.match(html, /function downloadAttachment\(/);
});
