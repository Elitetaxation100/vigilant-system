// Accessibility and state rules for the new screens, checked against the page source (no browser needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
const between = (a, b) => { const i = html.indexOf(a); assert.ok(i >= 0, a + ' present'); const j = html.indexOf(b, i + a.length); return html.slice(i, j < 0 ? undefined : j); };

test('every dialog is announced as a dialog and keyboard focus is managed', () => {
  assert.match(html, /id="modalBox" role="dialog" aria-modal="true"/);
  const js = between('function openModal(){', 'function closeModal(){');
  assert.match(js, /\.focus\(\)/, 'focus moves into the dialog on open');
  assert.match(js, /aria-label/, 'the dialog is named from its heading');
  const trap = between("if(e.key !== 'Tab') return;", '});');
  assert.match(trap, /shiftKey/); assert.match(trap, /first\.focus\(\)/); assert.match(trap, /last\.focus\(\)/);
  assert.match(between('function closeModal(){', '// Tab / Shift+Tab'), /_modalOpener[\s\S]*\.focus\(\)/, 'focus returns to where it came from on close');
  assert.match(html, /e\.key === 'Escape' && !window\.__loginGateActive/, 'Escape closes a dialog');
});

test('the new screens have visible keyboard focus, 44px touch targets and respect reduced motion', () => {
  assert.match(html, /body\.v2-dash :is\(button, select, input, textarea, a, summary, \[role=menuitem\]\):focus-visible\{ outline:2px solid/);
  assert.match(html, /@media \(pointer:coarse\), \(max-width:760px\)\{[\s\S]{0,400}min-height:44px/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)\{ body\.v2-dash/);
  assert.match(html, /\.nv2-new\{[^}]*min-height:44px/); assert.match(html, /#navV2 \.nav-item\{ min-height:44px/);
  assert.match(html, /\.td-count\{[^}]*min-height:64px/); assert.match(html, /\.td-seg button\{[^}]*min-height:44px/);
});

test('mobile: tables become cards that keep their labels, and the detail panel has a back button and sticky actions', () => {
  assert.match(html, /@media \(max-width: 760px\)\{[\s\S]*\.tm-table thead\{ display:none; \}/);
  assert.match(html, /\.tm-table td::before\{ content:attr\(data-l\)/);
  assert.match(html, /class="btn td-back td-act" onclick="tdBack\(\)"/); assert.match(html, /class="td-sticky"/);
});

test('every new screen has loading, empty and error states with a retry; live regions announce updates', () => {
  for (const [name, loading, empty, retry] of [
    ['renderToday', 'Loading your day', 'td-empty', 'renderToday()'], ['renderTeamView', 'Loading your team', 'No team members yet', 'renderTeamView()'],
    ['mtLoad', 'Loading tasks', 'No tasks match these filters', 'mtLoad()'], ['mtLoadCalendar', 'Loading the calendar', 'cal-grid', 'mtLoadCalendar()'], ['mtLoadTimeline', 'Loading the timeline', 'No open tasks match these filters', 'mtLoadTimeline()'],
  ]) { assert.ok(html.includes(loading), name + ' has a loading state'); assert.ok(html.includes(empty), name + ' has an empty state'); assert.ok(html.includes(retry), name + ' offers a retry'); }
  assert.match(html, /id="tdRoot" aria-live="polite"/);
  assert.equal((html.match(/role="alert">Could not load/g) || []).length >= 5, true, 'errors are announced');
  assert.match(html, /id="navV2" style="display:none;" aria-label="Main menu"/);
  assert.match(html, /aria-haspopup="menu"/); assert.match(html, /role="menu"/); assert.match(html, /role="menuitem"/);
});

test('form controls are labelled; link and review fields explain themselves', () => {
  for (const id of ['atSheet', 'atCash', 'atReviewer', 'atNoReviewReason', 'holdResp', 'holdFollow', 'mtaReason'])
    assert.match(html, new RegExp('<label[^>]*for="' + id + '"'), id + ' has a label');
  assert.match(html, /<label class="mt-f mt-q"><span>Search<\/span><input type="search"/, 'search is a real search field');
});

test('Performance: managers see Productivity (scoped by the server), team managers get a My team / Whole firm switch, and My Team lists productivity with report-card links', () => {
  assert.match(html, /\['productivity', 'Productivity', 'manager'\]/);
  assert.match(html, /gate === 'manager' \? \(isAdmin \|\| isSuperAdmin\)/);
  assert.match(html, /setProdScope\(false\)[\s\S]{0,200}setProdScope\(true\)/);
  assert.match(html, /function teamProductivityHtml\(\)/); assert.match(html, /openReportCardFor\(this\.dataset\.id\)/);
});

test('dashboard views are real tabs: tablist/tab/tabpanel, aria-selected, arrow keys, no checkboxes', () => {
  assert.match(html, /role="tablist" aria-label="Dashboard view"/);
  assert.match(html, /role="tab" id="tdTab_'/);
  assert.match(html, /aria-selected="' \+ \(_tdMode === k\)/);
  assert.match(html, /role="tabpanel" aria-labelledby="tdTab_'/);
  assert.match(html, /function tdTabKey\(e\)[\s\S]*ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/);
  assert.doesNotMatch(html.slice(html.indexOf('function drawToday')), /^[\s\S]{0,2500}type="checkbox"/, 'the view switcher is not a checkbox');
});
test('each tile announces its name, count, scope and action; the search box has a label', () => {
  assert.match(html, /aria-label="' \+ esc\(t\.label \+ ', ' \+ n \+ \(n === 1 \? ' task' : ' tasks'\) \+ '\. Scope: ' \+ t\.scope/);
  assert.match(html, /<label class="flt-q"><span class="sr-only"[^>]*>Search<\/span><input type="search" id="flt_' \+ ns \+ '_q"/);
  assert.match(html, /\.td-acc-h\{[^}]*min-height:44px/);
});
test('switching view clears the old view: tile, open section, selected task and search', () => {
  const fn = html.slice(html.indexOf('function tdSetMode'), html.indexOf('function tdTabKey'));
  for (const v of ['_tdTile = null', '_tdOpen = tdDefaultOpen()', '_tdSel = null', "fltReset('td')"]) assert.ok(fn.includes(v), v);
});
test('every task list sorts newest first', () => {
  assert.match(html, /function taskNewest\(a, b\)/);
  assert.equal((html.match(/\.sort\(taskNewest\)/g) || []).length >= 8, true);
});

test('the new layout is chosen the moment sign-in succeeds — before the slow data loads, and before the login box closes', () => {
  assert.match(html, /function landV2Early\(\)\{[\s\S]{0,200}applyDashboardV2\(\);[\s\S]{0,200}showView\('today'/);
  const submit = html.slice(html.indexOf('async function submitLogin()'), html.indexOf('// A brand-new account'));
  assert.ok(submit.indexOf('landV2Early()') > 0 && submit.indexOf('landV2Early()') < submit.indexOf('closeModal()'), 'before the login box closes');
  const done = html.slice(html.indexOf('async function onLoginComplete()'), html.indexOf('function openAdminLogin()'));
  assert.ok(done.indexOf('landV2Early()') < done.indexOf('await refreshEmployees()'), 'before the first slow load');
  assert.match(html, /_v2Landed = false; applyDashboardV2\(\);/, 'a new sign-in lands again after logout');
});

test('every task list has bold, coloured column headings in the same order as its rows: Name, Work, Processor, (Status,) Client commitment date, Link', () => {
  assert.match(html, /const TD_COLHEAD = [^;]*<span>Name<\/span><span>Work<\/span><span>Processor<\/span><span>Status<\/span><span>Client commitment date<\/span><span>Link<\/span>/);
  assert.match(html, /\.td-colhead\{[^}]*background:var\(--purple-dim\);[^}]*color:var\(--purple\);[^}]*font-weight:800/);
  assert.match(html, /const RQ_HEAD = [^;]*<span>Name<\/span><span>Work<\/span><span>Processor<\/span><span>Client commitment date<\/span><span>Link<\/span>/);
  assert.match(html, /<thead><tr><th>Name<\/th><th>Work<\/th><th>Processor<\/th><th>Status<\/th><th>Internal due<\/th><th>Client commitment date<\/th><th>Link<\/th>/);
  assert.match(html, /\.tm-table thead th\{ background:var\(--purple-dim\); color:var\(--purple\); font-weight:800; \}/);
  const row = html.slice(html.indexOf('function tdCardHtml'), html.indexOf('/* ---------------- One filter bar'));
  const order = ['tr-name', 'tr-work', 'tr-who', 'tr-st', 'tr-date', 'tr-link'].map(c => row.indexOf('class="' + c + '"') + 0 || row.indexOf('"' + c));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'cells are in the same order as the headings');
  assert.match(row, /<div class="td-card td-row/, 'a row is a div, so the links inside it are real links');
  assert.match(html, /\.td-list \.td-row\{ grid-template-columns:/, 'headings and rows share one column layout');
});
test('the Sheet and Cashbook links are real links that open in a new tab and never trigger the row', () => {
  const fn = html.slice(html.indexOf('function linkCellHtml'), html.indexOf('const TD_COLHEAD'));
  assert.match(fn, /target="_blank" rel="noopener noreferrer" onclick="event\.stopPropagation\(\)"/);
  assert.match(fn, /📎/);
});
test('the right-hand panel opens the first task by itself on a computer, never an empty box; a phone keeps a list', () => {
  assert.match(html, /function tdFirstVisibleId\(\)/);
  assert.match(html, /if\(!_tdSel && window\.matchMedia\('\(min-width: 901px\)'\)\.matches\)\{ const f = tdFirstVisibleId\(\); if\(f\) _tdSel = f; \}/);
  assert.doesNotMatch(html, /Select a task on the left to see everything about it here/);
});
test('every list has a Processor filter: Today (3 views), Reviews, the Tasks list, Calendar and Timeline', () => {
  assert.match(html, /<span>Processor<\/span><select id="flt_' \+ ns \+ '_processor"/);
  assert.match(html, /if\(f\.processor && c\.assigneeId !== f\.processor\) return false;/);
  assert.match(html, /function fltProcessors\(ns\)/);
  assert.match(html, /mtSel\('mtf_employee', 'Processor'/);
  assert.match(html, /sel\('employee', 'Processor'/);
});
