// The simplified manager layout (from the mockup): an 8-item menu, a Today with one "needs action" list, a one-line-per-task Tasks list with five plain
// statuses, and a short New task form. Everything is gated on the per-person switch, and the recurring-task buttons are untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8').replace(/\r\n/g, '\n');
const db = fs.readFileSync(__dirname + '/db.js', 'utf8').replace(/\r\n/g, '\n');

test('the menu has the eight items from the mockup, in order, and replaces the full manager menu', () => {
  const nav = html.slice(html.indexOf('id="navSimple"'), html.indexOf('id="navSimple"') + 2600);
  const labels = [...nav.matchAll(/<\/span> ([^<]+?)(?:<span|<\/div>)/g)].map(m => m[1].trim());
  assert.deepEqual(labels.slice(0, 8), ['Today', 'My tasks', '+ New task', 'Calls', 'Clients', 'Reviews', 'Team', 'Settings']);
  assert.ok(nav.includes('class="sl-sec">Manager<'), 'Manager heading above Reviews / Team / Settings');
  assert.ok(html.includes('body.v2-dash.simple-layout #navV2{ display:none !important; }') && html.includes('body.v2-dash.simple-layout .sidebar #navSimple.nav-section{ display:block !important; }'));
});

test('the layout is per person: switched on once for Disha, managers only, changed in Manage Access', () => {
  assert.ok(db.includes('simpleLayoutForDisha') && db.includes("'disha@elitetaxation.co.nz'"));
  assert.ok(server.includes("rest.simpleLayout = !!e.simpleLayout && isAdminRole(e.accessRole);"));
  assert.ok(html.includes("function slOn(){ return !!(session && session.simpleLayout && isAdmin); }"));
  assert.ok(html.includes("document.body.classList.toggle('simple-layout', slOn());"));
  assert.ok(html.includes('id="meSimpleLayout"') && html.includes('payload.simpleLayout = simpleEl.checked'));
});

test('Today shows the alert, the greeting, the four tiles, Needs action now (Mark sent / Nudge) and Team today', () => {
  const fn = html.slice(html.indexOf('function drawSlToday('), html.indexOf('async function slMarkSent('));
  for (const s of ['sl-alert', 'slGreeting()', 'Overdue (team)', 'Approved, not sent to client', 'Waiting for your review', 'Finished today', 'Needs action now', 'Mark sent', 'Nudge', 'Team today', 'Open Team →']) assert.ok(fn.includes(s), s);
  assert.ok(html.includes("if(slOn() && id === 'today'){ id = 'stoday';"), 'Today lands on the simple Today');
  assert.ok(html.includes("if(id === 'stoday') renderSlToday();") && html.includes("if(id === 'stasks') renderSlTasks();"));
});

test('the Tasks list: five plain statuses (the reviewer named), one date that is red only when late, and the four filters', () => {
  const st = html.slice(html.indexOf('function slStatus('), html.indexOf('const SL_ORDER'));
  for (const s of ['Approved – send it', 'Fix needed', "'With ' +", 'Doing', 'To do']) assert.ok(st.includes(s), s);
  const fn = html.slice(html.indexOf('function drawSlTasks('), html.indexOf('/* ---------- New task'));
  assert.ok(fn.includes("sl-due' + (late ? ' late' : '')") && fn.includes('s.k !== \'done\''));
  for (const s of ['Search…', "'Person ▾'", "'Status ▾'", 'Due: Any time', 'Due: This week', 'showing open']) assert.ok(fn.includes(s), s);
  assert.ok(fn.includes("mtOpenDetail("), 'a row opens the task');
});

test('the New task form is short: Who|Due, Client, Job type|Time, Notes, and everything else under More options; no Test User / Admin / duplicate names', () => {
  const fn = html.slice(html.indexOf('function atSimplify('), html.indexOf('function atSimplify(') + 4200);
  assert.ok(fn.includes('test user|admin') && fn.includes('seen.has(name)'), 'Who is cleaned up');
  assert.ok(fn.includes("'Who'") && fn.includes("'Notes (optional)'") && fn.includes('More options') && fn.includes("fieldOf('atPriority'), $('atClientDateWrap')"));
  assert.ok(html.includes('if(slOn()) atSimplify();'), 'only for people on the simple layout');
  assert.ok(html.includes("jw.style.display = (isInternal || !(taxonomyDepartments || []).length) ? 'none' : ''"), 'an Admin task hides Client and Job type');
  assert.ok(html.includes('onclick="closeModal();openBulkAssignModal()"'), 'the bulk import link stays');
});

test('the recurring-task buttons and the other layouts are untouched', () => {
  assert.ok(html.includes('openRecurringModal') && html.includes('/api/recurring-tasks'));
  assert.ok(html.includes('id="navV2"') && html.includes("function v2Manager(){ return !!(session && session.dashboardV2 && isAdmin); }"));
});
