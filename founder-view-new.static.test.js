// Founder view draft: one slim "Commitments & time" line under the action tiles, fed by the same lists everyone else opens — no new endpoint, nothing added to any other dashboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');

test('the founder view has the slim line, and it reuses the commitment-watch and time-ledger lists', () => {
  assert.ok(html.includes('<div id="fdWatch" class="fdw" aria-live="polite"></div>\' + fdKpiHtml()'));
  assert.ok(html.includes("api('/api/commitment-watch')") && html.includes("api('/api/time-ledger/team?from='"));
  assert.ok(html.includes("openCommitmentWatch('breaches')") && html.includes("openCommitmentWatch('flags')") && html.includes("openTimeLedger(null, null, null, 'team')"));
});

test('no strip was added to the other dashboards, and recurring tasks stay', () => {
  assert.ok(!html.includes('ws-mount') && !html.includes('/api/dashboard-strip'));
  assert.ok(html.includes('🔁 Daily / recurring tasks') && html.includes('openRecurringModal()">🔁 Daily tasks</button>'));
});
