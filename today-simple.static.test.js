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

test('the list has the columns people asked for, a search box, a Processor filter and an order — latest client date first by default', () => {
  const head = html.slice(html.indexOf('<div class="ts-head"'), html.indexOf('</div>', html.indexOf('<div class="ts-head"')));
  for (const col of ['Task · client', 'Processor', 'Client commitment date', 'Status']) assert.ok(head.includes(col), col + ' column');
  assert.ok(html.includes('id="tsQ"') && html.includes('placeholder="Search task, client or processor…"'), 'search bar');
  assert.ok(html.includes('id="tsProc"') && html.includes('<option value="">Everyone</option>'), 'processor filter');
  assert.ok(html.includes("let _tsQ = '', _tsProc = '', _tsSort = 'latest';"), 'latest first is the default');
  assert.ok(html.includes('Latest client date first') && html.includes('Oldest client date first') && html.includes('Most urgent first'));
  const row = html.slice(html.indexOf('function tdSimpleRow('), html.indexOf('function tdSimpleSelect('));
  assert.equal((row.match(/class="ts-pill/g) || []).length, 1, 'one status pill per row');
  assert.ok(row.includes('ts-proc') && row.includes('ts-date'));
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
