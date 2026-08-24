// ---------------------------------------------------------------------------
// Storage layer.
//
// This is the actual fix for "tasks not reaching the assigned person": data
// now lives in ONE place on the server's disk (data/db.json), and every
// employee's browser talks to that same server over HTTP. Nobody has their
// own private copy anymore.
//
// It's a JSON file rather than a full SQL database on purpose — at the scale
// of one accounting firm's team (a handful of employees, a few hundred
// tasks), a single file guarded by the server is simple, has zero native
// dependencies to install, and is trivial to back up (it's just a file).
// If this ever needs to scale to many more employees/offices, swapping this
// module for a real database (Postgres, etc.) later is a contained change —
// nothing outside this file needs to know how storage works internally.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// ---------------------------------------------------------------------------
// The starting roster — defined ONCE here and consumed by both seedData()
// (fresh database) and ensureOrgChart() (topping up an existing one). This
// used to be two separate hardcoded lists that partly overlapped, which
// meant editing one copy's password/job title without the other would
// silently drift. Single source of truth now; less surface area for
// hardcoded credentials to go stale in, too.
// ---------------------------------------------------------------------------
const ROSTER = [
  { name: 'Shubam Sharma', email: 'shubham@elitetaxation.co.nz', password: 'Shubham@2026', jobTitle: 'Director', team: 'Management', accessRole: 'superadmin' },
  { name: 'Parvinder Kumar', email: 'parvinder@elitetaxation.co.nz', password: 'Parvinder@2026', jobTitle: 'Senior Accountant', team: 'Rideshare Team', accessRole: 'admin' },
  { name: 'Ranjit Choudhary', email: 'ranjit@elitetaxation.co.nz', password: 'Ranjit@2026', jobTitle: 'Tax Associate', team: 'Rental Team', accessRole: 'employee' },
  { name: 'Suneha', email: 'suneha@elitetaxation.co.nz', password: 'Suneha@2026', jobTitle: 'Tax Associate', team: 'GST Team', accessRole: 'employee' },
  { name: 'Disha Chaudhary', email: 'disha@elitetaxation.co.nz', password: 'Disha@2026', jobTitle: 'Junior Accountant', team: 'GST Team', accessRole: 'admin' },
  { name: 'Anjana Pandey', email: 'anjana@elitetaxation.co.nz', password: 'Anjana@2026', jobTitle: 'Junior Accountant', team: 'Rental Team', accessRole: 'employee' },
  { name: 'Mukul', email: 'mukul@elitetaxation.co.nz', password: 'Mukul@2026', jobTitle: 'Tax Associate', team: 'Rideshare Team', accessRole: 'employee' },
  { name: 'HR Administrator', email: 'hr@elitetaxation.co.nz', password: 'kajal11A@', jobTitle: 'HR Administrator', team: 'Management', accessRole: 'superadmin' },
  { name: 'Khushi', email: 'khushi@elitetaxation.co.nz', password: 'Khushi@2026', jobTitle: 'Tax Associate', team: 'GST Team', accessRole: 'employee' },
  { name: 'Diksha', email: 'diksha@elitetaxation.co.nz', password: 'Diksha@2026', jobTitle: 'Tax Associate', team: 'GST Team', accessRole: 'employee' },
  { name: 'Nitish', email: 'nitish@elitetaxation.co.nz', password: 'Nitish@2026', jobTitle: 'Tax Associate', team: 'GST Team', accessRole: 'employee' },
  { name: 'Smita', email: 'smita@elitetaxation.co.nz', password: 'Smita@2026', jobTitle: 'Tax Associate', team: 'Unassigned', accessRole: 'employee' },
  { name: 'Hunny', email: 'hunny@elitetaxation.co.nz', password: 'Hunny@2026', jobTitle: 'Tax Associate', team: 'Unassigned', accessRole: 'employee' },
  { name: 'Natasha', email: 'natasha@elitetaxation.co.nz', password: 'Natasha@2026', jobTitle: 'Tax Associate', team: 'Rideshare Team', accessRole: 'employee' },
  { name: 'Vishal', email: 'vishal@elitetaxation.co.nz', password: 'Vishal@2026', jobTitle: 'Manager', team: 'Unassigned', accessRole: 'admin' },
  { name: 'Krishna', email: 'krishna@elitetaxation.co.nz', password: 'Krishna@2026', jobTitle: 'Tax Associate', team: 'Unassigned', accessRole: 'employee' },
];

function seedData() {
  const now = Date.now();
  const hash = (pw) => bcrypt.hashSync(pw, 10);
  return {
    employees: ROSTER.map((r, i) => ({
      id: 'e' + i, name: r.name, email: r.email, passwordHash: hash(r.password),
      jobTitle: r.jobTitle, accessRole: r.accessRole, team: r.team, managesIds: [],
    })),
    tasks: [], // starts empty — no fake/demo data
    clients: [], // { id, name, ownerId } — every client should have an owner (accountability)
    activityLog: [],
    punchLog: {}, // { [employeeId]: { date, punchedOut, seconds } } — today's live ticking state
    attendance: {}, // { [employeeId]: { [dateISO]: { loginAt, logoutAt, secondsWorked } } } — full daily history
    taskSeq: 100,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// Org chart setup — adds the requested employees and reporting lines if
// they aren't already present. Runs on every startup, matched by email, so
// it's safe against an existing db.json from an earlier deployment: it
// only ADDS missing people and UNIONS in missing managesIds (never removes
// an employee or a manage-grant that's already there), so no live task or
// client data is touched.
// ---------------------------------------------------------------------------
function ensureOrgChart(state) {
  const hash = (pw) => bcrypt.hashSync(pw, 10);
  let nextIdNum = state.employees.reduce((max, e) => {
    const n = parseInt(String(e.id).replace(/^e/, ''), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, -1) + 1;
  const byEmail = (email) => state.employees.find(e => e.email.toLowerCase() === email.toLowerCase());
  function ensureEmployee(email) {
    let emp = byEmail(email);
    if (!emp) {
      const r = ROSTER.find(x => x.email.toLowerCase() === email.toLowerCase());
      if (!r) return null; // not part of the known roster — nothing to create
      emp = { id: 'e' + (nextIdNum++), name: r.name, email: r.email, passwordHash: hash(r.password), jobTitle: r.jobTitle, accessRole: r.accessRole, team: r.team, managesIds: [] };
      state.employees.push(emp);
    }
    return emp;
  }
  function ensureManages(manager, subordinateIds) {
    if (manager.accessRole === 'employee') manager.accessRole = 'admin'; // don't downgrade an existing admin/superadmin
    manager.managesIds = manager.managesIds || [];
    subordinateIds.forEach(id => { if (!manager.managesIds.includes(id)) manager.managesIds.push(id); });
  }

  const shubham = ensureEmployee('shubham@elitetaxation.co.nz');
  const disha = byEmail('disha@elitetaxation.co.nz');
  const parvinder = byEmail('parvinder@elitetaxation.co.nz');
  const vishal = ensureEmployee('vishal@elitetaxation.co.nz');
  const khushi = ensureEmployee('khushi@elitetaxation.co.nz');
  const diksha = ensureEmployee('diksha@elitetaxation.co.nz');
  const nitish = ensureEmployee('nitish@elitetaxation.co.nz');
  const smita = ensureEmployee('smita@elitetaxation.co.nz');
  const hunny = ensureEmployee('hunny@elitetaxation.co.nz');
  const natasha = ensureEmployee('natasha@elitetaxation.co.nz');
  const krishna = ensureEmployee('krishna@elitetaxation.co.nz');
  const ranjit = byEmail('ranjit@elitetaxation.co.nz');
  const mukul = byEmail('mukul@elitetaxation.co.nz');

  if (disha) ensureManages(disha, [khushi.id, diksha.id, nitish.id]);
  ensureManages(vishal, [smita.id, hunny.id]);
  if (parvinder) ensureManages(parvinder, [natasha.id, ...(ranjit ? [ranjit.id] : []), ...(mukul ? [mukul.id] : [])]);
  // Disha, Vishal, Krishna, and Parvinder report to Shubham. Shubham is
  // superadmin, which already grants him assign-access to every employee —
  // managesIds only matters for the 'admin' role — so recording it here
  // isn't functionally required for that permission to work, but it keeps
  // the org chart correct and visible in the Employee Directory, and keeps
  // it accurate if Shubham's role is ever changed to admin later.
  const reportsToShubham = [disha, vishal, krishna, parvinder].filter(Boolean).map(e => e.id);
  ensureManages(shubham, reportsToShubham);

  // Governance-wide superadmins: Shubham, Vishal, Parvinder, Krishna, and
  // HR Administrator all get full oversight — who assigned what to whom,
  // every report card, and the Excel export — regardless of what role
  // they were seeded or previously set to. Enforced here every startup so
  // it can't silently drift.
  const hrAdmin = byEmail('hr@elitetaxation.co.nz');
  [shubham, vishal, parvinder, krishna, hrAdmin].filter(Boolean).forEach(e => { e.accessRole = 'superadmin'; });
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(seedData(), null, 2));
    console.log('[db] No existing data found — seeded a fresh database at', DB_PATH);
  }
}

ensureDataFile();
let state = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

// Migration safety net: if this is loading a db.json written by an older
// version of this app (before clients/review tracking existed), backfill
// the new fields so existing data doesn't break.
if (!state.clients) state.clients = [];
if (!state.attendance) state.attendance = {};
// Name-spelling fix: existing databases seeded before this correction still
// have the old spelling on disk — seedData()/ensureOrgChart() only add
// missing employees, they don't update fields on ones that already exist.
{
  const shubamRec = state.employees.find(e => e.email.toLowerCase() === 'shubham@elitetaxation.co.nz');
  if (shubamRec && shubamRec.name === 'Shubham Sharma') shubamRec.name = 'Shubam Sharma';
}
state.tasks.forEach(t => {
  // The Start/Pause timer and the pause-with-screenshot flow are gone —
  // the agreed-time-vs-actual-delivery clock now runs off acceptedAt
  // (set at Accept) instead of a manual timerRunning toggle.
  if (t.acceptedAt === undefined) t.acceptedAt = (t.status === 'accepted' || t.status === 'completed') ? (t.assignedAt || null) : null;
  if (t.reviewStatus === undefined) t.reviewStatus = null;
  if (t.reviewedBy === undefined) t.reviewedBy = null;
  if (t.reviewNote === undefined) t.reviewNote = null;
  if (t.reviewedAt === undefined) t.reviewedAt = null;
  if (t.completedAt === undefined) t.completedAt = null;
  if (t.clientId === undefined) t.clientId = null;
  if (t.reworkCount === undefined) t.reworkCount = 0;
  if (t.reworkStartedAt === undefined) t.reworkStartedAt = null;
  if (t.reworkHistory === undefined) t.reworkHistory = [];
  // Tracks which status ('accepted' or 'rework') a paused task should
  // return to on /resume — added when Accept stopped auto-starting the
  // timer and Pause/Start became reachable from rework too.
  if (t.pausedFromStatus === undefined) t.pausedFromStatus = null;
  // Reassignment / oversight tracking — backfill for tasks created before
  // these fields existed. assignedBy falls back to the assignee themself
  // (best available guess for old data — nothing was recorded before).
  if (t.assignedBy === undefined) t.assignedBy = t.assignedTo || null;
  if (t.assignedAt === undefined) t.assignedAt = null;
  if (t.reassignHistory === undefined) t.reassignHistory = [];
});

// All requests in this app are handled synchronously up to the point they
// mutate `state`, so a straightforward "load once, save after every write"
// pattern is safe here — Node runs JS single-threaded, so there's no
// interleaving between one request's read-modify-write and another's.
function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
}

// Apply the requested org chart (adds missing employees, unions in missing
// manage-grants) and persist immediately so it's on disk from this startup
// on, not just held in memory until some other write happens to trigger it.
ensureOrgChart(state);
save();

module.exports = {
  get: () => state,
  save,
  reload: () => { state = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); return state; },
};
