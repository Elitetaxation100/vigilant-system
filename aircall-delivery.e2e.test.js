// The Aircall hook on a REAL server: a wrong token is rejected AND counted, a right one is accepted, and /webhooks/health tells
// "nothing arriving" from "arriving but rejected" from "arriving but not routable" — counts only, no names or numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = 3100 + Math.floor(Math.random() * 800);
const base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-aircall-'));
let child;
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const health = async () => (await (await fetch(base + '/webhooks/health')).json());
const hook = (token, body) => fetch(base + '/webhooks/aircall', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...body }) });
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, NODE_ENV: 'test', AIRCALL_WEBHOOK_TOKEN: TOKEN } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
});
test.after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

test('before anything arrives the health page says so', async () => {
  const d = (await health()).aircallDelivery;
  assert.equal(d.sinceBoot.accepted, 0); assert.equal(d.sinceBoot.rejected, 0); assert.equal(d.sinceBoot.lastInAt, null);
  assert.equal(d.last24h.calls, 0); assert.equal(d.last24h.lastCallAt, null);
});

test('a wrong token is refused with 401 and COUNTED, with the reason; the right token is accepted', async () => {
  assert.equal((await hook('nope', { event: 'call.ended', data: { id: 1 } })).status, 401);
  let d = (await health()).aircallDelivery.sinceBoot;
  assert.equal(d.rejected, 1); assert.equal(d.lastRejectWhy, 'bad token'); assert.ok(d.lastRejectedAt); assert.equal(d.accepted, 0);
  assert.equal((await hook(TOKEN, { event: 'call.ended', data: { id: 2, direction: 'inbound', raw_digits: '+64211234567', duration: 30, answered_at: 1, user: { id: 99999, name: 'Nobody Mapped' } } })).status, 200);
  d = (await health()).aircallDelivery.sinceBoot;
  assert.equal(d.accepted, 1); assert.equal(d.lastEvent, 'call.ended'); assert.ok(d.lastInAt);
});

test('an answered call from an agent nobody is mapped to is saved but gets no card — and the health page shows exactly that', async () => {
  for (let i = 0; i < 20; i++) { const d = (await health()).aircallDelivery.last24h; if (d.calls >= 1) break; await new Promise(r => setTimeout(r, 250)); }
  const d = (await health()).aircallDelivery.last24h;
  assert.equal(d.calls, 1); assert.equal(d.answered, 1); assert.equal(d.answeredButAgentNotMapped, 1);
  assert.equal(d.cardsPosted, 0); assert.equal(d.cardsMissing, 0, 'unmapped is its own bucket, not a "missing card"');
  assert.ok(d.lastCallAt);
  assert.doesNotMatch(JSON.stringify(await health()), /Nobody Mapped|64211234567/, 'no names or numbers on the public page');
});

test('outbound calls are recorded like inbound ones and shown separately; the newest calls are listed without names or numbers', async () => {
  assert.equal((await hook(TOKEN, { event: 'call.ended', data: { id: 3, direction: 'outbound', raw_digits: '+64219998888', duration: 0, user: { id: 99999, name: 'Nobody Mapped' } } })).status, 200);   // the customer did not pick up
  assert.equal((await hook(TOKEN, { event: 'call.ended', data: { id: 4, direction: 'outbound', raw_digits: '+64217776666', duration: 45, answered_at: 5, user: { id: 99998, name: 'Other Unmapped' } } })).status, 200);
  for (let i = 0; i < 20; i++) { if ((await health()).aircallDelivery.last24h.calls >= 3) break; await new Promise(r => setTimeout(r, 250)); }
  const D = (await health()).aircallDelivery;
  const out = D.last24h.byDirection.outbound;
  assert.equal(out.calls, 2); assert.equal(out.notPickedUp, 1); assert.equal(out.answered, 1);
  assert.equal(D.last24h.byDirection.inbound.calls, 1);
  assert.equal(D.latest.length, 3); assert.ok(D.latest.every(x => 'direction' in x && 'status' in x && 'card' in x));
  assert.ok(D.latest.some(x => x.direction === 'outbound' && x.status === 'ended' && x.mapped === false), 'an answered outbound call from an unmapped agent is saved, with no card');
  assert.doesNotMatch(JSON.stringify(D), /Unmapped|64219998888|64217776666/);
});

test('every Aircall event leaves a line in the event log saying what we did with it — saved, duplicate, merged, ignored or failed', async () => {
  const D = (await health()).aircallDelivery;
  assert.ok(Array.isArray(D.events) && D.events.length >= 3, 'events are listed');
  const results = D.events.map(e => e.result);
  assert.ok(results.some(r => /^saved as call\d+ \(ended, agent not mapped, no card\)/.test(r)), JSON.stringify(results));
  assert.ok(results.some(r => /not_picked_up/.test(r)), 'a missed call says so');
  assert.ok(D.events.every(e => e.at && 'event' in e && 'direction' in e && 'answered' in e && 'agentMapped' in e));
  await hook(TOKEN, { event: 'call.ended', data: { id: 2, direction: 'outbound', raw_digits: '+64211234567', duration: 30, answered_at: 1, user: { id: 99999, name: 'Nobody Mapped' } } });
  await new Promise(r => setTimeout(r, 500));
  assert.match((await health()).aircallDelivery.events[0].result, /duplicate/, 'a call we already have is reported as a duplicate, not silently dropped');
  await hook(TOKEN, { event: 'call.something_else', data: { id: 77 } });
  await new Promise(r => setTimeout(r, 400));
  assert.match((await health()).aircallDelivery.events[0].result, /ignored/);
  assert.doesNotMatch(JSON.stringify((await health()).aircallDelivery.events), /Nobody Mapped|64211234567/);
});
