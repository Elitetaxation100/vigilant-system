// ---------------------------------------------------------------------------
// Email acknowledgement rules — pure functions, no server or database.
//
// An inbound email is either ACKNOWLEDGED or NOT ACKNOWLEDGED (the same split
// the Calls page uses: "listened" there, "opened" here):
//   Acknowledged
//     replied      — a real reply went out in the thread
//     read         — shown as "Not replied": opened (or given a 👍) but no reply
//     no_action    — marked "no reply needed"
//   Not acknowledged
//     unread       — still unopened, no 👍, not marked
// A 👍 — Gmail's own reaction, a reply that is only a thumbs-up, or the 👍
// button in the app — acknowledges the email WITHOUT counting as a reply.
// ---------------------------------------------------------------------------
const THUMB = '\\u{1F44D}[\\u{1F3FB}-\\u{1F3FF}]?';
const THUMBS_ONLY = new RegExp('^(?:' + THUMB + '[\\s\\uFE0F]*)+', 'u');

// Is this outbound message just a 👍 (optionally followed by the quoted
// original) or a Gmail "reacted via Gmail" notice? Metadata scope gives us only
// the snippet, so this is deliberately about the snippet's start.
function isThumbsSnippet(snippet) {
  const s = String(snippet || '').trim();
  if (!s) return false;
  if (/reacted\s+(to\s+your\s+message\s+)?via\s+gmail/i.test(s)) return true;
  const m = s.match(THUMBS_ONLY);
  if (!m) return false;
  const rest = s.slice(m[0].length).trim();
  if (!rest) return true;
  return /^(on\s.{0,160}wrote:|from:|sent from my|>|-{2,}|_{2,})/i.test(rest);
}

// Given an inbound message and the outbound messages in the same thread,
// decide whether it was REPLIED to or only thumbs-upped. Only outbound mail
// sent after the inbound one counts.
function classifyThread(inbound, outboundSiblings) {
  const later = (outboundSiblings || []).filter(o => (o.occurredAt || '') > (inbound.occurredAt || ''));
  if (!later.length) return { replied: false, thumbsUp: false };
  if (later.some(o => !isThumbsSnippet(o.snippet))) return { replied: true, thumbsUp: false };
  return { replied: false, thumbsUp: true };
}

// Whoever is responsible for an email: the person it was reassigned to, else
// the owner of the mailbox it arrived in.
const responsibleId = e => (e && (e.reassignedTo || e.mailboxOwner)) || null;

function outcomeStatus(e) {
  if (e.direction === 'outbound') return 'no_action';
  if (e.replyNotNeeded) return 'no_action';
  if (e.replied) return 'replied';
  if (e.thumbsUp) return 'read';
  if (e.status === 'unread') return 'unread';
  return 'read';
}
const LABELS = { no_action: 'No reply needed', replied: 'Replied', read: 'Not replied', unread: 'Unread' };
const isAcknowledged = status => status !== 'unread';

module.exports = { isThumbsSnippet, classifyThread, responsibleId, outcomeStatus, isAcknowledged, LABELS };
