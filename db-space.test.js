// The space report and the clean-up: what is using the database, and giving back what Postgres holds.
// A fake `pg` answers the size queries; the point is the shape, the safety (a probe that is not allowed
// must not break the report) and that clean-up flushes first and reports before/after.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-space-'));
process.env.TM_DATA_DIR = dir;
process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.PG_SAVE_DELAY_MS = '60000'; // so nothing is written unless flush() is called
delete process.env.DB_MODE;

const fake = { row: null, sql: [], dbBytes: 900 * 1048576, denyWal: false, vacuumFails: false };
class Pool {
  async query(sql, params) {
    const q = sql.replace(/\s+/g, ' ').trim();
    fake.sql.push(q);
    if (/^CREATE TABLE|^ALTER TABLE/i.test(q)) return { rows: [] };
    if (/SELECT data, rev/i.test(q)) return { rows: fake.row ? [fake.row] : [] };
    if (/INSERT INTO app_state/i.test(q)) { fake.row = { data: JSON.parse(params[0]), rev: Number(params[1]) || 0 }; return { rows: [] }; }
    if (/pg_database_size/i.test(q)) return { rows: [{ b: fake.dbBytes }] };
    if (/pg_total_relation_size\('app_state'\)/i.test(q)) return { rows: [{ total: 300 * 1048576, main: 8192, toast: 299 * 1048576 }] };
    if (/app_files/i.test(q) && /count/i.test(q)) return { rows: [{ total: 5 * 1048576, n: 7 }] };
    if (/pg_stat_user_tables/i.test(q)) return { rows: [{ n_dead_tup: '42', last_autovacuum: '2026-10-06T01:00:00Z', last_vacuum: null, autovacuum_count: '9' }] };
    if (/pg_ls_waldir/i.test(q)) { if (fake.denyWal) throw new Error('permission denied for function pg_ls_waldir'); return { rows: [{ n: 4, b: 64 * 1048576 }] }; }
    if (/pg_replication_slots/i.test(q)) return { rows: [] };
    if (/^SHOW max_wal_size/i.test(q)) return { rows: [{ max_wal_size: '1GB' }] };
    if (/pg_stat_activity/i.test(q)) return { rows: [{ n: 0, oldest_s: 0 }] };
    if (/^VACUUM/i.test(q)) { if (fake.vacuumFails) throw new Error('could not extend file: No space left on device'); fake.dbBytes = 120 * 1048576; return { rows: [] }; }
    if (/^CHECKPOINT/i.test(q)) throw new Error('must be superuser to do CHECKPOINT');
    return { rows: [] };
  }
}
const realLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'pg' ? { Pool } : realLoad.call(this, request, ...rest); };
const db = require('./db');
test.after(() => { Module._load = realLoad; try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

test('the report says what is big, in MB, and what Postgres is holding', async () => {
  await db.init();
  const r = await db.spaceReport();
  assert.equal(r.mode, 'postgres');
  assert.ok(Array.isArray(r.biggestInState) && r.biggestInState.length > 0, 'the biggest parts of the state are listed');
  assert.ok(r.biggestInState.every(x => typeof x.key === 'string' && x.kb >= 0));
  assert.equal(r.database.totalMB, 900);
  assert.equal(r.database.appStateMB, 300);
  assert.equal(r.database.appStateToastMB, 299);
  assert.equal(r.database.appFilesCount, 7);
  assert.equal(r.database.deadRowVersions, 42);
  assert.equal(r.database.walMB, 64);
  assert.equal(r.database.maxWalSize, '1GB');
  assert.deepEqual(r.database.replicationSlots, []);
});

test('a probe Postgres will not allow does not break the report', async () => {
  fake.denyWal = true;
  const r = await db.spaceReport();
  fake.denyWal = false;
  assert.equal(r.database.walMB, null, 'unknown, not an error');
  assert.equal(r.database.totalMB, 900, 'everything else is still there');
});

test('clean-up writes pending changes first, shrinks the table, and reports before and after', async () => {
  fake.dbBytes = 900 * 1048576; fake.sql.length = 0;
  db.get().cleanupProbe = 'pending'; db.save();
  const r = await db.maintenance();
  assert.equal(r.ok, true);
  assert.equal(r.beforeMB, 900); assert.equal(r.afterMB, 120);
  assert.equal(fake.row.data.cleanupProbe, 'pending', 'nothing waiting was left behind');
  assert.ok(fake.sql.some(q => /^VACUUM \(FULL, ANALYZE\) app_state$/.test(q)), 'only the one-row state table is rewritten');
  assert.ok(!fake.sql.some(q => /^VACUUM/i.test(q) && !/app_state/.test(q)), 'no other table is touched');
  assert.ok(r.steps.some(s => /checkpoint/.test(s)), 'the checkpoint is attempted, and its refusal is harmless');
});

test('if the clean-up itself cannot run, it says so and does not throw', async () => {
  fake.vacuumFails = true;
  const r = await db.maintenance();
  fake.vacuumFails = false;
  assert.equal(r.ok, true);
  assert.ok(r.steps.some(s => /No space left/.test(s)));
});

test('volumeUsage: every database plus the write-ahead log, against DB_VOLUME_MB (default 5 GB)', async () => {
  fake.dbBytes = 1000 * 1048576;
  delete process.env.DB_VOLUME_MB;
  const u = await db.volumeUsage();
  assert.equal(u.usedMB, 1064);                       // 1000 MB of databases + the 64 MB log in the fake
  assert.equal(u.volumeMB, 5120); assert.equal(u.pct, 20.8);
  process.env.DB_VOLUME_MB = '2048';
  assert.equal((await db.volumeUsage()).pct, 52);
  delete process.env.DB_VOLUME_MB;
  const rep = await db.spaceReport();
  assert.ok(rep.volume && rep.volume.usedMB === 1064, 'the space report carries it too');
});
