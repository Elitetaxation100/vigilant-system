// A review is optional everywhere: the New Task form starts unticked for every kind of task, anyone can leave it that way, and no reason is asked for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8').replace(/\r\n/g, '\n');

test('New Task form: the review box starts unticked and enabled for everyone, with no reason required', () => {
  const kind = html.slice(html.indexOf('function atReviewKindChanged()'), html.indexOf('function atLinkCheck('));
  assert.ok(kind.includes('box.checked = false;') && kind.includes('box.disabled = false;'));
  assert.ok(!kind.includes('canWaive') && !kind.includes('Only a manager or the founder can waive'));
  assert.ok(!html.includes('Say why this client task needs no review'), 'no reason is asked for');
  assert.ok(html.includes('payload.reviewRequired = req ? req.checked : false;'));
});

test('the server: a review is compulsory only when the creator ticks it; closing without one is allowed and recorded', () => {
  assert.ok(server.includes('reviewRequired = body0.reviewRequired === true;'));
  assert.ok(!server.includes('Only a manager or the founder can waive the review on client work.'));
  assert.ok(server.includes("'Review was optional — closed without one by '"));
});
