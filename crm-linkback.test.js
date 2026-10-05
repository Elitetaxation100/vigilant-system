// The link-back to ET-CRM: right action, right payload, conflicts are reported (never forced).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-linkback-'));
process.env.TM_DATA_DIR = dir; // a throwaway data folder — never the real one
const db = require('./db');
const connector = require('./connector');

test.before(async () => { await db.init(); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

const lastEvent = () => db.get().crmSync.events[0];

test('link-back calls link-task-manager-client with the contact id and our client id', async () => {
  const calls = [];
  const r = await connector.doLinkBack({ crmContactId: 'k1', clientId: 'c42' }, async (action, fields) => { calls.push({ action, fields }); return { ok: true, result: {} }; });
  assert.deepEqual(calls, [{ action: 'link-task-manager-client', fields: { id: 'k1', task_manager_client_id: 'c42' } }]);
  assert.equal(r.outcome, 'updated');
  assert.equal(lastEvent().kind, 'linkback'); assert.equal(lastEvent().outcome, 'updated'); assert.equal(lastEvent().crmId, 'k1');
});

test('an ET-CRM conflict is reported as a conflict — not retried, not forced', async () => {
  let n = 0;
  const r = await connector.doLinkBack({ crmContactId: 'k2', clientId: 'c43' }, async () => { n++; return { ok: false, error: 'Conflict: contact already linked to a different task_manager_client_id' }; });
  assert.equal(n, 1, 'one attempt only');
  assert.equal(r.outcome, 'conflict');
  assert.equal(lastEvent().outcome, 'conflict');
  assert.equal(db.get().crmSync.counts.linkback.conflict, 1);
});

test('an ET-CRM that does not offer the action yet, or is unreachable, is an error we can see', async () => {
  const a = await connector.doLinkBack({ crmContactId: 'k3', clientId: 'c44' }, async () => ({ ok: false, error: 'unknown action' }));
  assert.equal(a.outcome, 'error'); assert.match(a.note, /does not offer link-task-manager-client/);
  const b = await connector.doLinkBack({ crmContactId: 'k4', clientId: 'c45' }, async () => ({ ok: false, error: 'CRM_API_KEY not set' }));
  assert.equal(b.outcome, 'error');
  assert.ok(db.get().crmSync.counts.linkback.lastFail);
});
