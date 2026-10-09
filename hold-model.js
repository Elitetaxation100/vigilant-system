// The hold model — pure data and rules, shared by the server, the workflow layer and (mirrored) the page.
//
// A task on hold has ONE primary status (On Hold) and a structured category. The category — never the free-text reason — decides:
//   * who the task is waiting on, and
//   * whether the hold can ever pause the processor's responsibility (only a verified external dependency can).
// A hold NEVER changes the seven-hour daily capacity, the allocated hours, the client commitment date, or earns productivity.

// code → { label, kind (who it waits on), external (a verified external dependency may pause responsibility), clientRelated, party (what the
// "waiting on" field asks for) }
const CATEGORIES = [
  { code: 'CLIENT_INFO',         label: 'Waiting on client information',   kind: 'client',    external: true,  clientRelated: true,  party: 'client' },
  { code: 'CLIENT_DOCS',         label: 'Waiting on client documents',     kind: 'client',    external: true,  clientRelated: true,  party: 'client' },
  { code: 'EXTERNAL_AUTHORITY',  label: 'Waiting on IRD or external authority', kind: 'external', external: true, clientRelated: false, party: 'text' },
  { code: 'MANAGER_DECISION',    label: 'Waiting on manager decision',     kind: 'manager',   external: false, clientRelated: false, party: 'manager' },
  { code: 'REVIEWER',            label: 'Waiting on reviewer',             kind: 'reviewer',  external: false, clientRelated: false, party: 'reviewer' },
  { code: 'INTERNAL_DEPENDENCY', label: 'Internal dependency',             kind: 'internal',  external: false, clientRelated: false, party: 'text' },
  { code: 'REWORK_BLOCKED',      label: 'Rework blocked',                  kind: 'internal',  external: false, clientRelated: false, party: 'text' },
  { code: 'SCHEDULED_FUTURE',    label: 'Scheduled for a future date',     kind: 'scheduled', external: false, clientRelated: false, party: 'none' },
  { code: 'NO_CONFIRMATION',     label: 'No confirmation received',        kind: 'other',     external: false, clientRelated: false, party: 'text' },
  { code: 'OTHER',               label: 'Other',                           kind: 'other',     external: false, clientRelated: false, party: 'text' },
];
// Codes that already exist in saved data. They keep working exactly as before; new holds use CATEGORIES.
const LEGACY = {
  CLIENT_QUERY:    { label: 'Awaiting client answer to a query',         kind: 'client',   external: true,  clientRelated: true,  party: 'client',   mapsTo: 'CLIENT_INFO' },
  THIRD_PARTY:     { label: 'Awaiting IRD / bank / third party',          kind: 'external', external: true,  clientRelated: false, party: 'text',     mapsTo: 'EXTERNAL_AUTHORITY' },
  INTERNAL_REVIEW: { label: 'Blocked on a reviewer or partner sign-off',  kind: 'reviewer', external: false, clientRelated: false, party: 'reviewer', mapsTo: 'REVIEWER' },
  CAPACITY:        { label: 'Re-prioritised — parked by manager',         kind: 'manager',  external: false, clientRelated: false, party: 'manager',  mapsTo: null, managerOnly: true },
  BLOCKED_OTHER:   { label: 'Other',                                      kind: 'other',    external: false, clientRelated: false, party: 'text',     mapsTo: 'OTHER' },
};
const BY_CODE = Object.fromEntries(CATEGORIES.map(c => [c.code, c]));

const meta = code => BY_CODE[code] || LEGACY[code] || null;
const isCategory = code => !!BY_CODE[code];                       // a code that may be chosen on a NEW hold (legacy codes are accepted too, for old callers)
const isExternal = code => !!(meta(code) && meta(code).external);  // only a verified external dependency can pause responsibility
const isClientRelated = code => !!(meta(code) && meta(code).clientRelated);
const waitingKind = code => (meta(code) || { kind: 'other' }).kind;
const label = code => (meta(code) || { label: 'On hold' }).label;
// every code that is an external dependency (new + legacy) — used where a Set of "exempting" codes is needed
const EXTERNAL_CODES = [...CATEGORIES.filter(c => c.external).map(c => c.code), ...Object.keys(LEGACY).filter(k => LEGACY[k].external)];

// How a held task is described. Never says "waiting on client" unless a recorded client query exists.
function holdAge(heldAtIso, nowMs) {
  const ms = Math.max(0, (nowMs || Date.now()) - Date.parse(heldAtIso || 0));
  const hours = ms / 3600000;
  const days = Math.floor(hours / 24);
  return { hours: Math.round(hours * 10) / 10, days, text: hours < 1 ? 'under an hour' : hours < 24 ? Math.floor(hours) + (Math.floor(hours) === 1 ? ' hour' : ' hours') : days + (days === 1 ? ' day' : ' days') };
}

module.exports = { CATEGORIES, LEGACY, meta, isCategory, isExternal, isClientRelated, waitingKind, label, holdAge, EXTERNAL_CODES };
