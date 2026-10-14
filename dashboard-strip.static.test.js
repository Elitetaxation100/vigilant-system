// The commitments / time strip is NOT on the main dashboards (removed on request), and the recurring-task features on the older dashboards are still there (they must never be removed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8');

test('no strip of commitment / time tiles sits at the top of the main dashboards', () => {
  assert.ok(!html.includes('ws-mount') && !html.includes('wsLoad(') && !html.includes('/api/dashboard-strip'));
  assert.ok(!server.includes("app.get('/api/dashboard-strip'"));
  // the features themselves are still reachable from the menu
  assert.ok(html.includes('openCommitmentWatch()') && html.includes('openTimeLedger()') && html.includes('openLogTime()'));
});

test('RECURRING TASKS stay on the older dashboards: the Tasks page menu, the My work tab and the To-do panel, plus the server routes', () => {
  assert.ok(html.includes('🔁 Daily / recurring tasks'), 'Tasks page menu');
  assert.ok(html.includes('onclick="openRecurringModal()">🔁 Daily tasks</button>'), 'My work tab button');
  assert.ok(html.includes('openRecurringModal()">🔁 Daily tasks</button>'), 'To-do panel button');
  assert.ok((html.match(/openRecurringModal\(\)/g) || []).length >= 3, 'at least three entry points');
  assert.ok(/function openRecurringModal\(/.test(html));
  for (const route of ["app.get('/api/recurring-tasks'", "app.post('/api/recurring-tasks'", "app.patch('/api/recurring-tasks/:id'", "app.delete('/api/recurring-tasks/:id'"]) assert.ok(server.includes(route), route);
});
