// ---------------------------------------------------------------------------
// AUTOMATIC MARKS — deductions the system applies by itself. Pure functions:
// they only read/write the `state` they are given (the caller saves it and sends
// notifications), so every number can be tested.
//
// Rules (defaults, all adjustable by a superadmin):
//  1. ACKNOWLEDGEMENT — per person, per channel (emails and calls separately),
//     per finished working day. Of the items they were responsible for:
//       nothing acknowledged, or MORE than half unacknowledged  → −10
//       half or fewer unacknowledged (but some)                 → −5 or less,
//                                                                 in proportion
//     A person on leave / a holiday / a workshop day is skipped.
//  2. LINKS — a CLIENT task needs both a Google Sheet and a Cashbook link
//     (internal tasks never do).
//       the processor sends it for review without them          → −20 (−10 if one is missing)
//       the reviewer passes it on (returns it to send, or sends for profit
//       confirmation, or marks it sent) while they are still missing → −30 (−15 if one)
// Every automatic mark is tagged (type auto_*), carries a key so it can never be
// given twice for the same thing, and can be voided by a superadmin.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: { acknowledgement: true, links: true },
  points: { ackAll: 10, ackHalfMax: 5, processorLinks: 20, reviewerLinks: 30 },
};
const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const clampInt = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : d; };

// Current settings (defaults filled in). `activeFrom` is stamped the first time
// the rules are read, so nothing is ever deducted retroactively.
function settingsOf(state, today) {
  const a = state.autoMarks = state.autoMarks || {};
  const s = a.settings = a.settings || {};
  s.enabled = { ...DEFAULTS.enabled, ...(s.enabled || {}) };
  s.points = { ...DEFAULTS.points, ...(s.points || {}) };
  if (!isDay(s.activeFrom) && isDay(today)) s.activeFrom = today;
  return s;
}
function updateSettings(state, input, today) {
  const s = settingsOf(state, today);
  const b = input || {};
  if (b.enabled && typeof b.enabled === 'object') {
    Object.keys(DEFAULTS.enabled).forEach(k => { if (typeof b.enabled[k] === 'boolean') s.enabled[k] = b.enabled[k]; });
  }
  if (b.points && typeof b.points === 'object') {
    Object.keys(DEFAULTS.points).forEach(k => { if (b.points[k] !== undefined) s.points[k] = clampInt(b.points[k], s.points[k]); });
  }
  if (isDay(b.activeFrom)) s.activeFrom = b.activeFrom;
  return s;
}

// ---- rule 1: acknowledgement -------------------------------------------------
// notAck of total items unacknowledged → how many marks to take off (0 = none).
function ackDeduction(total, notAck, pts) {
  const p = { ...DEFAULTS.points, ...(pts || {}) };
  if (!(total > 0) || !(notAck > 0)) return 0;
  const ratio = notAck / total;
  if (ratio > 0.5) return p.ackAll;                                         // none acknowledged, or more than half not
  return Math.min(p.ackHalfMax, Math.max(1, Math.round(ratio * p.ackAll))); // half or fewer: 5 or less, in proportion
}

// ---- rule 2: links -----------------------------------------------------------
// Only client work that goes through review needs links; internal tasks and the
// call / Slack follow-ups that skip review never do.
const linksRequired = t => !!t && t.kind === 'client' && !['call', 'slack_message'].includes(t.source || '');
function missingLinks(t) {
  const out = [];
  if (!(t && String(t.sheetLink || '').trim())) out.push('Sheet');
  if (!(t && String(t.cashbookLink || '').trim())) out.push('Cashbook');
  return out;
}
const linkMarks = (missing, full) => Math.round((full * missing.length) / 2); // both missing = full, one = half

// ---- creating a mark ---------------------------------------------------------
function dayLabel(day) {
  return new Date(day + 'T12:00:00Z').toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
// Pure: builds + stores the mark, or returns null when this key was already used
// (even if that earlier mark was later voided — a void is a decision, not a retry).
function createAutoMark(state, spec) {
  state.marks = state.marks || [];
  if (spec.key && state.marks.some(m => m.autoKey === spec.key)) return null;
  state.marksSeq = (state.marksSeq || 0) + 1;
  const row = {
    id: 'mk' + state.marksSeq, toId: spec.toId, byId: null, points: -Math.abs(Math.round(spec.points)), reason: String(spec.reason || '').slice(0, 300),
    screenshot: null, type: spec.type, workshopId: null, taskId: spec.taskId || null,
    auto: true, autoKey: spec.key || null, createdAt: spec.at || new Date().toISOString(), voidedAt: null, voidedBy: null,
  };
  state.marks.push(row);
  return row;
}

// One finished day: who would lose marks for unacknowledged emails / calls.
// `people` is callsEmailsStats(...).people ({id, name, calls:{total,ack,notAck}, emails:{...}}).
function evaluateAckDay(state, day, people, ctx) {
  const settings = settingsOf(state, ctx.today);
  const results = [];
  const employees = state.employees || [];
  (people || []).forEach(p => {
    if (!employees.some(e => e.id === p.id)) return; // a mailbox with no owner is not a person
    [['emails', 'email'], ['calls', 'call']].forEach(([channel, noun]) => {
      const c = p[channel] || {};
      const marks = ackDeduction(c.total, c.notAck, settings.points);
      if (!marks) return;
      const skipped = ctx.skip ? ctx.skip(p.id, day) : false;
      const r = { toId: p.id, name: p.name, channel, total: c.total, notAck: c.notAck, marks, skipped, created: false };
      if (!skipped && !ctx.dryRun) {
        const row = createAutoMark(state, {
          toId: p.id, points: marks, type: 'auto_ack', key: `ack:${day}:${channel}:${p.id}`,
          reason: `Automatic: ${c.notAck} of ${c.total} ${noun}${c.total === 1 ? '' : 's'} on ${dayLabel(day)} not acknowledged`,
        });
        if (row) { r.created = true; r.row = row; if (ctx.onCreated) ctx.onCreated(row); }
      }
      results.push(r);
    });
  });
  return results;
}

const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Evaluate every finished working day since the last run (or since activeFrom).
// Day D is evaluated once the clock passes 08:00 NZ on the next day, so people have
// the evening and the early morning to clear what came in. Never more than 14 days
// in one run, and a disabled rule never "catches up" later.
function runDays(state, deps) {
  const settings = settingsOf(state, deps.today);
  const a = state.autoMarks;
  const out = { days: [], created: 0 };
  const lastFinished = deps.hourNZ >= 8 ? addDays(deps.today, -1) : addDays(deps.today, -2);
  if (!settings.enabled.acknowledgement) { a.lastEvaluated = lastFinished > (a.lastEvaluated || '') ? lastFinished : a.lastEvaluated; return out; }
  let day = addDays(a.lastEvaluated && a.lastEvaluated >= settings.activeFrom ? a.lastEvaluated : addDays(settings.activeFrom, -1), 1);
  let guard = 0;
  while (day <= lastFinished && guard++ < 14) {
    if (deps.isWorkingDay(day)) {
      const results = evaluateAckDay(state, day, deps.getStats(day), { today: deps.today, skip: deps.skip, onCreated: deps.onCreated });
      out.days.push({ day, deductions: results.filter(r => r.created).length });
      out.created += results.filter(r => r.created).length;
    }
    a.lastEvaluated = day;
    day = addDays(day, 1);
  }
  a.lastRun = { at: deps.now || new Date().toISOString(), created: out.created, upTo: a.lastEvaluated || null };
  return out;
}

module.exports = {
  DEFAULTS, settingsOf, updateSettings, ackDeduction, linksRequired, missingLinks, linkMarks,
  createAutoMark, evaluateAckDay, runDays, addDays, dayLabel,
};
