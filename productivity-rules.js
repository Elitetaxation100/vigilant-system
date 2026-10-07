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

// V3 applies to work COMPLETED on/after the cutoff; earlier work keeps the rule it was counted under.
const v3Applies = (completedAtMs, v3AtIso) => Number.isFinite(completedAtMs) && completedAtMs >= Date.parse(v3AtIso);

module.exports = { capacityDays, splitNotConverted, v3Applies, r2 };
