// Batch A — semantics: real radios for the review decision, no placeholder links, Admin Task wording, configured profit confirmer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');

test('no link goes to "#" — every action is a real button or route', () => {
  assert.equal((html.match(/href="#"/g) || []).length, 0);
  assert.match(html, /\.linkbtn\{/);
});
test('the review decision is a radio group; Approve no longer asks whether the work is clean', () => {
  assert.match(html, /role="radiogroup" aria-label="Review decision/);
  assert.equal((html.match(/type="radio" name="rv2Decision"/g) || []).length, 3);
  assert.doesNotMatch(html, /Is this work clean and ready/);
  assert.doesNotMatch(html, /rv2Clean/);
  assert.match(html, /Approving means the work is clean/);
});
test('people see "Admin Task", never "Internal task" or "Internal" as a client', () => {
  assert.doesNotMatch(html, />Internal task</);
  assert.doesNotMatch(html, /clientName \|\| 'Internal'/);
  assert.match(html, /function clientLabel\(t\)/);
  assert.match(html, /Admin Task<\/button>/);
});
test('Shubam is not typed into the review or confirmation screens — the configured confirmer is shown', () => {
  const rv = html.slice(html.indexOf('function openReviewV2'), html.indexOf('function openEscalationDecision'));
  assert.doesNotMatch(rv, /Shubam/);
  assert.match(rv, /pcName\(t\)/);
  assert.match(html, /function pcName\(t\)/);
});
test('escalation recipients exclude system / test accounts on the page and on the server', () => {
  assert.match(html, /!isSystemAccount\(e\) && e\.id !== currentViewerId/);
  assert.match(server, /isSystemAccount\(to\)\) return res\.status\(400\)/);
});

test('sidebar navigation is keyboard- and screen-reader-operable (buttons with a current-page marker)', () => {
  assert.match(html, /function enhanceNavItems\(\)/);
  assert.match(html, /n\.setAttribute\('role', 'button'\); n\.setAttribute\('tabindex', '0'\)/);
  assert.match(html, /aria-current/);
  assert.match(html, /\.nav-item:focus-visible\{/);
});

test('Reviews: one slim line per task (name, work, processor, client date, links, Review), the rest under the row, one open at a time', () => {
  const row = html.slice(html.indexOf('function rqCardHtml'), html.indexOf('async function renderReviewsV2'));
  for (const part of ['rq-name', 'rq-work', 'rq-cd', 'rq-links', 'rq-own', 'Review</button>', 'class="rq-det"', 'aria-expanded', 'aria-controls']) assert.ok(row.includes(part), part);
  assert.match(row, /function rqToggle\(id\)[\s\S]*one open at a time/);
  assert.match(html, /\.rq-row\{ min-height:38px;/);
  assert.match(html, /rq-sec-empty/, 'an empty section is a single line, not a box');
});

test('every list has the same search + Status + Date bar, and the tile numbers follow it', () => {
  assert.match(html, /function fltBarHtml\(ns\)/);
  for (const part of ['Search', 'Status', 'Date</span>', 'Date is the', 'fltClear']) assert.ok(html.slice(html.indexOf('function fltBarHtml')).includes(part), part);
  assert.ok(html.includes("['custom', 'Pick dates…']"), 'a custom date range');
  assert.match(html, /function tdMatch\(id\)\{ return fltMatch\('td'/);
  assert.match(html, /const n = idsOf\(FIELD\[k\]\)\.length/, 'Reviews tiles are counted from the filtered lists');
  assert.match(html, /fltBarHtml\('td'\)/); assert.match(html, /fltBarHtml\('rv'\)/);
  assert.match(html, /id="mtf_datePreset"/, 'the Tasks page has a date filter too');
  assert.match(html, /\.td-row\{ display:grid !important;/, 'dashboard rows are one slim line');
});

test('work assigned to me: Accept, Start, Mark Done, Send for review, Hold / query, Resume are offered on Today and on the Tasks page', () => {
  assert.match(html, /if\(n\.type === 'accept'\) return btn\(/, 'Accept is the primary action on a task waiting for me');
  assert.match(html, /<div class="td-own"><b>My actions<\/b>' \+ actionCell\(t\)/, 'the Today panel carries every own-task action');
  assert.match(html, /function myTaskMenuItems\(t\)/);
  for (const a of ["acceptTask('", "markDoneNoReview('", "openCompleteModal('", "openHoldModal('", "unholdTask('", "openProposeModal('"]) assert.ok(html.slice(html.indexOf('function myTaskMenuItems')).includes(a), a);
  assert.match(html, /<button type="button" class="btn small primary td-act" style="margin-top:4px;" onclick="acceptTask/, 'an Accept button right on the Tasks row');
  assert.match(html, /const tdDefaultOpen = \(\) => _tdMode === 'today' \? 'my_work'/, 'My work starts open on Today');
});

test('task history: a task on hold says On hold (not In rework), and a day-only resume never jumps after a later same-day hold', () => {
  assert.ok(html.includes("const stateNow = t.status === 'on_hold' ? 'On hold'"), 'on hold wins over the correction state');
  assert.ok(html.includes('nextHoldCap'), 'day-only resume events are capped before the next hold');
  assert.ok(html.includes("e.cap ? new Date(new Date(e.cap).getTime() - 1)"), 'the sort honours the cap');
});
