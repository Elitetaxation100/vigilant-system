// Anyone active can be the reviewer (not only managers), and Mark Complete always lets the person choose one — it never says "ask your manager".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');

test('the New Task reviewer list is everyone active except the person doing the work, not just managers', () => {
  const fn = html.slice(html.indexOf('function atReviewers()'), html.indexOf('function atReportSenders()'));
  assert.ok(fn.includes('eligibleReviewersFor(who)'), 'built from the same list every other reviewer picker uses');
  assert.ok(!/accessRole === 'admin'|accessRole === 'superadmin'/.test(fn), 'no manager-only filter');
});

test('Mark Complete always shows a reviewer picker and the Send for Review button', () => {
  const fn = html.slice(html.indexOf('function openCompleteModal('), html.indexOf('async function submitComplete('));
  assert.ok(!fn.includes('Ask your manager to assign one'), 'no dead-end message');
  assert.ok(fn.includes('id="cmpReviewer"') && fn.includes("onclick=\"submitComplete('${id}')\">Send for Review"));
});
