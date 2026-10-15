// Finished work (report sent / closed) is hidden from the everyday lists on the classic pages too, and appears only when searched for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');
const mv = fs.readFileSync(__dirname + '/manager-views.js', 'utf8');

test('classic Tasks page and the team lists hide closed work unless searched for / Done is chosen', () => {
  assert.ok(html.includes('function taskIsClosed(t){'));
  assert.ok(html.includes("else if(!q && !_tasksSavedFilter) list = list.filter(t => !taskIsClosed(t));"));
  assert.ok(html.includes("(status === '_all' ? !taskIsClosed(t) : dashCat(t) === status)"));
});

test('the new Tasks / My Tasks lists: finished rows are dropped unless there is a search or a finished-work filter', () => {
  assert.ok(mv.includes('const wantsClosed = !!(q || idSet || f.status || f.primary || f.reportSent || f.commitment || f.reviewState || f.includeClosed);'));
  assert.ok(mv.includes("if (!wantsClosed && r.status === 'Completed') return false;"));
});
