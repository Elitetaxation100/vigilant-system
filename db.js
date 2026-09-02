// ---------------------------------------------------------------------------
// Storage layer.
//
// This is the actual fix for "tasks not reaching the assigned person": data
// now lives in ONE place on the server's disk (data/db.json), and every
// employee's browser talks to that same server over HTTP. Nobody has their
// own private copy anymore.
//
// It started as a JSON file — simple, no native deps, trivial to back up.
// It now ALSO speaks Postgres: when DATABASE_URL is set (Railway injects it
// when a Postgres service is attached), Postgres becomes the store of record
// and the JSON file is kept as a within-container mirror. When DATABASE_URL
// is absent, behaviour is exactly as before — pure single-file store, byte
// for byte. Nothing outside this file knows or cares which store is active;
// the interface (init / get / save / reload / replace) is unchanged apart
// from the new async init().
//
//   DB_MODE=file   — force the file store even if DATABASE_URL is present
//                    (escape hatch if the Postgres path ever misbehaves).
//
// The in-memory `state` object stays the runtime source of truth exactly as
// it always was; save() persists it. Postgres writes are fire-and-forget so
// callers stay synchronous (same shape as the old fs.writeFileSync), but
// every failure is logged loudly and only-newer-wins is enforced in SQL.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// Postgres is used when DATABASE_URL is present and not explicitly disabled.
const USE_PG = !!process.env.DATABASE_URL && process.env.DB_MODE !== 'file';

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

// ---------------------------------------------------------------------------
// ADDITIVE FIELD MIGRATION (calls-into-tasks, Phase 0)
//
// Adds — never overwrites — the fields the new Admin space / membership
// dashboards / Slack task feed need. Runs on every startup, in BOTH storage
// modes, matched by email. Because every assignment is guarded with
// `=== undefined`, a value the founder later edits from the Employees screen
// is never rewritten on the next restart. Nothing existing is changed: the
// current `accessRole`, `team` string, `managesIds` and all task fields keep
// working exactly as they do.
// ---------------------------------------------------------------------------
function ensureExtendedFields(state) {
  // The confirmed Aircall agents — matched by the app's OWN login email, not
  // Aircall's (Aircall uses different addresses). Only the founder is
  // flagged; everyone else keeps whatever access they already have.
  const AIRCALL_AGENTS = {
    'shubham@elitetaxation.co.nz': '1660428',
    'parvinder@elitetaxation.co.nz': '1682239',
    'anjana@elitetaxation.co.nz': '1674408',
    'disha@elitetaxation.co.nz': '1937711',
  };
  const FOUNDER_EMAILS = ['shubham@elitetaxation.co.nz'];
  // Starting team memberships from the current org chart. Everyone not listed
  // gets a 'member' membership mirroring the team they're already in, so
  // their placement is unchanged — just also recorded in the new shape.
  // All of it is editable afterwards and never rewritten once set.
  const SEED_MEMBERSHIPS = {
    'shubham@elitetaxation.co.nz': [{ team: 'Leads', level: 'admin' }],
    'parvinder@elitetaxation.co.nz': [{ team: 'Companies', level: 'admin' }],
    'disha@elitetaxation.co.nz': [{ team: 'Rideshare', level: 'admin' }, { team: 'Rental', level: 'admin' }],
    'anjana@elitetaxation.co.nz': [{ team: 'Rideshare', level: 'admin' }],
    'vishal@elitetaxation.co.nz': [{ team: 'Marketing', level: 'admin' }],
  };

  (state.employees || []).forEach(e => {
    const email = String(e.email || '').toLowerCase();
    if (e.slackUserId === undefined) e.slackUserId = null;
    if (e.aircallAgentId === undefined) e.aircallAgentId = AIRCALL_AGENTS[email] || null;
    if (e.isFounder === undefined) e.isFounder = FOUNDER_EMAILS.includes(email);
    if (e.notifyPrefs === undefined) {
      e.notifyPrefs = { channel: 'slack', quietHoursStart: null, quietHoursEnd: null, digestHour: null };
    }
    if (e.memberships === undefined) {
      e.memberships = SEED_MEMBERSHIPS[email]
        ? SEED_MEMBERSHIPS[email].map(m => ({ ...m }))
        : (e.team && e.team !== 'Unassigned' ? [{ team: e.team, level: 'member' }] : []);
    }
  });

  // Team registry — the union of every team currently in use plus the
  // org-chart teams, so both name-sets work side by side. Additive only:
  // teams are added, never removed, even empty ones.
  if (!Array.isArray(state.teams)) state.teams = [];
  const ORG_CHART_TEAMS = ['Leads', 'Companies', 'Rideshare', 'Rental', 'Marketing'];
  const names = new Set();
  (state.employees || []).forEach(e => {
    if (e.team) names.add(e.team);
    (e.memberships || []).forEach(m => { if (m && m.team) names.add(m.team); });
  });
  ORG_CHART_TEAMS.forEach(t => names.add(t));
  names.forEach(name => {
    if (!state.teams.some(t => t.name === name)) {
      state.teams.push({ id: 't-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name, createdAt: Date.now() });
    }
  });
}

// Backfills that used to run inline at module load — now a function so both
// stores share exactly one migration path.
function runMigrations(state) {
  if (!state.clients) state.clients = [];
  if (!state.attendance) state.attendance = {};
  // calls-into-tasks Phase 5: the connector's call log moves off the Google
  // Sheet into here. Each row mirrors what the "Call Log" tab held.
  if (!Array.isArray(state.calls)) state.calls = [];
  if (typeof state.callSeq !== 'number') state.callSeq = 0;
  if (!state.connectorDigest || typeof state.connectorDigest !== 'object') state.connectorDigest = { lastSlot: null };
  // Name-spelling fix: existing databases seeded before this correction still
  // have the old spelling — seedData()/ensureOrgChart() only add missing
  // employees, they don't update fields on ones that already exist.
  {
    const shubamRec = (state.employees || []).find(e => e.email.toLowerCase() === 'shubham@elitetaxation.co.nz');
    if (shubamRec && shubamRec.name === 'Shubham Sharma') shubamRec.name = 'Shubam Sharma';
  }
  (state.tasks || []).forEach(t => {
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
    // calls-into-tasks (Phase 0): where a task came from. Existing tasks are
    // all 'manual'; the Slack connector will start sending 'call' / 'slack'
    // in a later phase. sourceRef holds a Slack permalink when relevant.
    if (t.source === undefined) t.source = 'manual';
    if (t.sourceRef === undefined) t.sourceRef = null;
  });
  ensureOrgChart(state);
  ensureExtendedFields(state);
}

// ---------------------------------------------------------------------------
// File store (unchanged behaviour — this is exactly what ran before when no
// database was configured).
// ---------------------------------------------------------------------------
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(seedData(), null, 2));
    console.log('[db] No existing data found — seeded a fresh database at', DB_PATH);
  }
}
function loadFromFileSync() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function writeFileMirror(json) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_PATH, json);
  } catch (e) {
    console.error('[db] file write failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Postgres store (used only when DATABASE_URL is set). A single-row table
// holds the whole state document as JSONB — the same "one place, load once,
// save after every write" model as the file, just durable across container
// restarts and deploys (which is the point: Railway's disk is ephemeral).
// Per-table schema comes in a later phase for the parts that actually grow.
// ---------------------------------------------------------------------------
let pool = null;
let pgActive = false;
let rev = 0;

function pgSslConfig(url) {
  if (/\bsslmode=require\b/i.test(url)) return { rejectUnauthorized: false };
  if (/\.railway\.internal(?::|\/|$)/i.test(url)) return false; // private network — no SSL
  if (/rlwy\.net|\.railway\.app|proxy\.rlwy/i.test(url)) return { rejectUnauthorized: false }; // public proxy
  if (process.env.PGSSLMODE === 'require' || process.env.DATABASE_SSL === 'require') return { rejectUnauthorized: false };
  return false;
}

async function pgInit() {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: pgSslConfig(process.env.DATABASE_URL),
    max: 5,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id         integer PRIMARY KEY DEFAULT 1,
      data       jsonb NOT NULL,
      rev        bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT app_state_singleton CHECK (id = 1)
    )
  `);
  const { rows } = await pool.query('SELECT data, rev FROM app_state WHERE id = 1');
  if (rows.length) {
    rev = Number(rows[0].rev) || 0;
    console.log('[db] Postgres: loaded existing state (rev ' + rev + ').');
    return rows[0].data;
  }
  // First boot on Postgres — bring across whatever is already in the local
  // file if it's present; otherwise seed fresh. (On Railway the file may or
  // may not survive the deploy that first attaches Postgres — see
  // /api/admin/state-import for the manual path if it doesn't.)
  let initial = null;
  if (fs.existsSync(DB_PATH)) {
    try {
      initial = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      console.log('[db] Postgres is empty — importing data/db.json (' +
        (initial.employees || []).length + ' employees, ' +
        (initial.tasks || []).length + ' tasks, ' +
        (initial.clients || []).length + ' clients).');
    } catch (e) {
      console.error('[db] could not parse data/db.json for import:', e.message);
      initial = null;
    }
  }
  if (!initial) {
    initial = seedData();
    console.log('[db] Postgres is empty and no data/db.json to import — seeding a fresh database.');
  }
  await pool.query(
    'INSERT INTO app_state (id, data, rev) VALUES (1, $1::jsonb, 0) ON CONFLICT (id) DO NOTHING',
    [JSON.stringify(initial)]
  );
  return initial;
}

function pgSave(json) {
  const r = ++rev;
  // Fire-and-forget so callers stay synchronous. only-newer-wins is enforced
  // in the WHERE clause, so an out-of-order landing can't clobber a newer
  // write. Failures are logged, not thrown.
  pool.query(
    `INSERT INTO app_state (id, data, rev, updated_at) VALUES (1, $1::jsonb, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, updated_at = now()
     WHERE app_state.rev < EXCLUDED.rev`,
    [json, r]
  ).catch(err => console.error('[db] Postgres save FAILED (rev ' + r + '):', err.message));
}

// ---------------------------------------------------------------------------
// Public interface — same as before, plus an async init() the server awaits
// before it starts listening.
// ---------------------------------------------------------------------------
let state = null;
let initialized = false;

async function init() {
  if (initialized) return state;

  if (USE_PG) {
    try {
      state = await pgInit();
      pgActive = true;
      console.log('[db] storage mode: POSTGRES (store of record) + file mirror');
    } catch (err) {
      console.error('[db] Postgres init FAILED — running on the file store instead. Fix the DB and redeploy. Error:', err.message);
      pgActive = false;
      state = loadFromFileSync();
      console.log('[db] storage mode: FILE (Postgres fallback)');
    }
  } else {
    state = loadFromFileSync();
    console.log('[db] storage mode: FILE');
  }

  runMigrations(state);
  save(); // persist migrations to whichever store(s) are active
  initialized = true;
  return state;
}

function get() {
  if (state === null) {
    // init() wasn't awaited before a request came in. Load the file store
    // synchronously so the app is never left without data. (Postgres can't
    // be read synchronously; this only happens if startup wasn't sequenced.)
    console.error('[db] get() before init() — loading the file store synchronously as a fallback.');
    state = loadFromFileSync();
    runMigrations(state);
  }
  return state;
}

function save() {
  if (state === null) return;
  const json = JSON.stringify(state, null, 2);
  writeFileMirror(json);          // always keep the local file current
  if (pgActive) pgSave(json);     // durable store of record
}

async function reload() {
  if (pgActive) {
    const { rows } = await pool.query('SELECT data, rev FROM app_state WHERE id = 1');
    if (rows.length) { state = rows[0].data; rev = Number(rows[0].rev) || 0; }
    return state;
  }
  state = loadFromFileSync();
  return state;
}

// Replace the entire state in place (keeps the same object reference every
// route handler is holding) and persist. Used by /api/admin/state-import.
function replace(newState) {
  if (!newState || typeof newState !== 'object' || !Array.isArray(newState.employees)) {
    throw new Error('replace() needs a state object with an employees array');
  }
  if (state === null) state = {};
  Object.keys(state).forEach(k => { delete state[k]; });
  Object.assign(state, newState);
  runMigrations(state);
  save();
  return state;
}

module.exports = {
  init,
  get,
  save,
  reload,
  replace,
  _mode: () => (pgActive ? 'postgres' : 'file'),
  _rev: () => rev,
};
