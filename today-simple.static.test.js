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

test('the list is calm: one "Do this first" card, short one-line rows with one pill and one button, a cap with "Show more", no section headings or filters', () => {
  assert.ok(html.includes('Do this first') && html.includes('function tdSimpleNext('));
  assert.ok(html.includes('const TS_SHOW = 6;') && html.includes('class="ts-more"'));
  const fn = html.slice(html.indexOf('function tdSimpleRow('), html.indexOf('function tdSimpleNext('));
  assert.equal((fn.match(/class="ts-pill/g) || []).length, 1, 'one pill per row');
  assert.ok(!fn.includes('ts-when') && !fn.includes('ts-why'), 'no extra date / reason columns in a row');
});

test('no Punch In / Time Clock card for anyone, and the automatic-marks "how it works" help is not shown on the Marks panel', () => {
  assert.ok(html.includes('.clock-card{ display:none !important; }') && !html.includes('body.v2-dash .clock-card'));
  assert.ok(!html.includes('How the automatic marks work'));
  assert.ok(html.includes('Automatic marks</h2>') && html.includes('amLate'), 'the settings themselves are still there');
});
