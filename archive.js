// Archive — old calls, emails and WhatsApp messages leave the main state row.
//
// The whole state is ONE database row that is rewritten on every save, so everything in it is paid for again and again.
// Calls, emails and WhatsApp messages only ever grow. After ARCHIVE_AFTER_DAYS (default 95) they are moved, month by month,
// into JSON files in the file store (kind 'archive'), where a superadmin can still download them.
//
// Safe by construction, in this order:
//   1. write the new month file;   2. point the index at it and drop the items from the state;
//   3. persist the state (`persist`);   4. ONLY THEN delete the file it replaced.
// A crash at any point leaves either the old state (items still in it — the next run merges by id, no duplicates) or the new
// one with its file in place. Nothing is ever deleted before its replacement is safely stored.
const DEFAULT_DAYS = 95;
const KINDS = {
  calls: r => r.occurredAt,
  emails: r => r.occurredAt,
  waMessages: r => r.at,
};

function days() { const n = Number(process.env.ARCHIVE_AFTER_DAYS); return n >= 1 ? Math.floor(n) : DEFAULT_DAYS; }
function cutoffISO(now, d) { return new Date((now ? new Date(now).getTime() : Date.now()) - (d || days()) * 86400000).toISOString(); }
const monthOf = iso => String(iso).slice(0, 7);

// what would move, without moving it
function plan(state, cutoff) {
  const out = {};
  for (const kind of Object.keys(KINDS)) {
    const old = (Array.isArray(state[kind]) ? state[kind] : []).filter(r => { const t = KINDS[kind](r); return r && r.id != null && t && String(t) < cutoff && !r.stub; });
    const months = {};
    old.forEach(r => { (months[monthOf(KINDS[kind](r))] = months[monthOf(KINDS[kind](r))] || []).push(r); });
    out[kind] = { total: old.length, months };
  }
  return out;
}

// deps: { fileStore, persist: async () => {} }   opts: { now, days, dryRun }
async function run(state, deps, opts) {
  opts = opts || {};
  const d = opts.days || days();
  const cutoff = cutoffISO(opts.now, d);
  const p = plan(state, cutoff);
  const out = { days: d, cutoff, dryRun: !!opts.dryRun, archived: 0, kinds: {}, errors: [] };
  for (const kind of Object.keys(p)) out.kinds[kind] = { found: p[kind].total, archived: 0, months: Object.fromEntries(Object.entries(p[kind].months).map(([m, l]) => [m, l.length])) };
  if (opts.dryRun) return out;
  if (!Array.isArray(state.archives)) state.archives = [];

  for (const kind of Object.keys(p)) {
    for (const month of Object.keys(p[kind].months).sort()) {
      const group = p[kind].months[month];
      try {
        const entry = state.archives.find(a => a.kind === kind && a.month === month);
        let existing = [];
        if (entry) {
          const f = await deps.fileStore.get(entry.fileId);
          if (!f) throw new Error('the existing ' + kind + ' ' + month + ' archive file is missing — not touching it');
          existing = (JSON.parse(f.data.toString('utf8')).items) || [];
        }
        const byId = new Map(existing.map(r => [String(r.id), r]));
        group.forEach(r => byId.set(String(r.id), r));
        const items = [...byId.values()];
        const buf = Buffer.from(JSON.stringify({ kind, month, archivedAt: new Date().toISOString(), count: items.length, items }));
        const meta = await deps.fileStore.put(buf, { name: kind + '-' + month + '.json', mime: 'application/json', createdBy: null, kind: 'archive' });
        const replaced = entry ? entry.fileId : null;
        const rec = { kind, month, fileId: meta.id, count: items.length, bytes: buf.length, updatedAt: new Date().toISOString() };
        if (entry) Object.assign(entry, rec); else state.archives.push(rec);
        const ids = new Set(group.map(r => r.id));
        state[kind] = state[kind].filter(r => !ids.has(r.id));
        await deps.persist();                                   // the state now points at the new file…
        if (replaced) await deps.fileStore.remove(replaced).catch(() => {}); // …only now is the old one deleted
        out.kinds[kind].archived += group.length; out.archived += group.length;
      } catch (e) {
        out.errors.push(kind + ' ' + month + ': ' + (e && e.message || e));
      }
    }
  }
  return out;
}

module.exports = { run, plan, cutoffISO, monthOf, days, DEFAULT_DAYS, KINDS };
