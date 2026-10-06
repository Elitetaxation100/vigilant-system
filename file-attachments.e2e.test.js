// File attachments on a rework (PDF, images, Excel…), the employee-side download, who may see them,
// and the move of inline screenshots out of the state into the file store. Real server, throwaway data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('./files');

/* ---------------- the pure rules ---------------- */
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj\n<<>>\nendobj\n%%EOF\n')]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

test('validate: the allowed kinds pass, with the content type we choose', () => {
  assert.deepEqual(files.validate('Review notes.pdf', pdf), { ok: true, name: 'Review notes.pdf', ext: 'pdf', mime: 'application/pdf', size: pdf.length });
  assert.equal(files.validate('shot.PNG', png).mime, 'image/png');
  assert.equal(files.validate('books.xlsx', xlsx).mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(files.validate('list.csv', Buffer.from('a,b\n1,2\n')).ok, true);
});
test('validate: the wrong kind, a fake file, an empty file and a huge file are refused', () => {
  for (const bad of ['run.exe', 'page.html', 'pic.svg', 'script.js', 'noextension', 'archive.zip']) {
    assert.equal(files.validate(bad, pdf).ok, false, bad + ' should be refused');
  }
  assert.match(files.validate('fake.pdf', Buffer.from('<html>not a pdf</html>')).error, /real \.pdf/);
  assert.match(files.validate('fake.png', pdf).error, /real \.png/);
  assert.match(files.validate('bin.txt', Buffer.from([65, 0, 66])).error, /real \.txt/);
  assert.match(files.validate('a.pdf', Buffer.alloc(0)).error, /empty/);
  assert.match(files.validate('big.pdf', Buffer.concat([pdf, Buffer.alloc(files.MAX_BYTES)])).error, /too large/);
});
test('names are cleaned: no folders, no control characters', () => {
  assert.equal(files.cleanName('C:\\Users\\x\\..\\secret.pdf'), 'secret.pdf');
  assert.equal(files.cleanName('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(files.cleanName('a"b<c>.pdf'), 'abc.pdf');
  assert.ok(files.cleanName('x'.repeat(500) + '.pdf').length <= 120);
});
test('dataUrlToBuffer: only inline images', () => {
  const ok = files.dataUrlToBuffer('data:image/png;base64,' + png.toString('base64'));
  assert.equal(ok.mime, 'image/png'); assert.deepEqual(ok.buf, png);
  assert.equal(files.dataUrlToBuffer('data:text/html;base64,PGI+'), null);
  assert.equal(files.dataUrlToBuffer('hello'), null);
});

/* ---------------- the real server ---------------- */
const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-files-'));
let child;
const enc = encodeURIComponent;

async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const upload = (token, name, buf) => fetch(base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'X-File-Name': enc(name) }, body: buf })
  .then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));
const download = (token, id) => fetch(base + '/api/files/' + id, { headers: { Authorization: 'Bearer ' + token } });
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;
async function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test', FILES_MOVE_INTERVAL_MS: '400' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
}
test.after(async () => {
  if (child) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

let SA, RJ, DI, E, OUT, task;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const wait = ms => new Promise(r => setTimeout(r, ms));

test('setup: a task sent to Disha for review', async () => {
  await start();
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  // someone with no connection to this task at all: an employee on another team
  const ranjitTeam = emp('ranjit').team, dishaTeam = emp('disha').team;
  for (const e of E.filter(x => x.accessRole === 'employee' && x.team !== ranjitTeam && x.team !== dishaTeam && x.id !== emp('ranjit').id)) {
    const first = e.email.split('@')[0]; const pw = first[0].toUpperCase() + first.slice(1) + '@2026';
    const r = await http('POST', '/api/auth/login', { body: { email: e.email, password: pw, expectedTab: 'employee' } });
    if (r.j && r.j.token) { OUT = r.j.token; break; }
  }
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Attach Ltd', email: 'at' + Date.now() + '@t.co' } })).j.client;
  const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const clientDate = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const c = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Attach task', clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: due, clientDate } });
  assert.equal(c.status, 201, JSON.stringify(c.j));
  task = c.j.task;
  assert.equal((await http('POST', `/api/tasks/${enc(task.id)}/accept`, { token: RJ })).status, 200);
  const done = await http('POST', `/api/tasks/${enc(task.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } });
  assert.equal(done.status, 200, JSON.stringify(done.j));
});

test('upload: a PDF is accepted; wrong kinds and fake files are refused; nobody sees it before it is attached', async () => {
  const ok = await upload(DI, 'Review notes.pdf', pdf);
  assert.equal(ok.status, 201, JSON.stringify(ok.j));
  assert.match(ok.j.file.id, /^f_[0-9a-f]{24}$/); assert.equal(ok.j.file.name, 'Review notes.pdf'); assert.equal(ok.j.file.mime, 'application/pdf');
  assert.equal((await upload(DI, 'virus.exe', pdf)).status, 400);
  assert.equal((await upload(DI, 'fake.pdf', Buffer.from('<script>alert(1)</script>'))).status, 400);
  assert.equal((await upload(DI, 'page.html', Buffer.from('<html>'))).status, 400);
  assert.equal((await upload(undefined, 'a.pdf', pdf)).status, 401);
  // private to the uploader until it is attached
  assert.equal((await download(RJ, ok.j.file.id)).status, 403, 'the assignee cannot see an unattached file');
  assert.equal((await download(DI, ok.j.file.id)).status, 200, 'the uploader can');
});

test('review with files: the employee sees them on the task and can download the exact bytes', async () => {
  const a = (await upload(DI, 'Review notes.pdf', pdf)).j.file;
  const b = (await upload(DI, 'Screenshot of error.png', png)).j.file;
  const r = await http('POST', `/api/tasks/${enc(task.id)}/review`, { token: DI, body: { status: 'error', note: 'GST does not reconcile', faultType: 'processor', attachments: [a.id, b.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const mine = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(t => t.id === task.id);
  assert.deepEqual((mine.reviewAttachments || []).map(x => x.name), ['Review notes.pdf', 'Screenshot of error.png']);
  assert.equal(mine.status, 'awaiting_acceptance');
  const d = await download(RJ, a.id);
  assert.equal(d.status, 200);
  assert.equal(d.headers.get('content-type'), 'application/pdf');
  assert.match(d.headers.get('content-disposition'), /^attachment; filename="Review notes\.pdf"/);
  assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await d.arrayBuffer()), pdf, 'byte for byte');
  assert.deepEqual(Buffer.from(await (await download(RJ, b.id)).arrayBuffer()), png);
});

test('who may download: the task\'s people and managers — nobody else', async () => {
  const id = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(t => t.id === task.id).reviewAttachments[0].id;
  assert.equal((await download(DI, id)).status, 200, 'the reviewer');
  assert.equal((await download(SA, id)).status, 200, 'a superadmin');
  assert.ok(OUT, 'an unrelated employee could be logged in for this check');
  assert.equal((await download(OUT, id)).status, 403, 'an unrelated employee');
  assert.equal((await download(RJ, 'f_000000000000000000000000')).status, 404, 'unknown id');
  assert.equal((await download(RJ, '..%2F..%2Fdb.json')).status, 404, 'not a real id');
  assert.equal((await fetch(base + '/api/files/' + id)).status, 401, 'not signed in');
});

test('review rules: only your own uploads, at most five, and only on a rework', async () => {
  // a second task to review
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Attach Two', email: 'a2' + Date.now() + '@t.co' } })).j.client;
  const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const clientDate = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const t2 = (await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Attach task 2', clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: due, clientDate } })).j.task;
  await http('POST', `/api/tasks/${enc(t2.id)}/accept`, { token: RJ });
  await http('POST', `/api/tasks/${enc(t2.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } });
  const theirs = (await upload(RJ, 'mine.pdf', pdf)).j.file;
  const body = ids => ({ status: 'error', note: 'x', faultType: 'processor', attachments: ids });
  assert.equal((await http('POST', `/api/tasks/${enc(t2.id)}/review`, { token: DI, body: body([theirs.id]) })).status, 400, "someone else's upload");
  assert.equal((await http('POST', `/api/tasks/${enc(t2.id)}/review`, { token: DI, body: body(['f_ffffffffffffffffffffffff']) })).status, 400, 'a file that does not exist');
  const six = []; for (let i = 0; i < 6; i++) six.push((await upload(DI, `f${i}.pdf`, pdf)).j.file.id);
  assert.equal((await http('POST', `/api/tasks/${enc(t2.id)}/review`, { token: DI, body: body(six) })).status, 400, 'more than five');
  // a failed attempt changed nothing about the task
  assert.equal((await http('GET', '/api/tasks', { token: SA })).j.tasks.find(t => t.id === t2.id).status, 'completed');
  // a clean review ignores attachments
  const one = (await upload(DI, 'clean.pdf', pdf)).j.file.id;
  const clean = await http('POST', `/api/tasks/${enc(t2.id)}/review`, { token: DI, body: { status: 'clean', attachments: [one] } });
  assert.equal(clean.status, 200);
  assert.deepEqual(clean.j.task.reviewAttachments, []);
});

test('rework history keeps the files of each round', async () => {
  assert.equal((await http('POST', `/api/tasks/${enc(task.id)}/accept`, { token: RJ })).status, 200);
  const r = await http('POST', `/api/tasks/${enc(task.id)}/resubmit`, { token: RJ });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const t = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(x => x.id === task.id);
  assert.equal(t.reworkHistory[0].attachments.length, 2);
});

test('screenshots move out of the state into the file store and still display', async () => {
  const client = (await http('POST', '/api/clients', { token: SA, body: { name: 'Shots Ltd', email: 'sh' + Date.now() + '@t.co' } })).j.client;
  const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const clientDate = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  const t3 = (await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name: 'Shot task', clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: due, clientDate } })).j.task;
  await http('POST', `/api/tasks/${enc(t3.id)}/accept`, { token: RJ });
  const filesBefore = (await http('GET', '/api/admin/storage-health', { token: SA })).j.files.files;
  const shot = 'data:image/png;base64,' + png.toString('base64');
  const h = await http('POST', `/api/tasks/${enc(t3.id)}/hold`, { token: RJ, body: { reasonCode: 'INTERNAL_REVIEW', screenshot: shot } });
  assert.equal(h.status, 200, JSON.stringify(h.j));
  assert.equal(h.j.task.hasHoldScreenshot, true);
  // a mark with a snip
  const m = await http('POST', '/api/marks', { token: SA, body: { toId: emp('ranjit').id, points: -1, reason: 'with a snip', screenshot: shot } });
  assert.equal(m.status, 201, JSON.stringify(m.j));
  let moved = false;
  for (let i = 0; i < 40 && !moved; i++) {
    await wait(300);
    const st = (await http('GET', '/api/admin/storage-health', { token: SA })).j;
    moved = st.files && st.files.files >= filesBefore + 2; // the hold's image and the mark's snip
  }
  assert.ok(moved, 'the images were moved into the file store');
  // nothing inline is left in the state file
  assert.ok(!fs.readFileSync(path.join(dir, 'db.json'), 'utf8').includes('base64,'), 'no base64 images left in the state');
  // and they still display, through the same endpoints, to the same people
  const got = await http('GET', `/api/tasks/${enc(t3.id)}/hold-screenshot`, { token: RJ });
  assert.equal(got.status, 200); assert.equal(got.j.screenshot, shot);
  const mk = await http('GET', `/api/marks/${enc(m.j.mark.id)}/screenshot`, { token: SA });
  assert.equal(mk.status, 200); assert.equal(mk.j.screenshot, shot);
  assert.equal((await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(t => t.id === t3.id).hasHoldScreenshot, true);
  // the task list never carries image bytes or internal file ids
  const raw = JSON.stringify((await http('GET', '/api/tasks', { token: RJ })).j);
  assert.ok(!raw.includes('holdScreenshotFile') && !raw.includes('base64,'));
});

test('orphans: a file uploaded but never attached is swept; an attached one is kept', async () => {
  const lone = (await upload(DI, 'lone.pdf', pdf)).j.file.id;
  files.init({ _mode: () => 'file', _dataDir: () => dir });
  assert.ok(await files.meta(lone), 'on disk');
  assert.equal(await files.sweepOrphans(24 * 3600 * 1000), 0, 'too new to sweep');
  assert.ok(await files.sweepOrphans(-1000) >= 1, 'swept once old enough');
  assert.equal(await files.meta(lone), null);
  const kept = (await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(t => t.id === task.id).reworkHistory[0].attachments[0].id;
  assert.equal((await download(RJ, kept)).status, 200, 'attached files survive');
});
