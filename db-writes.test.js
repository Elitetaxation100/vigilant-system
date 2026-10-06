// Postgres write load: the app used to write the whole state on EVERY save (~2,800 times a day), which
// filled the database volume. Saves are now coalesced, skipped when unchanged, retried on failure, and
// flushed on demand. A fake `pg` stands in for the real database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dbw-'));
process.env.TM_DATA_DIR = dir;                   // never the real data
process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.PG_SAVE_DELAY_MS = '60';
delete process.env.DB_MODE;

// ---- a fake pg: one row, counts the writes ----
const fake = { row: null, writes: 0, fail: 0, queries: [] };
class Pool {
  async query(sql, params) {
    fake.queries.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40));
    if (/^\s*CREATE TABLE|^\s*ALTER TABLE/i.test(sql)) return { rows: [] };
    if (/SELECT data, rev/i.test(sql)) return { rows: fake.row ? [fake.row] : [] };
    if (/INSERT INTO app_state/i.test(sql)) {
      if (fake.fail > 0) { fake.fail--; throw new Error('No space left on device'); }
      if (/ON CONFLICT \(id\) DO NOTHING/i.test(sql)) { fake.row = { data: JSON.parse(params[0]), rev: 0 }; return { rows: [] }; }
      fake.writes++; fake.row = { data: JSON.parse(params[0]), rev: Number(params[1]) };
      return { rows: [] };
    }
    return { rows: [] };
  }
}
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'pg' ? { Pool } : realLoad.call(this, request, ...rest); };

const db = require('./db');
test.after(() => { Module._load = realLoad; try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('many saves inside the window become ONE write of the newest state', async () => {
  await db.init();
  assert.equal(db._mode(), 'postgres');
  await db.flush();
  const before = fake.writes;
  const s = db.get();
  for (let i = 0; i < 50; i++) { s.writeTestCounter = i; db.save(); }
  assert.equal(fake.writes, before, 'nothing is written synchronously');
  await sleep(200);
  assert.equal(fake.writes, before + 1, '50 saves → 1 write');
  assert.equal(fake.row.data.writeTestCounter, 49, 'and it is the NEWEST state');
});

test('a save that changed nothing is not written at all', async () => {
  await db.flush();
  const before = fake.writes;
  for (let i = 0; i < 10; i++) db.save();
  await db.flush();
  assert.equal(fake.writes, before, 'identical state → no write');
  assert.ok(db._pgStats().skipped >= 1);
});

test('flush() puts pending changes into Postgres immediately (what shutdown and imports rely on)', async () => {
  const s = db.get();
  s.flushProbe = 'x'; db.save();
  assert.notEqual(fake.row.data.flushProbe, 'x', 'still pending');
  await db.flush();
  assert.equal(fake.row.data.flushProbe, 'x');
  assert.equal(db._pgStats().pending, false);
});

test('a failed write is reported and RETRIED until it lands — nothing is dropped', async () => {
  const s = db.get();
  s.retryProbe = 'kept'; fake.fail = 1; db.save();
  await db.flush();
  const st = db._pgStats();
  assert.equal(st.consecutiveFailures, 1); assert.match(st.lastError, /No space left/); assert.ok(st.lastErrorAt);
  assert.equal(st.pending, true, 'the state is still waiting for the retry');
  await db.flush();                                   // the retry
  assert.equal(fake.row.data.retryProbe, 'kept');
  assert.equal(db._pgStats().consecutiveFailures, 0);
});

test('autovacuum is tuned on the one-row table at start-up', () => {
  assert.ok(fake.queries.some(q => /^ALTER TABLE app_state/i.test(q)));
});

test('the local file mirror is still written on every save', async () => {
  db.get().mirrorProbe = 'now'; db.save();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert.equal(onDisk.mirrorProbe, 'now');
  await db.flush();
});
