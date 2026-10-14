// Every dashboard shows the shared strip, and the recurring-task features on the older dashboards are still there (they must never be removed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8');

test('the strip is mounted on the old dashboard, the Today page and the Founder view, and refreshes with them', () => {
  assert.ok(html.includes('<div id="deliveryStrip"></div>\n        <div class="ws-mount"></div>') || html.includes('<div id="deliveryStrip"></div>\r\n        <div class="ws-mount"></div>'), 'the old dashboard mount');
  assert.ok(html.includes("+ '<div class=\"ws-mount\"></div>'\n    + fltBarHtml('td')") || html.includes("+ '<div class=\"ws-mount\"></div>'\r\n    + fltBarHtml('td')"), 'the Today page mount');
  assert.ok(html.includes("'<div class=\"ws-mount\"></div>' + fdKpiHtml()"), 'the Founder mount');
  assert.ok((html.match(/\bwsLoad\(\);/g) || []).length >= 3, 'each dashboard calls wsLoad after it draws');
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
