// ---------------------------------------------------------------------------
// TIME LEDGER — where each person's time goes, task by task and day by day.
//
// Every time the work clock stops (Pause, Hold, Complete, Done, Reassign, Punch Out, Resubmit, the forgotten-timer auto-pause…) the time it ran is
// split at New Zealand midnight and written to the task as dated entries:  t.timeLedger = [{ id, e (person), d (NZ day), h (hours), s (how), at }].
// The ledger is APPEND-ONLY. t.logged stays the single total everything else uses; the ledger explains it, and any part of t.logged that has no dated
// entry (everything logged before this existed, or an edit with no date) is shown as "Before day-by-day tracking" — it is NEVER spread across days
// that were not recorded.
// ---------------------------------------------------------------------------
const TZ = 'Pacific/Auckland';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const nzDayMs = ms => dayFmt.format(new Date(ms));
const nzDayIso = iso => nzDayMs(Date.parse(iso));
const r2 = n => Math.round(n * 100) / 100;

// How each entry came to be (shown to people).
const SOURCES = {
  timer: 'Work clock', auto_pause: 'Forgotten clock, auto-paused', backdated: 'Hours entered when starting', actual_entered: 'Actual hours entered on Mark Done',
  added_on_hold: 'Time added while on hold', correction: 'Correction', manual: 'Logged by the employee', manual_late: 'Logged later by the employee',
};

// Split [fromMs, toMs) at New Zealand midnights → [{ day, hours }].
function splitByDay(fromMs, toMs) {
  const out = [];
  if (!(toMs > fromMs)) return out;
  let cur = fromMs, guard = 0;
  while (cur < toMs && guard++ < 400) {
    const day = nzDayMs(cur);
    if (nzDayMs(toMs - 1) === day) { out.push({ day, hours: (toMs - cur) / 3600000 }); break; }
    let lo = cur, hi = toMs;                               // lo is on `day`, hi is not — find the first millisecond of the next day
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (nzDayMs(mid) === day) lo = mid; else hi = mid; }
    out.push({ day, hours: (hi - cur) / 3600000 });
    cur = hi;
  }
  return out;
}

function addEntry(t, { empId, day, hours, source, at, note }) {
  if (!Number.isFinite(hours) || hours === 0) return null;
  t.timeLedger = t.timeLedger || [];
  const row = { id: 'tl-' + (t.timeLedger.length + 1), e: empId || t.assignedTo || null, d: day || null, h: hours, s: source || 'timer', at: at || new Date().toISOString() };
  if (note) row.n = String(note).slice(0, 200);
  t.timeLedger.push(row);
  return row;
}
// Dated entries for a stretch of the clock (split at midnight).
function addSpan(t, startMs, endMs, source, empId) {
  splitByDay(startMs, endMs).forEach(p => addEntry(t, { empId, day: p.day, hours: p.hours, source, at: new Date(endMs).toISOString() }));
}
// Stop the work clock: bank what it ran into t.logged (exactly as before) and write the dated entries. Returns the hours banked.
// `endMs` defaults to now; `capHours` limits what is banked (the forgotten-timer auto-pause banks a fixed amount from the start).
function bank(t, opts) {
  if (!t || !t.timerStartedAt) return 0;
  const o = opts || {};
  const startMs = Date.parse(t.timerStartedAt);
  let endMs = o.endMs != null ? o.endMs : Date.now();
  if (o.capHours != null) endMs = Math.min(endMs, startMs + o.capHours * 3600000);
  const hours = (endMs - startMs) / 3600000;
  t.logged = (Number(t.logged) || 0) + hours;
  addSpan(t, startMs, endMs, o.source || 'timer', t.assignedTo);
  t.timerStartedAt = null;
  return hours;
}
// Time added or changed WITHOUT a clock run: dated today unless a day is given (backdated hours have no day).
function addAdjustment(t, hours, source, day, note) {
  return addEntry(t, { empId: t.assignedTo, day: day === undefined ? nzDayMs(Date.now()) : day, hours, source, note });
}

const entriesOf = t => (t && Array.isArray(t.timeLedger)) ? t.timeLedger : [];
// The clock that is running RIGHT NOW has not been banked yet; it still counts for today (split at midnight if it crossed one).
function liveEntries(t, nowMs) {
  if (!t || !t.timerStartedAt || !t.assignedTo) return [];
  return splitByDay(Date.parse(t.timerStartedAt), nowMs == null ? Date.now() : nowMs).map(p => ({ e: t.assignedTo, d: p.day, h: p.hours, s: 'timer', live: true }));
}
// How a task's logged hours break down. `running` is the clock still running (not yet in t.logged).
function totalsOf(t) {
  const dated = r2(entriesOf(t).reduce((n, x) => n + x.h, 0)), logged = Number(t.logged) || 0;
  const earlier = r2(logged - dated);
  return { logged: r2(logged), tracked: dated, earlier: Math.abs(earlier) < 0.01 ? 0 : earlier, allocated: Number(t.tat) || 0 };
}

// One person's time between two days, from tasks the caller is allowed to see.
// deps: { standardHoursOn(day) → hours expected that day (0 on a day off), nameOf(id) }
function personReport(tasks, empId, from, to, deps) {
  const days = {}, byTask = {}, byClient = {};
  let total = 0, undated = 0;
  tasks.forEach(t => {
    entriesOf(t).concat(liveEntries(t)).forEach(x => {
      if (x.e !== empId) return;
      if (x.d == null) { undated += x.h; return; }
      if (x.d < from || x.d > to) return;
      const d = days[x.d] = days[x.d] || { day: x.d, hours: 0, items: {} };
      d.hours += x.h; total += x.h;
      const it = d.items[t.id] = d.items[t.id] || { taskId: t.id, name: t.name, client: t.clientName || (t.kind === 'internal' ? 'Admin' : ''), hours: 0, sources: new Set() };
      it.hours += x.h; it.sources.add(x.s);
      const b = byTask[t.id] = byTask[t.id] || { taskId: t.id, name: t.name, client: t.clientName || (t.kind === 'internal' ? 'Admin' : ''), status: t.status, allocated: Number(t.tat) || 0, loggedTotal: r2(Number(t.logged) || 0), hours: 0, days: new Set() };
      b.hours += x.h; b.days.add(x.d);
      const c = byClient[b.client || '—'] = byClient[b.client || '—'] || { client: b.client || '—', hours: 0, tasks: new Set() };
      c.hours += x.h; c.tasks.add(t.id);
    });
  });
  const list = [];
  for (let d = to; d >= from; d = addDay(d, -1)) {                                  // every day in the range, newest first — a quiet day shows as 0
    const row = days[d];
    list.push({ day: d, hours: r2(row ? row.hours : 0), standard: deps.standardHoursOn(d),
      items: row ? Object.values(row.items).map(i => ({ ...i, hours: r2(i.hours), sources: [...i.sources].map(s => SOURCES[s] || s) })).sort((a, b) => b.hours - a.hours) : [] });
    if (list.length > 400) break;
  }
  return {
    empId, from, to, totalHours: r2(total), undatedHours: r2(undated), days: list,
    byTask: Object.values(byTask).map(b => ({ ...b, hours: r2(b.hours), days: b.days.size })).sort((a, b) => b.hours - a.hours),
    byClient: Object.values(byClient).map(c => ({ client: c.client, hours: r2(c.hours), tasks: c.tasks.size })).sort((a, b) => b.hours - a.hours),
  };
}
function addDay(day, n) { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

module.exports = { SOURCES, splitByDay, nzDayMs, nzDayIso, addEntry, addSpan, bank, addAdjustment, entriesOf, liveEntries, totalsOf, personReport, addDay };
