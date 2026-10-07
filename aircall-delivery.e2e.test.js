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
