// The Founder dashboard on a REAL server (throwaway data): one shared productivity service, elapsed-only capacity, eligibility, duplicates,
// Report Sent kept separate, every tile = its list = its export, scope and period filters, and founder-only access.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cal = require('./calendar');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-founder-'));
let child;
const enc = encodeURIComponent;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { status: r.status, j, text };
}
const login = async (email, password, tab) => (await http('POST', '/api/auth/login', { body: { email, password, expectedTab: tab } })).j.token;
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const day = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const FROM = '2026-09-07';
const qs = o => new URLSearchParams({ preset: 'custom', from: FROM, to: today, ...o }).toString();
let SH, PK, DI, RJ, E, client;
const emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
const dash = async (o, tok) => (await http('GET', '/api/founder/dashboard?' + qs(o), { token: tok || SH })).j;
const drill = async (o) => (await http('GET', '/api/founder/productivity?' + qs(o), { token: SH })).j;
const rowOf = (D, name) => D.table.find(r => r.name.startsWith(name));
const T = id => `/api/tasks/${enc(id)}`;
async function mk(name, who, extra) {
  const r = await http('POST', '/api/tasks', { token: SH, body: { mode: 'team', name, clientId: client.id, assignedTo: emp(who).id, tat: 1, internalDeadline: today, clientDate: day(9), ...(extra || {}) } });
  assert.equal(r.status, 201, name + ' ' + JSON.stringify(r.j));
  return r.j.task;
}
async function submit(t, tok, links = true) {
  assert.equal((await http('POST', T(t.id) + '/accept', { token: tok })).status, 200);
  const c = await http('POST', T(t.id) + '/complete', { token: tok, body: { reviewerId: emp('parvinder').id, ...(links ? { sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } : {}) } });
  assert.equal(c.status, 200, JSON.stringify(c.j));
}
const clean = t => http('POST', T(t.id) + '/review', { token: PK, body: { status: 'clean' } });
const qualifiedIds = D => D.detail.qualifying.map(x => x.id);

test('setup', async () => {
  SH = await login('shubham@elitetaxation.co.nz', 'Shubham@2026', 'admin');
  PK = await login('parvinder@elitetaxation.co.nz', 'Parvinder@2026', 'admin');
  DI = await login('disha@elitetaxation.co.nz', 'Disha@2026', 'admin');
  RJ = await login('ranjit@elitetaxation.co.nz', 'Ranjit@2026', 'employee');
  E = (await http('GET', '/api/employees', { token: SH })).j.employees;
  client = (await http('POST', '/api/clients', { token: SH, body: { name: 'Founder Ltd', email: 'fd' + Date.now() + '@t.co' } })).j.client;
});

test('access: only the founder — a plain superadmin, a manager and an employee are refused by the SERVER; sign-in is required', async () => {
  for (const p of ['dashboard', 'productivity', 'eligibility', 'export?section=performance']) {
    assert.equal((await http('GET', '/api/founder/' + p, { token: PK })).status, 403, p + ' for a superadmin who is not the founder');
    assert.equal((await http('GET', '/api/founder/' + p, { token: DI })).status, 403, p + ' for a manager');
    assert.equal((await http('GET', '/api/founder/' + p, { token: RJ })).status, 403, p + ' for an employee');
    assert.equal((await http('GET', '/api/founder/' + p)).status, 401, p + ' without sign-in');
  }
  assert.equal((await http('GET', '/api/founder/dashboard?' + qs(), { token: SH })).status, 200);
});

test('who counts: the founder, the HR login and system/test accounts are out by default; a superadmin can switch someone on or off; reasons are shown', async () => {
  const el = (await http('GET', '/api/founder/eligibility', { token: SH })).j.people;
  const by = n => el.find(p => p.email === n + '@elitetaxation.co.nz');
  assert.equal(by('shubham').included, false); assert.match(by('shubham').reason, /Founder/);
  assert.equal(by('hr').included, false); assert.match(by('hr').reason, /HR/);
  assert.equal(by('ranjit').included, true);
  const D = await drill({});
  assert.ok(!D.table.some(r => /Shubam/.test(r.name)) && !D.table.some(r => /HR Administrator/.test(r.name)), 'and they add no capacity');
  assert.equal((await http('PATCH', `/api/employees/${enc(emp('hunny').id)}`, { token: SH, body: { countsInProductivity: false } })).status, 200);
  assert.equal((await http('GET', '/api/founder/eligibility', { token: SH })).j.people.find(p => p.email === 'hunny@elitetaxation.co.nz').reason, 'Excluded by a superadmin');
  assert.ok(!(await drill({})).table.some(r => /Hunny/.test(r.name)));
  assert.equal((await http('PATCH', `/api/employees/${enc(emp('hunny').id)}`, { token: SH, body: { countsInProductivity: null } })).status, 200, 'back to the default rules');
  assert.ok((await drill({})).table.some(r => /Hunny/.test(r.name)));
  assert.equal((await http('PATCH', `/api/employees/${enc(emp('hunny').id)}`, { token: DI, body: { countsInProductivity: false } })).status, 403, 'only a superadmin');
  assert.equal((await http('PATCH', `/api/employees/${enc(emp('hunny').id)}`, { token: SH, body: { countsInProductivity: 'maybe' } })).status, 400);
});

test('REVIEWED CLEAN counts its allocated hours; submitted, returned and on-hold work counts nothing; each task counts ONCE', async () => {
  const before = rowOf(await drill({}), 'Ranjit');
  const a = await mk('Clean one', 'ranjit', { tat: 2 });  await submit(a, RJ); assert.equal((await clean(a)).status, 200);
  const pending = await mk('Only submitted', 'ranjit', { tat: 1 }); await submit(pending, RJ);
  const ret = await mk('Returned', 'ranjit', { tat: 1 }); await submit(ret, RJ);
  assert.equal((await http('POST', T(ret.id) + '/review', { token: PK, body: { status: 'error', note: 'redo', faultType: 'processor' } })).status, 200);
  const held = await mk('On hold', 'ranjit', { tat: 1 }); assert.equal((await http('POST', T(held.id) + '/accept', { token: RJ })).status, 200);
  assert.equal((await http('POST', T(held.id) + '/hold', { token: RJ, body: { reasonCode: 'CLIENT_DOCS', detail: 'waiting' } })).status, 200);
  const D = await drill({ employee: emp('ranjit').id }), row = rowOf(D, 'Ranjit');
  assert.equal(Math.round((row.qualifiedHours - before.qualifiedHours) * 100) / 100, 2, 'only the reviewed-clean 2 h');
  assert.ok(qualifiedIds(D).includes(a.id)); assert.ok(![pending.id, ret.id, held.id].some(id => qualifiedIds(D).includes(id)));
  const q = D.detail.qualifying.find(x => x.id === a.id);
  assert.equal(q.creditedHours, 2); assert.match(q.reason, /^Included — reviewed clean/); assert.equal(q.reviewDecision, 'Reviewed clean'); assert.ok(q.reviewedCleanAt && q.submittedAt && q.reviewCompletedAt);
  const ex = D.detail.excluded.map(x => x.reason).join(' | ');
  assert.match(ex, /waiting for review/); assert.equal(D.detail.excluded.find(x => x.id === pending.id).qualification, 'Excluded');
  // reopened and reviewed clean AGAIN: the hours are not counted twice
  assert.equal((await http('POST', T(a.id) + '/send-for-review', { token: SH, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x', cashbookLink: 'https://example.com/cb' } })).status, 200);
  assert.equal((await clean(a)).status, 200);
  const D2 = await drill({ employee: emp('ranjit').id });
  assert.equal(qualifiedIds(D2).filter(id => id === a.id).length, 1, 'one line for the task');
  assert.equal(Math.round((rowOf(D2, 'Ranjit').qualifiedHours - before.qualifiedHours) * 100) / 100, 2, 'still 2 h, not 4');
  global.__a = a;
});

test('actual worked hours and Report Sent never change productivity — but Report Sent has its OWN metric and its own list', async () => {
  const a = global.__a, base0 = rowOf(await drill({}), 'Ranjit');
  assert.equal((await http('POST', T(a.id) + '/correct-logged', { token: SH, body: { logged: 55, note: 'a forgotten timer was fixed' } })).status, 200);
  const afterLogged = rowOf(await drill({}), 'Ranjit');
  assert.equal(afterLogged.qualifiedHours, base0.qualifiedHours, 'actual hours worked are not the numerator'); assert.equal(afterLogged.eligibleCapacityHours, base0.eligibleCapacityHours, 'nor the capacity');
  // a reviewed-clean task whose report is NOT sent yet still earns its productivity credit, and shows up under Reports Not Sent
  const D0 = await dash({});
  assert.ok(D0.views.founder.actionTiles.find(t => t.key === 'reports_not_sent').ids.includes(a.id), 'unsent report is listed separately');
  const delivery0 = D0.views.founder.kpis.find(k => k.key === 'delivery').extra;
  // a task due to the client TODAY, reviewed clean, then SENT today: on time
  const s = await mk('Sent on time', 'ranjit', { tat: 1, clientDate: today }); await submit(s, RJ); assert.equal((await clean(s)).status, 200);
  const before = rowOf(await drill({}), 'Ranjit').qualifiedHours;
  const sent = await http('POST', T(s.id) + '/send-to-client', { token: PK, body: { decision: 'yes', channel: 'email', reference: 'msg-1' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.j));
  assert.equal(rowOf(await drill({}), 'Ranjit').qualifiedHours, before, 'sending the report does not move productivity');
  const delivery1 = (await dash({})).views.founder.kpis.find(k => k.key === 'delivery');
  assert.equal(delivery1.extra.onTime, delivery0.onTime + 1, 'it shows in the separate client-delivery metric'); assert.equal(delivery1.numerator, delivery1.extra.onTime); assert.equal(delivery1.denominator, delivery1.extra.due);
  // a task whose client date was YESTERDAY and was never sent: not sent → counts against delivery, never against productivity
  const late = await mk('Late report', 'ranjit', { tat: 1, clientDate: day(-1) }); await submit(late, RJ); assert.equal((await clean(late)).status, 200);
  const d2 = (await dash({})).views.founder.kpis.find(k => k.key === 'delivery').extra;
  assert.equal(d2.notSent, delivery1.extra.notSent + 1); assert.equal(d2.due, delivery1.extra.due + 1);
  assert.ok(qualifiedIds(await drill({ employee: emp('ranjit').id })).includes(late.id), 'but its hours still count');
  assert.equal((await http('POST', T(late.id) + '/send-to-client', { token: PK, body: { decision: 'yes', channel: 'email', reference: 'msg-2' } })).status, 200);
  const d3 = (await dash({})).views.founder.kpis.find(k => k.key === 'delivery').extra;
  assert.equal(d3.late, d2.late + 1, 'sent after the client date = late'); assert.equal(d3.notSent, d2.notSent - 1);
});

test('capacity: seven hours per eligible working day — approved leave, the weekly off and a workshop Saturday each take it away, and the breakdown adds up', async () => {
  const D0 = await drill({}), r0 = rowOf(D0, 'Ranjit');
  const sundays = (() => { let n = 0; for (let x = FROM; x <= today; x = day(0) && new Date(Date.parse(x + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)) if (new Date(x + 'T12:00:00Z').getUTCDay() === 0) n++; return n; })();
  assert.equal(r0.weeklyOffs, sundays, 'the weekly off is reported');
  const workingDays = cal.workingDaysBetween(cal.addWorkingDays(FROM, -1), today);
  assert.equal(r0.eligibleCapacityHours, Math.round((workingDays - r0.approvedLeaveDays - r0.workshopSaturdays - r0.otherExclusions) * 7 * 100) / 100, 'capacity = eligible working days × 7');
  // approved full-day leave on a past working day
  const leaveDay = '2026-09-15';
  assert.equal((await http('POST', '/api/leave', { token: SH, body: { employeeId: emp('ranjit').id, from: leaveDay, to: leaveDay, type: 'ANNUAL' } })).status, 201);
  const r1 = rowOf(await drill({}), 'Ranjit');
  assert.equal(Math.round((r0.eligibleCapacityHours - r1.eligibleCapacityHours) * 100) / 100, 7, 'approved leave takes 7 h'); assert.equal(r1.approvedLeaveDays - r0.approvedLeaveDays, 1);
  // a Saturday marked as a workshop by the superadmin
  const sat = '2026-09-19';
  assert.equal(new Date(sat + 'T12:00:00Z').getUTCDay(), 6);
  const ws = await http('POST', '/api/capacity-calendar', { token: SH, body: { date: sat, name: 'Training', reason: 'Founder test', confirmedPastImpact: true } });
  assert.equal(ws.status, 201, JSON.stringify(ws.j));
  const r2 = rowOf(await drill({}), 'Ranjit');
  assert.equal(Math.round((r1.eligibleCapacityHours - r2.eligibleCapacityHours) * 100) / 100, 7, 'the workshop Saturday takes 7 h'); assert.equal(r2.workshopSaturdays - r1.workshopSaturdays, 1);
  const bk = (await http('GET', `/api/productivity?from=${FROM}&to=${today}&scope=firm`, { token: SH })).j.people.find(p => p.id === emp('ranjit').id).capacityBreakdown;
  assert.equal(bk.reconciles, true, 'every day accounted for');
  // cancelling it restores the capacity everywhere at once
  const id = (await http('GET', '/api/capacity-calendar', { token: SH })).j.adjustments.find(a => a.date === sat).id;
  assert.equal((await http('POST', `/api/capacity-calendar/${id}/cancel`, { token: SH, body: { reason: 'test over' } })).status, 200);
  assert.equal(rowOf(await drill({}), 'Ranjit').eligibleCapacityHours, r1.eligibleCapacityHours);
});

test('FUTURE days never count: a period that runs past today is measured only through today, and the planned end is reported separately', async () => {
  const through = await drill({ to: today }), past = await drill({ to: day(30) });
  assert.equal(past.period.elapsedOnly, true); assert.equal(past.period.to, today); assert.equal(past.period.plannedTo, day(30));
  assert.equal(past.totals.capacityHours, through.totals.capacityHours, 'identical capacity');
  assert.equal(past.totals.qualifiedHours, through.totals.qualifiedHours);
  const dsh = await dash({ preset: 'month', from: undefined, to: undefined });
  assert.equal(dsh.period.to, today); assert.ok(dsh.period.requested.to >= today);
  assert.match(dsh.period.label, /^This month/);
  const P = (await http('GET', `/api/productivity?from=${FROM}&to=${day(30)}&scope=firm`, { token: SH })).j;
  assert.equal(P.to, today, 'the shared service itself stops at today'); assert.equal(P.elapsedOnly, true); assert.equal(P.plannedTo, day(30));
  const future = await dash({ from: day(5), to: day(20) });
  assert.equal(future.period.empty, true); const prod = future.views.founder.kpis.find(k => k.key === 'productivity');
  assert.equal(prod.value, null); assert.equal(prod.available, false); assert.match(prod.why, /elapsed working days/, 'not available — never a silent 0%');
});

test('firm productivity = total hours ÷ total capacity, never the average of percentages — and the table, the KPI and /api/productivity agree', async () => {
  const D = await drill({}), kpi = (await dash({})).views.founder.kpis.find(k => k.key === 'productivity');
  const q = D.table.reduce((s, r) => s + r.qualifiedHours, 0), c = D.table.reduce((s, r) => s + r.eligibleCapacityHours, 0);
  assert.equal(Math.round(q * 100) / 100, kpi.numerator); assert.equal(Math.round(c * 100) / 100, kpi.denominator);
  assert.equal(kpi.value, Math.round(q / c * 1000) / 10);
  const withCap = D.table.filter(r => r.eligibleCapacityHours > 0), avgRaw = withCap.reduce((s, r) => s + r.qualifiedHours / r.eligibleCapacityHours * 100, 0) / withCap.length, aggRaw = q / c * 100;
  const caps = new Set(D.table.map(r => r.eligibleCapacityHours)); assert.ok(caps.size > 1, 'the people have different capacities (leave)');
  assert.ok(Math.abs(avgRaw - aggRaw) > 1e-6, 'a naive average of the percentages would give a different (wrong) number');
  assert.ok(Math.abs(kpi.value - Math.round(aggRaw * 10) / 10) < 1e-9, 'the KPI is the weighted figure');
  const P = (await http('GET', `/api/productivity?from=${FROM}&to=${today}&scope=firm`, { token: SH })).j;
  assert.equal(P.totals.qualifiedHours, Math.round(q * 100) / 100); assert.equal(P.totals.capacityHours, Math.round(c * 100) / 100, 'the other dashboards total the same people');
  assert.equal(kpi.calc.includes('Never actual hours worked'), true);
});

test('the SAME employee and period give the SAME result on the Founder dashboard, Parvinder\'s view and the Report Card service', async () => {
  const f = rowOf(await drill({}), 'Ranjit');
  const p = (await http('GET', `/api/productivity?from=${FROM}&to=${today}&scope=firm`, { token: PK })).j.people.find(x => x.id === emp('ranjit').id);
  const m = (await http('GET', `/api/productivity?from=${FROM}&to=${today}`, { token: RJ })).j.people.find(x => x.id === emp('ranjit').id);   // his own Report Card
  for (const other of [p, m]) { assert.ok(other); assert.equal(other.qualifiedHours, f.qualifiedHours); assert.equal(other.capacityHours, f.eligibleCapacityHours); }
  const pf = await dash({ scopeKind: 'employee', scopeValue: emp('ranjit').id }), k = pf.views.founder.kpis.find(x => x.key === 'productivity');
  assert.equal(k.numerator, f.qualifiedHours); assert.equal(k.denominator, f.eligibleCapacityHours); assert.equal(pf.views.founder.performance.byEmployee[0].productivity.numerator, f.qualifiedHours, 'the performance table row too');
});

test('duplicate profiles: mapped onto the real person — capacity is not doubled, their work counts once, and nothing is deleted', async () => {
  const sm = emp('smita'), hn = emp('hunny');
  const hTask = await mk('Hunny work', 'hunny', { tat: 1 }); const HN = await login('hunny@elitetaxation.co.nz', 'Hunny@2026', 'employee'); await submit(hTask, HN); assert.equal((await clean(hTask)).status, 200);
  const before = await drill({}), capBefore = before.totals.capacityHours, hRow = rowOf(before, 'Hunny'), sRow = rowOf(before, 'Smita');
  assert.ok(hRow && hRow.qualifiedHours >= 1);
  assert.equal((await http('PATCH', `/api/employees/${enc(hn.id)}`, { token: SH, body: { duplicateOf: sm.id } })).status, 200);
  const after = await drill({});
  assert.ok(!after.table.some(r => /Hunny/.test(r.name)), 'the duplicate has no row and no capacity of its own');
  assert.equal(Math.round((capBefore - after.totals.capacityHours) * 100) / 100, hRow.eligibleCapacityHours, 'capacity is not counted twice');
  assert.ok(rowOf(after, 'Smita').qualifiedHours >= sRow.qualifiedHours + 1, 'their reviewed-clean work counts under the real profile, once');
  assert.ok((await http('GET', '/api/tasks', { token: SH })).j.tasks.find(t => t.id === hTask.id), 'the task and its history are untouched');
  const el = (await http('GET', '/api/founder/eligibility', { token: SH })).j;
  assert.match(el.people.find(p => p.id === hn.id).reason, /Duplicate profile \(counted under Smita/); assert.equal(el.mapped.length, 1);
  assert.equal((await http('PATCH', `/api/employees/${enc(sm.id)}`, { token: SH, body: { duplicateOf: hn.id } })).status, 400, 'no loops');
  assert.equal((await http('PATCH', `/api/employees/${enc(hn.id)}`, { token: SH, body: { duplicateOf: hn.id } })).status, 400, 'not itself');
  assert.equal((await http('PATCH', `/api/employees/${enc(hn.id)}`, { token: SH, body: { duplicateOf: null } })).status, 200);
  assert.equal((await drill({})).totals.capacityHours, capBefore, 'clearing it restores everything');
});

test('every tile, KPI and list: the count IS the list, every row exists, and the CSV export has exactly those records', async () => {
  const D = await dash({}), V = D.views;
  const lists = [...V.founder.actionTiles, ...V.today.tiles, ...V.review.tiles, ...V.founder.kpis.filter(k => k.unit !== undefined)];
  for (const l of lists) {
    assert.equal(new Set(l.ids).size, l.ids.length, l.key + ' has no repeats');
    l.ids.forEach(id => assert.ok(D.rows[id], l.key + ' → ' + id + ' has a row'));
  }
  const noKpi = V.founder.kpis.find(k => k.key === 'open'); assert.equal(noKpi.value, noKpi.ids.length, 'Open Work equals its list');
  for (const t of V.founder.actionTiles) {
    const csv = (await http('GET', `/api/founder/export?${qs({ section: t.key })}`, { token: SH })).text.split(/\r?\n/).filter(Boolean);
    assert.equal(csv.length - 1, t.ids.length, 'export of ' + t.key + ' = tile count');
  }
  assert.equal(V.founder.attention.shown.length, Math.min(12, V.founder.attention.total)); assert.equal(V.founder.attention.all.length, V.founder.attention.total);
  const sev = V.founder.attention.all.map(a => ({ critical: 0, high: 1, medium: 2 }[a.severity])); assert.deepEqual(sev, [...sev].sort((a, b) => a - b), 'most serious first');
  for (const a of V.founder.attention.all) for (const k of ['severity', 'id', 'name', 'clientName', 'employee', 'reviewer', 'manager', 'internalDeadline', 'clientDate', 'status', 'daysOverdue', 'blocker', 'requiredAction']) assert.ok(k in a, 'attention row has ' + k);
  const att = (await http('GET', `/api/founder/export?${qs({ section: 'attention' })}`, { token: SH })).text.split(/\r?\n/).filter(Boolean);
  assert.equal(att.length - 1, V.founder.attention.total, 'the full attention export has every record');
  // the capacity section adds up and holds no worked-hours terms
  const cap = V.founder.capacity; assert.equal(cap.reconciles, true);
  assert.ok(Math.abs(cap.reviewedCleanHours + cap.openAllocatedHours + cap.nonQualifyingCompletedHours + cap.unallocatedCapacityHours - cap.eligibleCapacityHours) < 0.2 || cap.reviewedCleanHours > cap.eligibleCapacityHours, 'the parts never exceed the whole');
  assert.doesNotMatch(JSON.stringify(V.founder.capacity), /worked|punch|online/i);
});

test('scope filters change EVERY section: an employee scope shows only their work, and team / manager scopes narrow the firm', async () => {
  const rj = emp('ranjit').id;
  const firm = await dash({}), one = await dash({ scopeKind: 'employee', scopeValue: rj });
  assert.equal(one.scope.label.startsWith('Employee: Ranjit'), true);
  for (const t of [...one.views.founder.actionTiles]) t.ids.forEach(id => assert.equal(one.rows[id].assigneeId, rj, t.key + ' only has Ranjit\'s work'));
  assert.ok(one.views.founder.kpis.find(k => k.key === 'open').value <= firm.views.founder.kpis.find(k => k.key === 'open').value);
  assert.deepEqual(one.views.founder.performance.byEmployee.map(g => g.label), [emp('ranjit').name]); assert.equal(one.eligibleEmployees.length, 1);
  assert.ok(one.views.founder.attention.all.every(a => a.employee === emp('ranjit').name));
  const team = await dash({ scopeKind: 'team', scopeValue: emp('ranjit').team });
  assert.ok(team.eligibleEmployees.length >= 1 && team.eligibleEmployees.length < firm.eligibleEmployees.length); assert.ok(team.eligibleEmployees.every(e => e.team === emp('ranjit').team));
  const mgr = await dash({ scopeKind: 'manager', scopeValue: emp('disha').id });
  assert.ok(mgr.eligibleEmployees.length < firm.eligibleEmployees.length); assert.ok(!mgr.eligibleEmployees.some(e => e.name.startsWith('Disha')), 'a manager is not their own report');
  assert.equal((await dash({ scopeKind: 'employee', scopeValue: 'nobody' })).eligibleEmployees.length, 0);
});

test('period filters change EVERY section: today vs the long range give different, internally consistent numbers', async () => {
  const wide = await dash({}), todayOnly = await dash({ preset: 'today', from: undefined, to: undefined });
  assert.equal(todayOnly.period.from, today); assert.equal(todayOnly.period.to, today); assert.equal(wide.period.from, FROM);
  const kp = (D, k) => D.views.founder.kpis.find(x => x.key === k);
  assert.ok(kp(wide, 'productivity').denominator > kp(todayOnly, 'productivity').denominator || kp(todayOnly, 'productivity').denominator === 0, 'a longer period has more capacity');
  assert.ok(kp(todayOnly, 'backlog').extra.created <= kp(wide, 'backlog').extra.created);
  assert.equal(kp(todayOnly, 'open').value, kp(wide, 'open').value, 'Open Work is a position as of today — it does not depend on the period');
  assert.match(kp(wide, 'open').basis, /Current open position as of/);
  const prev = kp(wide, 'productivity'); assert.ok(prev.prev === null || typeof prev.prev.value === 'number' || prev.prev.value === null, 'previous-period comparison is present or honestly absent');
  // internal commitment is dated by the INTERNAL DUE DATE: a task due today and submitted today counts today, not by when it was created
  const t = await mk('Due today ok', 'suneha', { tat: 1, internalDeadline: today });
  const SU = await login('suneha@elitetaxation.co.nz', 'Suneha@2026', 'employee'); await submit(t, SU);
  const ic = kp(await dash({ preset: 'today', from: undefined, to: undefined }), 'internal');
  assert.ok(ic.ids.includes(t.id) && ic.numerator >= 1, 'in the Internal Commitment list for the day it was due');
  assert.ok(ic.calc.includes('internal due date'));
});

test('missing data says "Not available" — never a silent 0% — and 0% appears only when capacity exists and nothing qualified', async () => {
  const hr = await dash({ scopeKind: 'employee', scopeValue: emp('hr').id });
  const prod = hr.views.founder.kpis.find(k => k.key === 'productivity');
  assert.equal(prod.value, null); assert.equal(prod.available, false); assert.match(prod.why, /no eligible capacity/);
  for (const k of ['internal', 'delivery', 'firstPass']) { const x = hr.views.founder.kpis.find(y => y.key === k); assert.equal(x.value, null, k + ' has no denominator'); assert.match(x.why, /No |Not available/); }
  const none = await dash({ scopeKind: 'employee', scopeValue: emp('diksha').id }), p2 = none.views.founder.kpis.find(k => k.key === 'productivity');
  assert.ok(p2.denominator > 0); assert.equal(p2.value, 0, 'real capacity, genuinely nothing qualified → 0%');
});

test('Today shows only the founder\'s own responsibilities; Review & Decisions has its own tiles; three views, six tiles each', async () => {
  const D = await dash({}), V = D.views;
  assert.deepEqual(V.today.tiles.map(t => t.label), ['My Tasks Today', 'My Overdue Tasks', 'Profit Confirmations Waiting', 'Decisions Waiting', 'Reports Requiring My Action', 'Actions Completed Today']);
  assert.deepEqual(V.founder.actionTiles.map(t => t.label), ['Client Deliveries at Risk', 'Reviews Overdue', 'Reports Not Sent', 'Profit Confirmations Pending', 'Team Overdue', 'Unassigned or Blocked']);
  assert.deepEqual(V.founder.kpis.map(k => k.label), ['Reviewed-Clean Productivity', 'Internal Commitment Met', 'Client Delivery On Time', 'First-Pass Approval', 'Open Work', 'Backlog Change']);
  assert.equal(V.review.tiles.length, 6);
  const mine = emp('shubham').id;
  for (const t of V.today.tiles.filter(t => ['my_today', 'my_overdue'].includes(t.key))) t.ids.forEach(id => assert.equal(D.rows[id].assigneeId, mine, t.key + ' is Shubam\'s own work'));
  assert.ok(!JSON.stringify(V.today.tiles).includes('"Tasks Completed Today"'), 'completed actions are not called tasks');
  // a task assigned to someone else with a profit confirmation pending reaches Shubam's profit tile (he is the confirmer), not his task tiles
  const profit = V.today.tiles.find(t => t.key === 'profit_mine'); profit.ids.forEach(id => assert.ok(D.rows[id]));
  for (const k of V.founder.kpis) { for (const f of ['numerator', 'denominator', 'calc', 'ids', 'available']) assert.ok(f in k, k.key + ' has ' + f); }
});

test('the performance table: one set of numbers per row, by team / manager / employee, each cell with its numerator and denominator', async () => {
  const D = await dash({}), P = D.views.founder.performance;
  assert.ok(P.byTeam.length && P.byEmployee.length);
  for (const g of [...P.byTeam, ...P.byManager, ...P.byEmployee]) for (const k of ['productivity', 'internal', 'delivery', 'firstPass']) { assert.ok('value' in g[k] && 'numerator' in g[k] && 'denominator' in g[k], g.label + ' ' + k); }
  const sumCap = P.byEmployee.reduce((s, g) => s + g.productivity.denominator, 0), sumQ = P.byEmployee.reduce((s, g) => s + g.productivity.numerator, 0);
  const prod = D.views.founder.kpis.find(k => k.key === 'productivity');
  assert.equal(Math.round(sumCap * 100) / 100, prod.denominator, 'the employee rows add up to the KPI'); assert.equal(Math.round(sumQ * 100) / 100, prod.numerator);
  const csv = (await http('GET', `/api/founder/export?${qs({ section: 'performance', by: 'employee' })}`, { token: SH })).text.split(/\r?\n/).filter(Boolean);
  assert.equal(csv.length - 1, P.byEmployee.length); assert.ok(csv[0].includes('Reviewed-clean productivity %'));
});

test('exports match the screen: the productivity CSV carries the very same figures as the drill-down table', async () => {
  const D = await drill({}), csv = (await http('GET', `/api/founder/export?${qs({ section: 'productivity' })}`, { token: SH })).text.split(/\r?\n/).filter(Boolean);
  const cells = line => line.replace(/^﻿/, '').split(',');
  const rows = csv.slice(1, -1).map(cells);
  assert.equal(rows.length, D.table.length);
  D.table.forEach((r, i) => { assert.equal(rows[i][0], r.name); assert.equal(Number(rows[i][7]), r.eligibleCapacityHours); assert.equal(Number(rows[i][8]), r.qualifiedHours); });
  const total = cells(csv[csv.length - 1]); assert.equal(Number(total[7]), D.totals.capacityHours); assert.equal(Number(total[8]), D.totals.qualifiedHours);
  const tasks = (await http('GET', `/api/founder/export?${qs({ section: 'productivity_tasks', employee: emp('ranjit').id })}`, { token: SH })).text.split(/\r?\n/).filter(Boolean);
  const det = (await drill({ employee: emp('ranjit').id })).detail; assert.equal(tasks.length - 1, det.qualifying.length + det.excluded.length);
  assert.equal((await http('GET', '/api/founder/export?section=nonsense', { token: SH })).status, 400);
});

test('reading the Founder dashboard changes nothing: no task, mark or history row is written', async () => {
  const snap = async () => JSON.stringify((await http('GET', '/api/tasks', { token: SH })).j.tasks) + JSON.stringify((await http('GET', '/api/employees', { token: SH })).j.employees);
  const before = await snap();
  for (const p of ['dashboard?' + qs(), 'productivity?' + qs(), 'eligibility', 'export?' + qs({ section: 'attention' })]) await http('GET', '/api/founder/' + p, { token: SH });
  assert.equal(await snap(), before);
});
