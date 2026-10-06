// The acknowledgement marks must agree with the 6:45 pm report the admins receive: they count only what had
// arrived up to the report time that day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-stats-'));
process.env.TM_DATA_DIR = dir; // never the real data
const connector = require('./connector');
const crmSync = require('./crm-sync');
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

const day = '2026-10-12'; // Monday
const at = hhmm => crmSync.nzLocalToISO(day, hhmm); // NZ wall-clock → instant
const mail = (id, hhmm, extra) => ({ id, direction: 'inbound', occurredAt: at(hhmm), mailboxOwner: 'e1', fromAddress: 'c@x.nz', labelIds: ['INBOX'], status: 'unread', replied: false, ...(extra || {}) });
const state = {
  employees: [{ id: 'e1', name: 'Ann' }],
  emailIgnoredSenders: [], calls: [],
  emails: [mail('a', '09:00'), mail('b', '15:00', { status: 'read' }), mail('c', '18:44'), mail('d', '18:46'), mail('e', '21:00')],
};
const emailsOf = people => (people.find(p => p.id === 'e1') || {}).emails;

test('with a cut-off, mail received after the daily report is not counted for that day', () => {
  const until = new Date(at('18:45'));
  const e = emailsOf(connector.callsEmailsStats(state, day, day, { until }).people);
  assert.deepEqual([e.total, e.ack, e.notAck], [3, 1, 2], 'a (09:00), b (15:00, read) and c (18:44) — not d (18:46) or e (21:00)');
});
test('without a cut-off the whole day is counted (the existing behaviour is unchanged)', () => {
  const e = emailsOf(connector.callsEmailsStats(state, day, day).people);
  assert.deepEqual([e.total, e.ack, e.notAck], [5, 1, 4]);
});
test('the cut-off is exact: a mail at 18:45 on the dot still counts, one second later does not', () => {
  const s2 = { ...state, emails: [mail('x', '18:45'), { ...mail('y', '18:45'), occurredAt: new Date(new Date(at('18:45')).getTime() + 1000).toISOString() }] };
  const e = emailsOf(connector.callsEmailsStats(s2, day, day, { until: new Date(at('18:45')) }).people);
  assert.equal(e.total, 1);
});
