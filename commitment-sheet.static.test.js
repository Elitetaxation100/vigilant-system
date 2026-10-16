// Commitment watch is a full page that works like a spreadsheet; the client is the headline and the task name is small; search and filters on the pages that lacked them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');

test('Commitment watch is a page, not a pop-up, and every menu entry and tile still opens it', () => {
  assert.ok(html.includes('id="view-cwatch"') && html.includes('id="cwRoot"'));
  assert.ok(html.includes("if(id === 'cwatch') renderCommitmentSheet();") && html.includes("showView('cwatch', null);"));
  assert.ok(!html.includes('class="cw-modal"') && !html.includes('function drawCommitmentWatch('), 'the pop-up is gone');
  assert.ok(html.includes('id="cwNavItemV2" onclick="openCommitmentWatch()"') && html.includes("openCommitmentWatch('breaches')") && html.includes("openCommitmentWatch('flags')"));
});

test('the sheet has a column for every date and stage, and sort, filter, search, group, columns, saved views, resize and CSV like a spreadsheet', () => {
  const cols = html.slice(html.indexOf('const CWS_COLS = ['), html.indexOf('const CWS_DEFAULT_COLS'));
  for (const label of ['Client', 'Task', 'Processor', 'Reviewer', 'Status', 'Assigned', 'Internal due', 'Client due', 'Submitted', 'Reviewed', 'Sent back', 'Ready for report', 'Report sent', 'Last update', 'Days over', 'Flags', 'Allocated h', 'Logged h', 'Fix rounds', 'Financial year']) assert.ok(cols.includes("label:'" + label + "'"), label);
  for (const fn of ['function cwsSort(', 'function cwsPopFilter(', 'function cwsSearch(', 'function cwsSetGroup(', 'function cwsPopColumns(', 'function cwsSaveView(', 'function cwsResizeStart(', 'function cwsCsv(', 'function cwsDateQuick(', 'function cwsEnumTick(', 'function cwsRemoveFilter(']) assert.ok(html.includes(fn), fn);
  for (const kind of ["c.type === 'text'", "c.type === 'enum'", "c.type === 'date' || c.type === 'datetime'", "c.type === 'num'", "c.type === 'multi'"]) assert.ok(html.includes(kind), kind + ' filters');
  assert.ok(html.includes('.cws-s1{ position:sticky;') && html.includes('.cws-table thead th{ position:sticky;'), 'header row and first column stay put');
  for (const p of ['Commitment breaches', 'Late & at risk', 'All open tasks', 'All tasks']) assert.ok(html.includes("label:'" + p + "'"), p);
});

test('client first, task small: one helper, used on the lists, cards and tables', () => {
  assert.ok(html.includes('function ttHtml(client, name)') && html.includes('function ttOf(t)') && html.includes('.tt-task{ display:block; font-size:12px;'));
  assert.ok((html.match(/ttOf\(t\)/g) || []).length >= 8, 'the task lists use it');
  assert.ok(html.includes('<th>Client</th><th>Task</th><th>Source</th><th>Assignee</th>') && html.includes('<thead><tr><th>Client</th><th>Task</th><th style="width:110px;">Owner</th>'), 'tables put Client first');
  assert.ok(html.includes("ttHtml(c.clientName, c.name)"), 'the Today list too');
});

test('search and filters on the pages that lacked them: Today, client ownership, client profile', () => {
  assert.ok(html.includes('id="slTq"') && html.includes('function slTodayFilter('));
  assert.ok(html.includes('id="coQ"') && html.includes('function coFilter(') && html.includes("['late', 'Late work']"));
  assert.ok(html.includes('id="cpQ"') && html.includes('function cpFilter('));
});

test('managers can change the dates on their own tasks (client side too)', () => {
  assert.ok(html.includes("&& (isAdmin || selfEditActive());"));
});
