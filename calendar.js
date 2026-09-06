// ---------------------------------------------------------------------------
// WORKING-DAY CALENDAR — the single source of truth for every date
// calculation in the app (commitment dates, query freezes, capacity walks).
// The firm works Monday–Saturday; Sunday is the only weekend day. NZ public
// holidays (national + Auckland Anniversary) are excluded too.
//
// Nothing else in the codebase should compute working days on its own — call
// addWorkingDays / workingDaysBetween / isWorkingDay from here.
//
// HOLIDAYS is a plain observed-date list. Update it once a year (or move it
// into app state and edit from the dashboard). Dates are the *observed* days,
// with NZ Mondayisation already applied.
// ---------------------------------------------------------------------------

const HOLIDAYS = new Set([
  // 2026 (observed)
  '2026-01-01', '2026-01-02',                 // New Year's Day, Day after
  '2026-01-26',                                // Auckland Anniversary
  '2026-02-06',                                // Waitangi Day
  '2026-04-03', '2026-04-06',                  // Good Friday, Easter Monday
  '2026-04-27',                                // ANZAC Day (observed, 25th falls Sat)
  '2026-06-01',                                // King's Birthday
  '2026-07-10',                                // Matariki
  '2026-10-26',                                // Labour Day
  '2026-12-25', '2026-12-28',                  // Christmas, Boxing Day (observed)
  // 2027 (observed)
  '2027-01-01', '2027-01-04',                  // New Year's Day, Day after (observed)
  '2027-02-01',                                // Auckland Anniversary
  '2027-02-08',                                // Waitangi Day (observed, 6th falls Sat)
  '2027-03-26', '2027-03-29',                  // Good Friday, Easter Monday
  '2027-04-26',                                // ANZAC Day (observed, 25th falls Sun)
  '2027-06-07',                                // King's Birthday
  '2027-06-25',                                // Matariki
  '2027-10-25',                                // Labour Day
  '2027-12-27', '2027-12-28',                  // Christmas, Boxing Day (observed)
]);

// Extra firm close-down days can be added at boot from state or env.
function loadExtraHolidays(list) {
  (list || []).forEach(d => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) HOLIDAYS.add(d); });
}

function toISO(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// Parse a YYYY-MM-DD to a UTC date at midnight — no timezone drift.
function parse(iso) {
  const [y, m, day] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function isWorkingDay(dateISO) {
  const iso = toISO(dateISO);
  const dow = parse(iso).getUTCDay(); // 0 = Sunday
  return dow !== 0 && !HOLIDAYS.has(iso);
}

// Step `n` working days from `dateISO`. n may be negative. The start day
// itself is day 0; the result is the date that is `n` working days away.
// addWorkingDays('2026-10-07', 3) → the 3rd working day after the 7th.
function addWorkingDays(dateISO, n) {
  let d = parse(toISO(dateISO));
  const step = n >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.trunc(n));
  while (remaining > 0) {
    d = new Date(d.getTime() + step * 86400000);
    if (isWorkingDay(d)) remaining -= 1;
  }
  return toISO(d);
}

// Count working days in the half-open interval (aISO, bISO] — the working
// days strictly after `a`, up to and INCLUDING `b`. Order-independent: a
// negative result if b < a. This is the "how many working days from X to Y"
// count used for deadlines and capacity.
//   workingDaysBetween('Mon', 'Tue')  → 1   (Tue)
//   workingDaysBetween('Sat', 'Mon')  → 1   (Mon; Sun skipped)
function workingDaysBetween(aISO, bISO) {
  let a = toISO(aISO), b = toISO(bISO);
  if (a === b) return 0;
  const sign = a < b ? 1 : -1;
  if (sign < 0) { const t = a; a = b; b = t; }
  let d = parse(a);
  const end = parse(b).getTime();
  let count = 0;
  while (d.getTime() < end) {
    d = new Date(d.getTime() + 86400000);
    if (isWorkingDay(d)) count += 1;
  }
  return count * sign;
}

// Working days strictly BETWEEN a and b — excludes both endpoints. Used for a
// query freeze: the days the file was blocked are those after it was sent and
// before the reply landed (you worked up to sending; you can resume the day
// the reply arrives).
//   query sent Tue, reply Mon (next week) → Wed,Thu,Fri,Sat = 4
function workingDaysStrictlyBetween(aISO, bISO) {
  const a = toISO(aISO), b = toISO(bISO);
  if (a >= b) return 0;
  const n = workingDaysBetween(a, b);           // (a, b]
  return n - (isWorkingDay(b) ? 1 : 0);         // drop b itself
}

// The next working day on or after `dateISO`.
function nextWorkingDay(dateISO) {
  let iso = toISO(dateISO);
  while (!isWorkingDay(iso)) iso = addWorkingDays(iso, 1);
  return iso;
}

// The working-day shift a client query earns on the commitment date:
// the frozen working days, minus any the processor wasted before resuming
// (one working day of grace after the reply).
//   q = { sentAt, replyAt|null, resumedAt|null }, `todayISO` for open queries
function queryShift(q, todayISO) {
  if (!q || !q.sentAt) return { frozen: 0, forfeit: 0, shift: 0 };
  const frozen = q.replyAt
    ? workingDaysStrictlyBetween(q.sentAt, q.replyAt)
    : workingDaysBetween(q.sentAt, todayISO);          // open: today is still frozen
  let forfeit = 0;
  if (q.replyAt && q.resumedAt) {
    const lag = workingDaysBetween(q.replyAt, q.resumedAt);  // 1 if resumed next working day
    forfeit = Math.max(0, lag - 1);
  }
  return { frozen, forfeit, shift: Math.max(0, frozen - forfeit) };
}

module.exports = {
  isWorkingDay,
  addWorkingDays,
  workingDaysBetween,
  workingDaysStrictlyBetween,
  nextWorkingDay,
  queryShift,
  loadExtraHolidays,
  _holidays: HOLIDAYS,
};
