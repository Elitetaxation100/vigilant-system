// Pure rules behind the Productivity and capacity numbers — no state, no clock — so every figure can be checked on its own.
//
//   Productivity % = qualifying allocated hours ÷ eligible capacity hours × 100          (the task's ALLOCATED hours; never
//   online / punch / timer / actual hours, and never Report Sent or profit confirmation)
//   Eligible capacity hours = final eligible days × the 7 h working day
//   Capacity not converted = eligible capacity − qualifying completed allocated hours, split WITHOUT overlap into open work,
//   completed-but-not-qualifying work and unallocated capacity.

const r2 = n => Math.round(n * 100) / 100;

// days: one entry per calendar day in the period —
//   { scheduled: bool, holiday: bool, status: 'PRESENT'|'LEAVE'|'HALF'|'WORKSHOP'|'CUSTOM', customHours: number }
// "scheduled" = a day the firm's week includes (not the weekly off). A deduction is reported only if it was actually made.
function capacityDays(days, dayHours) {
  let scheduled = 0, holidays = 0, leave = 0, workshop = 0, customHours = 0;
  for (const d of days) {
    if (!d.scheduled) continue;
    scheduled += 1;
    if (d.holiday) { holidays += 1; continue; }
    if (d.status === 'WORKSHOP') workshop += 1;
    else if (d.status === 'LEAVE') leave += 1;
    else if (d.status === 'HALF') leave += 0.5;
    else if (d.status === 'CUSTOM') customHours += Number(d.customHours) || 0;
  }
  const workingDays = scheduled - holidays;
  const finalEligibleDays = r2(workingDays - leave - workshop - customHours / dayHours);
  return {
    dayHours, scheduledDays: scheduled, publicHolidays: holidays, workingDays, leaveDays: r2(leave), workshopDays: workshop,
    customHoursOff: r2(customHours), finalEligibleDays, capacityHours: r2(finalEligibleDays * dayHours),
  };
}

// The "not converted" total split into parts that add up to it exactly. Filled in order: open work, then completed work that did
// not qualify, then the rest is unallocated. Work larger than the gap simply fills it (the parts can never exceed the total).
function splitNotConverted(notConverted, openHours, nonQualifyingCompletedHours) {
  const total = r2(Math.max(0, notConverted));
  const open = r2(Math.min(Math.max(0, openHours), total));
  const nonQual = r2(Math.min(Math.max(0, nonQualifyingCompletedHours), total - open));
  const unallocated = r2(total - open - nonQual);
  return { total, openAllocated: open, nonQualifyingCompleted: nonQual, unallocated, reconciles: Math.abs(open + nonQual + unallocated - total) < 0.011 };
}

// Team / firm totals from per-person results. The percentage is summed hours over summed capacity — a person with more capacity
// weighs more; it is NEVER an average of individual percentages. Used by /api/productivity AND the Founder dashboard, so they cannot differ.
function aggregateTotals(people, extra) {
  const sum = k => people.reduce((s, p) => s + (p[k] || 0), 0);
  const totalQualified = sum('qualifiedHours'), totalCap = sum('capacityHours');
  const rawTotalPct = totalCap > 0 ? (totalQualified / totalCap) * 100 : null;
  const reportPoints = sum('reportPoints'), reportMax = sum('reportMaxPoints');
  const commitmentMet = sum('commitmentMet'), commitmentTotal = sum('commitmentTotal');
  const k = f => r2(people.reduce((n, p) => n + ((p.notConvertedBreakdown || {})[f] || 0), 0));
  const b = { total: k('total'), openAllocated: k('openAllocated'), nonQualifyingCompleted: k('nonQualifyingCompleted'), unallocated: k('unallocated') };
  return {
    capacityHours: r2(totalCap), qualifiedHours: r2(totalQualified),
    productivityPct: rawTotalPct == null ? null : Math.min(100, Math.round(rawTotalPct * 10) / 10),
    rawUtilisationPct: rawTotalPct == null ? null : Math.round(rawTotalPct * 10) / 10,
    additionalHours: rawTotalPct != null && rawTotalPct > 100 ? r2(totalQualified - totalCap) : 0,
    notScorable: totalCap <= 0,
    leaveDays: r2(sum('leaveDays')),
    commitmentMet, commitmentTotal, commitmentPct: commitmentTotal > 0 ? Math.round((commitmentMet / commitmentTotal) * 1000) / 10 : null,
    reportsRequired: sum('reportsRequired'), reportsOnTime: sum('reportsOnTime'), reportsLate: sum('reportsLate'), reportsReadyNotSent: sum('reportsReadyNotSent'), reportsNoDate: sum('reportsNoDate'),
    reportPoints, reportMaxPoints: reportMax, reportSentRate: reportMax > 0 ? Math.round((reportPoints / reportMax) * 1000) / 10 : null,
    outstandingReports: sum('outstandingReports'),
    capacityNotConverted: r2(sum('capacityNotConverted')), assignedOpenHours: r2(sum('assignedOpenHours')), trulyUnallocatedHours: r2(sum('trulyUnallocatedHours')),
    notConvertedBreakdown: { ...b, reconciles: people.every(p => (p.notConvertedBreakdown || {}).reconciles !== false) && Math.abs(b.openAllocated + b.nonQualifyingCompleted + b.unallocated - b.total) < 0.05 },
    ...(extra || {}),
  };
}

// V3 applies to work COMPLETED on/after the cutoff; earlier work keeps the rule it was counted under.
const v3Applies = (completedAtMs, v3AtIso) => Number.isFinite(completedAtMs) && completedAtMs >= Date.parse(v3AtIso);

module.exports = { capacityDays, splitNotConverted, aggregateTotals, v3Applies, r2 };
