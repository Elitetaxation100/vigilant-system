// The pure rules behind the manager views — no server, easy to read, fast.
const test = require('node:test');
const assert = require('node:assert/strict');
const mv = require('./manager-views');
const wf = require('./workflow');

const names = { a: 'Asha', b: 'Ben', m: 'Manager' };
const deps = { today: '2026-10-07', nowMs: Date.parse('2026-10-07T00:00:00Z'), nzDay: iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }), nameOf: id => names[id] || null, profitOwnerId: 'm', canApprove: () => true, isManager: true, roleOf: () => 'manager' };
const task = (o) => ({ id: 't' + Math.random().toString(36).slice(2, 7), name: 'T', kind: 'team', clientId: 'c1', clientName: 'Acme', status: 'accepted', assignedTo: 'a', reviewerId: 'm', tat: 2, clientDate: '2026-10-20', internalDeadline: '2026-10-12', reviewStatus: null, ...o });
const rows = ts => ts.map(t => mv.enrich(wf.card(t, deps), t, deps));
const by = Object.fromEntries;

test('pagination: only 25/50/100, page clamped, nothing skipped or repeated', () => {
  const rs = rows(Array.from({ length: 60 }, (_, i) => task({ id: 'x' + i })));
  const p = mv.paginate(rs, 1, 25); assert.equal(p.pages, 3); assert.equal(p.rows.length, 25);
  assert.equal(mv.paginate(rs, 99, 25).page, 3); assert.equal(mv.paginate(rs, 0, 25).page, 1); assert.equal(mv.paginate(rs, 'x', 7).pageSize, 25);
  const all = [1, 2, 3].flatMap(n => mv.paginate(rs, n, 25).rows.map(r => r.id)); assert.equal(new Set(all).size, 60);
  assert.equal(mv.paginate([], 1, 25).pages, 1, 'an empty list still has one page');
});

test('filters: each one is exact; a search matches name, client, number and employee', () => {
  const ts = [task({ id: 'a1', name: 'GST return', assignedTo: 'a' }), task({ id: 'b1', name: 'BAS', assignedTo: 'b', status: 'completed', completedAt: '2026-10-06T01:00:00Z', reviewStatus: null }), task({ id: 'a2', name: 'Tax', assignedTo: 'a', status: 'on_hold', holdReasonCode: 'CLIENT_DOCS' })];
  const rs = rows(ts), f = o => mv.applyFilters(rs, { today: deps.today, ...o }).map(r => r.id).sort();
  assert.deepEqual(f({ employee: 'a' }), ['a1', 'a2']); assert.deepEqual(f({ status: 'In Review' }), ['b1']);
  assert.deepEqual(f({ waitingOn: 'client' }), ['a2']); assert.deepEqual(f({ q: 'gst' }), ['a1']); assert.deepEqual(f({ q: 'ben' }), ['b1']);
  assert.deepEqual(f({ employee: 'a', status: 'On Hold' }), ['a2'], 'filters combine');
  assert.deepEqual(f({ ids: 'a1|b1' }), ['a1', 'b1']);
  assert.deepEqual(f({ q: 'zzz' }), []);
});

test('due filter: overdue / today / next 7 days / no date', () => {
  const rs = rows([task({ id: 'o', internalDeadline: '2026-10-01' }), task({ id: 't', internalDeadline: '2026-10-07' }), task({ id: 'w', internalDeadline: '2026-10-12' }), task({ id: 'f', internalDeadline: '2026-11-30' }), task({ id: 'n', internalDeadline: null })]);
  const f = due => mv.applyFilters(rs, { today: deps.today, due }).map(r => r.id).sort();
  assert.deepEqual(f('overdue'), ['o']); assert.deepEqual(f('today'), ['t']); assert.deepEqual(f('week'), ['t', 'w']); assert.deepEqual(f('none'), ['n']);
});

test('sort: most at risk puts overdue clients first and a missing date last', () => {
  const rs = rows([task({ id: 'ok', clientDate: '2026-12-01' }), task({ id: 'late', clientDate: '2026-10-01' }), task({ id: 'today', clientDate: '2026-10-07' })]);
  assert.deepEqual(mv.sortRows(rs, 'risk').map(r => r.id), ['late', 'today', 'ok']);
  assert.deepEqual(mv.sortRows(rows([task({ id: 'x', internalDeadline: null }), task({ id: 'y', internalDeadline: '2026-10-09' })]), 'internal').map(r => r.id), ['y', 'x']);
});

test('team summary: counts follow who owns the next action, never review waiting as the employee\'s overdue', () => {
  const ts = [task({ id: 'o1', internalDeadline: '2026-10-01' }), task({ id: 'r1', status: 'completed', completedAt: '2026-10-06T01:00:00Z' }), task({ id: 'c1', status: 'on_hold', holdReasonCode: 'CLIENT_QUERY' }), task({ id: 'e1', status: 'rework', reviewStatus: 'error' })];
  const T = mv.teamSummary(rows(ts), [{ id: 'a', name: 'Asha' }], { today: deps.today, workloadOf: () => ({ freeCapacityNext5wd: 12 }) })[0];
  assert.equal(T.overdueByEmployee, 1); assert.deepEqual(T.ids.overdue, ['o1']);
  assert.equal(T.waitingOnReviewer, 1); assert.equal(T.waitingOnClient, 1); assert.equal(T.corrections, 1);
  assert.equal(T.openActionable, 2, 'the overdue task and the correction are the employee\'s'); assert.equal(T.availableCapacityHours, 12);
});

test('exceptions: only real problems; healthy and finished work never appear', () => {
  const ts = {
    ok: task({ id: 'ok' }),
    nodate: task({ id: 'nodate', internalDeadline: null }),
    zero: task({ id: 'zero', tat: 0 }),
    twice: task({ id: 'twice', reworkCount: 2 }),
    longhold: task({ id: 'longhold', status: 'on_hold', holdReasonCode: 'THIRD_PARTY', heldAt: '2026-09-20T00:00:00Z' }),
    unsent: task({ id: 'unsent', status: 'completed', reviewStatus: 'clean', completedAt: '2026-10-01T00:00:00Z', reviewedAt: '2026-10-03T00:00:00Z', sentToClient: null }),
    profit: task({ id: 'profit', status: 'completed', reviewStatus: 'clean', sentToClient: null, profitConfirmStatus: 'pending', profitConfirmRequestedAt: '2026-10-01T00:00:00Z', reviewedAt: '2026-10-07T00:00:00Z', completedAt: '2026-10-01T00:00:00Z' }),
    done: task({ id: 'done', status: 'completed', reviewStatus: 'done', sentToClient: true }),
    changed: task({ id: 'changed', dateHistory: [{ at: '2026-10-05T00:00:00Z', by: 'M', from: { internal: '2026-10-08', client: '2026-10-20' }, to: { internal: '2026-10-12', client: '2026-10-20' } }] }),
    badlink: task({ id: 'badlink', status: 'completed', reviewStatus: null, completedAt: '2026-10-06T00:00:00Z', sheetLink: 'not a link', cashbookLink: 'https://docs.google.com/x' }),
  };
  const E = mv.exceptions(rows(Object.values(ts)), ts, { today: deps.today, nowMs: deps.nowMs });
  const types = id => E.filter(e => e.id === id).map(e => e.type);
  assert.deepEqual(types('ok'), []); assert.deepEqual(types('done'), []);
  assert.ok(types('nodate').includes('no_due_date')); assert.ok(types('zero').includes('zero_hours')); assert.ok(types('twice').includes('repeated_return'));
  assert.ok(types('longhold').includes('blocked_long')); assert.ok(types('unsent').includes('report_unsent')); assert.ok(types('profit').includes('profit_overdue'));
  assert.ok(types('changed').includes('date_changed')); assert.ok(types('badlink').includes('bad_link'));
});

test('link domains: an approved-site check works on subdomains and rejects look-alikes', () => {
  assert.ok(mv.domainAllowed('https://docs.google.com/spreadsheets/d/1')); assert.ok(mv.domainAllowed('https://go.xero.com/x'));
  assert.ok(!mv.domainAllowed('https://docs.google.com.evil.example/x')); assert.ok(!mv.domainAllowed('notaurl')); assert.ok(!mv.domainAllowed('https://example.com'));
  assert.ok(mv.domainAllowed('https://example.com', ['example.com']), 'a custom list overrides the default');
});

test('calendar and timeline: tones follow state; bars never run backwards', () => {
  const ts = { r: task({ id: 'r', internalDeadline: '2026-10-01' }), p: task({ id: 'p', status: 'completed', completedAt: '2026-10-06T00:00:00Z' }), g: task({ id: 'g', status: 'on_hold', holdReasonCode: 'CLIENT_DOCS', holdFollowUp: '2026-10-09' }) };
  const rs = rows(Object.values(ts)), ev = mv.calendarEvents(rs, deps);
  assert.equal(ev.find(e => e.id === 'r' && e.kind === 'internal').tone, 'red'); assert.equal(ev.find(e => e.id === 'p' && e.kind === 'internal').tone, 'purple');
  assert.equal(ev.find(e => e.id === 'g' && e.kind === 'internal').tone, 'grey'); assert.ok(ev.some(e => e.id === 'g' && e.kind === 'followup'));
  const tl = mv.timelineRows(rs, ts, deps); tl.forEach(r => assert.ok(r.start <= r.end));
  assert.deepEqual(ev.map(e => e.date), [...ev.map(e => e.date)].sort());
});

test('sortRows: the default is newest first, and an unknown sort falls back to it', () => {
  const mv = require('./manager-views');
  const rows = [{ id: '#1', createdAt: '2026-10-01T00:00:00Z', clientRisk: { state: 'ok' } }, { id: '#3', createdAt: '2026-10-03T00:00:00Z', clientRisk: { state: 'ok' } }, { id: '#2', createdAt: '2026-10-03T00:00:00Z', clientRisk: { state: 'ok' } }];
  assert.deepEqual(mv.sortRows(rows).map(r => r.id), ['#3', '#2', '#1']);
  assert.deepEqual(mv.sortRows(rows, 'nonsense').map(r => r.id), ['#3', '#2', '#1']);
  assert.deepEqual(mv.sortRows(rows, 'newest').map(r => r.id), ['#3', '#2', '#1']);
});
