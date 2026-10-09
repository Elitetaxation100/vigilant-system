// A throwaway server (its own empty data folder) with a realistic day for Ranjit Choudhary, so the Processor Dashboard can be checked by eye.
//   node docs/ui-checks/qa-processor-server.js          → http://localhost:3777   (sign in as ranjit@elitetaxation.co.nz — seed password in db.js)
// Nothing here touches the real data folder.
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-qa-proc-'));
process.env.TM_DATA_DIR = dir; process.env.PORT = process.env.PORT || '3777'; process.env.LOGIN_RATE_LIMIT = '10000'; process.env.NODE_ENV = 'test';
require('../../server.js');
const base = 'http://127.0.0.1:' + process.env.PORT, enc = encodeURIComponent;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const day = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
async function http(method, p, { token, body, raw, headers } = {}) {
  const h = { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(headers || {}) }; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers: h, body: raw ? body : (body === undefined ? undefined : JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j };
}
const login = async (e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  const SA = await login('shubham', 'Shubham@2026', 'admin'), PA = await login('parvinder', 'Parvinder@2026', 'admin'), RJ = await login('ranjit', 'Ranjit@2026', 'employee');
  const E = (await http('GET', '/api/employees', { token: SA })).j.employees, emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
  const cl = async name => (await http('POST', '/api/clients', { token: SA, body: { name, email: name.split(' ')[0].toLowerCase() + '@t.co' } })).j.client.id;
  const T = id => '/api/tasks/' + enc(id);
  const mk = async (name, clientName, over) => {
    const clientId = await cl(clientName);
    const r = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name, taskKind: 'client', clientId, assignedTo: emp('ranjit').id, tat: 0.5, internalDeadline: day(0), clientDate: day(6), reviewerId: emp('parvinder').id, ...(over || {}) } });
    if (r.status !== 201) throw new Error('create ' + name + ' ' + JSON.stringify(r.j));
    await http('POST', T(r.j.task.id) + '/accept', { token: RJ }); return r.j.task;
  };
  const submit = t => http('POST', T(t.id) + '/complete', { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/qa', cashbookLink: 'https://example.com/cashbook' } });
  const approve = (t, id) => http('POST', T(t.id) + '/review-decision', { token: PA, body: { decision: 'approve', requestId: id, note: '' } });
  const hold = (t, body) => http('POST', T(t.id) + '/hold', { token: RJ, body: { followUpDate: day(2), ...body } });
  // 1. due today
  await mk('GST return Sep', 'Alpha Traders Ltd');
  await mk('Income tax FY26', 'Bravo Holdings', { internalDeadline: day(0), tat: 1 });
  // 2. not due yet
  await mk('Annual accounts FY26', 'Charlie Family Trust', { internalDeadline: day(4), clientDate: day(9), tat: 1 });
  // 3. fix needed, with the reviewer's file
  const fix = await mk('Rental schedule Aug', 'Delta Rentals', { internalDeadline: day(0) }); await submit(fix);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj<<>>endobj\n%%EOF')]);
  const up = await http('POST', '/api/files', { token: PA, raw: true, body: pdf, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': enc('Reviewer notes.pdf') } });
  await http('POST', T(fix.id) + '/review-decision', { token: PA, body: { decision: 'return', requestId: 'qa-r1', category: 'Calculation error', responsibility: 'Employee', dueDate: day(1), note: 'GST on the vehicle was claimed at 100%.', attachments: [up.j.file.id] } });
  // 4. on hold, waiting on the client — query recorded, pause awaiting approval
  const h1 = await mk('PAYE reconciliation', 'Echo Cafe Ltd', { internalDeadline: day(1) });
  await hold(h1, { category: 'CLIENT_INFO', detail: 'Asked which entity owns the van', waitingOnPerson: 'Echo Cafe Ltd', followUpDate: day(2), queryConfirmed: true, querySource: 'email', querySentAt: day(0), querySentTime: '09:15', queryEvidence: 'Email "Van ownership" to the client, 9:15 am' });
  // 5. on hold, waiting on a manager (no query)
  const h2 = await mk('Fringe benefit tax', 'Foxtrot Engineering', { internalDeadline: day(1) });
  await hold(h2, { category: 'MANAGER_DECISION', detail: 'Need a ruling on the vehicle treatment', waitingOnId: emp('parvinder').id });
  // 6. on hold, ready to resume (the client replied)
  const h3 = await mk('GST return Aug', 'Golf Plumbing', { internalDeadline: day(0) });
  await hold(h3, { category: 'CLIENT_DOCS', detail: 'Bank statements for August', waitingOnPerson: 'Golf Plumbing', queryConfirmed: true, querySource: 'email', querySentAt: day(-1), querySentTime: '14:00', queryEvidence: 'Email "August statements" to the client' });
  const q = ((await http('GET', '/api/tasks', { token: RJ })).j.tasks.find(x => x.id === h3.id).queries || [])[0];
  await http('POST', T(h3.id) + '/query/' + enc(q.id) + '/reply', { token: RJ, body: { replyAt: day(0), replySource: 'email' } });
  // 7. sent for review
  const s1 = await mk('Bookkeeping Sep', 'Hotel Supplies Ltd', { internalDeadline: day(0) }); await submit(s1);
  // 8. reviewed clean, report ready to send
  const c1 = await mk('GST return Jul', 'India Imports Ltd', { internalDeadline: day(0), clientDate: day(2) }); await submit(c1); await approve(c1, 'qa-a1');
  await http('POST', T(c1.id) + '/profit-confirm/done', { token: SA });
  // 9. reviewed clean and sent (qualifies; report sent on time)
  const c2 = await mk('Income tax FY25', 'Juliet Farms', { internalDeadline: day(0), clientDate: day(3) }); await submit(c2); await approve(c2, 'qa-a2');
  await http('POST', T(c2.id) + '/profit-confirm/done', { token: SA });
  await http('POST', T(c2.id) + '/send-to-client', { token: RJ, body: { decision: 'yes' } });
  console.log('QA data ready — http://localhost:' + process.env.PORT + '  (Ranjit: ranjit@elitetaxation.co.nz)');
})().catch(e => console.error('QA seed failed:', e && e.stack || e));
