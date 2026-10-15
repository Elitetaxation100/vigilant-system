// The founder gets the same new layout as Parvinder (Today / Tasks / Reviews / My Team …) and still reaches the Founder dashboard from that menu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8');

test('the founder is on the new layout by default (unless switched off in Manage Access)', () => {
  assert.ok(server.includes("(e.accessRole === 'employee' || !!e.isFounder)"));
});

test('the new menu has a Founder View entry that only the founder sees', () => {
  assert.ok(html.includes('id="founderNavItemV2" data-view="founder" style="display:none;" onclick="showView(\'founder\', this)"'));
  assert.ok(html.includes("fv.style.display = (isSuperAdmin && session.isFounder) ? '' : 'none';"));
});
