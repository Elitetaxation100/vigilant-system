// A throwaway server (its own empty data folder) with a realistic day for Disha's team, so the simple manager layout can be checked by eye.
//   node docs/ui-checks/qa-manager-server.js   → http://localhost:3778   (sign in as disha@elitetaxation.co.nz — seed password in db.js)
// Nothing here touches the real data folder.
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-qa-mgr-'));
process.env.TM_DATA_DIR = dir; process.env.PORT = process.env.PORT || '3778'; process.env.LOGIN_RATE_LIMIT = '10000'; process.env.NODE_ENV = 'test';
require('../../server.js');
const db = require('../../db.js');
const base = 'http://127.0.0.1:' + process.env.PORT, enc = encodeURIComponent;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const day = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
async function http(method, p, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j };
}
const login = async (e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  const SA = await login('shubham', 'Shubham@2026', 'admin'), PA = await login('parvinder', 'Parvinder@2026', 'admin'), DI = await login('disha', 'Disha@2026', 'admin');
  const tk = {};
  for (const n of ['khushi', 'diksha', 'nitish']) { const r = await http('POST', '/api/auth/login', { body: { email: n + '@elitetaxation.co.nz', password: n[0].toUpperCase() + n.slice(1) + '@2026', expectedTab: 'employee' } }); tk[n] = r.j && r.j.token; console.log(n, r.status); }
  const E = (await http('GET', '/api/employees', { token: SA })).j.employees, emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
  const T = id => '/api/tasks/' + enc(id);
  const made = {};
  const cl = async (name, ownerId, type) => made[name] || (made[name] = (await http('POST', '/api/clients', { token: SA, body: { name, ownerId, type: type || (/Ltd|Supplies|Media/.test(name) ? 'Company' : 'Rideshare'), email: name.split(' ')[0].toLowerCase() + '@t.co' } })).j.client.id);
  const mk = async (who, name, clientName, over) => {
    const body = { mode: 'team', name, taskKind: clientName ? 'client' : 'admin', assignedTo: emp(who).id, tat: 1, internalDeadline: day(2), clientDate: day(6), reviewerId: emp('parvinder').id, ...(clientName ? { clientId: await cl(clientName, emp(who).id) } : {}), ...(over || {}) };
    if (!clientName) { delete body.clientDate; }
    const past = (body.internalDeadline < today) ? { internalDeadline: body.internalDeadline, clientDate: body.clientDate } : null;   // the form refuses a past date, so set it afterwards
    if (past) { body.internalDeadline = today; if (body.clientDate && body.clientDate < today) body.clientDate = day(1); }
    const r = await http('POST', '/api/tasks', { token: DI, body });
    if (r.status !== 201) { console.log('create failed', name, r.status, JSON.stringify(r.j).slice(0, 160)); return null; }
    await http('POST', T(r.j.task.id) + '/accept', { token: tk[who] });
    if (past) { const t = db.get().tasks.find(x => x.id === r.j.task.id); t.internalDeadline = past.internalDeadline; if (past.clientDate) t.clientDate = past.clientDate; }
    return r.j.task;
  };
  const submit = (who, t, rev) => http('POST', T(t.id) + '/complete', { token: tk[who], body: { reviewerId: emp(rev || 'parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/qa', cashbookLink: 'https://example.com/cb' } });
  // approved, not sent
  const a = await mk('khushi', 'GST return', 'Sandeep Boparai', { internalDeadline: day(0), clientDate: day(-1) });
  if (a) { await submit('khushi', a); const r = await http('POST', T(a.id) + '/review-decision', { token: PA, body: { decision: 'approve', next: 'report', note: 'ok', requestId: 'sl-a1' } }); console.log('approve', r.status); }
  // with reviewer
  const b = await mk('nitish', 'Updation', 'Herry Sharma', { internalDeadline: day(-1), clientDate: day(1) });
  if (b) await submit('nitish', b);
  // fix needed
  const c = await mk('khushi', 'GST return', 'Bhupender Singh', { internalDeadline: day(-1) });
  if (c) { await submit('khushi', c); await http('POST', T(c.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'sl-r1', category: 'Calculation error', responsibility: 'Employee', dueDate: day(1), note: 'Recheck GST' } }); }
  // overdue + due today + to do
  await mk('diksha', 'Client processing', 'Ebasa Debela', { internalDeadline: day(-3) });
  await mk('diksha', 'Rideshare processing', 'Manya Pat', { internalDeadline: day(0) });
  await mk('nitish', 'Loan client list', null, { internalDeadline: day(1) });
  await mk('khushi', 'Ravikash IRD reply', null, { internalDeadline: day(2) });
  // finished today
  const f = await mk('diksha', 'Bookkeeping Sep', 'Hotel Supplies', { internalDeadline: day(0) });
  if (f) { await submit('diksha', f); await http('POST', T(f.id) + '/review-decision', { token: PA, body: { decision: 'approve', next: 'done', note: 'ok', requestId: 'sl-d1' } }); }
  // a client with a real history: Sandeep's tax return (for last year, done in August), an earlier GST return, a cashflow forecast and a letter
  const done = async (who, name, client, extra, hours) => { const t = await mk(who, name, client, Object.assign({ internalDeadline: day(0), tat: hours || 1 }, extra || {})); if (!t) return; await submit(who, t); await http('POST', T(t.id) + '/review-decision', { token: PA, body: { decision: 'approve', next: 'report', note: 'ok', requestId: 'cp-' + Math.random().toString(36).slice(2, 7) } }); await http('POST', T(t.id) + '/send-to-client', { token: DI, body: { decision: 'yes' } }); return t; };
  await done('khushi', 'Income tax return (IR3)', 'Sandeep Boparai', { financialYear: '2025–26' }, 3);
  await done('khushi', 'GST return period 1', 'Sandeep Boparai', {}, 1);
  await done('khushi', 'Cashflow forecast', 'Sandeep Boparai', { financialYear: '2025–26' }, 2);
  await cl('Jasbir Singh Raina', emp('khushi').id); await cl('AA Cheema Ltd', emp('diksha').id); await cl('Black Sheep Media', emp('nitish').id, 'Company'); await cl('Gill Rentals', emp('nitish').id, 'Rental'); await cl('Orphan Client', null, 'Rideshare');
  console.log('QA data ready — http://localhost:' + process.env.PORT + '  (Disha: disha@elitetaxation.co.nz)');
})().catch(e => console.error(e));
