// Recovering calls Aircall never delivered: a dry run changes nothing; a real run stores each call with its REAL time,
// skips ones we already have, merges transfer legs as a live webhook would, leaves ringing calls alone, and flags
// the calls so the automatic acknowledgement marks never penalise anyone for them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-recover-'));
process.env.TM_DATA_DIR = dir; // never the real data
delete process.env.DATABASE_URL;
const db = require('./db');
const connector = require('./connector');
const crmSync = require('./crm-sync');
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

const day = connector.__nzToday ? connector.__nzToday() : new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
const unix = hhmm => Math.floor(new Date(crmSync.nzLocalToISO(day, hhmm)).getTime() / 1000);
const mk = (id, startHHMM, mins, extra) => ({ id, direction: 'inbound', raw_digits: '+6421' + String(1000000 + id), user: { id: 7777, name: 'Late Agent' },
  started_at: unix(startHHMM), answered_at: unix(startHHMM) + 5, ended_at: unix(startHHMM) + mins * 60, duration: mins * 60, ...(extra || {}) });
const calls = [
  mk(501, '08:10', 4), mk(502, '09:30', 2), mk(503, '11:00', 6),
  mk(504, '12:00', 1, { answered_at: null, missed_call_reason: 'no_available_agent' }),   // not picked up
  mk(505, '13:00', 3, { voicemail: 'https://example/vm.mp3' }),                           // a voicemail
  mk(506, '14:00', 3, { ended_at: null }),                                                // still ringing
];
const pages = list => async (from, to, page) => ({ calls: page === 1 ? list.slice(0, 4) : list.slice(4), meta: { next_page_link: page === 1 ? 'next' : null } });

test.before(async () => { await db.init(); });

test('a dry run lists what would come back and stores nothing', async () => {
  const before = db.get().calls.length;
  const r = await connector.recoverCalls({ day, fetchPage: pages(calls) });          // dryRun defaults to TRUE
  assert.equal(r.dryRun, true);
  assert.equal(r.found, 6); assert.equal(r.stillRinging, 1); assert.equal(r.wouldRecover, 5);
  assert.equal(r.recovered, 0); assert.equal(db.get().calls.length, before, 'nothing was stored');
  assert.deepEqual(r.calls.map(c => c.status), ['ended', 'ended', 'ended', 'not_picked_up', 'voicemail'], 'in call order, with what each would be');
  assert.equal(r.voicemails, 1); assert.equal(r.notPickedUp, 1);
});

test('a real run stores each call with its REAL time, flagged as recovered; ringing calls are left alone', async () => {
  const r = await connector.recoverCalls({ day, dryRun: false, fetchPage: pages(calls), pauseMs: 0 });
  assert.equal(r.recovered, 5); assert.deepEqual(r.errors, []);
  const rows = db.get().calls.filter(c => c.recovered);
  assert.equal(rows.length, 5);
  const by = id => rows.find(c => c.aircallId === String(id));
  assert.equal(by(501).occurredAt, new Date((unix('08:10') + 4 * 60) * 1000).toISOString(), 'the time the call really ended, not "now"');
  assert.equal(by(503).occurredAt, new Date((unix('11:00') + 6 * 60) * 1000).toISOString());
  assert.equal(by(504).status, 'not_picked_up');
  assert.equal(by(505).status, 'voicemail');
  assert.ok(!rows.some(c => c.aircallId === '506'), 'a call still ringing is not stored');
  assert.equal(by(501).agentName, 'Late Agent');
});

test('running it again adds nothing — safe to repeat', async () => {
  const n = db.get().calls.length;
  const r = await connector.recoverCalls({ day, dryRun: false, fetchPage: pages(calls), pauseMs: 0 });
  assert.equal(r.recovered, 0); assert.equal(r.alreadyHad, 5); assert.equal(db.get().calls.length, n);
});

test('calls we already had from the live webhook are skipped, not duplicated', async () => {
  const s = db.get();
  s.calls.push({ id: 'callX', aircallId: '601', occurredAt: new Date().toISOString(), status: 'ended', team: 'Unmapped', stub: false });
  const r = await connector.recoverCalls({ day, dryRun: false, fetchPage: async () => ({ calls: [mk(601, '15:00', 2)], meta: {} }), pauseMs: 0 });
  assert.equal(r.alreadyHad, 1); assert.equal(r.recovered, 0);
  assert.equal(s.calls.filter(c => c.aircallId === '601').length, 1);
});

test('two legs of one transferred call merge into one row, judged at the call\'s own time', async () => {
  const leg1 = mk(701, '16:00', 1, { answered_at: null, missed_call_reason: 'agent_did_not_answer', raw_digits: '+64219990001' });
  const leg2 = mk(702, '16:00', 5, { raw_digits: '+64219990001', started_at: unix('16:01'), answered_at: unix('16:01') + 3, ended_at: unix('16:01') + 300 });
  const before = db.get().calls.length;
  const r = await connector.recoverCalls({ day, dryRun: false, fetchPage: async () => ({ calls: [leg1, leg2], meta: {} }), pauseMs: 0 });
  assert.equal(r.recovered, 2, 'both legs were processed');
  assert.equal(db.get().calls.length, before + 1, 'but they became ONE call row, as a live webhook would');
});

test('the acknowledgement marks do not count recovered calls — nobody is penalised for a call Slack never showed', () => {
  const at = hhmm => crmSync.nzLocalToISO(day, hhmm);
  const st = { employees: [{ id: 'e1', name: 'Ann', slackUserId: 'U1' }], agentMap: { 42: { name: 'Line', team: 'GST', employeeIds: ['e1'] } }, emailIgnoredSenders: [], emails: [],
    calls: [
      { id: 'c1', aircallId: '1', agentAircallId: '42', status: 'ended', occurredAt: at('09:00'), listenedBy: 'e1', listenedAt: at('09:05') },            // a live call, handled
      { id: 'c2', aircallId: '2', agentAircallId: '42', status: 'ended', occurredAt: at('10:00'), recovered: true },                                     // recovered, nobody saw it
      { id: 'c3', aircallId: '3', agentAircallId: '42', status: 'ended', occurredAt: at('11:00'), recovered: true },
    ] };
  const ann = opts => connector.callsEmailsStats(st, day, day, opts).people.find(p => p.id === 'e1');
  assert.deepEqual([ann({}).calls.total, ann({}).calls.notAck], [3, 2], 'the daily report still counts all three');
  assert.deepEqual([ann({ excludeRecovered: true }).calls.total, ann({ excludeRecovered: true }).calls.notAck], [1, 0], 'the acknowledgement check sees only the live call');
});

test('another leg of a call we already have (same caller, a different Aircall id) is skipped, not duplicated; two genuine calls in one run are both kept', async () => {
  const st = db.get();
  st.calls.push({ id: 'callL', aircallId: '800', callerPhone: '215550001', occurredAt: new Date((unix('17:00') + 120) * 1000).toISOString(), status: 'ended', team: 'GST', stub: false });
  const before = st.calls.length;
  const leg = mk(801, '17:00', 1, { raw_digits: '+64215550001', answered_at: null, missed_call_reason: 'agent_did_not_answer' });            // another leg of the call we have
  const a1 = mk(802, '18:00', 2, { raw_digits: '+64215550002' });
  const a2 = mk(803, '18:05', 2, { raw_digits: '+64215550002', started_at: unix('18:05') });                                                  // same person calls again 5 min later
  const dry = await connector.recoverCalls({ day, fetchPage: async () => ({ calls: [leg, a1, a2], meta: {} }) });
  assert.equal(dry.mergedLegs, 1); assert.equal(dry.wouldRecover, 2, 'the dry run and the real run agree');
  const r = await connector.recoverCalls({ day, dryRun: false, fetchPage: async () => ({ calls: [leg, a1, a2], meta: {} }), pauseMs: 0 });
  assert.equal(r.mergedLegs, 1); assert.equal(r.recovered, 2);
  assert.equal(st.calls.length, before + 2, 'no duplicate for the leg; both genuine calls stored');
  assert.ok(dry.calls[0].caller.startsWith('…'), 'the report shows only the last 4 digits of a number');
});
test('a failure from Aircall is reported, not swallowed', async () => {
  await assert.rejects(connector.recoverCalls({ day, fetchPage: async () => { throw new Error('Aircall answered 401'); } }), /401/);
});
