// Mark done is offered wherever a task can be closed: the Reviews rows, the Tasks menu, the task detail (Today) and the classic actions window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');

test('Mark done is on the Reviews rows, the Tasks menu, the Today task detail and the actions window', () => {
  assert.ok(html.includes('function markDoneAny(id){') && html.includes('function canMarkDoneAny(t){'));
  const rq = html.slice(html.indexOf('function rqCardHtml('), html.indexOf('function rqCardHtml(') + 2500);
  assert.ok(rq.includes('✓ Mark done') && rq.includes('markDoneAny('), 'Reviews rows');
  assert.ok(html.includes("['✓ Mark done', \"markDoneAny('\" + id + \"')\""), 'Tasks menu');
  const det = html.slice(html.indexOf('function tdDetailHtml('), html.indexOf('function tdDetailHtml(') + 3500);
  assert.ok(det.includes('canMarkDoneAny(t)') && det.includes('✓ Mark done'), 'Today task detail');
  assert.ok(html.includes("closeModal();markDoneAny('${t.id}')"), 'classic actions window');
});

test('Mark done closes through the existing rules: open work, in review, approved and waiting for the report (with a recorded reason)', () => {
  const fn = html.slice(html.indexOf('function markDoneAny('), html.indexOf('async function markDoneNoReview('));
  assert.ok(fn.includes('markDoneNoReview(id)') && fn.includes("decision:'approve', next:'done'") && fn.includes("decision:'no', waivedReason: why"));
  assert.ok(fn.includes('client_cancelled') && fn.includes('admin_correction'), 'the fixed reasons are offered, not bypassed');
});
