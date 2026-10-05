const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('./email-status');

test('a reply that is only a thumbs-up is recognised, a real reply is not', () => {
  assert.equal(s.isThumbsSnippet('👍'), true);
  assert.equal(s.isThumbsSnippet('  👍🏽  '), true);
  assert.equal(s.isThumbsSnippet('👍 👍'), true);
  assert.equal(s.isThumbsSnippet('👍 On Tue, 6 Oct 2026 at 9:00 AM Jo <jo@x.nz> wrote: Hi, can you send...'), true);
  assert.equal(s.isThumbsSnippet('Jo reacted via Gmail'), true);
  assert.equal(s.isThumbsSnippet('👍 thanks, will send the GST return tomorrow'), false);
  assert.equal(s.isThumbsSnippet('Thanks, done'), false);
  assert.equal(s.isThumbsSnippet(''), false);
  assert.equal(s.isThumbsSnippet(null), false);
});

test('classifyThread: reply vs thumbs-up vs nothing', () => {
  const inb = { occurredAt: '2026-10-05T01:00:00Z' };
  const out = (t, snippet) => ({ occurredAt: t, snippet });
  assert.deepEqual(s.classifyThread(inb, []), { replied: false, thumbsUp: false });
  assert.deepEqual(s.classifyThread(inb, [out('2026-10-05T00:00:00Z', 'earlier mail')]), { replied: false, thumbsUp: false }); // before it
  assert.deepEqual(s.classifyThread(inb, [out('2026-10-05T02:00:00Z', '👍')]), { replied: false, thumbsUp: true });
  assert.deepEqual(s.classifyThread(inb, [out('2026-10-05T02:00:00Z', '👍'), out('2026-10-05T03:00:00Z', 'Sent the report')]), { replied: true, thumbsUp: false });
  assert.deepEqual(s.classifyThread(inb, [out('2026-10-05T02:00:00Z', 'Sent the report')]), { replied: true, thumbsUp: false });
});

test('outcome: acknowledged = everything except unread', () => {
  const base = { direction: 'inbound', status: 'unread' };
  assert.equal(s.outcomeStatus({ ...base }), 'unread');
  assert.equal(s.outcomeStatus({ ...base, status: 'read' }), 'read');
  assert.equal(s.outcomeStatus({ ...base, thumbsUp: true }), 'read'); // 👍 acknowledges even if unopened
  assert.equal(s.outcomeStatus({ ...base, replied: true }), 'replied');
  assert.equal(s.outcomeStatus({ ...base, replyNotNeeded: true }), 'no_action');
  assert.equal(s.outcomeStatus({ ...base, replyNotNeeded: true, replied: true }), 'no_action');
  const ack = e => s.isAcknowledged(s.outcomeStatus(e));
  assert.equal(ack({ ...base }), false);
  assert.equal(ack({ ...base, status: 'read' }), true);
  assert.equal(ack({ ...base, thumbsUp: true }), true);
  assert.equal(ack({ ...base, replyNotNeeded: true }), true); // no reply needed counts as acknowledged
  assert.equal(ack({ ...base, replied: true }), true);
});

test('the labels match the three sub-groups under Acknowledged', () => {
  assert.equal(s.LABELS.replied, 'Replied');
  assert.equal(s.LABELS.read, 'Not replied');
  assert.equal(s.LABELS.no_action, 'No reply needed');
});

test('responsible person: the reassigned-to person, else the mailbox owner', () => {
  assert.equal(s.responsibleId({ mailboxOwner: 'e1' }), 'e1');
  assert.equal(s.responsibleId({ mailboxOwner: 'e1', reassignedTo: 'e2' }), 'e2');
  assert.equal(s.responsibleId({ mailboxOwner: 'e1', reassignedTo: null }), 'e1');
  assert.equal(s.responsibleId(null), null);
});
