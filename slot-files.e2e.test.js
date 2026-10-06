// "…or attach a file" next to every Sheet / Cashbook link: a file in a slot counts as that slot being filled (no link penalty),
// the right people can download it (the reviewer, the sender, Shubam for profit confirmation) and nobody else, and only
// files the caller uploaded can be attached. Real server, throwaway data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const am = require('./auto-marks');

const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj\n<<>>\nendobj\n%%EOF\n')]);
const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);

test('missingLinks: a file in a slot counts as that slot filled', () => {
  assert.deepEqual(am.missingLinks({ kind: 'client' }), ['Sheet', 'Cashbook']);
  assert.deepEqual(am.missingLinks({ sheetFiles: [{ id: 'f_1' }] }), ['Cashbook']);
  assert.deepEqual(am.missingLinks({ sheetLink: 'https://x', cashbookFiles: [{ id: 'f_2' }] }), []);
  assert.deepEqual(am.missingLinks({ sheetFiles: [{ id: 'f_1' }], cashbookFiles: [{ id: 'f_2' }] }), []);
});

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-slots-'));
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
async function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
}
test.after(async () => { if (child) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SH, RJ, DI, E, client, OUT;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const marksOf = async tok => (await http('GET', '/api/marks', { token: tok })).j.marks;
const due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const clientDate = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
async function accepted(name) {
  const t = (await http('POST', '/api/tasks', { token: SH, body: { mode: 'team', name, clientId: client.id, assignedTo: emp('ranjit').id, tat: 1, internalDeadline: due, clientDate } })).j.task;
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/accept`, { token: RJ })).status, 200);
  return t;
}
const mine = async (tok, id) => (await http('GET', '/api/tasks', { token: tok })).j.tasks.find(t => t.id === id);

test('setup', async () => {
  await start();
  SH = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  E = (await http('GET', '/api/employees', { token: SH })).j.employees;
  client = (await http('POST', '/api/clients', { token: SH, body: { name: 'Slots Ltd', email: 'sl' + Date.now() + '@t.co' } })).j.client;
  for (const e of E.filter(x => x.accessRole === 'employee' && x.team !== emp('ranjit').team && x.team !== emp('disha').team)) {
    const first = e.email.split('@')[0]; const r = await http('POST', '/api/auth/login', { body: { email: e.email, password: first[0].toUpperCase() + first.slice(1) + '@2026', expectedTab: 'employee' } });
    if (r.j && r.j.token) { OUT = r.j.token; break; }
  }
  assert.ok(OUT, 'an unrelated employee to test against');
  await http('POST', '/api/admin/auto-marks/settings', { token: SH, body: { activeFrom: '2026-01-01' } });
});

test('Mark Complete with FILES instead of links: no link penalty, and the reviewer and the sender can download them', async () => {
  const t = await accepted('Files not links');
  const sheet = (await upload(RJ, 'workings.xlsx', xlsx)).j.file, cash = (await upload(RJ, 'cashbook.pdf', pdf)).j.file;
  const r = await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetFileIds: [sheet.id], cashbookFileIds: [cash.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const task = await mine(DI, t.id);
  assert.deepEqual(task.sheetFiles.map(f => f.name), ['workings.xlsx']); assert.deepEqual(task.cashbookFiles.map(f => f.name), ['cashbook.pdf']);
  assert.ok(!(await marksOf(SH)).some(m => m.type === 'auto_links_processor' && m.taskId === t.id), 'files count — the processor is not penalised');
  assert.deepEqual(Buffer.from(await (await download(DI, sheet.id)).arrayBuffer()), xlsx, 'the reviewer gets the exact bytes');
  assert.equal((await download(RJ, cash.id)).status, 200, 'the processor');
  assert.equal((await download(OUT, sheet.id)).status, 403, 'an unrelated employee cannot');
  global.__t1 = t.id; global.__sheet1 = sheet.id;
});

test('with NEITHER a link nor a file the processor is still penalised (the rule is unchanged)', async () => {
  const t = await accepted('Nothing attached');
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id } })).status, 200);
  assert.ok((await marksOf(SH)).some(m => m.type === 'auto_links_processor' && m.taskId === t.id));
});

test('only the caller\'s own uploads can be attached, at most five, and a bad one changes nothing', async () => {
  const t = await accepted('Rules');
  const theirs = (await upload(DI, 'not-yours.pdf', pdf)).j.file;
  const bad = await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetFileIds: [theirs.id] } });
  assert.equal(bad.status, 400); assert.match(bad.j.error, /no longer available/);
  assert.equal((await mine(RJ, t.id)).status, 'accepted', 'the task was not completed by the failed attempt');
  const six = []; for (let i = 0; i < 6; i++) six.push((await upload(RJ, `f${i}.pdf`, pdf)).j.file.id);
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetFileIds: six } })).status, 400, 'six is too many');
  const ok = (await upload(RJ, 'ok.pdf', pdf)).j.file;
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetFileIds: [ok.id] } })).status, 200, 'and the same task can still be completed properly');
});

test('adding a file later (the links screen), and the same file twice is not duplicated', async () => {
  const id = global.__t1;
  const extra = (await upload(DI, 'reviewer-note.pdf', pdf)).j.file;
  const r = await http('PATCH', `/api/tasks/${enc(id)}/links`, { token: DI, body: { sheetFileIds: [extra.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.task.sheetFiles.map(f => f.name), ['workings.xlsx', 'reviewer-note.pdf']);
  const again = await http('PATCH', `/api/tasks/${enc(id)}/links`, { token: DI, body: { sheetFileIds: [extra.id] } });
  assert.equal(again.j.task.sheetFiles.length, 2, 'not duplicated');
  assert.equal((await download(RJ, extra.id)).status, 200, 'the processor can open a file the reviewer added');
});

test('profit confirmation: a file alone is enough, and Shubam can open it', async () => {
  const t = await accepted('Profit with a file');
  const f = (await upload(RJ, 'profit-workings.xlsx', xlsx)).j.file;
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/complete`, { token: RJ, body: { reviewerId: emp('disha').id, sheetFileIds: [f.id], cashbookFileIds: [] } })).status, 200);
  assert.equal((await http('POST', `/api/tasks/${enc(t.id)}/review`, { token: DI, body: { status: 'clean' } })).status, 200);
  const pc = await http('POST', `/api/tasks/${enc(t.id)}/profit-confirm`, { token: DI });
  assert.equal(pc.status, 200, JSON.stringify(pc.j));                                       // used to need a link
  assert.equal((await download(SH, f.id)).status, 200, 'Shubam can open the file to confirm the profit');
  assert.equal((await download(OUT, f.id)).status, 403);
});
