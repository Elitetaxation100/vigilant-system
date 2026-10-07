// ET-CRM connection health — the pure rules behind the admin panel, the one-click check and the alerts.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./crm-health');

const NOW = Date.parse('2026-10-14T00:00:00Z');
const ago = (hours, base) => new Date((base || NOW) - hours * 3600e3).toISOString();
const mk = (extra) => ({ employees: [], clients: [], crmSync: { events: [], counts: {}, ...(extra || {}) } });

test('employee health: linked / not linked / inactive / conflicts — and a candidate ONLY from a unique work email, never a name', () => {
  const s = mk({
    counts: { user: { conflict: 2, ambiguous: 1 } },
    unlinked: { a: { key: 'a', crmUserId: 'u-ann', email: 'ann@x.nz', count: 2, kinds: { attendance: 2 }, pending: [{}] }, b: { key: 'b', crmUserId: 'u-bob1', email: 'bob@x.nz', count: 1, kinds: {}, pending: [] }, c: { key: 'c', crmUserId: 'u-bob2', email: 'BOB@x.nz', count: 1, kinds: {}, pending: [] } },
  });
  s.employees = [
    { id: 'e1', name: 'Ann Lee', email: 'ann@x.nz' },                                  // one waiting CRM user has her email → candidate
    { id: 'e2', name: 'Bob Ray', email: 'bob@x.nz' },                                  // two waiting CRM users share it → ambiguous, no candidate
    { id: 'e3', name: 'Ann Lee', email: 'someone.else@x.nz' },                         // same NAME as e1 — a name never matches
    { id: 'e4', name: 'Cy', email: 'cy@x.nz', crmUserId: 'u-cy' },
    { id: 'e5', name: 'Di', email: 'di@x.nz', crmUserId: 'u-di', accessDisabled: { by: 'crm' } },
    { id: 'e6', name: 'Ed', email: 'ED@x.nz' }, { id: 'e7', name: 'Edward', email: 'ed@x.nz' },   // a duplicate work email
  ];
  const r = h.employeeHealth(s);
  assert.equal(r.linked, 2); assert.equal(r.unlinked, 5); assert.equal(r.inactiveLinked, 1);
  assert.equal(r.conflicts, 2); assert.equal(r.ambiguous, 1);
  const by = id => r.unlinkedEmployees.find(u => u.id === id);
  assert.deepEqual(by('e1').candidate, { crmUserId: 'u-ann', email: 'ann@x.nz' });
  assert.equal(by('e2').candidate, null); assert.equal(by('e2').ambiguousCandidates, 2);
  assert.equal(by('e3').candidate, null, 'the same name is NOT a match');
  assert.deepEqual(r.duplicateEmails.map(d => d.email), ['ed@x.nz']);
  assert.ok(r.unlinkedEmployees.every(u => u.crmUserId === null));
});

test('customer health: link-back results, skipped contacts by reason, last success / failure', () => {
  const s = mk({
    counts: { customer: { skipped: 4, ambiguous: 1, conflict: 1, lastOk: ago(3), lastFail: { at: ago(1), outcome: 'conflict', note: 'x' } }, linkback: { updated: 5, error: 2, conflict: 1, lastOk: ago(2), lastFail: { at: ago(1), outcome: 'error', note: 'HTTP 403' } } },
    events: [
      { kind: 'customer', outcome: 'skipped', note: 'not a client yet: authority not signed' }, { kind: 'customer', outcome: 'skipped', note: 'PBQ not done yet' },
      { kind: 'customer', outcome: 'skipped', note: 'no change for client c1' }, { kind: 'customer', outcome: 'skipped', note: 'something odd' }, { kind: 'user', outcome: 'skipped', note: 'authority' },
    ],
  });
  s.clients = [{ id: 'c1', crmContactId: 'k1' }, { id: 'c2' }, { id: 'c3' }];
  const r = h.customerHealth(s);
  assert.equal(r.linked, 1); assert.equal(r.unlinked, 2); assert.equal(r.ambiguous, 1); assert.equal(r.conflicts, 2);
  assert.deepEqual(r.skipReasons, { 'Authority not signed': 1, 'PBQ incomplete': 1, 'Already linked': 1, Other: 1 });
  assert.deepEqual([r.linkBack.ok, r.linkBack.failed, r.linkBack.conflicts], [5, 2, 1]);
  assert.equal(r.lastSuccess, ago(3)); assert.equal(r.linkBack.lastFailure.note, 'HTTP 403');
});

test('staleness is judged by what is EXPECTED — a quiet system is not a broken one', () => {
  const quiet = mk({ counts: { attendance: { lastOk: ago(24 * 20) }, leave: { lastOk: ago(24 * 30) }, policy: { lastOk: ago(24 * 9) } } });
  const a = h.staleness(quiet, NOW);
  assert.equal(a.attendance.status, 'ok', 'attendance is only stale once ET-CRM IS the source');
  assert.equal(a.leave.status, 'ok', 'leave is never "stale": it arrives only when someone books it');
  const on = mk({ counts: { attendance: { lastOk: ago(80) } }, cutover: { attendance: true } });
  assert.equal(h.staleness(on, NOW).attendance.status, 'stale', '80 hours with no attendance while ET-CRM is the source');
  assert.equal(h.staleness(mk({ counts: { attendance: { lastOk: ago(70) } }, cutover: { attendance: true } }), NOW).attendance.status, 'ok', '70 hours is still fine');
  assert.equal(h.staleness(mk(), NOW).attendance.status, 'never'); assert.equal(h.staleness(mk(), NOW).leave.status, 'never');
  assert.equal(h.staleness(mk({ lastReconcile: { policy: ago(5) } }), NOW).policy.lastReconcile, ago(5));
});

test('alerts: one temporary failure is silent; repeated ones are raised, with plain advice', () => {
  const ev = (n, note, extra) => Array.from({ length: n }, (_, i) => ({ at: ago(i / 60), kind: 'user', outcome: 'error', note, ...(extra || {}) }));
  assert.deepEqual(h.alertCandidates(mk({ events: ev(1, 'rejected: bad secret') }), NOW), [], 'a single bad call is not an alert');
  assert.deepEqual(h.alertCandidates(mk({ events: ev(4, 'rejected: bad secret') }), NOW), [], 'four is still quiet');
  const five = h.alertCandidates(mk({ events: ev(5, 'rejected: bad secret') }), NOW);
  assert.deepEqual(five.map(a => a.key), ['crm_secret']); assert.match(five[0].text, /secret does not match/);
  assert.ok(!h.alertCandidates(mk({ events: ev(5, 'rejected: bad secret').map(e => ({ ...e, at: ago(5) })) }), NOW).length, 'refusals from 5 hours ago are old news');
  const api = h.alertCandidates(mk({ events: ev(3, 'link-back failed: HTTP 401', { kind: 'linkback' }) }), NOW);
  assert.deepEqual(api.map(a => a.key), ['crm_api']);
  const unl = {}; for (let i = 0; i < 5; i++) unl['u' + i] = { key: 'u' + i };
  assert.deepEqual(h.alertCandidates(mk({ unlinked: unl }), NOW).map(a => a.key), ['crm_unlinked']);
  assert.deepEqual(h.alertCandidates(mk({ counts: { linkback: { lastFail: { at: ago(2), outcome: 'conflict', note: 'x' } } } }), NOW).map(a => a.key), ['crm_conflicts']);
  assert.deepEqual(h.alertCandidates(mk({ counts: { attendance: { lastOk: ago(100) } }, cutover: { attendance: true } }), NOW).map(a => a.key), ['crm_stale_attendance']);
  assert.deepEqual(h.alertCandidates(mk({ counts: { attendance: { lastOk: ago(100) } } }), NOW), [], 'no stale alert while ET-CRM is not the source');
});

test('the one-click check: Healthy / Needs Attention / Not Configured, honest about what it cannot test, never writes', () => {
  const s = mk({ counts: { user: { created: 3, lastOk: ago(1) }, attendance: { updated: 4, lastOk: ago(2) }, leave: { updated: 1, lastOk: ago(30) }, customer: { updated: 2, lastOk: ago(5) }, policy: { updated: 1, lastOk: ago(9) } } });
  s.employees = [{ id: 'e1', name: 'A', email: 'a@x.nz', crmUserId: 'u1' }];
  const before = JSON.stringify(s);
  const ctx = (o) => ({ nowMs: NOW, secretConfigured: true, apiUrlConfigured: true, apiKeyConfigured: true, probes: { policy: { ok: true }, pipeline: { ok: true } }, ...(o || {}) });
  const ok = h.buildCheck(s, ctx());
  assert.equal(ok.status, 'healthy', JSON.stringify(ok.checks.filter(c => c.status !== 'ok' && c.status !== 'info')));
  assert.ok(ok.checks.find(c => c.key === 'legacy_task' && c.status === 'ok'), 'legacy CRM task sync reported as disabled');
  assert.ok(ok.checks.find(c => c.key === 'api_linkback').detail.match(/Not testable without writing/), 'link-back is never probed — it writes');
  assert.equal(h.buildCheck(s, ctx({ probes: { policy: { ok: false, error: 'ET-CRM refused the API key (401).' }, pipeline: null } })).status, 'needs_attention');
  assert.equal(h.buildCheck(s, ctx({ apiKeyConfigured: false, probes: null })).status, 'needs_attention', 'no API key is a warning');
  assert.equal(h.buildCheck(s, ctx({ secretConfigured: false })).checks.find(c => c.key === 'secret').status, 'fail');
  assert.equal(h.buildCheck(mk(), ctx({ secretConfigured: false, apiKeyConfigured: false, probes: null })).status, 'not_configured');
  const text = JSON.stringify(ok);
  assert.ok(!/secret-value|sk_|Bearer/i.test(text));
  assert.equal(JSON.stringify(s), before, 'READ-ONLY: the state is untouched');
});

test('ownership labels make the rule explicit', () => {
  assert.deepEqual(h.OWNERSHIP.filter(o => o.source === 'ET-CRM').map(o => o.area), ['Employees', 'Customers', 'Attendance', 'Leave', 'Policy compliance']);
  assert.deepEqual(h.OWNERSHIP.filter(o => o.source === 'Task Manager').map(o => o.area), ['Tasks']);
});
