// The Founder dashboard's Today tab shows the same list as everyone else's Today: the shared table (Urgent / Also today), search, Processor filter and order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');

test('Founder Today tab: same table, search, Processor filter and order as the Today page', () => {
  assert.ok(html.includes("if(_fdView === 'today'){ fdTodayDraw(); return; }"));
  const fn = html.slice(html.indexOf('function fdtListHtml('), html.indexOf('function fdtCount('));
  assert.ok(fn.includes('TD_COLHEAD') && fn.includes('tdCardHtml(') && fn.includes('Urgent — client date today or passed'));
  assert.ok(html.includes('id="fdtQ"') && html.includes('id="fdtProc"') && html.includes('id="fdtSort"') && html.includes("_fdtSort = 'latest'"));
  assert.ok(html.includes("api('/api/workflow/today')") && html.includes('class="td-list" id="fdtList"'));
});

test('the Founder View and Review & Decisions tabs are unchanged', () => {
  assert.ok(html.includes("V.founder.actionTiles") && html.includes('V.review.tiles') && html.includes('<div id="fdWatch" class="fdw"'));
});
