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
//     Judged at 18:45 NZ the SAME day — the moment the daily Calls & Email report goes
//     to the admins — using exactly what that report counts (items received up to then).
//     A person on leave / a holiday / a workshop day is skipped.
//  3. REPORT DEADLINE — a client report not sent by the (query-aware) committed
//     date costs whoever is sending it −10. Only for dates after the rules started.
//  4. REASSIGNED MAIL — an email reassigned to someone must be REPLIED to (or marked
//     "no reply needed") the SAME working day, before the daily Calls & Email report goes
//     to the admins (6:45 pm NZ). Handed over after that report, or on a non-working day,
//     it is due before the next working day's report. Otherwise that person loses 10, once
//     per hand-off. Leave days push the deadline on.
//  2. LINKS — a CLIENT task needs both a Google Sheet and a Cashbook link
//     (internal tasks never do).
//       the processor sends it for review without them          → −20 (−10 if one is missing)
//       the reviewer passes it on (returns it to send, or sends for profit
//       confirmation, or marks it sent) while they are still missing → −30 (−15 if one)
// Every automatic mark is tagged (type auto_*), carries a key so it can never be
// given twice for the same thing, and can be voided by a superadmin.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: { acknowledgement: true, links: true, reports: true, mailReply: true },
  points: { ackAll: 10, ackHalfMax: 5, processorLinks: 20, reviewerLinks: 30, reportLate: 10, mailReplyLate: 10 },
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

// ---- rule 3: the report must go to the client by the committed date ----------
// Late = still unsent the day AFTER the committed date, and that date is on/after
// the day the rules started (nothing is judged retroactively).
function reportIsLate(committedDate, today, activeFrom) {
  return !!committedDate && isDay(committedDate) && today > committedDate && (!isDay(activeFrom) || committedDate >= activeFrom);
}

// ---- rule 4: a reassigned email must be replied to BEFORE the daily report ----
// The firm's Calls & Email report goes to the admins at 18:45 NZ (CALLS_EMAILS_DIGEST_HOUR).
// A mail reassigned before that on a working day must be answered that day; otherwise it
// is due before the next working day's report.
function digestCutoffMinutes() { return (Number(process.env.CALLS_EMAILS_DIGEST_HOUR) || 18) * 60 + 45; }
function cutoffLabel(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h >= 12 ? ' pm' : ' am');
}
// ctx: nzDay(iso), nzMinutes(iso) (minutes since midnight NZ), isWorkingDay(day), workingDayAfter(day),
//      skip(empId, day), cutoffMinutes. The CURRENT hand-off is what counts (the last reassignHistory
//      entry that points at the current owner); hand-offs before the rules started are ignored.
function reassignedMailDeadline(e, ctx, settings) {
  if (!e || e.direction !== 'inbound' || !e.reassignedTo || e.reassignedTo === e.mailboxOwner) return null;
  const hist = e.reassignHistory || [];
  const last = hist[hist.length - 1];
  if (!last || last.to !== e.reassignedTo || !last.at) return null;
  const day = ctx.nzDay(last.at);
  if (!isDay(day) || (settings && isDay(settings.activeFrom) && day < settings.activeFrom)) return null;
  const cutoff = ctx.cutoffMinutes != null ? ctx.cutoffMinutes : digestCutoffMinutes();
  const mins = ctx.nzMinutes ? ctx.nzMinutes(last.at) : 0;
  let deadline = (ctx.isWorkingDay(day) && mins < cutoff) ? day : ctx.workingDayAfter(day);
  let guard = 0;
  while (ctx.skip && ctx.skip(e.reassignedTo, deadline) && guard++ < 30) deadline = ctx.workingDayAfter(deadline);
  return { toId: e.reassignedTo, handedOn: day, deadline, cutoffMinutes: cutoff, index: hist.length };
}
// Due once the daily report has gone out on the deadline day (or that day has passed).
function reassignedMailIsDue(d, ctx) {
  return ctx.today > d.deadline || (ctx.today === d.deadline && ctx.nowMinutes >= d.cutoffMinutes);
}
function evaluateReassignedMail(state, ctx) {
  const settings = settingsOf(state, ctx.today);
  const out = [];
  if (!settings.enabled.mailReply) return out;
  (state.emails || []).forEach(e => {
    if (e.replied || e.replyNotNeeded) return; // handled (a real reply, or marked no-reply-needed)
    const d = reassignedMailDeadline(e, ctx, settings);
    if (!d || !reassignedMailIsDue(d, ctx)) return;
    const r = { emailId: e.id, toId: d.toId, subject: e.subject || '(no subject)', deadline: d.deadline, marks: settings.points.mailReplyLate, created: false };
    if (!ctx.dryRun) {
      const row = createAutoMark(state, {
        toId: d.toId, points: r.marks, type: 'auto_mail_reply', key: `mailreply:${e.id}:${d.index}`,
        reason: `Automatic: the email "${String(e.subject || '(no subject)').slice(0, 80)}" reassigned to you on ${dayLabel(d.handedOn)} was not replied to by ${cutoffLabel(d.cutoffMinutes)} on ${dayLabel(d.deadline)} (before the daily report)`,
      });
      if (row) { r.created = true; if (ctx.onCreated) ctx.onCreated(row); }
    }
    out.push(r);
  });
  return out;
}

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
// Evaluate every working day whose daily report has gone out since the last run (or
// since activeFrom). Day D is judged once the clock reaches the report time (18:45 NZ)
// ON day D, so the marks and the report the admins receive always agree; a day that
// was missed (server down) is judged afterwards. Never more than 14 days in one run,
// and a disabled rule never "catches up" later.
function runDays(state, deps) {
  const settings = settingsOf(state, deps.today);
  const a = state.autoMarks;
  const out = { days: [], created: 0 };
  const cutoff = deps.cutoffMinutes != null ? deps.cutoffMinutes : digestCutoffMinutes();
  const lastFinished = (deps.nowMinutes != null && deps.nowMinutes >= cutoff) ? deps.today : addDays(deps.today, -1);
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
  DEFAULTS, settingsOf, updateSettings, ackDeduction, linksRequired, missingLinks, linkMarks, reportIsLate, reassignedMailDeadline, reassignedMailIsDue, evaluateReassignedMail, digestCutoffMinutes, cutoffLabel,
  createAutoMark, evaluateAckDay, runDays, addDays, dayLabel,
};
