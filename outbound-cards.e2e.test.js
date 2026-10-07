// EVERY outbound call gets a Slack card (answered or not); inbound calls nobody answered and voicemails stay silent.
// The server runs with a fake Slack token, so every card attempt FAILS — and each attempt is counted on /webhooks/health
// (`sinceBoot.cardFails`), which is how this test sees whether a card was tried without calling the real Slack.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-outcards-'));
const TOKEN = 'tok-' + Math.random().toString(36).slice(2);
let child;
const run = () => spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, NODE_ENV: 'test', AIRCALL_WEBHOOK_TOKEN: TOKEN, SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_CHANNEL: 'C123' } });
const up = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 400)); } throw new Error('server did not start'); };
const health = async () => (await (await fetch(base + '/webhooks/health')).json()).aircallDelivery;
const call = (id, direction, { answered, voicemail, agent } = {}) => fetch(base + '/webhooks/aircall', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, event: 'call.ended', data: { id, direction, duration: 40, raw_digits: '+642155500' + (id % 10) + String(id).padStart(2, '0'), answered_at: answered ? 1 : null, missed_call_reason: voicemail ? 'voicemail' : null, user: { id: agent || 77, name: 'Agent X' } } }) });
async function settle(fails, calls) { for (let i = 0; i < 40; i++) { const d = await health(); if (d.sinceBoot.cardFails >= fails && d.last24h.calls >= calls) return d; await new Promise(r => setTimeout(r, 250)); } return health(); }

test.before(async () => {
  child = run(); await up(); child.kill(); await new Promise(r => setTimeout(r, 800));
  const f = path.join(dir, 'db.json'), st = JSON.parse(fs.readFileSync(f, 'utf8'));
  st.agentMap = { '77': { name: 'Agent X', team: 'Rideshare + Rental', employeeIds: [], mandatory: false } };   // agent 77 is mapped, 88 is not
  fs.writeFileSync(f, JSON.stringify(st));
  child = run(); await up();
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

test('inbound: an answered call gets a card; a missed call and a voicemail do not', async () => {
  await call(1, 'inbound', { answered: true });
  let d = await settle(1, 1); assert.equal(d.sinceBoot.cardFails, 1, 'answered inbound → a card was tried');
  await call(2, 'inbound', {}); await call(3, 'inbound', { voicemail: true });
  d = await settle(1, 3); await new Promise(r => setTimeout(r, 600)); d = await health();
  assert.equal(d.sinceBoot.cardFails, 1, 'missed inbound and voicemail → no card');
  assert.equal(d.last24h.calls, 3);
});

test('outbound: answered, not answered AND voicemail all get a card', async () => {
  await call(11, 'outbound', { answered: true });
  let d = await settle(2, 4); assert.equal(d.sinceBoot.cardFails, 2, 'answered outbound');
  await call(12, 'outbound', {});
  d = await settle(3, 5); assert.equal(d.sinceBoot.cardFails, 3, 'the customer did not pick up — still a card');
  await call(13, 'outbound', { voicemail: true });
  d = await settle(4, 6); assert.equal(d.sinceBoot.cardFails, 4, 'it went to voicemail — still a card');
});

test('calling the same customer twice in a row is two calls with two cards (a redial is not a transfer)', async () => {
  const same = (id) => fetch(base + '/webhooks/aircall', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, event: 'call.ended', data: { id, direction: 'outbound', duration: 20, raw_digits: '+64219990000', answered_at: null, user: { id: 77, name: 'Agent X' } } }) });
  await same(21); await settle(5, 7); await same(22);
  const d = await settle(6, 8);
  assert.equal(d.last24h.calls, 8, 'both attempts are kept'); assert.equal(d.sinceBoot.cardFails, 6);
});

test('an unmapped agent still gets no card (there is nobody to route it to) — and the health page counts it separately', async () => {
  const before = (await health()).sinceBoot.cardFails;
  await call(31, 'outbound', { answered: true, agent: 88 });
  const d = await settle(before, 9); await new Promise(r => setTimeout(r, 500));
  assert.equal((await health()).sinceBoot.cardFails, before);
  assert.equal(d.last24h.answeredButAgentNotMapped >= 1, true);
});

test('the card for an unanswered outbound call says so, offers follow-up buttons, and is not a "listen" item', () => {
  const c = require('./connector');
  const state = { employees: [], agentMap: { '77': { name: 'Agent X', team: 'Rideshare + Rental', employeeIds: [] } } };
  const row = { id: 'call9', direction: 'outbound', status: 'not_picked_up', team: 'Rideshare + Rental', agentName: 'Agent X', agentAircallId: '77', clientName: 'Acme', callerPhone: '64211234567', durationSec: 12 };
  const p = c.callCardPreview(state, row, 'ended');
  assert.match(p.header, /Outbound — Not Answered/); assert.match(p.header, /Outbound/);
  assert.match(p.text, /Not Answered/);
  const vm = c.callCardPreview(state, { ...row, status: 'voicemail' }, 'ended');
  assert.match(vm.header, /Went to Voicemail/);
});
