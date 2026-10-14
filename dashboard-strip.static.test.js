// The shared strip is on the older dashboard and the Today page (not the Founder dashboard), and the recurring-task features on the older dashboards are still there (they must never be removed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8');

test('the strip is mounted on the old dashboard and the Today page (NOT the Founder dashboard), and refreshes with them', () => {
  assert.ok(html.includes('<div id="deliveryStrip"></div>\n        <div class="ws-mount"></div>'), 'the old dashboard mount');
  assert.ok(html.includes("+ '<div class=\"ws-mount\"></div>'\n    + fltBarHtml('td')"), 'the Today page mount');
  assert.ok(!html.includes("'<div class=\"ws-mount\"></div>' + fdKpiHtml()"), 'the Founder dashboard has no strip');
  assert.equal((html.match(/class=\\?"ws-mount\\?"/g) || []).length, 2, 'exactly two mounts: the old dashboard and the Today page');
  assert.ok((html.match(/\bwsLoad\(\);/g) || []).length >= 2, 'each of them calls wsLoad after it draws');
  assert.ok(html.includes('/api/dashboard-strip') && /function wsHtml\(/.test(html));
  assert.ok(server.includes("app.get('/api/dashboard-strip'"));
});

test('RECURRING TASKS stay on the older dashboards: the Tasks page menu, the My work tab and the To-do panel, plus the server routes', () => {
  assert.ok(html.includes('🔁 Daily / recurring tasks'), 'Tasks page menu');
  assert.ok(html.includes('onclick="openRecurringModal()">🔁 Daily tasks</button>'), 'My work tab button');
  assert.ok(html.includes('openRecurringModal()">🔁 Daily tasks</button>'), 'To-do panel button');
  assert.ok((html.match(/openRecurringModal\(\)/g) || []).length >= 3, 'at least three entry points');
  assert.ok(/function openRecurringModal\(/.test(html));
  for (const route of ["app.get('/api/recurring-tasks'", "app.post('/api/recurring-tasks'", "app.patch('/api/recurring-tasks/:id'", "app.delete('/api/recurring-tasks/:id'"]) assert.ok(server.includes(route), route);
});
