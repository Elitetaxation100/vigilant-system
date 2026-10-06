// Disk-use watch — when to warn the founders that the database volume is filling up. Pure: no I/O, easy to test.
//
// used = every database on the server + the write-ahead log; volume = DB_VOLUME_MB (what Railway gave the volume).
// Levels: warn at 60 %, high at 80 %, critical at 90 %. An alert goes out when the level WORSENS, and is repeated while it stays
// bad (critical every 6 h, high every day, warn every week) so it cannot be missed and does not nag.
const LEVELS = [['critical', 90], ['high', 80], ['warn', 60]];
const RANK = { ok: 0, warn: 1, high: 2, critical: 3 };
const REMIND_MS = { critical: 6 * 3600e3, high: 24 * 3600e3, warn: 7 * 86400e3 };

function levelFor(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'ok';
  for (const [name, at] of LEVELS) if (pct >= at) return name;
  return 'ok';
}
function pctOf(usedMB, volumeMB) {
  if (!(volumeMB > 0) || usedMB == null || !Number.isFinite(Number(usedMB))) return null;
  return Math.round(Number(usedMB) / volumeMB * 1000) / 10;
}
// prev: { level, lastAlertAt } from the last check (may be undefined)
function decide(prev, level, nowMs) {
  prev = prev || {};
  const before = prev.level || 'ok';
  if (level === 'ok') return { alert: false, kind: null };
  if (RANK[level] > RANK[before]) return { alert: true, kind: 'worse' };
  const last = prev.lastAlertAt ? new Date(prev.lastAlertAt).getTime() : 0;
  if (level === before && nowMs - last >= REMIND_MS[level]) return { alert: true, kind: 'reminder' };
  return { alert: false, kind: null };
}
function message(level, pct, usedMB, volumeMB) {
  const lead = { warn: '⚠️ Database disk is filling up', high: '🚨 Database disk is getting full', critical: '🛑 DATABASE DISK IS ALMOST FULL' }[level];
  const advice = level === 'critical'
    ? 'Resize the Postgres volume in Railway NOW — if it fills, the whole app stops.'
    : 'Check Admin → space report, and enlarge the Postgres volume in Railway if it keeps growing.';
  return `${lead}: ${pct}% used (${Math.round(usedMB)} MB of ${Math.round(volumeMB)} MB). ${advice}`;
}

module.exports = { levelFor, pctOf, decide, message, LEVELS, REMIND_MS };
