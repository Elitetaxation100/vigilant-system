// Archive: old calls / emails / WhatsApp messages move out of the state into monthly files — safely — and the disk watch
// decides when to warn. A real file store on a throwaway folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('./files');
const archive = require('./archive');
const watch = require('./space-watch');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-archive-'));
files.init({ _mode: () => 'file', _dataDir: () => dir });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

const NOW = '2026-10-06T00:00:00Z';
const ago = d => new Date(new Date(NOW).getTime() - d * 86400000).toISOString();
const mkState = () => ({
  calls: [{ id: 'c1', occurredAt: ago(200) }, { id: 'c2', occurredAt: ago(130) }, { id: 'c3', occurredAt: ago(130) }, { id: 'c4', occurredAt: ago(96) }, { id: 'c5', occurredAt: ago(94) }, { id: 'c6', occurredAt: ago(1) }, { id: 'stub', occurredAt: ago(300), stub: true }],
  emails: [{ id: 'e1', occurredAt: ago(150) }, { id: 'e2', occurredAt: ago(2) }],
  waMessages: [{ id: 'w1', at: ago(120) }, { id: 'w2', at: ago(5) }],
});
let persists = 0, order = [];
const deps = () => ({ fileStore: { ...files, remove: async id => { order.push('remove'); return files.remove(id); } }, persist: async () => { persists++; order.push('persist'); } });
const read = async id => JSON.parse((await files.get(id)).data.toString('utf8'));

test('the window is 95 days by default, and ARCHIVE_AFTER_DAYS changes it', () => {
  assert.equal(archive.DEFAULT_DAYS, 95); assert.equal(archive.days(), 95);
  process.env.ARCHIVE_AFTER_DAYS = '30'; assert.equal(archive.days(), 30);
  process.env.ARCHIVE_AFTER_DAYS = 'junk'; assert.equal(archive.days(), 95);
  delete process.env.ARCHIVE_AFTER_DAYS;
  assert.equal(archive.cutoffISO(NOW, 95), ago(95));
});

test('a dry run says what would move and changes nothing', async () => {
  const s = mkState(), before = JSON.stringify(s);
  const r = await archive.run(s, deps(), { now: NOW, dryRun: true });
  assert.equal(r.dryRun, true); assert.equal(r.archived, 0);
  assert.equal(r.kinds.calls.found, 4, 'c1–c4 are older than 95 days; the stub and the recent ones are not');
  assert.equal(r.kinds.emails.found, 1); assert.equal(r.kinds.waMessages.found, 1);
  assert.equal(JSON.stringify(s), before, 'the state is untouched'); assert.equal(s.archives, undefined);
});

test('a real run moves ONLY the old ones into monthly files, keeps the rest, and indexes them', async () => {
  const s = mkState(); persists = 0; order = [];
  const r = await archive.run(s, deps(), { now: NOW });
  assert.deepEqual(r.errors, []); assert.equal(r.archived, 6);
  assert.deepEqual(s.calls.map(c => c.id), ['c5', 'c6', 'stub'], 'recent calls and a stub stay');
  assert.deepEqual(s.emails.map(e => e.id), ['e2']); assert.deepEqual(s.waMessages.map(w => w.id), ['w2']);
  const months = s.archives.map(a => a.kind + ' ' + a.month).sort();
  assert.deepEqual(months, ['calls 2026-03', 'calls 2026-05', 'calls 2026-07', 'emails 2026-05', 'waMessages 2026-06'].sort());
  const may = s.archives.find(a => a.kind === 'calls' && a.month === '2026-05');
  assert.deepEqual((await read(may.fileId)).items.map(i => i.id).sort(), ['c2', 'c3'], 'the file holds the records, whole');
  assert.equal(may.count, 2); assert.ok(may.bytes > 0);
  assert.ok(persists >= 5, 'the state is saved after every month');
});

test('running again changes nothing; a later run MERGES into the month file without duplicates', async () => {
  const s = mkState();
  await archive.run(s, deps(), { now: NOW });
  const again = await archive.run(s, deps(), { now: NOW });
  assert.equal(again.archived, 0);
  // two more records from the same month turn up later (and one that is already in the file)
  s.calls.push({ id: 'c7', occurredAt: ago(131) }, { id: 'c2', occurredAt: ago(130), extra: 'updated' });
  persists = 0; order = [];
  const r = await archive.run(s, deps(), { now: NOW });
  assert.equal(r.archived, 2);
  const entry = s.archives.find(a => a.kind === 'calls' && a.month === '2026-05');
  const items = (await read(entry.fileId)).items;
  assert.deepEqual(items.map(i => i.id).sort(), ['c2', 'c3', 'c7'], 'merged by id, no duplicates');
  assert.equal(items.find(i => i.id === 'c2').extra, 'updated', 'the newer copy wins');
  assert.ok(order.indexOf('persist') < order.indexOf('remove'), 'the old file is deleted only AFTER the state was saved pointing at the new one');
});

test('if writing a month fails, that month stays exactly where it was and the others still go', async () => {
  const s = mkState();
  const bad = { ...deps(), fileStore: { ...files, put: async (buf, info) => { if (/-2026-05\.json$/.test(info.name)) throw new Error('disk full'); return files.put(buf, info); } } };
  const r = await archive.run(s, bad, { now: NOW });
  assert.equal(r.errors.length, 2, 'the May calls and the May emails both failed'); assert.ok(r.errors.some(e => /calls 2026-05: disk full/.test(e)));
  assert.ok(s.calls.some(c => c.id === 'c2') && s.calls.some(c => c.id === 'c3') && s.emails.some(e => e.id === 'e1'), 'the failed month is still in the state — nothing lost');
  assert.ok(!s.calls.some(c => c.id === 'c1'), 'a month that worked was moved');
});

test('a missing existing archive file is never overwritten blindly', async () => {
  const s = mkState();
  await archive.run(s, deps(), { now: NOW });
  const entry = s.archives.find(a => a.kind === 'calls' && a.month === '2026-05');
  await files.remove(entry.fileId);
  s.calls.push({ id: 'c8', occurredAt: ago(131) });
  const r = await archive.run(s, deps(), { now: NOW });
  assert.match(r.errors.join(), /missing — not touching it/);
  assert.ok(s.calls.some(c => c.id === 'c8'), 'the record stays in the state');
});

/* ---------------- the disk watch ---------------- */
test('levels: warn 60 %, high 80 %, critical 90 %', () => {
  assert.deepEqual([0, 59.9, 60, 79.9, 80, 89.9, 90, 100].map(watch.levelFor), ['ok', 'ok', 'warn', 'warn', 'high', 'high', 'critical', 'critical']);
  assert.equal(watch.levelFor(null), 'ok'); assert.equal(watch.pctOf(512, 5120), 10); assert.equal(watch.pctOf(1, 0), null);
});
test('an alert goes out when the level gets worse, then reminds — it does not nag', () => {
  const t0 = Date.parse('2026-10-06T00:00:00Z'), h = n => t0 + n * 3600e3;
  assert.equal(watch.decide({}, 'ok', t0).alert, false);
  assert.deepEqual(watch.decide({}, 'warn', t0), { alert: true, kind: 'worse' });
  const prev = { level: 'warn', lastAlertAt: new Date(t0).toISOString() };
  assert.equal(watch.decide(prev, 'warn', h(24)).alert, false, 'same level, a day later: quiet');
  assert.deepEqual(watch.decide(prev, 'warn', h(24 * 7)), { alert: true, kind: 'reminder' }, 'a warning is repeated weekly');
  assert.deepEqual(watch.decide(prev, 'high', h(1)), { alert: true, kind: 'worse' }, 'worse at once');
  const crit = { level: 'critical', lastAlertAt: new Date(t0).toISOString() };
  assert.equal(watch.decide(crit, 'critical', h(5)).alert, false); assert.equal(watch.decide(crit, 'critical', h(6)).alert, true, 'critical repeats every 6 hours');
  assert.equal(watch.decide({ level: 'high', lastAlertAt: new Date(t0).toISOString() }, 'warn', h(1)).alert, false, 'getting better is not an alert');
});
test('the message says how full, in MB, and what to do', () => {
  assert.match(watch.message('high', 82.5, 4224, 5120), /82\.5% used \(4224 MB of 5120 MB\)/);
  assert.match(watch.message('critical', 93, 4762, 5120), /Resize the Postgres volume in Railway NOW/);
});
