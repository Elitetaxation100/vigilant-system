// Client ownership and the client profile: counts per owner, an owner's list with the yearly checklist, a profile built from the client's work, who may see what.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-clients-'));
let child;
const enc = encodeURIComponent;
const T = id => '/api/tasks/' + enc(id);
const nzToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const day = n => new Date(Date.parse(nzToday() + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(async () => { if (child) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

let SA, PK, KH, NI, RJ, E; const ids = {};
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');

test('setup: clients with types and owners; Sandeep (Khushi) has a done GST return, an approved one waiting to be sent, and a tax return for last year', async () => {
  SA = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin'); PK = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  KH = await login('khushi@elitetaxation.co.nz', 'Khushi@2026', 'employee'); NI = await login('nitish@elitetaxation.co.nz', 'Nitish@2026', 'employee'); RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SA })).j.employees;
  const mkClient = async (name, type, owner) => { const r = await http('POST', '/api/clients', { token: SA, body: { name, type, ownerId: emp(owner).id, email: name.split(' ')[0].toLowerCase() + Date.now() + '@t.co' } }); assert.equal(r.status, 201, JSON.stringify(r.j)); return r.j.client.id; };
  ids.sandeep = await mkClient('Sandeep Boparai', 'Rideshare', 'khushi'); ids.bhup = await mkClient('Bhupender Singh', 'Rideshare', 'khushi');
  ids.cheema = await mkClient('AA Cheema Ltd', 'Company', 'nitish'); ids.gill = await mkClient('Gill Rentals', 'Rental', 'nitish'); ids.custom = await mkClient('Odd Client', 'Custom', 'nitish');
  const make = async (who, tok, name, clientId, over) => {
    const c = await http('POST', '/api/tasks', { token: PK, body: { mode: 'team', name, taskKind: 'client', clientId, assignedTo: emp(who).id, tat: 1, internalDeadline: day(0), clientDate: day(5), reviewerId: emp('parvinder').id, ...(over || {}) } });
    assert.equal(c.status, 201, JSON.stringify(c.j));
    assert.equal((await http('POST', T(c.j.task.id) + '/accept', { token: tok })).status, 200);
    return c.j.task;
  };
  const submit = (id, tok) => http('POST', T(id) + '/complete', { token: tok, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/1', cashbookLink: 'https://example.com/cb' } });
  const send = async (t, tok) => { await submit(t.id, tok); assert.equal((await http('POST', T(t.id) + '/review-decision', { token: PK, body: { decision: 'approve', next: 'report', note: 'ok' } })).status, 200); };
  const gst1 = await make('khushi', KH, 'GST return period 1', ids.sandeep); await send(gst1, KH); assert.equal((await http('POST', T(gst1.id) + '/send-to-client', { token: PK, body: { decision: 'yes' } })).status, 200);
  const gst2 = await make('khushi', KH, 'GST return', ids.sandeep, { clientDate: day(1) }); await send(gst2, KH); ids.approved = gst2.id;
  const ir3 = await make('khushi', KH, 'Income tax return (IR3)', ids.sandeep, { financialYear: '2025–26' }); await send(ir3, KH); assert.equal((await http('POST', T(ir3.id) + '/send-to-client', { token: PK, body: { decision: 'yes' } })).status, 200); ids.ir3 = ir3.id;
  const fixT = await make('khushi', KH, 'GST return', ids.bhup); await submit(fixT.id, KH); assert.equal((await http('POST', T(fixT.id) + '/review-decision', { token: PK, body: { decision: 'return', category: 'Calculation error', responsibility: 'Employee', dueDate: day(1), note: 'Recheck' } })).status, 200); ids.fix = fixT.id; ids.cheemaTask = (await make('nitish', NI, 'GST return', ids.cheema)).id;
  ids.reg = (await make('nitish', NI, 'Annual accounts', ids.cheema)).id;
});

test('ownership: clients per owner, counted from the directory, biggest first; a type filter narrows it; the owner list shows the checklist and the status', async () => {
  const o = (await http('GET', '/api/client-ownership', { token: SA })).j;
  assert.equal(o.total, o.perOwner.reduce((n, x) => n + x.count, 0), 'every client is counted once');
  const nit = o.perOwner.find(x => x.id === emp('nitish').id), kh = o.perOwner.find(x => x.id === emp('khushi').id);
  assert.equal(nit.count, 3); assert.equal(kh.count, 2);
  assert.ok(o.perOwner[0].count >= o.perOwner[o.perOwner.length - 1].count);
  const r = (await http('GET', '/api/client-ownership?owner=' + enc(emp('khushi').id), { token: SA })).j;
  assert.equal(r.owner.name.split(' ')[0], 'Khushi');
  const s = r.clients.find(c => c.name === 'Sandeep Boparai');
  assert.equal(s.checklist.total, 4); assert.equal(s.checklist.done, 1, 'the sent GST return is period 1 of this year');
  assert.equal(s.status.label, 'Approved, not sent'); assert.equal(s.late, true);
  assert.equal(r.stats.owned, 2); assert.equal(r.stats.late, 2, 'Sandeep (approved, not sent) and Bhupender (fix needed)');
  const rideshare = (await http('GET', '/api/client-ownership?type=Rideshare', { token: SA })).j;
  assert.equal(rideshare.total, 2); assert.deepEqual(rideshare.types.sort(), ['Company', 'Rental', 'Rideshare', 'Custom'].sort());
  const custom = (await http('GET', '/api/client-ownership?owner=' + enc(emp('nitish').id), { token: SA })).j.clients.find(c => c.name === 'Odd Client');
  assert.equal(custom.checklist, null, 'a type with no checklist shows none');
});

test('an employee sees their own list only, even if they ask for someone else\'s', async () => {
  const r = (await http('GET', '/api/client-ownership?owner=' + enc(emp('khushi').id), { token: NI })).j;
  assert.equal(r.canPickOwner, false); assert.equal(r.owner.name.split(' ')[0], 'Nitish');
  assert.ok(r.clients.every(c => ['AA Cheema Ltd', 'Gill Rentals', 'Odd Client'].includes(c.name)));
});

test('the profile: history by financial year (last year\'s tax return filed this year sits in last year), checklist, hours, open work', async () => {
  const p = (await http('GET', '/api/clients/' + enc(ids.sandeep) + '/profile', { token: SA })).j;
  assert.equal(p.client.ownerName.split(' ')[0], 'Khushi'); assert.equal(p.client.balanceLabel, '31 Mar');
  const years = p.history.map(h => h.fy);
  assert.ok(years.includes('2025–26') && years.includes(p.currentFY), years.join());
  const last = p.history.find(h => h.fy === '2025–26');
  assert.equal(last.tasks[0].name, 'Income tax return (IR3)'); assert.equal(last.done, 1);
  assert.match(last.tasks[0].line, /Khushi · approved first time · sent \d\d \w{3} \d{4}/);
  const cur = p.history.find(h => h.fy === p.currentFY);
  assert.equal(cur.open, 1); assert.equal(cur.done, 1);
  assert.equal(p.checklist.done, 1); assert.equal(p.stats.openCount, 1);
  assert.ok(p.stats.hoursThisYear > 0 && p.hoursByType.length > 0 && p.hoursByYear.length === 2);
  assert.equal(p.canSeeFee, true);
});

test('the owner sees every task on their client, whoever does it; someone else sees only what they can already see; fee, notes and documents stay with owner and managers', async () => {
  // Parvinder created and reviewed every task; give Ranjit (not involved, not a manager) a look and make Nitish the owner of a client Khushi works on
  const mine = (await http('POST', '/api/clients', { token: SA, body: { name: 'Shared Client', type: 'Rideshare', ownerId: emp('nitish').id, email: 'shared' + Date.now() + '@t.co' } })).j.client.id;
  const c = await http('POST', '/api/tasks', { token: PK, body: { mode: 'team', name: 'GST return', taskKind: 'client', clientId: mine, assignedTo: emp('khushi').id, tat: 1, internalDeadline: day(0), clientDate: day(5), reviewerId: emp('parvinder').id } });
  assert.equal(c.status, 201);
  const own = (await http('GET', '/api/clients/' + enc(mine) + '/profile', { token: NI })).j;
  assert.equal(own.history.flatMap(h => h.tasks).length, 1, 'the owner sees Khushi\'s work on their client');
  assert.equal(own.partial, false); assert.equal(own.canSeeMore, true); assert.equal(own.canSeeFee, false);
  const other = (await http('GET', '/api/clients/' + enc(mine) + '/profile', { token: RJ })).j;
  assert.equal(other.history.flatMap(h => h.tasks).length, 0); assert.equal(other.partial, true);
  assert.equal(other.client.notes, null); assert.equal(other.client.documents, null); assert.equal(other.client.fee, null);
  assert.equal((await http('GET', '/api/clients/nope/profile', { token: SA })).status, 404);
});

test('editing a client: GST registered, balance date, notes, documents; the fee is a manager\'s; bad values are refused', async () => {
  const E1 = '/api/clients/' + enc(ids.sandeep);
  const r = await http('PATCH', E1, { token: KH, body: { gstRegistered: true, balanceDate: '06-30', notes: 'Prefers WhatsApp', documents: [{ label: 'IRD letter', url: 'https://example.com/ird.pdf' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal((await http('PATCH', E1, { token: KH, body: { fee: 900 } })).status, 403, 'the owner cannot set the fee');
  assert.equal((await http('PATCH', E1, { token: SA, body: { fee: 900 } })).status, 200);
  assert.equal((await http('PATCH', E1, { token: SA, body: { balanceDate: '13-45' } })).status, 400);
  assert.equal((await http('PATCH', E1, { token: SA, body: { documents: [{ url: 'javascript:alert(1)' }] } })).status, 400);
  const p = (await http('GET', E1 + '/profile', { token: KH })).j;
  assert.equal(p.client.gstRegistered, true); assert.equal(p.client.balanceLabel, '30 Jun'); assert.equal(p.client.notes, 'Prefers WhatsApp'); assert.equal(p.client.documents.length, 1);
  assert.equal(p.client.fee, null, 'the owner does not see the fee');
  assert.equal((await http('GET', E1 + '/profile', { token: SA })).j.client.fee, 900);
  assert.equal((await http('PATCH', E1, { token: SA, body: { balanceDate: '03-31' } })).status, 200);
});

test('the financial year of a task can be set (by who does it, who gave it, the client owner or a manager) and cleared', async () => {
  const set = await http('PATCH', T(ids.approved) + '/financial-year', { token: KH, body: { financialYear: '2025-26' } });
  assert.equal(set.status, 200); assert.equal(set.j.task.financialYear, '2025–26');
  assert.equal((await http('PATCH', T(ids.approved) + '/financial-year', { token: KH, body: { financialYear: '2025–28' } })).status, 400);
  assert.equal((await http('PATCH', T(ids.approved) + '/financial-year', { token: RJ, body: { financialYear: '2025–26' } })).status, 403);
  assert.equal((await http('PATCH', T(ids.approved) + '/financial-year', { token: KH, body: { financialYear: null } })).j.task.financialYear, null);
  const t = await http('POST', '/api/tasks', { token: PK, body: { mode: 'team', name: 'Annual accounts', taskKind: 'client', clientId: ids.cheema, assignedTo: emp('nitish').id, tat: 1, internalDeadline: day(1), clientDate: day(6), financialYear: '2024-25' } });
  assert.equal(t.j.task.financialYear, '2024–25', 'a new task carries the year it is for');
});

test('checklists: everyone can read them, only a superadmin changes them', async () => {
  const g = (await http('GET', '/api/client-checklists', { token: RJ })).j;
  assert.ok(g.checklists.Rideshare && g.checklists.Company);
  assert.equal((await http('PUT', '/api/client-checklists', { token: NI, body: { checklists: g.checklists } })).status, 403);
  assert.equal((await http('PUT', '/api/client-checklists', { token: SA, body: { checklists: { Rideshare: [{ group: 'gst', label: 'GST return, period {n}', match: 'gst', count: 2 }] } } })).status, 200);
  const r = (await http('GET', '/api/client-ownership?owner=' + enc(emp('khushi').id), { token: SA })).j.clients.find(c => c.name === 'Bhupender Singh');
  assert.equal(r.checklist.total, 2, 'the new list is used');
  assert.equal((await http('PUT', '/api/client-checklists', { token: SA, body: { checklists: { Rideshare: [{ group: 'x', label: 'x', match: '(' }] } } })).status, 400);
});
