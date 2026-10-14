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
