// A review is optional everywhere: the New Task form starts unticked for every kind of task, anyone can leave it that way, and no reason is asked for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8').replace(/\r\n/g, '\n');

test('New Task form: no review, report or profit questions at all — those are decided later by the processor and the reviewer', () => {
  const form = html.slice(html.indexOf('<div id="atV2Basics"'), html.indexOf('<details class="at-more">'));
  for (const gone of ['atReviewReq', 'atReviewer', 'atReportSender', 'atProfitReq', 'atReportReq', 'Report required', 'Profit confirmation required', 'Make a review compulsory']) assert.ok(!form.includes(gone), gone + ' is not on the form');
  assert.ok(html.includes('payload.reviewRequired = req ? req.checked : false;'));
  assert.ok(!html.includes('Say why this client task needs no review'), 'no reason is asked for');
});

test('the reviewer chooses what happens after approving: send the report, send for profit confirmation, or mark done', () => {
  const fn = html.slice(html.indexOf('function rv2NextHtml('), html.indexOf('function rv2Pick('));
  for (const v of ["'report'", "'profit'", "'done'"]) assert.ok(fn.includes('opt(' + v), v);
  assert.ok(html.includes("body.next = nx.value"));
});

test('the server: a review is compulsory only when the creator ticks it; closing without one is allowed and recorded', () => {
  assert.ok(server.includes('reviewRequired = body0.reviewRequired === true;'));
  assert.ok(!server.includes('Only a manager or the founder can waive the review on client work.'));
  assert.ok(server.includes("'Review was optional — closed without one by '"));
});
