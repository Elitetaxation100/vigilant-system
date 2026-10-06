// A Gmail re-sync must not bring back mail from a month that was archived — but a month that was NOT archived (a brand-new
// mailbox, the old test fixtures) loads as it always did. Uses the fixture mailbox (mail dated November 2023).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-archgmail-'));
process.env.TM_DATA_DIR = dir; delete process.env.DATABASE_URL;
const db = require('./db');
const connector = require('./connector');
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
const BOX = 'selfemployed@elitetaxation.co.nz';

test('with the month NOT archived the old mail loads normally', async () => {
  await db.init();
  const s = db.get(); s.emails = []; s.emailPollCursor = {};
  const r = await connector.pollGmailMailbox(BOX, 'e1');
  assert.ok(r.ok !== false); assert.ok(s.emails.length > 0, 'fixture mail was ingested');
});
test('once that month is archived, a re-sync does NOT bring it back', async () => {
  const s = db.get(); s.emails = []; s.emailPollCursor = {};
  s.archives = [{ kind: 'emails', month: '2023-11', fileId: 'f_000000000000000000000000', count: 3 }];
  await connector.pollGmailMailbox(BOX, 'e1');
  assert.equal(s.emails.length, 0, 'mail from the archived month stays archived');
});
