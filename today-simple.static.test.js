// The simple Today is the default for personal views, keeps a way to the full dashboard, hides the duplicate alert banners on that page, and leaves the other views alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');

test('simple view is the default, remembered, only for the personal views, and the full dashboard is one click away (and back)', () => {
  assert.ok(html.includes('let _tdSimple = true;'));
  assert.ok(html.includes("localStorage.getItem('tdSimple') === '0'"), 'the choice is remembered');
  assert.ok(html.includes("['today', 'processor'].includes(_tdMode)"), 'Manager View and Review View keep their own screens');
  assert.ok(html.includes('onclick="tdSetSimple(false)">Show everything') && html.includes('tdSetSimple(true)">← Simple view'));
  assert.ok(html.includes('if(tdIsSimple()){ body.innerHTML = tdSimpleHtml(); return; }'));
  assert.ok(html.includes("(tdIsSimple() ? '' : fltBarHtml('td'))"), 'no filter bar in the simple view');
});

test('the duplicate alert banners are hidden on the simple Today page only', () => {
  assert.ok(html.includes('body.td-simple-on #deadlineBannerWrap{ display:none; }'));
  assert.ok(html.includes("document.body.classList.toggle('td-simple-on', id === 'today' && typeof tdIsSimple === 'function' && tdIsSimple());"), 'switching to any other page brings them back');
});

test('the Today list uses the same table as the full dashboard (Name · Work · Processor · Status · Client commitment date · Link), in an Urgent section then the rest, with search, Processor filter and order', () => {
  const fn = html.slice(html.indexOf('function tsListHtml('), html.indexOf('function tsRedrawList('));
  assert.ok(fn.includes('TD_COLHEAD') && fn.includes('tdCardHtml('), 'the shared table header and row');
  assert.ok(html.includes("const TD_COLHEAD = colHeadHtml('Client commitment date');"));
  assert.ok(fn.includes('Urgent — client date today or passed') && fn.includes('td-sec'), 'an Urgent section with its count');
  assert.ok(html.includes('id="tsQ"') && html.includes('id="tsProc"') && html.includes('Latest client date first'));
  assert.ok(html.includes("let _tsQ = '', _tsProc = '', _tsSort = 'latest';"), 'latest first is the default');
  assert.ok(html.includes('const TS_SHOW = 15;') && html.includes('class="ts-more"'));
});

test('no Punch In / Time Clock card for anyone, and the automatic-marks "how it works" help is not shown on the Marks panel', () => {
  assert.ok(html.includes('.clock-card{ display:none !important; }') && !html.includes('body.v2-dash .clock-card'));
  assert.ok(!html.includes('How the automatic marks work'));
  assert.ok(html.includes('Automatic marks</h2>') && html.includes('amLate'), 'the settings themselves are still there');
});

test('the automatic-marks on/off tick boxes are hidden (kept in the page so Save leaves every rule as it is)', () => {
  assert.ok(html.includes('id="amSwitches" style="display:none;"'));
  for (const id of ['amOnAck', 'amOnLinks', 'amOnReports', 'amOnMail', 'amOnCallback', 'amOnSubmit']) assert.ok(html.includes('id="' + id + '"'), id + ' still exists so saveAutoMarks keeps working');
});
