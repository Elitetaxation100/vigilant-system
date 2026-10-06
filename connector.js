// ---------------------------------------------------------------------------
// CONNECTOR — Aircall + Slack, in Node (calls-into-tasks, Phase 5)
//
// Replaces the Google Apps Script "Call Notifier". An Aircall call becomes a
// Slack card with accountability buttons; the outcome and any follow-up task
// are tracked. The Google Sheet is retired — the call log lives in Postgres
// (state.calls); tasks go straight into state.tasks (same process, no API).
//
// Env vars (Railway → vigilant-system → Variables):
//   SLACK_BOT_TOKEN  SLACK_SIGNING_SECRET  SLACK_APP_ID  SLACK_TEAM_ID
//   SLACK_CALL_CHANNEL  AIRCALL_API_ID  AIRCALL_API_TOKEN
//   AIRCALL_WEBHOOK_TOKEN  GEMINI_API_KEY
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const https = require('https');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const cal = require('./calendar');
const crmSync = require('./crm-sync');
const emailStatus = require('./email-status');
const crmApply = require('./crm-apply');
const autoMarks = require('./auto-marks');
const policyCompliance = require('./policy-compliance');

const cfg = () => ({
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET || '',
  slackAppId: process.env.SLACK_APP_ID || '',
  slackTeamId: process.env.SLACK_TEAM_ID || '',
  slackChannel: process.env.SLACK_CALL_CHANNEL || '',
  aircallApiId: process.env.AIRCALL_API_ID || '',
  aircallApiToken: process.env.AIRCALL_API_TOKEN || '',
  aircallWebhookToken: process.env.AIRCALL_WEBHOOK_TOKEN || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  interaktApiKey: process.env.INTERAKT_API_KEY || '',
  interaktWebhookSecret: process.env.INTERAKT_WEBHOOK_SECRET || '',
  // Slack channel WhatsApp messages get relayed into (so the team sees them
  // live and can use the existing "Convert to Task" message shortcut on
  // them for free). Falls back to the call channel if no dedicated one is set.
  interaktChannel: process.env.INTERAKT_SLACK_CHANNEL || '',
  // Shared secret for the CRM (crm.elitetaxation.co.nz) → task manager sync.
  // The CRM's Supabase project sends a Database Webhook with this value in
  // an X-CRM-Webhook-Secret header whenever a customer/user row changes.
  crmWebhookSecret: process.env.CRM_WEBHOOK_SECRET || '',
  // For writing back the other way — task manager → CRM — once a customer
  // syncs in, so the CRM side can also see which Task Manager record it
  // connects to. The CRM's documented API (Settings > API Docs there), a
  // Supabase Edge Function. Actions used: link-task-manager-client (link-back),
  // get-policy-compliance (policy fallback), list-pipeline (customer reconciliation).
  crmApiUrl: process.env.CRM_API_URL || 'https://ceqqphhqjqyfxxmaaglw.supabase.co/functions/v1/crm-api',
  crmApiKey: process.env.CRM_API_KEY || '',
  // Gmail activity log (visibility only, like Calls — no Slack posting, no
  // task conversion). The full service-account key JSON, as a single-line
  // env var value — never committed to the repo. Domain-wide delegation
  // lets it impersonate any of the 4 mailbox addresses for the metadata
  // scope only (no message body access).
  gmailServiceAccountJson: process.env.GMAIL_SERVICE_ACCOUNT_JSON || '',
  gmailPollMinutes: Number(process.env.GMAIL_POLL_MINUTES) || 7,
  // Daily Calls & Email digest — Meta's own WhatsApp Business Cloud API,
  // called directly (deliberately NOT Interakt, which is receive-only
  // here). A permanent access token + the sender's phone_number_id from
  // Meta's dashboard; who it's sent to (E.164 numbers, comma-separated);
  // and the name of the one approved message template it uses (must have a
  // single body {{1}} text parameter). See runCallsEmailsDigest below.
  whatsappCloudToken: process.env.WHATSAPP_CLOUD_TOKEN || '',
  whatsappCloudPhoneNumberId: process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID || '',
  whatsappCloudTemplateName: process.env.WHATSAPP_CLOUD_TEMPLATE_NAME || 'daily_calls_email_report',
  whatsappCloudRecipients: (process.env.WHATSAPP_CLOUD_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Same digest, sent by email instead — via its OWN dedicated service
  // account (deliberately NOT gmailServiceAccountJson above, which is
  // shared with an unrelated client-facing integration on the same Google
  // Workspace — this one only ever needs gmail.send, on a Client ID that
  // exists purely for this digest and nothing else it could break).
  // fromMailbox: which connected mailbox to impersonate as the sender.
  gmailSendServiceAccountJson: process.env.GMAIL_SEND_SERVICE_ACCOUNT_JSON || '',
  gmailDigestFromMailbox: process.env.GMAIL_DIGEST_FROM_MAILBOX || '',
  gmailDigestRecipients: (process.env.GMAIL_DIGEST_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean),
});
// NZ hour the Calls & Email digest fires — a 10-minute-wide window starting
// at :45 past this hour, never earlier (see the scheduler tick), covering
// that same NZ calendar day's activity. Default 18 = 6:45pm NZ.
const CALLS_EMAILS_DIGEST_HOUR = Number(process.env.CALLS_EMAILS_DIGEST_HOUR) || 18;

// Agent → team routing. Used to live as a hardcoded AGENT_MAP object here;
// now state.agentMap (db.js seeds it once from the old hardcoded values, so
// routing didn't change on migration day) — editable from the app's "Team
// Assignments" admin page instead of needing a code change every time
// ownership rotates. `name`/`team` stay the real Aircall agent (Shubam/
// Parvinder/Disha still took the call, on record) — only `employeeId`
// changes, to whoever's actually doing the listening now.
function agentRouting(state, agentId) { return (state.agentMap || {})[agentId] || null; }
// Slack IDs are derived from the employees at read time, never stored
// redundantly — 0, 1 or 2 responsible people per agent (e.g. Shubam's
// Leads calls are reviewed by both Anjana Pandey and Diksha Goyal).
// De-duped so picking the same person in both admin-page slots never
// double-@-mentions them.
function agentSlackIds(state, agentId) {
  const r = agentRouting(state, agentId);
  const ids = (r && Array.isArray(r.employeeIds)) ? r.employeeIds : [];
  const slackIds = ids
    .map(id => (state.employees || []).find(e => e.id === id))
    .filter(Boolean)
    .map(e => e.slackUserId)
    .filter(Boolean);
  return [...new Set(slackIds)];
}
// Kudos — firm-wide recognition, star-leveled. Who can AWARD kudos to
// someone depends on the recipient's employee team (substring match, so
// "Companies & Rental Team" satisfies both the companies and rental
// rules): Shubam has whole-firm authority; everyone else's rule is scoped
// to their own patch. A superadmin can always award, same as everywhere
// else in the app. Anyone can RECOMMEND kudos for anyone (except
// themselves) — recommending needs no authority, only awarding does.
const KUDOS_MANAGERS = [
  { match: t => /rideshare|admin/.test(t), email: 'disha@elitetaxation.co.nz' },
  { match: t => /compan|rental/.test(t), email: 'parvinder@elitetaxation.co.nz' },
  { match: t => /marketing/.test(t), email: 'vishal@elitetaxation.co.nz' },
];
const KUDOS_FIRMWIDE_EMAIL = 'shubham@elitetaxation.co.nz';
function kudosManagerEmailFor(team) {
  const t = String(team || '').toLowerCase();
  const rule = KUDOS_MANAGERS.find(r => r.match(t));
  return rule ? rule.email : null;
}
function canAwardKudosTo(actor, toEmployee) {
  if (!actor || !toEmployee) return false;
  if (actor.accessRole === 'superadmin') return true;
  const email = String(actor.email || '').toLowerCase();
  if (email === KUDOS_FIRMWIDE_EMAIL) return true;
  const mgrEmail = kudosManagerEmailFor(toEmployee.team);
  return !!mgrEmail && email === mgrEmail;
}
const KUDOS_LEVELS = {
  '1star':     { label: '1-Star',    stars: 1, badge: '⭐' },
  '3star':     { label: '3-Star',    stars: 3, badge: '⭐⭐⭐' },
  '4star':     { label: '4-Star',    stars: 4, badge: '⭐⭐⭐⭐' },
  '5star':     { label: '5-Star',    stars: 5, badge: '⭐⭐⭐⭐⭐' },
  'legendary': { label: 'Legendary', stars: 0, badge: '🏆 Legendary' },
};
const TRANSFER_MERGE_MINUTES = 15;
const RECORDING_MATCH_MINUTES = 120;
// Digest: reminder about un-listened mandatory calls + overdue call/Slack
// tasks, posted to the call channel at these NZ hours (24h, comma list).
const DIGEST_HOURS = (process.env.CALL_DIGEST_HOURS || '9,15').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
const DIGEST_TZ = process.env.CALL_DIGEST_TZ || 'Pacific/Auckland';
// Personal "your day" DM — everyone with a linked Slack account and
// anything to report gets one, at this NZ hour. Separate from the call
// digest above (that's the shared channel post about calls specifically).
const PERSONAL_DIGEST_HOURS = (process.env.PERSONAL_DIGEST_HOURS || '8').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
const LISTEN_GRACE_HOURS = 2;   // don't nag about a recording younger than this
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Phase 3 — per-person task reminders + escalation ladder (Slack DM).
// OFF by default: nothing is DM'd to staff until REMINDERS_ENABLED is truthy
// on Railway. REMINDER_DRY_RUN logs what it *would* send instead.
const truthy = (v) => ['true', '1', 'yes', 'on', 'enabled'].includes(String(v == null ? '' : v).trim().toLowerCase());
const REMINDERS_ON = truthy(process.env.REMINDERS_ENABLED);
const REMINDER_DRY_RUN = truthy(process.env.REMINDER_DRY_RUN);
const REMINDER_DIGEST_HOUR = parseInt(process.env.REMINDER_DIGEST_HOUR || '8', 10);   // NZ hour for the daily "what's on your plate" DM
const REMINDER_ESCALATE_HOURS = parseFloat(process.env.REMINDER_ESCALATE_HOURS || '24'); // gap between escalation rungs
const REMINDER_MGMT_CHANNEL = process.env.REMINDER_MGMT_CHANNEL || '';                 // optional channel for level-3 escalations

// ---------------------------------------------------------------------------
// tiny HTTPS JSON client (Node 18 — avoid depending on global fetch)
// ---------------------------------------------------------------------------
function httpsRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let u;
    try { u = new URL(url); } catch (e) { return finish({ status: 0, json: null, error: 'bad url' }); }
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(raw.toString('utf8')); } catch (e) {}
          finish({ status: res.statusCode, json, raw, headers: res.headers });
        });
      }
    );
    req.on('error', (e) => finish({ status: 0, json: null, error: String(e) }));
    if (typeof req.setTimeout === 'function') req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout ' + timeoutMs + 'ms')));
    if (body != null) req.write(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Slack Web API. Returns the parsed response; logs on `ok:false`.
async function slack(method, payload) {
  const c = cfg();
  const r = await httpsRequest('https://slack.com/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + c.slackBotToken },
    body: payload || {},
  });
  // A failed chat.update / views.publish is usually transient (stale ts, home
  // tab not opened yet) and the callers handle it — log as warn, not error.
  if (!r.json || !r.json.ok) clog('warn', 'slack ' + method + ' not ok', { error: (r.json && r.json.error) || r.status });
  return r.json || { ok: false };
}
function aircallAuthHeader() {
  const c = cfg();
  return 'Basic ' + Buffer.from(c.aircallApiId + ':' + c.aircallApiToken).toString('base64');
}

// ---------------------------------------------------------------------------
// verification (Phase 5.1)
// ---------------------------------------------------------------------------
function verifySlack(req) {
  const secret = cfg().slackSigningSecret;
  if (!secret) return { ok: false, why: 'SLACK_SIGNING_SECRET not set' };
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return { ok: false, why: 'missing signature headers' };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { ok: false, why: 'stale timestamp' };
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  const mine = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  let match = false;
  try { match = crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(String(sig))); } catch (e) { match = false; }
  return match ? { ok: true } : { ok: false, why: 'signature mismatch' };
}
function slackPayloadIsOurs(p) {
  const c = cfg();
  const team = (p && p.team && p.team.id) || (p && p.team_id);
  if (c.slackTeamId && team && team !== c.slackTeamId) return false;
  const appId = p && p.api_app_id;
  if (c.slackAppId && appId && appId !== c.slackAppId) return false;
  return true;
}
function verifyAircall(req) {
  const expected = cfg().aircallWebhookToken;
  if (!expected) return { ok: false, why: 'AIRCALL_WEBHOOK_TOKEN not set' };
  const got = (req.body && req.body.token) || req.query.token || req.headers['x-aircall-token'];
  return got === expected ? { ok: true } : { ok: false, why: 'bad token' };
}
// Interakt signs the raw body with HMAC-SHA256 using the webhook secret set
// in their dashboard, sent as `Interakt-Signature: sha256=<hex>`.
function verifyInterakt(req) {
  const secret = cfg().interaktWebhookSecret;
  if (!secret) return { ok: false, why: 'INTERAKT_WEBHOOK_SECRET not set' };
  const header = req.headers['interakt-signature'] || req.headers['x-interakt-signature'];
  if (!header) return { ok: false, why: 'missing Interakt-Signature header' };
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  const mine = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  let match = false;
  try { match = crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(String(header))); } catch (e) { match = false; }
  return match ? { ok: true } : { ok: false, why: 'signature mismatch' };
}
// The CRM's Supabase Database Webhook lets you attach a fixed custom header
// (no HMAC signing available) — same static-token pattern as verifyAircall.
function verifyCrm(req) {
  const expected = cfg().crmWebhookSecret;
  if (!expected) return { ok: false, why: 'CRM_WEBHOOK_SECRET not set' };
  const got = req.headers['x-crm-webhook-secret'];
  if (!got) return { ok: false, why: 'missing X-CRM-Webhook-Secret header' };
  let match = false;
  try { match = crypto.timingSafeEqual(Buffer.from(String(got)), Buffer.from(expected)); } catch (e) { match = false; }
  return match ? { ok: true } : { ok: false, why: 'bad secret' };
}

// ---------------------------------------------------------------------------
// logging — replaces the Sheet's "Errors" tab
// ---------------------------------------------------------------------------
function clog(level, msg, meta) {
  const line = `[connector] ${level.toUpperCase()} ${msg}` + (meta ? ' ' + JSON.stringify(meta) : '');
  if (level === 'error') console.error(line); else console.log(line);
  try {
    const state = db.get();
    if (!Array.isArray(state.connectorLog)) state.connectorLog = [];
    state.connectorLog.push({ at: new Date().toISOString(), level, msg, meta: meta || null });
    if (state.connectorLog.length > 400) state.connectorLog.shift();
    // Persist immediately only for warn/error; info lines ride along with the
    // next real db.save() (every handler saves) to avoid write amplification.
    if (level === 'warn' || level === 'error') db.save();
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function normalizeNumber(raw) { return raw ? String(raw).replace(/\D/g, '').slice(-9) : ''; }
function isUnanswered(call) { return !!call.missed_call_reason || !call.answered_at; }
function isVoicemail(call) {
  if (!call) return false;
  if (call.voicemail || call.missed_call_reason === 'voicemail') return true;
  return String((call.asset && call.asset.type) || call.type || '').toLowerCase() === 'voicemail';
}
function findCall(state, aircallId) { return (state.calls || []).find(c => String(c.aircallId) === String(aircallId)); }
function findCallByRowId(state, rowId) { return (state.calls || []).find(c => c.id === rowId); }
function esc(s, max) {
  let v = String(s == null ? '' : s);
  if (max && v.length > max) v = v.slice(0, max - 1) + '…';
  return v.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
// Slack section text hard-caps at 3000 chars — keep user-supplied blocks under it.
const SLACK_TEXT_MAX = 2800;
// A Slack message's raw `text` encodes links/emails/mentions as <url|label>
// (or bare <url>) — passed straight through, that leaks as e.g.
// "<mailto:x@y.com|x@y.com> Rideshare client processing" in a task title.
// Unwrap to just the readable label (or the url/address when there's no
// separate label). Slack's raw text also HTML-escapes &, < and > (so a
// literal "&" survives as "&amp;" — see "HAMILTON PANEL &amp; PAINT
// LIMITED" in a real task title) — unescape those too, same as what a
// person actually sees in Slack's UI.
function deslackifyText(s) {
  return String(s || '')
    .replace(/<([^|>]+)(?:\|([^>]*))?>/g, (_, url, label) => label || url.replace(/^(mailto|tel):/, ''))
    .replace(/&(amp|lt|gt);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>' }[e]));
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-NZ', { day: '2-digit', month: 'short', year: 'numeric' });
}
function empBySlackId(state, sid) { return (state.employees || []).find(e => e.slackUserId && e.slackUserId === sid); }
function empName(state, sid) { const e = empBySlackId(state, sid); return e ? e.name : sid; }

// Caller name — best of: Aircall webhook contact, Aircall Contacts API, our
// own client list (matched on the number), else a formatted number.
async function resolveCaller(state, call) {
  const raw = call.raw_digits || '';
  const norm = normalizeNumber(raw);
  if (call.contact && call.contact.name) return { name: call.contact.name, clientId: null };
  const client = (state.clients || []).find(c => c.phone && normalizeNumber(c.phone) === norm);
  if (client) return { name: client.name, clientId: client.id };
  if (raw) {
    const r = await httpsRequest('https://api.aircall.io/v1/contacts/search?phone_number=' + encodeURIComponent(raw), {
      headers: { Authorization: aircallAuthHeader() },
    });
    const contact = r.json && r.json.contacts && r.json.contacts[0];
    if (contact) {
      const nm = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.company_name;
      if (nm) return { name: nm, clientId: null };
    }
  }
  return { name: raw ? ('+' + raw.replace(/^\+/, '')) : 'Unknown / not saved', clientId: null };
}

// A fresh, currently-valid recording URL (Aircall's are ~50-60 min presigned).
async function fetchAircallCall(aircallId) {
  const r = await httpsRequest('https://api.aircall.io/v1/calls/' + encodeURIComponent(aircallId), {
    headers: { Authorization: aircallAuthHeader() },
  });
  return (r.json && r.json.call) || null;
}
async function freshRecordingUrl(aircallId) {
  const call = await fetchAircallCall(aircallId);
  if (!call || isVoicemail(call)) return null; // voicemails have no recording to listen to
  return call.recording || (call.asset && call.asset.url) || null;
}

// A call where the caller left a voicemail is not a call to listen to: no
// Slack card, no recording kept, and never counted in the call totals.
const countsAsCall = c => (c.status === 'ended' || c.status === 'no_action') && !c.voicemail;
async function markVoicemail(state, row) {
  row.voicemail = true; row.status = 'voicemail'; row.recordingUrl = null; row.recordingFetchedAt = null;
  if (row.slackTs) { // a card was already posted — take it down
    const del = await slack('chat.delete', { channel: row.slackChannel || cfg().slackChannel, ts: row.slackTs });
    if (del && del.ok) { row.slackTs = null; row.slackChannel = null; }
  }
  db.save();
}

// ---------------------------------------------------------------------------
// Block Kit — one card per call, grows in place
// ---------------------------------------------------------------------------
function buttonEl(text, actionId, value) {
  return { type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id: actionId, value: String(value) };
}
function buildCallCard(o) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${o.icon} ${o.statusLabel} — ${o.team}`, emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Agent*\n${esc(o.agent)}` },
      { type: 'mrkdwn', text: `*Client*\n${esc(o.client)}` },
      { type: 'mrkdwn', text: `*Phone*\n${esc(o.phone)}` },
      { type: 'mrkdwn', text: `*Duration*\n${esc(o.duration)}` },
    ] },
  ];
  if (o.assignedLine) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Assigned:* ${o.assignedLine}` } });
  const ctx = [];
  if (o.footer) ctx.push({ type: 'mrkdwn', text: o.footer });
  ctx.push({ type: 'mrkdwn', text: `🟢 via *Governance OS*${o.ref ? ' · `' + o.ref + '`' : ''}` });
  blocks.push({ type: 'context', elements: ctx });
  if (o.buttons && o.buttons.length) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'actions', elements: o.buttons });
  }
  return blocks;
}
function callCardFallback(o) { return `${o.icon} ${o.statusLabel} — ${o.team} — ${o.client} (${o.phone})`; }

function endedButtons(rowId) {
  return [buttonEl('📝 Log Outcome & Action Item', 'log_outcome', rowId),
          buttonEl("🙋 I'll Handle This", 'self_assign', rowId),
          buttonEl('🚫 No Action Needed', 'no_action', rowId)];
}
function recordingButtons(rowId, resolved) {
  if (resolved) return [buttonEl('🎧 Play Recording', 'play_recording', rowId)];
  return [buttonEl('🎧 Play Recording', 'play_recording', rowId),
          buttonEl('✅ Mark listened, done & actioned', 'mark_listened', rowId),
          buttonEl('📝 Log Outcome & Action Item', 'log_outcome', rowId),
          buttonEl("🙋 I'll Handle This", 'self_assign', rowId),
          buttonEl('🚫 No Action Needed', 'no_action', rowId)];
}

function cardOptsFor(state, row, stage) {
  const mentions = agentSlackIds(state, row.agentAircallId).map(id => `<@${id}>`).join(' ');
  const resolved = !!row.finalOutcome || !!row.taskId || row.status === 'no_action';
  if (stage === 'ended') {
    return {
      icon: '📞', statusLabel: 'Call Ended', team: row.team, agent: row.agentName,
      client: row.clientName || 'Unknown / not saved', phone: row.callerPhone ? '+' + row.callerPhone : '—',
      duration: row.durationSec ? row.durationSec + 's' : '—', assignedLine: mentions, ref: row.id,
      footer: row.mandatory ? '🎙️ Recording will follow once ready.' : null,
      buttons: endedButtons(row.id),
    };
  }
  return {
    icon: '🎙️', statusLabel: 'Recording Ready', team: row.team, agent: row.agentName,
    client: row.clientName || 'Unknown / not saved', phone: row.callerPhone ? '+' + row.callerPhone : '—',
    duration: row.durationSec ? row.durationSec + 's' : '—', assignedLine: mentions, ref: row.id,
    footer: resolved ? '✅ Already resolved — see the task manager.' : '👂 Please listen and note action items.',
    buttons: recordingButtons(row.id, resolved),
  };
}

// ---------------------------------------------------------------------------
// in-process task creation / update (what /api/int/tasks does, no HTTP)
// ---------------------------------------------------------------------------
function activity(state, empId, text, meta) {
  if (!Array.isArray(state.activityLog)) state.activityLog = [];
  state.activityLog.push({ id: crypto.randomUUID(), empId: empId || null, text, meta: meta || null, ts: new Date().toISOString() });
  if (state.activityLog.length > 300) state.activityLog.shift();
}
function createTask(state, o) {
  // An estimate is REQUIRED — no task without a time on it, same as the
  // in-app assign form. Returns null when there's no valid estimate; the
  // caller tells the user to reopen the modal and fill it in.
  const mins = Number(o.estMinutes);
  if (!(mins > 0)) { clog('warn', 'createTask refused — no estimate', { title: o.title, source: o.source }); return null; }
  const tat = Math.max(0.25, Math.round((mins / 60) * 4) / 4); // minutes → hours, 0.25h steps

  let assignee = null;
  if (o.assigneeSlackId) assignee = empBySlackId(state, o.assigneeSlackId);
  let client = null;
  if (o.clientName) client = (state.clients || []).find(c => c.name.toLowerCase() === String(o.clientName).toLowerCase());
  state.taskSeq = (state.taskSeq || 100) + 1;
  const now = new Date().toISOString();
  const task = {
    id: '#' + (100000000000 + state.taskSeq), name: String(o.title || 'Call follow-up').slice(0, 200),
    scope: o.detail ? String(o.detail).trim() : '—',
    clientId: client ? client.id : null, clientName: client ? client.name : (o.clientName || ''),
    // A due date is required everywhere else a task is created (same rule
    // the in-app assign form enforces) — a call/Slack task with none used to
    // stay null forever if "Log Outcome" skipped its optional date field,
    // which then permanently blocked the assignee's punch-out (the gate
    // treats an accepted task with no internal deadline as unsettled).
    // Default to the next working day so it's never null; easy to correct
    // later from the task's own "Edit dates" if that's not the real date.
    clientDate: null, internalDeadline: o.dueDate || cal.addWorkingDays(nzToday(), 1), points: 0,
    assignedTo: assignee ? assignee.id : null, assignedBy: assignee ? assignee.id : null,
    team: (assignee && assignee.team) || null,
    assignedAt: now, reassignHistory: [], status: 'accepted', logged: 0, tat,
    acceptedAt: now, timerStartedAt: null, completedAt: null, reviewStatus: null, reviewedBy: null,
    reviewNote: null, reviewedAt: null, reworkCount: 0, reviewerId: null, awaitingClientDecision: false,
    sentToClient: null, sentToClientAt: null, sentToClientBy: null, reworkStartedAt: null, faultType: null,
    reworkHistory: [], dateHistory: [], tatHistory: [], source: o.source || 'call', sourceRef: o.sourceRef || null,
    estMinutes: mins, priority: null,
    productivityAllocatedHoursSnapshot: tat, // already accepted at creation — snapshot immediately
    reportDeliveryStatus: null, reportDeliveryChannel: null, reportDeliveryReference: null,
    reportDeliveryWaivedReason: null, reportDeliveryWaivedBy: null, reportDeliveryWaivedAt: null,
    noReviewAuthorizedBy: null, noReviewAuthorizedAt: null, noReviewAuthorizedReason: null,
  };
  state.tasks.unshift(task);
  activity(state, task.assignedTo, `Task from ${task.source === 'call' ? 'a call' : 'Slack'}: "${esc(task.name)}" (${tat}h)${assignee ? ` — assigned to <b>${esc(assignee.name)}</b>` : ' — unassigned'}.`, { source: task.source });
  return task;
}
function completeTask(state, taskId, byName) {
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t || t.status === 'completed') return t;
  if (t.timerStartedAt) { t.logged += (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000; t.timerStartedAt = null; }
  if (t.status === 'on_hold') { t.preHoldStatus = null; t.heldAt = null; }
  t.status = 'completed'; t.completedAt = new Date().toISOString();
  // Call / Slack tasks skip review by default — mark them terminally 'done'
  // so they read as done, not "awaiting review". But if someone already
  // nominated a reviewer (reviewerId set), respect that and leave it in
  // the review flow.
  if ((t.source === 'call' || t.source === 'slack_message') && !t.reviewerId) {
    t.reviewStatus = 'done'; t.closedBy = t.closedBy || t.assignedTo || null; t.closedAt = t.completedAt;
  }
  activity(state, t.assignedTo, `"${esc(t.name)}" marked done from Slack${byName ? ' by <b>' + esc(byName) + '</b>' : ''}.`);
  return t;
}

// ---------------------------------------------------------------------------
// Interakt (WhatsApp) webhook handler
//
// Interakt's payload shape (per their docs): { version, timestamp, type,
// data: { customer, message } }. `type` and the exact field names inside
// `customer`/`message` vary by plan/event, so extraction below is
// deliberately defensive (several fallback paths) and every hit is logged
// with its top-level shape — check `GET /webhooks/log` after the first real
// message if a field ever comes back empty, and tighten the fallbacks.
//
// This does NOT send WhatsApp replies — Interakt is the reply channel.
// It (a) tracks who's still waiting so the app can show "N people not yet
// replied to", and (b) optionally relays a message into Slack so the team
// sees it live and can use the existing "Convert to Task" shortcut on it —
// opt-in PER CONTACT (c.relayToSlack, off by default), toggled from the
// WhatsApp view or /api/whatsapp/contacts/:phone/relay. Nobody's messages
// land in Slack until someone in the app chooses that person.
// ---------------------------------------------------------------------------
// Interakt doesn't always send `message.message` as real JSON — sometimes
// it's the SAME content JSON-*encoded as a string* instead (a template
// block array serialized to text rather than left as actual array/object
// data). That string form slipped past both the text extractor and the
// direction check, since both only recognized a genuine array — a sent
// template ended up read as a brand-new inbound customer message. Parse it
// back into real data first so every downstream check sees the same shape
// regardless of which form Interakt happened to send.
function waNormalizeMessage(msg) {
  if (!msg || typeof msg.message !== 'string') return msg;
  const s = msg.message.trim();
  if (!s.startsWith('[') && !s.startsWith('{')) return msg;
  try { return { ...msg, message: JSON.parse(s) }; } catch (e) { return msg; } // wasn't actually JSON — leave it alone
}
function waPhoneOf(customer, msg) {
  return String(
    (customer && (customer.phone_number || customer.phoneNumber || customer.wa_id)) ||
    (msg && (msg.customer_phone_number || msg.from || msg.to)) || ''
  ).trim();
}
function waNameOf(customer, phone) {
  const traits = customer && customer.traits;
  return (customer && (customer.full_name || customer.name)) || (traits && traits.name) || phone;
}
// A sent WhatsApp template's content blocks, e.g.
// [{type:'body', parameters:[{type:'text', text:'Shijith'}]}] — surface the
// actual filled-in values instead of the raw structure.
function waTemplateBlocksToText(blocks) {
  const texts = [];
  (blocks || []).forEach(block => (block && block.parameters || []).forEach(p => { if (p && p.text) texts.push(p.text); }));
  return texts.length ? '[template] ' + texts.join(', ') : '[template message]';
}
// Some fields in Interakt's payload come through as the literal string
// "None" (or "null"/"undefined") rather than actually being absent —
// almost certainly a Python `None` caption/body serialized straight into
// JSON on their end. Treat those exactly like "no text", not real content.
function isWaPlaceholder(s) {
  return typeof s === 'string' && ['none', 'null', 'undefined', ''].includes(s.trim().toLowerCase());
}
// Common WhatsApp Cloud API media shapes — message.image / .video /
// .document / .audio / .sticker, each optionally carrying a caption. Used
// when there's no text body at all, so a photo shows as "📷 Photo" instead
// of blank or a stray "None".
const WA_MEDIA_LABELS = { image: '📷 Photo', video: '🎥 Video', document: '📄 Document', audio: '🎤 Voice message', voice: '🎤 Voice message', sticker: '💬 Sticker' };
function waMediaLabel(m) {
  if (!m || typeof m !== 'object') return null;
  for (const key of Object.keys(WA_MEDIA_LABELS)) {
    if (m[key]) {
      const caption = m[key].caption;
      return isWaPlaceholder(caption) || !caption ? WA_MEDIA_LABELS[key] : `${WA_MEDIA_LABELS[key]} — ${caption}`;
    }
  }
  return null;
}
// Re-clean text that's already stored — covers records saved before this
// parsing existed (a raw JSON block array, or a literal "None", saved as
// the message text back when waTextOf() didn't know what to do with it).
// Applied wherever stored text is served, so old rows read cleanly too
// without a data migration.
function prettyWaText(text) {
  if (typeof text !== 'string') return text;
  if (isWaPlaceholder(text)) return '📎 Attachment (no caption)';
  const s = text.trim();
  if (!s.startsWith('[') && !s.startsWith('{')) return text;
  try {
    const parsed = JSON.parse(s);
    return waTemplateBlocksToText(Array.isArray(parsed) ? parsed : [parsed]);
  } catch (e) { return text; } // wasn't actually JSON — leave it alone
}
function waTextOf(msg) {
  if (!msg) return '';
  const m = msg.message;
  if (Array.isArray(m)) return waTemplateBlocksToText(m);
  if (m && typeof m === 'object') {
    if (m.text && m.text.body && !isWaPlaceholder(m.text.body)) return m.text.body;
    const media = waMediaLabel(m);
    if (media) return media;
    if (m.caption && !isWaPlaceholder(m.caption)) return '[media] ' + m.caption;
    if (m.body && !isWaPlaceholder(m.body)) return m.body;
  }
  if (typeof m === 'string' && !isWaPlaceholder(m)) return m;
  if (msg.text) {
    const t = typeof msg.text === 'string' ? msg.text : (msg.text.body || '');
    if (!isWaPlaceholder(t)) return t;
  }
  if (msg.body && !isWaPlaceholder(msg.body)) return msg.body;
  return '📎 Attachment (no caption)';
}
// Best-effort direction guess from the event type / message shape.
// `chat_message_type` ('AgentMessage' vs 'CustomerMessage'), found directly
// on data.message, turned out to be the one reliable field Interakt stamps
// on EVERY event about a message — not just the content event, but also its
// delivered/read status updates. Confirmed from a real read-receipt
// ("agent_message_read") that carried our own outbound text again ~10
// minutes after we sent it: no "sent"/"template" substring in the type, no
// array-shaped message, so it fell through to the 'in' default and wrongly
// flipped a contact back to "awaiting reply" for a message WE sent. Check
// this field first; the older structural/string checks stay as a fallback
// for any payload shape that doesn't carry it.
function waDirectionOf(type, msg) {
  // AgentMessage = a person on our team replying manually. PublicApiMessage
  // = sent programmatically via Interakt's Public API (confirmed from real
  // traffic: every sample carries meta_data.source "PublicInterakt" and is
  // an automated/bulk-send follow-up or CRM-triggered template — never
  // something a customer typed). Both are ours; only CustomerMessage is
  // genuinely inbound (100% consistent across every real sample seen).
  if (msg && (msg.chat_message_type === 'AgentMessage' || msg.chat_message_type === 'PublicApiMessage')) return 'out';
  if (msg && msg.chat_message_type === 'CustomerMessage') return 'in';
  const t = String(type || '').toLowerCase();
  if (msg && Array.isArray(msg.message)) return 'out';
  if (t.includes('template') || t.includes('sent') || (msg && (msg.direction === 'outgoing' || msg.sent_by))) return 'out';
  return 'in'; // default to inbound — safer to surface a message than silently drop it
}
async function handleInteraktWebhook(body) {
  const state = db.get();
  const type = body && body.type;
  const data = (body && body.data) || {};
  const customer = data.customer || {};
  const msg = waNormalizeMessage(data.message || {});
  const phone = waPhoneOf(customer, msg);
  clog('info', 'interakt webhook', { type, hasPhone: !!phone, keys: Object.keys(data), messageWasStringified: typeof (data.message || {}).message === 'string' && typeof msg.message !== 'string' });
  if (!phone) { clog('warn', 'interakt webhook — no phone number in payload', { type }); return; }
  const name = waNameOf(customer, phone);
  const text = waTextOf(msg); // always a non-empty, human-readable string now
  const direction = waDirectionOf(type, msg);

  if (!state.waContacts || typeof state.waContacts !== 'object') state.waContacts = {};
  if (!Array.isArray(state.waMessages)) state.waMessages = [];
  const c = state.waContacts[phone] || (state.waContacts[phone] = {
    phone, name, firstSeenAt: new Date().toISOString(),
    lastInboundAt: null, lastOutboundAt: null, lastMessageText: '', lastMessageAt: null,
    lastMessageSourceId: null, status: 'new', taskIds: [], relayToSlack: false,
  });
  c.name = name || c.name;
  const now = new Date().toISOString();
  // Interakt fires a separate webhook for each status a message passes
  // through — sent, delivered, read — and a read receipt can land many
  // minutes after the original send, carrying the same message content
  // again. data.message.id is stable across all of them (confirmed from
  // real traffic: a "sent" and its "read" receipt shared one id 10 minutes
  // apart), so it's a far more reliable dedup key than the text+20s window
  // below, which only catches near-simultaneous duplicates. Check the id
  // first, uncapped by time; fall back to the text+time heuristic for any
  // payload that doesn't carry an id.
  const sourceId = msg && msg.id ? String(msg.id) : null;
  if (sourceId && c.lastMessageSourceId === sourceId) {
    clog('info', 'interakt webhook — duplicate status update suppressed', { phone, type, sourceId });
    return;
  }
  if (c.lastMessageText === text && c.lastMessageAt && (Date.parse(now) - Date.parse(c.lastMessageAt)) < 20000) {
    clog('info', 'interakt webhook — duplicate/echo suppressed', { phone, type });
    return;
  }
  state.waSeq = (state.waSeq || 0) + 1;
  // Keep the original payload alongside the parsed fields — Interakt's exact
  // shape for "this is an outbound plain-text message" isn't nailed down
  // yet (only the template-array case is confirmed), so this is what lets
  // that get diagnosed from real traffic via the app's own authenticated
  // API instead of guessing another heuristic blind. Bounded defensively —
  // WhatsApp message payloads are small, but never trust that blindly.
  let raw = null;
  try { raw = JSON.stringify(body).slice(0, 4000); } catch (e) {}
  state.waMessages.push({ id: 'wa' + state.waSeq, phone, name: c.name, direction, text, at: now, raw });
  if (state.waMessages.length > 500) state.waMessages.shift(); // rolling window, same cap style as connectorLog
  c.lastMessageText = text; c.lastMessageAt = now; c.lastMessageSourceId = sourceId;
  if (direction === 'in') { c.lastInboundAt = now; c.status = 'awaiting'; }
  else { c.lastOutboundAt = now; c.status = 'replied'; }
  db.save();

  if (direction === 'in' && c.relayToSlack) await relayWaToSlack(c, text);
}
// Post one message into Slack for a contact someone has opted into relaying.
// Reused both by the webhook (new inbound message) and by the "turn relay
// on" endpoint (so switching it on immediately shows their latest message,
// instead of silently waiting for their next one).
async function relayWaToSlack(c, text) {
  const channel = cfg().interaktChannel || cfg().slackChannel;
  if (!cfg().slackBotToken || !channel) return;
  await slack('chat.postMessage', {
    channel,
    text: `📱 *WhatsApp* — ${c.name} (${c.phone}):\n${text}`,
    unfurl_links: false,
  });
}

// ---------------------------------------------------------------------------
// Aircall webhook handlers
//
// Aircall does NOT guarantee ordering — in practice the recording-ready
// event ("call.comm_assets_generated") often arrives ~20s BEFORE
// "call.ended". So recording-ready with no call row stashes a `stub` row
// carrying the recording URL; the later call.ended adopts that stub and
// fills in agent / team / caller / duration, then posts the card straight
// at the "recording ready" stage.
// ---------------------------------------------------------------------------
function recordingUrlOf(call) {
  return call.recording || (call.asset && call.asset.url) ||
    (Array.isArray(call.recordings) && call.recordings[0] && (call.recordings[0].url || call.recordings[0])) ||
    null; // a voicemail's audio is never treated as a call recording
}

// Post the card, or update it in place if we've posted before. Stage is
// derived from whether we have a recording yet.
async function syncCard(state, row) {
  if (row.team === 'Unmapped' || row.status === 'not_picked_up' || row.status === 'voicemail') return;
  const stage = row.recordingUrl ? 'recording' : 'ended';
  const opts = cardOptsFor(state, row, stage);
  if (row.slackTs) {
    const upd = await slack('chat.update', {
      channel: row.slackChannel || cfg().slackChannel, ts: row.slackTs,
      text: callCardFallback(opts), blocks: buildCallCard(opts),
    });
    if (upd && upd.ok) return;
  }
  const posted = await slack('chat.postMessage', {
    channel: cfg().slackChannel, text: callCardFallback(opts), blocks: buildCallCard(opts),
  });
  if (posted && posted.ok) { row.slackChannel = posted.channel; row.slackTs = posted.ts; db.save(); }
}

async function handleCallEnded(call) {
  const state = db.get();
  const existing = findCall(state, call.id);
  if (existing && !existing.stub) { clog('info', 'call.ended dedup', { id: call.id }); return; }

  const agentId = call.user ? String(call.user.id) : null;
  const routing = agentId ? agentRouting(state, agentId) : null;
  const callerPhone = normalizeNumber(call.raw_digits || '');
  const unanswered = isUnanswered(call);
  const vm = isVoicemail(call);
  const status = vm ? 'voicemail' : (unanswered ? 'not_picked_up' : 'ended');

  // Transfer-leg merge: an earlier leg of the SAME call routed to another
  // agent. Only merge when it really looks like a transfer — the prior leg
  // was unanswered, or it landed in the last 90s — so a genuine second call
  // from the same number a few minutes later is NOT swallowed.
  if (!existing) {
    const cutoff = Date.now() - TRANSFER_MERGE_MINUTES * 60000;
    const cand = (state.calls || []).filter(c => !c.stub && c.callerPhone === callerPhone && callerPhone &&
      new Date(c.occurredAt).getTime() >= cutoff).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0];
    const looksLikeTransfer = cand && (cand.status === 'not_picked_up' ||
      Date.now() - new Date(cand.occurredAt).getTime() < 90000);
    const priorLeg = looksLikeTransfer ? cand : null;
    if (priorLeg) {
      priorLeg.aircallId = String(call.id);
      priorLeg.agentName = routing ? routing.name : (call.user ? call.user.name : priorLeg.agentName);
      priorLeg.agentAircallId = agentId || priorLeg.agentAircallId;
      if (routing) { priorLeg.team = routing.team; priorLeg.mandatory = !!routing.mandatory; }
      priorLeg.status = status;
      if (vm) { priorLeg.voicemail = true; priorLeg.recordingUrl = null; }
      db.save();
      clog('info', 'call.ended merged into transfer leg', { id: call.id, into: priorLeg.id });
      return;
    }
  }

  const caller = await resolveCaller(state, call);
  const base = {
    direction: call.direction || null, durationSec: call.duration || null, callerPhone,
    contactName: caller.name, clientId: caller.clientId, clientName: caller.name,
    agentName: routing ? routing.name : (call.user ? call.user.name : 'Unknown agent'),
    agentAircallId: agentId, team: routing ? routing.team : 'Unmapped',
    mandatory: routing ? !!routing.mandatory : false, status, voicemail: vm,
  };

  let row;
  if (existing && existing.stub) {
    Object.assign(existing, base, { stub: false });
    if (existing.recordingUrl && status === 'ended') existing.status = 'ended';
    if (vm) { existing.recordingUrl = null; existing.recordingFetchedAt = null; }
    row = existing;
    clog('info', 'call.ended adopted early-recording stub', { id: call.id, row: row.id, hadRecording: !!row.recordingUrl });
  } else {
    state.callSeq = (state.callSeq || 0) + 1;
    row = Object.assign({
      id: 'call' + state.callSeq, aircallId: String(call.id), occurredAt: new Date().toISOString(),
      recordingUrl: null, recordingFetchedAt: null, listenedBy: null, listenedAt: null,
      slackChannel: null, slackTs: null, aiOutcome: null, aiAction: null, aiDue: null,
      taskId: null, finalOutcome: null, createdVia: 'node-connector',
    }, base);
    state.calls.push(row);
    if (state.calls.length > 5000) state.calls.shift();
  }
  db.save();

  if (row.recordingUrl && !vm && cfg().geminiApiKey && !row.aiOutcome) {
    generateAiDraft(row.id).catch(e => clog('error', 'gemini draft threw: ' + (e && e.stack || e)));
  }
  if (routing && !unanswered && !vm) await syncCard(state, row);
  clog('info', 'call.ended', { id: call.id, team: row.team, status: row.status, posted: !!row.slackTs, hadRecording: !!row.recordingUrl });

  // Backstop: if the recording-ready webhook never arrives (or was missed),
  // poll the Aircall API once, a couple of minutes out.
  if (routing && !unanswered && !vm && !row.recordingUrl) {
    const rowId = row.id, aid = String(call.id);
    setTimeout(() => backfillRecording(rowId, aid), 150000);
  }
}

async function backfillRecording(rowId, aircallId) {
  try {
    const state = db.get();
    const row = findCallByRowId(state, rowId);
    if (!row || row.recordingUrl) return;
    const call = await fetchAircallCall(aircallId);
    if (call && isVoicemail(call)) { await markVoicemail(state, row); clog('info', 'recording backstop — it was a voicemail, no recording kept', { row: rowId }); return; }
    const url = call ? (call.recording || (call.asset && call.asset.url) || null) : null;
    if (!url) { clog('info', 'recording backstop — none on API either', { row: rowId }); return; }
    row.recordingUrl = url;
    row.recordingFetchedAt = new Date().toISOString();
    db.save();
    if (!row.aiOutcome && cfg().geminiApiKey) generateAiDraft(rowId).catch(e => clog('error', 'gemini draft threw: ' + (e && e.stack || e)));
    await syncCard(state, row);
    clog('info', 'recording backstop — fetched from Aircall API', { row: rowId });
  } catch (e) { clog('error', 'recording backstop threw: ' + (e && e.stack || e)); }
}

async function handleRecordingReady(call) {
  const state = db.get();
  const url = recordingUrlOf(call);
  const vm = isVoicemail(call);
  let row = findCall(state, call.id);
  if (!row) {
    // Aircall sometimes uses a different call.id — match on phone + time.
    const phone = normalizeNumber(call.raw_digits || '');
    const cutoff = Date.now() - RECORDING_MATCH_MINUTES * 60000;
    row = (state.calls || []).filter(c => c.callerPhone === phone && phone && !c.recordingUrl &&
      new Date(c.occurredAt).getTime() >= cutoff).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0];
    if (row) { row.aircallId = String(call.id); clog('warn', 'recording matched by phone fallback', { id: call.id, row: row.id }); }
  }

  if (!row) {
    // Recording-ready before call.ended — stash a stub the call.ended will adopt.
    state.callSeq = (state.callSeq || 0) + 1;
    row = {
      id: 'call' + state.callSeq, aircallId: String(call.id), stub: true,
      occurredAt: new Date().toISOString(), callerPhone: normalizeNumber(call.raw_digits || ''),
      direction: call.direction || null, durationSec: call.duration || null,
      recordingUrl: vm ? null : url, recordingFetchedAt: vm ? null : new Date().toISOString(), voicemail: vm,
      status: vm ? 'voicemail' : 'ended', team: 'Unmapped', mandatory: false,
      contactName: null, clientName: null, clientId: null, agentName: null, agentAircallId: null,
      listenedBy: null, listenedAt: null, slackChannel: null, slackTs: null,
      aiOutcome: null, aiAction: null, aiDue: null, taskId: null, finalOutcome: null, createdVia: 'node-connector',
    };
    state.calls.push(row);
    if (state.calls.length > 5000) state.calls.shift();
    db.save();
    clog('info', 'recording ready — stub stashed, awaiting call.ended', { id: call.id, hasUrl: !!url });
    return;
  }

  if (vm) { await markVoicemail(state, row); clog('info', 'voicemail — no recording kept, no card', { id: call.id }); return; }
  row.recordingUrl = url;
  row.recordingFetchedAt = new Date().toISOString();
  db.save();

  if (!vm && url && cfg().geminiApiKey && !row.aiOutcome) {
    generateAiDraft(row.id).catch(e => clog('error', 'gemini draft threw: ' + (e && e.stack || e)));
  }
  if (row.stub || vm || row.team === 'Unmapped') { clog('info', 'recording logged, no card yet', { id: call.id, stub: !!row.stub }); return; }
  await syncCard(state, row);
  clog('info', 'recording ready — card synced', { id: call.id });
}

// ---------------------------------------------------------------------------
// Slack interactivity — buttons, modal submissions, message shortcut
// ---------------------------------------------------------------------------
function stripActions(blocks) { return (blocks || []).filter(b => b.type !== 'actions'); }
function removeButton(blocks, actionId) {
  return (blocks || []).map(b => {
    if (b.type !== 'actions') return b;
    const els = (b.elements || []).filter(e => e.action_id !== actionId);
    return els.length ? Object.assign({}, b, { elements: els }) : null;
  }).filter(Boolean);
}
async function editMessage(payload, newBlocks) {
  await slack('chat.update', {
    channel: payload.channel.id, ts: payload.message.ts,
    text: payload.message.text || 'Call update', blocks: newBlocks,
  });
}

async function onMarkListened(payload, rowId) {
  const state = db.get();
  const row = findCallByRowId(state, rowId);
  const who = payload.user.name || payload.user.username || payload.user.id;
  if (row) { row.listenedBy = who; row.listenedAt = new Date().toISOString(); db.save(); }
  const blocks = removeButton(payload.message.blocks, 'mark_listened');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `✅ Listened by *${esc(who)}* — ${new Date().toLocaleString('en-NZ')}` }] });
  await editMessage(payload, blocks);
}
async function onNoAction(payload, rowId) {
  const state = db.get();
  const row = findCallByRowId(state, rowId);
  const who = payload.user.name || payload.user.username || payload.user.id;
  if (row) { row.finalOutcome = 'No action needed'; row.status = 'no_action'; db.save(); }
  const blocks = stripActions(payload.message.blocks);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `🚫 *No action needed* — marked by *${esc(who)}*` }] });
  await editMessage(payload, blocks);
}
async function onSelfAssign(payload, rowId) {
  const state = db.get();
  const row = findCallByRowId(state, rowId);
  if (!row || row.taskId) return;
  const task = createTask(state, {
    title: row.clientName && row.clientName.indexOf('Unknown') !== 0 ? ('Call — ' + row.clientName) : 'Call follow-up',
    detail: "Self-claimed via 'I'll Handle This'.", source: 'call',
    sourceRef: row.slackTs ? slackPermalink(row) : null, assigneeSlackId: payload.user.id,
    clientName: row.clientName && row.clientName.indexOf('Unknown') !== 0 ? row.clientName : null,
    estMinutes: 30, // placeholder — the person sets the real estimate in "Log Outcome"
  });
  if (!task) { await dm(payload.user.id, "Couldn't create that task — try again."); return; }
  row.taskId = task.id; db.save();
  await postTaskCard(row, task, payload.user.id, payload.user.name || payload.user.id, true);
}
function slackPermalink(row) {
  if (!row.slackChannel || !row.slackTs) return null;
  return `https://slack.com/archives/${row.slackChannel}/p${String(row.slackTs).replace('.', '')}`;
}
// Listened-vs-remaining call counts for whoever's Slack ID is tagged on an
// agent's calls (Manage Access > Slack user ID). Deliberately status ===
// 'ended' only — a voicemail or missed call never gets a card posted or a
// tag in the first place (see handleCallEnded's `!unanswered && !vm`
// guard), so this stays consistent with what actually reached them.
function callStatsForSlackId(state, slackUserId) {
  const empty = { total: 0, listened: 0, remaining: 0, remainingCalls: [], noAction: 0, noActionCalls: [], listenedCalls: [] };
  if (!slackUserId) return empty;
  const agentIds = Object.keys(state.agentMap || {}).filter(id => agentSlackIds(state, id).includes(slackUserId));
  // Rolling window, not the whole backlog — old unlistened calls (weeks back)
  // just buried the tile in noise. "Remaining" now means yesterday onward.
  const cutoff = nzToday(new Date(Date.now() - 86400000));
  // Ended calls AND ones explicitly marked "no action needed" — the latter
  // used to be excluded from this tile entirely, which is why there was no
  // way to see them here at all.
  const calls = (state.calls || []).filter(c => agentIds.includes(c.agentAircallId)
    && countsAsCall(c)
    && c.occurredAt && nzToday(new Date(c.occurredAt)) >= cutoff);
  const shape = c => ({
    id: c.id, agentName: c.agentName, clientName: c.clientName || 'Unknown / not saved',
    callerPhone: c.callerPhone, occurredAt: c.occurredAt, link: slackPermalink(c),
  });
  const noActionCalls = calls.filter(c => c.status === 'no_action');
  const endedCalls = calls.filter(c => c.status === 'ended');
  const remaining = endedCalls.filter(c => !c.listenedBy);
  const listenedCalls = endedCalls.filter(c => c.listenedBy);
  const byRecent = (a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || '');
  return {
    total: endedCalls.length,
    listened: listenedCalls.length,
    remaining: remaining.length,
    remainingCalls: remaining.sort(byRecent).map(shape),
    noAction: noActionCalls.length,
    noActionCalls: noActionCalls.sort(byRecent).map(shape),
    listenedCalls: listenedCalls.sort(byRecent).map(shape),
  };
}
// Who's actually on the hook for listening to this call — state.agentMap's
// employeeIds, resolved to real employee records via their Slack user ID
// (same mapping callStatsForSlackId uses in the other direction). An agent
// with no employeeIds assigned (nobody listens to those calls) has no
// responsible person; an agent with two gets both.
function responsiblePeopleForCall(state, c) {
  const slackIds = agentSlackIds(state, c.agentAircallId);
  return slackIds
    .map(sid => (state.employees || []).find(e => e.slackUserId === sid))
    .filter(Boolean)
    .map(e => ({ id: e.id, name: e.name }));
}
// The single state a call has reached, in the same order the Slack card's
// own buttons move it through: once it's got a final outcome or a
// self-claimed task, "listened" no longer matters for the status column —
// this is "how far did it get", not a checklist.
function callOutcomeStatus(c) {
  if (c.status === 'no_action') return 'no_action';
  if (c.finalOutcome) return 'logged_outcome';
  if (c.taskId) return 'self_assigned';
  if (c.listenedBy) return 'listened';
  return 'not_listened';
}
const CALL_STATUS_LABELS = {
  not_listened: 'Not listened yet',
  listened: 'Listened',
  self_assigned: 'Sorted calls',
  logged_outcome: 'Outcome logged',
  no_action: 'No action needed',
};
// Calls report — every tagged call (same 'ended'/'no_action' scope as
// callStatsForSlackId) in a date window. A superadmin gets the whole firm,
// with an owner (responsible-person) and agent breakdown/filter; anyone
// else is hard-scoped server-side to only the calls they're responsible for
// listening to — `personId`/`agentId` from the query string are ignored
// for them, same "list endpoints scope by role" rule as everywhere else.
function allCallsReport(state, { from, to, personId, agentId, actor } = {}) {
  let calls = (state.calls || []).filter(c => {
    if (!countsAsCall(c)) return false;
    if (!c.occurredAt) return false;
    const day = nzToday(new Date(c.occurredAt));
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
  const isSuperAdmin = actor && actor.accessRole === 'superadmin';
  if (!isSuperAdmin) {
    calls = calls.filter(c => responsiblePeopleForCall(state, c).some(p => p.id === (actor && actor.id)));
  }
  const shaped = calls.map(c => {
    const responsible = responsiblePeopleForCall(state, c);
    const agent = agentRouting(state, c.agentAircallId);
    const agentName = c.agentName || (agent && agent.name) || 'Unknown';
    // Groups (and the owner filter) key on the responsible person(s) when
    // there are any, else on the agent whose calls nobody's assigned to
    // listen to — so two different "unassigned" agents don't collapse into
    // one indistinguishable bucket.
    const personKey = responsible.length ? responsible.map(p => p.id).sort().join(',') : `unassigned:${agentName}`;
    const outcomeStatus = callOutcomeStatus(c);
    return {
      id: c.id,
      occurredAt: c.occurredAt,
      day: nzToday(new Date(c.occurredAt)),
      agentName,
      agentAircallId: c.agentAircallId || null,
      team: (agent && agent.team) || null,
      clientName: c.clientName || 'Unknown / not saved',
      callerPhone: c.callerPhone,
      status: c.status,
      listened: !!c.listenedBy,
      finalOutcome: c.finalOutcome || null,
      taskId: c.taskId || null,
      responsible,
      responsibleName: responsible.length ? responsible.map(p => p.name).join(' / ') : `${agentName} (unassigned)`,
      personKey,
      outcomeStatus,
      outcomeLabel: CALL_STATUS_LABELS[outcomeStatus],
      link: slackPermalink(c),
    };
  }).sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''));
  const byPerson = {};
  const byAgent = {};
  shaped.forEach(c => {
    if (!byPerson[c.personKey]) byPerson[c.personKey] = { key: c.personKey, name: c.responsibleName, total: 0, listened: 0, remaining: 0, noAction: 0 };
    const b = byPerson[c.personKey];
    b.total++;
    if (c.status === 'no_action') b.noAction++;
    else if (c.listened) b.listened++;
    else b.remaining++;
    const agentKey = c.agentAircallId || c.agentName;
    if (!byAgent[agentKey]) byAgent[agentKey] = { key: agentKey, name: c.agentName, total: 0 };
    byAgent[agentKey].total++;
  });
  // Owner/agent filters only make sense (and are only exposed) for a
  // superadmin — a non-superadmin's `calls` is already scoped to just them.
  let scoped = shaped;
  if (isSuperAdmin && personId) scoped = scoped.filter(c => c.personKey === personId);
  if (isSuperAdmin && agentId) scoped = scoped.filter(c => c.agentAircallId === agentId);
  const counts = { total: scoped.length, not_listened: 0, listened: 0, self_assigned: 0, logged_outcome: 0, no_action: 0 };
  scoped.forEach(c => { counts[c.outcomeStatus]++; });
  return {
    calls: scoped,
    counts,
    byPerson: isSuperAdmin ? Object.values(byPerson).sort((a, b) => b.total - a.total) : [],
    byAgent: isSuperAdmin ? Object.values(byAgent).sort((a, b) => b.total - a.total) : [],
    isSuperAdmin,
  };
}

// ---------------------------------------------------------------------------
// EMAIL (Gmail) — a firm-wide visibility/audit log for 4 real mailboxes
// (Rideshare, Property, Companies, Info), tagged to whichever employee owns
// each one (employee.gmailAddresses[] — one employee can own more than one,
// e.g. Khushi runs both Rideshare and Property). Deliberately mirrors
// Calls' shape (log/filter, no task conversion, no Slack posting, no AI)
// rather than WhatsApp's (which IS a triage/convert-to-task feature) —
// email here is visibility only.
//
// Unlike Aircall's AGENT_MAP (a routing table, because who LISTENS to a
// call can be a different person than who took it), Gmail mailbox ownership
// is direct and real: the mailbox owner IS the responsible person, so there
// is no separate routing/delegation layer to build.
//
// Auth: domain-wide delegation. A GCP service account (its key JSON in
// GMAIL_SERVICE_ACCOUNT_JSON) impersonates each mailbox address in turn for
// the `gmail.metadata` scope only (headers/subject/snippet — no message
// body), via a self-signed JWT exchanged for a short-lived access token.
// Polling (not Pub/Sub push) — no urgency here, and it avoids a second
// public webhook endpoint + a 7-day watch-renewal job for a read-only log.
// ---------------------------------------------------------------------------
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const _gmailTokenCache = {}; // mailboxAddress -> { token, expiresAt }

function gmailServiceAccount() {
  const raw = cfg().gmailServiceAccountJson;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { clog('error', 'GMAIL_SERVICE_ACCOUNT_JSON is not valid JSON'); return null; }
}

// Mints (and caches, until near-expiry) a short-lived OAuth2 access token
// impersonating `mailboxAddress`, via a self-signed JWT assertion — the
// standard domain-wide-delegation flow, no separate consent screen per
// mailbox.
async function gmailAccessToken(mailboxAddress) {
  const cached = _gmailTokenCache[mailboxAddress];
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const sa = gmailServiceAccount();
  if (!sa) return null;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: sa.client_email, sub: mailboxAddress, scope: GMAIL_SCOPE,
    aud: GMAIL_TOKEN_URL, iat: now, exp: now + 3600,
  }, sa.private_key, { algorithm: 'RS256' });
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
  }).toString();
  const r = await httpsRequest(GMAIL_TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    clog('error', 'gmail token exchange failed', { mailboxAddress, status: r.status, error: r.json && r.json.error });
    return null;
  }
  _gmailTokenCache[mailboxAddress] = { token: r.json.access_token, expiresAt: Date.now() + (r.json.expires_in || 3600) * 1000 };
  return r.json.access_token;
}

// Thin Gmail API wrapper. In non-production with no service account
// configured, reads from a local fixture file instead of calling Google —
// the seam that makes pollGmailMailbox exercisable in the test harness with
// zero live credentials (see test/fixtures/gmail-messages.json).
async function gmailApi(mailboxAddress, path) {
  if (!cfg().gmailServiceAccountJson && process.env.NODE_ENV !== 'production') {
    return gmailApiFixture(mailboxAddress, path);
  }
  const token = await gmailAccessToken(mailboxAddress);
  if (!token) return { status: 0, json: null, error: 'no gmail access token' };
  return httpsRequest('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
}

let _gmailFixtureCache = null;
function gmailApiFixture(mailboxAddress, path) {
  if (_gmailFixtureCache === null) {
    try {
      const fs = require('fs');
      const p = require('path').join(__dirname, 'test', 'fixtures', 'gmail-messages.json');
      _gmailFixtureCache = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { _gmailFixtureCache = {}; }
  }
  const mailbox = _gmailFixtureCache[mailboxAddress] || { historyId: '1', messages: [] };
  if (path === 'profile') {
    return { status: 200, json: { emailAddress: mailboxAddress, historyId: mailbox.historyId, messagesTotal: mailbox.messages.length, threadsTotal: mailbox.messages.length } };
  }
  if (path.startsWith('history/list') || path.startsWith('messages?')) {
    return { status: 200, json: { historyId: mailbox.historyId, messages: mailbox.messages.map(m => ({ id: m.id })) } };
  }
  const idMatch = path.match(/^messages\/([^?]+)/);
  const msg = idMatch && mailbox.messages.find(m => m.id === idMatch[1]);
  return { status: msg ? 200 : 404, json: msg ? gmailMessageShape(msg) : null };
}
// Shapes a fixture message the same way a real `format=metadata` response
// does — { id, threadId, internalDate, labelIds, snippet, payload:{headers} }.
function gmailMessageShape(m) {
  return {
    id: m.id, threadId: m.threadId, internalDate: String(m.internalDate),
    labelIds: m.labelIds || [], snippet: m.snippet || '',
    payload: { headers: [
      { name: 'From', value: m.from || '' }, { name: 'To', value: m.to || '' }, { name: 'Subject', value: m.subject || '' },
    ] },
  };
}

function findEmail(state, gmailMessageId) { return (state.emails || []).find(e => e.gmailMessageId === gmailMessageId); }
function gmailHeader(headers, name) { const h = (headers || []).find(x => x.name === name); return h ? h.value : ''; }
function gmailAddressesOf(headerValue) {
  return String(headerValue || '').split(',').map(s => {
    const m = s.match(/<([^>]+)>/);
    return (m ? m[1] : s).trim().toLowerCase();
  }).filter(Boolean);
}

// Polls one mailbox, incrementally via history.list once a cursor exists,
// else bootstraps on first run. The gmail.metadata scope doesn't allow the
// `q` search parameter on messages.list (Google: "Metadata scope does not
// support 'q' parameter") — so the bootstrap can't date-filter, it just
// takes the most recent page as the starting batch, and gets a real
// historyId to poll incrementally from via users.getProfile (a plain
// messages.list response carries no historyId of its own). Dedupes by
// gmailMessageId (mirrors findCall's dedupe by aircallId).
async function pollGmailMailbox(mailboxAddress, employeeId) {
  const state = db.get();
  const emp = (state.employees || []).find(e => e.id === employeeId);
  const ownerName = emp ? emp.name : 'Unknown';
  const cursor = state.emailPollCursor[mailboxAddress];
  let messageIds, newCursor = cursor;
  if (cursor) {
    const listResp = await gmailApi(mailboxAddress, `history/list?startHistoryId=${encodeURIComponent(cursor)}&historyTypes=messageAdded`);
    if (listResp.status !== 200 || !listResp.json) {
      // Gmail only retains history for a limited window (about a week) —
      // once this cursor ages past that (or otherwise goes bad), every
      // future poll hits the exact same failure and this mailbox silently
      // stops ingesting anything new, forever, with no visible error to
      // anyone but this log line. Clear the cursor and re-bootstrap (same
      // path as a brand-new mailbox) instead of giving up, so one bad
      // cursor self-heals on the very next tick rather than needing a
      // manual fix.
      clog('warn', 'gmail poll: list failed — clearing cursor and re-bootstrapping', { mailboxAddress, status: listResp.status, error: listResp.json && listResp.json.error });
      state.emailPollCursor[mailboxAddress] = null;
      db.save();
      return pollGmailMailbox(mailboxAddress, employeeId);
    }
    const history = listResp.json.history || [];
    messageIds = [...new Set(history.flatMap(h => (h.messagesAdded || []).map(m => m.message.id)))];
    if (listResp.json.historyId) newCursor = listResp.json.historyId;
  } else {
    const [listResp, profileResp] = await Promise.all([
      gmailApi(mailboxAddress, 'messages?maxResults=50'),
      gmailApi(mailboxAddress, 'profile'),
    ]);
    if (listResp.status !== 200 || !listResp.json) {
      clog('warn', 'gmail poll: bootstrap list failed', { mailboxAddress, status: listResp.status, error: listResp.json && listResp.json.error, raw: !listResp.json && listResp.raw ? listResp.raw.toString('utf8').slice(0, 300) : undefined });
      return { mailboxAddress, ok: false, added: 0 };
    }
    messageIds = (listResp.json.messages || []).map(m => m.id);
    if (profileResp.status === 200 && profileResp.json && profileResp.json.historyId) newCursor = profileResp.json.historyId;
    else clog('warn', 'gmail poll: bootstrap profile fetch failed (cursor not set — next poll will re-bootstrap)', { mailboxAddress, status: profileResp.status });
  }
  let added = 0;
  for (const gmailMessageId of messageIds) {
    if (findEmail(state, gmailMessageId)) continue;
    const msgResp = await gmailApi(mailboxAddress, `messages/${encodeURIComponent(gmailMessageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`);
    if (msgResp.status !== 200 || !msgResp.json) continue;
    const m = msgResp.json;
    const headers = m.payload && m.payload.headers;
    const fromAddress = gmailAddressesOf(gmailHeader(headers, 'From'))[0] || '';
    const toAddresses = gmailAddressesOf(gmailHeader(headers, 'To'));
    const direction = fromAddress === mailboxAddress ? 'outbound' : 'inbound';
    // Replied: for an inbound message, does the SAME thread already contain
    // an outbound message (from the mailbox owner) with a later internalDate?
    // Cheap approximation from what's already in state.emails for this
    // thread — avoids a second live thread-fetch per message.
    const threadSiblings = (state.emails || []).filter(e => e.threadId === m.threadId);
    // A reply that is only a 👍 (or Gmail's own reaction) acknowledges the mail
    // without counting as a reply — see email-status.js.
    const thread = direction === 'inbound'
      ? emailStatus.classifyThread({ occurredAt: new Date(Number(m.internalDate)).toISOString() }, threadSiblings.filter(e => e.direction === 'outbound'))
      : { replied: false, thumbsUp: false };
    const replied = thread.replied;
    state.emailSeq = (state.emailSeq || 0) + 1;
    state.emails.push({
      id: 'email' + state.emailSeq, gmailMessageId, threadId: m.threadId,
      occurredAt: new Date(Number(m.internalDate)).toISOString(),
      direction, fromAddress, toAddresses, subject: gmailHeader(headers, 'Subject'),
      mailbox: mailboxAddress, mailboxOwner: employeeId, agentName: ownerName,
      status: (m.labelIds || []).includes('UNREAD') ? 'unread' : 'read',
      replied, thumbsUp: thread.thumbsUp, labelIds: m.labelIds || [], snippet: m.snippet || '',
      listenedBy: null, listenedAt: null, finalOutcome: null, taskId: null,
      replyNotNeeded: false, replyNotNeededBy: null, replyNotNeededAt: null,
      createdVia: 'gmail-poller',
    });
    if (state.emails.length > 5000) state.emails.shift();
    added++;
    // A newly-ingested outbound message answers any earlier-still-open
    // inbound sibling in the same thread — retroactively flips `replied`
    // rather than waiting for that older row to be re-polled itself.
    if (direction === 'outbound') {
      const occurredAt = new Date(Number(m.internalDate)).toISOString();
      state.emails.filter(e => e.threadId === m.threadId && e.direction === 'inbound' && !e.replied && e.occurredAt < occurredAt)
        .forEach(e => { if (emailStatus.isThumbsSnippet(m.snippet)) e.thumbsUp = true; else { e.replied = true; e.thumbsUp = false; } });
    }
  }
  // Refresh read/unread on already-logged unread rows for this mailbox —
  // a cheap per-message label re-check (bounded by how many are still
  // unread), not a re-fetch of content, so the log doesn't go stale between
  // a message arriving unread and someone later reading it in Gmail itself.
  const stillUnread = (state.emails || []).filter(e => e.mailboxOwner === employeeId && e.status === 'unread');
  for (const row of stillUnread) {
    const r = await gmailApi(mailboxAddress, `messages/${encodeURIComponent(row.gmailMessageId)}?format=metadata`);
    if (r.status === 200 && r.json && Array.isArray(r.json.labelIds)) {
      row.status = r.json.labelIds.includes('UNREAD') ? 'unread' : 'read';
    }
  }
  if (newCursor) state.emailPollCursor[mailboxAddress] = newCursor;
  reclassifyThumbs(state);
  db.save();
  clog('info', 'gmail poll', { mailboxAddress, added, refreshed: stillUnread.length });
  return { mailboxAddress, ok: true, added };
}

// Acknowledged = replied, opened-but-not-replied ("Not replied", also a 👍),
// or marked "no reply needed". Not acknowledged = still unread. See email-status.js.
function emailOutcomeStatus(e) { return emailStatus.outcomeStatus(e); }
const EMAIL_STATUS_LABELS = emailStatus.LABELS;
const emailResponsibleId = emailStatus.responsibleId;
// Replies that were only a 👍 used to be stored as "replied" — move them over.
// Idempotent: it only ever turns a "replied" whose every later outbound message
// is thumbs-only into a 👍; anything with no sibling left in the log is untouched.
function reclassifyThumbs(state) {
  const all = state.emails || [];
  const outByThread = {};
  all.forEach(e => { if (e.direction === 'outbound' && e.threadId) (outByThread[e.threadId] = outByThread[e.threadId] || []).push(e); });
  let changed = 0;
  all.forEach(e => {
    if (e.direction !== 'inbound' || !e.replied || !e.threadId) return;
    const outs = (outByThread[e.threadId] || []).filter(o => (o.occurredAt || '') > (e.occurredAt || ''));
    if (outs.length && outs.every(o => emailStatus.isThumbsSnippet(o.snippet))) { e.replied = false; e.thumbsUp = true; changed++; }
  });
  return changed;
}
// Gmail's own tab categorization (the labelIds already captured at ingest
// on every message) — Promotions/Social/Updates are never real client
// correspondence, so they're excluded from the report the same way
// outbound and ignored-sender mail is: filtered here, never deleted.
// Forums is deliberately left alone — not mentioned, and rare enough in
// these mailboxes not to warrant guessing beyond what was asked.
const EMAIL_EXCLUDED_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES'];

function emailStatsForEmployee(state, employeeId) {
  const cutoff = nzToday(new Date(Date.now() - 86400000));
  const mine = (state.emails || []).filter(e => emailResponsibleId(e) === employeeId && e.direction === 'inbound'
    && e.occurredAt && nzToday(new Date(e.occurredAt)) >= cutoff);
  const shape = e => ({ id: e.id, fromAddress: e.fromAddress, subject: e.subject, occurredAt: e.occurredAt });
  const byRecent = (a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || '');
  // "Remaining" = not acknowledged yet (still unread); everything else is acknowledged.
  const remaining = mine.filter(e => !emailStatus.isAcknowledged(emailOutcomeStatus(e)));
  const repliedRows = mine.filter(e => e.replied);
  return {
    total: mine.length, replied: repliedRows.length, acknowledged: mine.length - remaining.length, remaining: remaining.length,
    remainingEmails: remaining.sort(byRecent).map(shape), repliedEmails: repliedRows.sort(byRecent).map(shape),
  };
}

// A row's own mailbox address — stored directly since Gmail's "sent
// history" fix (mailbox field added later than the first live rows), with
// a fallback derivation for any older row ingested before that.
function mailboxOf(e) {
  if (e.mailbox) return e.mailbox;
  return e.direction === 'outbound' ? e.fromAddress : (e.toAddresses || [])[0] || null;
}

// Email report — every logged message in a date window. A superadmin gets
// the whole firm with an owner + mailbox filter and breakdown; anyone else
// is hard-scoped server-side to their own mailbox(es) — personId/mailbox
// are ignored for them, same "list endpoints scope by role" rule as
// Calls/everywhere else.
function allEmailsReport(state, { from, to, personId, mailbox, actor } = {}) {
  // Outbound (sent BY the mailbox owner) is still ingested and kept in
  // state.emails — it's needed internally to detect whether an inbound
  // message got replied to (see pollGmailMailbox) — but it's noise in this
  // report: mostly our own automated notifications/reports, not client
  // correspondence needing attention. Excluded here, not at ingest.
  // Ignored senders (state.emailIgnoredSenders, superadmin-managed —
  // "Ignore sender" on a row, or the manage-list modal) are our own test/
  // internal addresses that occasionally send through a connected mailbox
  // — same reasoning, excluded from the report only, never deleted.
  const ignored = new Set((state.emailIgnoredSenders || []).map(s => String(s || '').toLowerCase()));
  let emails = (state.emails || []).filter(e => {
    if (e.direction !== 'inbound') return false;
    if (ignored.has(String(e.fromAddress || '').toLowerCase())) return false;
    if ((e.labelIds || []).some(l => EMAIL_EXCLUDED_LABELS.includes(l))) return false;
    if (!e.occurredAt) return false;
    const day = nzToday(new Date(e.occurredAt));
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
  const isSuperAdmin = actor && actor.accessRole === 'superadmin';
  if (!isSuperAdmin) emails = emails.filter(e => emailResponsibleId(e) === (actor && actor.id));
  const nameOfEmp = id => { const x = (state.employees || []).find(p => p.id === id); return x ? x.name : null; };
  const shaped = emails.map(e => {
    const outcomeStatus = emailOutcomeStatus(e);
    return {
      id: e.id, occurredAt: e.occurredAt, day: nzToday(new Date(e.occurredAt)),
      agentName: e.agentName, mailboxOwner: e.mailboxOwner, mailbox: mailboxOf(e), direction: e.direction,
      responsibleId: emailResponsibleId(e), responsibleName: nameOfEmp(emailResponsibleId(e)) || e.agentName,
      reassigned: !!e.reassignedTo && e.reassignedTo !== e.mailboxOwner, thumbsUp: !!e.thumbsUp,
      fromAddress: e.fromAddress, toAddresses: e.toAddresses, subject: e.subject, snippet: e.snippet,
      status: e.status, replied: e.replied, finalOutcome: e.finalOutcome || null, taskId: e.taskId || null,
      replyNotNeeded: !!e.replyNotNeeded,
      outcomeStatus, outcomeLabel: EMAIL_STATUS_LABELS[outcomeStatus],
    };
  }).sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''));
  const byPerson = {};
  const byMailbox = {};
  shaped.forEach(e => {
    if (!byPerson[e.responsibleId]) byPerson[e.responsibleId] = { key: e.responsibleId, name: e.responsibleName, total: 0, unread: 0, replied: 0 };
    const b = byPerson[e.responsibleId];
    b.total++;
    if (e.outcomeStatus === 'replied') b.replied++;
    else if (e.outcomeStatus === 'unread') b.unread++;
    if (e.mailbox) {
      if (!byMailbox[e.mailbox]) byMailbox[e.mailbox] = { key: e.mailbox, name: e.mailbox, ownerName: e.agentName, total: 0 };
      byMailbox[e.mailbox].total++;
    }
  });
  let scoped = shaped;
  if (isSuperAdmin && personId) scoped = scoped.filter(e => e.responsibleId === personId);
  // Mailbox filtering is safe for anyone, not just superadmins — `emails`
  // was already hard-scoped to the actor's own mailbox(es) above for a
  // non-superadmin, so filtering further by mailbox can't leak anyone
  // else's mail. Needed for someone like Khushi who owns two mailboxes
  // (Rideshare + Property) and wants to look at just one of them.
  if (mailbox) scoped = scoped.filter(e => e.mailbox === mailbox);
  const counts = { total: scoped.length, unread: 0, read: 0, replied: 0, no_action: 0 };
  scoped.forEach(e => { counts[e.outcomeStatus]++; });
  counts.not_replied = counts.unread + counts.read;
  // The two top-level groups: acknowledged (replied + not replied + no reply needed) vs not.
  counts.acknowledged = counts.total - counts.unread;
  counts.not_acknowledged = counts.unread;
  return {
    emails: scoped, counts,
    byPerson: isSuperAdmin ? Object.values(byPerson).sort((a, b) => b.total - a.total) : [],
    // Also not superadmin-gated — already scoped to the actor's own
    // mailbox(es), same reasoning as the mailbox filter above.
    byMailbox: Object.values(byMailbox).sort((a, b) => b.total - a.total),
    isSuperAdmin,
  };
}

// ---------------------------------------------------------------------------
// CALLS & EMAIL DIGEST — a daily report (email and/or WhatsApp) summarizing,
// per person, how many calls/emails they had TODAY (the current NZ
// calendar day, up to send time — fires in the evening, ~18:45 NZ, so this
// covers effectively the whole working day) and how many they'd
// acknowledged (a call: someone listened to the recording; an email:
// replied, or marked reply-not-needed) vs not. One combined management
// summary listing everyone, not a personal message per employee.
// ---------------------------------------------------------------------------
// Calls & emails per responsible person over a date range (NZ days,
// inclusive) — the shared source for the daily digest, the Admin-group
// productivity table and the monthly cards, so they can never disagree.
// Definitions match the Calls and Email pages exactly:
//   call  = every tagged ended / no-action call; ACKNOWLEDGED = anything
//           past "not listened yet" (listened, sorted, outcome logged, or
//           no action needed) — see callOutcomeStatus; a call with two
//           responsible people (responsiblePeopleForCall) counts for both.
//   email = inbound only, minus ignored senders and Gmail's Promotions/
//           Social/Updates tabs (same filters as allEmailsReport);
//           ACKNOWLEDGED = anything but unread: replied, opened/👍 but not
//           replied, or marked no-reply-needed (see email-status.js).
function callsEmailsStats(state, from, to) {
  const byPerson = {};
  const row = (id, name) => {
    if (!byPerson[id]) byPerson[id] = { id, name, calls: { total: 0, ack: 0, notAck: 0 }, emails: { total: 0, ack: 0, notAck: 0 } };
    return byPerson[id];
  };
  const inRange = ts => { const d = nzToday(new Date(ts)); return d >= from && d <= to; };
  (state.calls || []).filter(c => countsAsCall(c) && c.occurredAt && inRange(c.occurredAt))
    .forEach(c => {
      responsiblePeopleForCall(state, c).forEach(p => {
        const r = row(p.id, p.name);
        r.calls.total++;
        if (callOutcomeStatus(c) !== 'not_listened') r.calls.ack++; else r.calls.notAck++;
      });
    });
  const ignored = new Set((state.emailIgnoredSenders || []).map(s => String(s || '').toLowerCase()));
  (state.emails || []).filter(e => e.direction === 'inbound' && e.occurredAt && inRange(e.occurredAt)
    && !ignored.has(String(e.fromAddress || '').toLowerCase())
    && !(e.labelIds || []).some(l => EMAIL_EXCLUDED_LABELS.includes(l)))
    .forEach(e => {
      const emp = (state.employees || []).find(x => x.id === emailResponsibleId(e));
      const r = row(emailResponsibleId(e) || e.mailbox, emp ? emp.name : e.agentName || 'Unknown');
      r.emails.total++;
      const status = emailOutcomeStatus(e);
      if (emailStatus.isAcknowledged(status)) r.emails.ack++; else r.emails.notAck++;
    });
  // Only people with actual activity — no point listing everyone at 0/0/0/0.
  const people = Object.values(byPerson)
    .filter(p => p.calls.total > 0 || p.emails.total > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { from, to, people };
}
// ---------------------------------------------------------------------------
// AUTOMATIC MARKS — the daily acknowledgement check (rules in auto-marks.js).
// Each finished working day is judged once, from 08:00 NZ the next morning: per
// person, emails and calls separately, using the same "acknowledged" definitions
// as the Calls/Email pages. Leave, holiday and workshop days are skipped.
// ---------------------------------------------------------------------------
function autoMarksDeps(state) {
  const server = require('./server');
  const now = new Date();
  return {
    today: nzToday(now), hourNZ: nzHour(now), now: now.toISOString(),
    isWorkingDay: d => cal.isWorkingDay(d),
    getStats: day => callsEmailsStats(state, day, day).people,
    skip: (empId, day) => {
      const emp = (state.employees || []).find(e => e.id === empId);
      return !emp || emp.accessDisabled || ['LEAVE', 'WORKSHOP', 'HOLIDAY'].includes(server.attendanceStatus(state, emp, day));
    },
    onCreated: row => server.announceAutoMark(state, row),
  };
}
function runAutoMarks(reason) {
  const state = db.get();
  const res = autoMarks.runDays(state, autoMarksDeps(state));
  res.reports = require('./server').sweepReportDeadlines(state); // reports still unsent past their committed date
  res.created += res.reports;
  db.save();
  if (res.created) clog('info', 'automatic marks given', { reason, created: res.created, days: res.days.map(d => d.day) });
  return res;
}
// What the rule WOULD do for one day — changes nothing.
function previewAutoMarksDay(day) {
  const state = db.get();
  const d = autoMarksDeps(state);
  const rows = autoMarks.evaluateAckDay(state, day, d.getStats(day), { today: d.today, skip: d.skip, dryRun: true });
  const workday = cal.isWorkingDay(day);
  return rows.map(r => ({ toId: r.toId, name: r.name, channel: r.channel, total: r.total, notAck: r.notAck, marks: r.marks, skipped: r.skipped || !workday, why: !workday ? 'not a working day' : (r.skipped ? 'on leave / holiday / workshop' : '') }));
}

// One person's individual calls and emails in the range, each flagged
// acknowledged or not — the drill-down behind the Admin productivity rows
// ("collect all data of theirs"). Headers/subject only, same as the Email
// page: no message body is ever read or stored.
function callsEmailsDetail(state, personId, from, to) {
  const inRange = ts => { const d = nzToday(new Date(ts)); return d >= from && d <= to; };
  const calls = (state.calls || [])
    .filter(c => countsAsCall(c) && c.occurredAt && inRange(c.occurredAt)
      && responsiblePeopleForCall(state, c).some(p => p.id === personId))
    .map(c => { const st = callOutcomeStatus(c); return {
      id: c.id, occurredAt: c.occurredAt, clientName: c.clientName || 'Unknown / not saved', callerPhone: c.callerPhone || null,
      outcomeLabel: CALL_STATUS_LABELS[st], acknowledged: st !== 'not_listened',
    }; })
    .sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''));
  const ignored = new Set((state.emailIgnoredSenders || []).map(s => String(s || '').toLowerCase()));
  const emails = (state.emails || [])
    .filter(e => e.direction === 'inbound' && emailResponsibleId(e) === personId && e.occurredAt && inRange(e.occurredAt)
      && !ignored.has(String(e.fromAddress || '').toLowerCase())
      && !(e.labelIds || []).some(l => EMAIL_EXCLUDED_LABELS.includes(l)))
    .map(e => { const st = emailOutcomeStatus(e); return {
      id: e.id, occurredAt: e.occurredAt, fromAddress: e.fromAddress, subject: e.subject || '',
      outcomeLabel: EMAIL_STATUS_LABELS[st], acknowledged: emailStatus.isAcknowledged(st),
    }; })
    .sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''));
  return { calls, emails };
}
// The daily digest is just one day of the same stats.
function callsEmailsDigestData(state, dayISO) {
  const day = dayISO || nzToday(new Date());
  return { day, people: callsEmailsStats(state, day, day).people };
}
function formatCallsEmailsDigestText(data) {
  const dayLabel = new Date(data.day + 'T00:00:00').toLocaleDateString('en-NZ', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  if (!data.people.length) return `📞📧 Calls & Email Report — ${dayLabel}\n\nNo calls or emails logged.`;
  // Two separate sections — calls and emails are different work with
  // different people responsible for each, so mixed one-line-per-person
  // read as noise. Each section only lists people who actually had that
  // kind of activity (no padding zero-rows for someone with emails but no
  // calls, or vice versa).
  const callRows = data.people.filter(p => p.calls.total > 0)
    .map(p => `${p.name} — ${p.calls.total} (${p.calls.ack} ack / ${p.calls.notAck} not)`);
  const emailRows = data.people.filter(p => p.emails.total > 0)
    .map(p => `${p.name} — ${p.emails.total} (${p.emails.ack} ack / ${p.emails.notAck} not)`);
  const section = (title, rows) => `${title}\n${rows.length ? rows.join('\n') : 'None'}`;
  return `📞📧 Calls & Email Report — ${dayLabel}\n\n`
    + section('📞 CALLS', callRows) + '\n\n' + section('📧 EMAILS', emailRows);
}
// HTML version for email — same underlying data as the plain-text one
// above (still used for WhatsApp), but laid out as real tables: a Summary
// (Calls / Emails / Overall totals) plus a per-person breakdown table for
// each channel, each with its own Total row.
function formatCallsEmailsDigestHtml(data) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dayLong = new Date(data.day + 'T00:00:00').toLocaleDateString('en-NZ', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const dayShort = new Date(data.day + 'T00:00:00').toLocaleDateString('en-NZ', { day: '2-digit', month: 'long', year: 'numeric' });
  const sum = (key) => data.people.reduce((s, p) => ({ total: s.total + p[key].total, ack: s.ack + p[key].ack, notAck: s.notAck + p[key].notAck }), { total: 0, ack: 0, notAck: 0 });
  const th = 'text-align:left;padding:8px 14px;border-bottom:2px solid #333;font-size:13px;';
  const td = 'padding:8px 14px;border-bottom:1px solid #ddd;font-size:14px;';
  const tdTotal = td + 'font-weight:bold;border-top:2px solid #333;border-bottom:none;';
  const row = (label, r, bold) => `<tr><td style="${bold ? tdTotal : td}">${esc(label)}</td><td style="${bold ? tdTotal : td}">${r.total}</td><td style="${bold ? tdTotal : td}">${r.ack}</td><td style="${bold ? tdTotal : td}">${r.notAck}</td></tr>`;
  const table = (headFirst, headCount, bodyRows) => `<table style="border-collapse:collapse;width:100%;max-width:640px;margin:0 0 8px;">
    <tr><th style="${th}">${esc(headFirst)}</th><th style="${th}">${esc(headCount)}</th><th style="${th}">Acknowledged</th><th style="${th}">Not Acknowledged</th></tr>
    ${bodyRows}
  </table>`;
  const activitySection = (title, key, headCount) => {
    const rows = data.people.filter(p => p[key].total > 0);
    if (!rows.length) return `<h2 style="font-size:16px;margin:24px 0 8px;">${esc(title)}</h2><p style="font-size:14px;color:#666;">None</p>`;
    const body = rows.map(p => row(p.name, p[key])).join('') + row('Total', sum(key), true);
    return `<h2 style="font-size:16px;margin:24px 0 8px;">${esc(title)}</h2>${table('Team Member', headCount, body)}`;
  };
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:680px;">
    <h1 style="font-size:20px;">Daily Calls &amp; Email Report – ${esc(dayShort)}</h1>
    <p>Hi Team,</p>
    <p>Please find below the Calls and Email Activity Report for ${esc(dayLong)}.</p>
    ${activitySection('Call Activity', 'calls', 'Total Calls')}
    ${activitySection('Email Activity', 'emails', 'Total Emails')}
  </div>`;
}
// Meta's own WhatsApp Business Cloud API, called directly — deliberately
// NOT Interakt (that integration is receive-only here; see interaktApiKey
// above). Requires an approved message template with exactly one body
// {{1}} parameter, which carries the entire preformatted report as one
// string — WhatsApp templates don't support a variable number of rows, so
// the whole multi-line report is packed into that single placeholder.
async function sendWhatsAppCloudTemplate(toE164, bodyText) {
  const c = cfg();
  if (!c.whatsappCloudToken || !c.whatsappCloudPhoneNumberId) return { ok: false, error: 'WhatsApp Cloud API not configured' };
  const r = await httpsRequest(`https://graph.facebook.com/v19.0/${encodeURIComponent(c.whatsappCloudPhoneNumberId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.whatsappCloudToken },
    body: {
      messaging_product: 'whatsapp', to: toE164, type: 'template',
      template: { name: c.whatsappCloudTemplateName, language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: bodyText }] }] },
    },
  });
  if (r.status !== 200 && r.status !== 201) {
    return { ok: false, error: (r.json && r.json.error && r.json.error.message) || 'HTTP ' + r.status };
  }
  return { ok: true, result: r.json };
}
// Sending the digest by email uses its OWN dedicated service account
// (GMAIL_SEND_SERVICE_ACCOUNT_JSON) — deliberately NOT the one Gmail
// reading uses (gmailServiceAccountJson/gmailServiceAccount above), which
// is shared with an unrelated client-facing integration on the same
// Google Workspace. Completely separate credential, token cache and
// domain-wide-delegation Client ID, so nothing about this digest can ever
// touch that other integration's authorization.
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const _gmailSendTokenCache = {};
function gmailSendServiceAccount() {
  const raw = cfg().gmailSendServiceAccountJson;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { clog('error', 'GMAIL_SEND_SERVICE_ACCOUNT_JSON is not valid JSON'); return null; }
}
async function gmailSendAccessToken(mailboxAddress) {
  const cached = _gmailSendTokenCache[mailboxAddress];
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const sa = gmailSendServiceAccount();
  if (!sa) return null;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: sa.client_email, sub: mailboxAddress, scope: GMAIL_SEND_SCOPE,
    aud: GMAIL_TOKEN_URL, iat: now, exp: now + 3600,
  }, sa.private_key, { algorithm: 'RS256' });
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
  const r = await httpsRequest(GMAIL_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    clog('error', 'gmail send-token exchange failed — is this service account\'s Client ID authorized for gmail.send in Workspace Admin, and does fromMailbox belong to this Workspace?', { mailboxAddress, status: r.status, error: r.json && r.json.error });
    return null;
  }
  _gmailSendTokenCache[mailboxAddress] = { token: r.json.access_token, expiresAt: Date.now() + (r.json.expires_in || 3600) * 1000 };
  return r.json.access_token;
}
function buildRawEmail({ from, to, subject, html }) {
  const raw = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', '', html,
  ].join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sendGmailDigestEmail(fromMailbox, toAddresses, subject, html) {
  if (!cfg().gmailSendServiceAccountJson) return { ok: false, error: 'GMAIL_SEND_SERVICE_ACCOUNT_JSON not configured' };
  const token = await gmailSendAccessToken(fromMailbox);
  if (!token) return { ok: false, error: 'no gmail send token — check this service account is domain-wide-delegated for gmail.send' };
  const r = await httpsRequest('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: { raw: buildRawEmail({ from: fromMailbox, to: toAddresses.join(', '), subject, html }) },
  });
  if (r.status !== 200 || !r.json) return { ok: false, error: (r.json && r.json.error && r.json.error.message) || 'HTTP ' + r.status };
  return { ok: true, result: r.json };
}
async function runCallsEmailsDigest(reason) {
  const state = db.get();
  const day = nzToday(new Date());
  const data = callsEmailsDigestData(state, day);
  const text = formatCallsEmailsDigestText(data);
  const c = cfg();
  let sent = 0, of = 0;
  if (c.whatsappCloudRecipients.length) {
    of += c.whatsappCloudRecipients.length;
    for (const to of c.whatsappCloudRecipients) {
      const r = await sendWhatsAppCloudTemplate(to, text);
      if (r.ok) sent++;
      else clog('warn', 'calls/email digest: whatsapp send failed', { to, error: r.error });
    }
  }
  if (c.gmailDigestFromMailbox && c.gmailDigestRecipients.length) {
    of += 1;
    const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-NZ', { day: '2-digit', month: 'long', year: 'numeric' });
    // Plain ASCII subject — header values aren't declared with a charset the
    // way the body is, so keep it simple; the richer formatting/emoji live
    // in the UTF-8-declared HTML body instead.
    const html = formatCallsEmailsDigestHtml(data);
    const r = await sendGmailDigestEmail(c.gmailDigestFromMailbox, c.gmailDigestRecipients, `Daily Calls & Email Report - ${dayLabel}`, html);
    if (r.ok) sent++;
    else clog('warn', 'calls/email digest: gmail send failed', { error: r.error });
  }
  clog('info', 'calls/email digest sent', { reason, day, people: data.people.length, sent, of });
  return { day, sent, of, people: data.people.length };
}

// Scheduler tick — polls every mailbox in every employee's gmailAddresses
// (one employee can own more than one — e.g. Khushi runs both Rideshare and
// Property). Gated on the service account being configured (matches the
// `if (!cfg().slackBotToken) return;` guard style used by the digest tick).
async function pollAllGmailMailboxes() {
  if (!cfg().gmailServiceAccountJson && process.env.NODE_ENV === 'production') return { polled: 0 };
  const state = db.get();
  const jobs = (state.employees || []).flatMap(e => (e.gmailAddresses || []).map(addr => ({ addr, empId: e.id })));
  const results = [];
  for (const { addr, empId } of jobs) {
    try { results.push(await pollGmailMailbox(addr, empId)); }
    catch (e) { clog('error', 'gmail poll threw: ' + (e && e.stack || e), { mailboxAddress: addr }); }
  }
  return { polled: results.length, results };
}

// ---------------------------------------------------------------------------
// KUDOS — firm-wide recognition, star-leveled (see KUDOS_LEVELS above).
// Core mutation functions, shared by the HTTP endpoints (server.js) and
// the Slack App Home buttons below — one place owns the actual state
// changes + notifications + the public Slack post, so the two entry
// points can't drift apart. Each returns {ok:true,...} or {ok:false,error}
// rather than throwing, so both an HTTP 400 and a Slack error can read it.
// ---------------------------------------------------------------------------
async function postKudosAnnouncement(toEmployee, byName, level, note) {
  const mention = toEmployee.slackUserId ? `<@${toEmployee.slackUserId}>` : esc(toEmployee.name);
  const badge = (KUDOS_LEVELS[level] || {}).badge || level;
  const text = `${badge} *Kudos to ${mention}!*\n${esc(byName)} gave them ${badge} recognition.` + (note ? `\n> ${esc(note)}` : '');
  await slack('chat.postMessage', {
    channel: cfg().slackChannel,
    text: `${badge} Kudos to ${toEmployee.name}!`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  }).catch(e => clog('error', 'kudos slack post failed: ' + (e && e.message)));
}
async function awardKudos(state, { toId, byId, level, note }) {
  const { findEmployee, logEvent, notify, escHtml } = require('./server');
  const to = findEmployee(state, toId);
  const by = findEmployee(state, byId);
  if (!to || !by) return { ok: false, error: 'Person not found.' };
  if (!KUDOS_LEVELS[level]) return { ok: false, error: 'Pick a level: 1-Star, 3-Star, 4-Star, 5-Star or Legendary.' };
  if (!canAwardKudosTo(by, to)) return { ok: false, error: "You're not authorized to award kudos to this person." };
  const cleanNote = String(note || '').trim().slice(0, 300);
  state.kudosSeq = (state.kudosSeq || 0) + 1;
  const row = { id: 'kd' + state.kudosSeq, toId: to.id, byId: by.id, level, note: cleanNote || null, awardedAt: new Date().toISOString() };
  state.kudos.push(row);
  const badge = (KUDOS_LEVELS[level] || {}).badge || level;
  const label = (KUDOS_LEVELS[level] || {}).label || level;
  logEvent(state, to.id, `${badge} <b>${escHtml(by.name)}</b> awarded you ${escHtml(label)} kudos${cleanNote ? ' — ' + escHtml(cleanNote) : ''}.`);
  notify(state, to.id, 'kudos', `${badge} ${by.name} awarded you ${label} kudos!`, null);
  db.save();
  postKudosAnnouncement(to, by.name, level, cleanNote).catch(() => {});
  return { ok: true, kudos: row };
}
// Points — a separate, simpler award from Kudos: any positive amount, no
// team-manager mapping (just "admin or founder", the plain reading of what
// was asked for), visible firm-wide (not just to the recipient) since the
// whole point is a firm-wide celebration/announcement.
async function awardPoints(state, { toId, byId, amount, note }) {
  const { findEmployee, logEvent, notify, escHtml } = require('./server');
  const to = findEmployee(state, toId);
  const by = findEmployee(state, byId);
  if (!to || !by) return { ok: false, error: 'Person not found.' };
  if (!(by.accessRole === 'admin' || by.accessRole === 'superadmin')) return { ok: false, error: 'Only an admin or the founder can award points.' };
  const amt = Math.round(Number(amount));
  if (!(amt > 0)) return { ok: false, error: 'Points must be a positive number.' };
  const cleanNote = note ? String(note).trim().slice(0, 300) : null;
  state.pointsSeq = (state.pointsSeq || 0) + 1;
  const row = { id: 'pt' + state.pointsSeq, toId: to.id, byId: by.id, amount: amt, note: cleanNote, awardedAt: new Date().toISOString(), reactions: [] };
  state.points.push(row);
  logEvent(state, to.id, `${escHtml(by.name)} awarded <b>${amt.toLocaleString()} points</b> to ${escHtml(to.name)}${cleanNote ? ' — "' + escHtml(cleanNote) + '"' : ''}.`);
  notify(state, to.id, 'points', `${by.name} awarded you ${amt.toLocaleString()} points!${cleanNote ? ' — ' + cleanNote : ''}`, null);
  db.save();
  return { ok: true, points: row };
}
// Remove a Kudos award — founder (superadmin) only, e.g. to clean up a test
// or mistaken entry. Kudos has no edit path, just delete: the wall is a
// public record, so fixing a bad entry means removing it, not silently
// rewriting history.
function deleteKudos(state, { kudosId, byId }) {
  const { findEmployee } = require('./server');
  const by = findEmployee(state, byId);
  if (!by || by.accessRole !== 'superadmin') return { ok: false, error: 'Only the founder can remove a kudos award.' };
  const idx = (state.kudos || []).findIndex(k => k.id === kudosId);
  if (idx < 0) return { ok: false, error: 'Kudos award not found.' };
  state.kudos.splice(idx, 1);
  db.save();
  return { ok: true };
}
// Remove a Points award — same founder-only, delete-not-edit contract as
// deleteKudos above.
function deletePoints(state, { pointsId, byId }) {
  const { findEmployee } = require('./server');
  const by = findEmployee(state, byId);
  if (!by || by.accessRole !== 'superadmin') return { ok: false, error: 'Only the founder can remove a points award.' };
  const idx = (state.points || []).findIndex(p => p.id === pointsId);
  if (idx < 0) return { ok: false, error: 'Points award not found.' };
  state.points.splice(idx, 1);
  db.save();
  return { ok: true };
}
// Toggle/replace the caller's own reaction on a points award — one reaction
// per employee per award (clicking the same emoji again removes it).
function reactToPoints(state, { pointsId, empId, emoji }) {
  const row = (state.points || []).find(p => p.id === pointsId);
  if (!row) return { ok: false, error: 'Points award not found.' };
  row.reactions = row.reactions || [];
  const existing = row.reactions.find(r => r.empId === empId);
  if (existing && existing.emoji === emoji) row.reactions = row.reactions.filter(r => r.empId !== empId);
  else if (existing) { existing.emoji = emoji; existing.at = new Date().toISOString(); }
  else row.reactions.push({ empId, emoji, at: new Date().toISOString() });
  db.save();
  return { ok: true, points: row };
}
async function recommendKudos(state, { toId, byId, note }) {
  const { findEmployee, logEvent, notify, escHtml } = require('./server');
  const to = findEmployee(state, toId);
  const by = findEmployee(state, byId);
  if (!to || !by) return { ok: false, error: 'Person not found.' };
  if (to.id === by.id) return { ok: false, error: "You can't recommend kudos for yourself." };
  const cleanNote = String(note || '').trim().slice(0, 300);
  if (!cleanNote) return { ok: false, error: 'Say why — a short reason is required.' };
  state.kudosRecSeq = (state.kudosRecSeq || 0) + 1;
  const row = {
    id: 'kr' + state.kudosRecSeq, toId: to.id, byId: by.id, note: cleanNote,
    createdAt: new Date().toISOString(), status: 'pending', resolvedBy: null, resolvedAt: null, awardedKudosId: null,
  };
  state.kudosRecommendations.push(row);
  const mgrEmail = kudosManagerEmailFor(to.team);
  const mgr = mgrEmail ? (state.employees || []).find(e => String(e.email || '').toLowerCase() === mgrEmail) : null;
  logEvent(state, to.id, `<b>${escHtml(by.name)}</b> recommended you for kudos — "${escHtml(cleanNote)}".`);
  if (mgr) notify(state, mgr.id, 'kudos_recommend', `${by.name} recommended ${to.name} for kudos.`, null);
  db.save();
  return { ok: true, recommendation: row };
}
async function resolveKudosRecommendation(state, { recId, byId, action, level, note }) {
  const { findEmployee } = require('./server');
  const rec = (state.kudosRecommendations || []).find(r => r.id === recId);
  if (!rec) return { ok: false, error: 'Recommendation not found.' };
  if (rec.status !== 'pending') return { ok: false, error: 'This recommendation was already resolved.' };
  const to = findEmployee(state, rec.toId);
  const by = findEmployee(state, byId);
  if (!to || !by) return { ok: false, error: 'Person not found.' };
  if (!canAwardKudosTo(by, to)) return { ok: false, error: "You're not authorized to resolve this." };
  if (action === 'dismiss') {
    rec.status = 'dismissed'; rec.resolvedBy = by.id; rec.resolvedAt = new Date().toISOString();
    db.save();
    return { ok: true, recommendation: rec };
  }
  if (action !== 'award') return { ok: false, error: 'Unknown action.' };
  const r = await awardKudos(state, { toId: rec.toId, byId: by.id, level, note: note || rec.note });
  if (!r.ok) return r;
  rec.status = 'awarded'; rec.resolvedBy = by.id; rec.resolvedAt = new Date().toISOString(); rec.awardedKudosId = r.kudos.id;
  db.save();
  return { ok: true, recommendation: rec, kudos: r.kudos };
}
// Slack App Home entry points — open modals, then hand off to the same
// awardKudos/recommendKudos core functions the HTTP endpoints use. Unlike
// the app's own picker, Slack's users_select can't be filtered to just
// who the giver is authorized for, so an unauthorized pick still reaches
// awardKudos and gets rejected there — reported back by DM.
async function openGiveKudosModalSlack(payload) {
  await slack('views.open', {
    trigger_id: payload.trigger_id,
    view: { type: 'modal', callback_id: 'kudos_give_modal',
      title: { type: 'plain_text', text: 'Give Kudos' }, submit: { type: 'plain_text', text: 'Award' }, close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'to', label: { type: 'plain_text', text: 'Who' }, element: { type: 'users_select', action_id: 'v' } },
        { type: 'input', block_id: 'level', label: { type: 'plain_text', text: 'Level' }, element: { type: 'static_select', action_id: 'v',
          options: Object.entries(KUDOS_LEVELS).map(([key, lv]) => ({ text: { type: 'plain_text', text: lv.badge, emoji: true }, value: key })) } },
        { type: 'input', block_id: 'note', optional: true, label: { type: 'plain_text', text: 'Note' }, element: { type: 'plain_text_input', action_id: 'v', multiline: true } },
      ] },
  });
}
async function openRecommendKudosModalSlack(payload) {
  await slack('views.open', {
    trigger_id: payload.trigger_id,
    view: { type: 'modal', callback_id: 'kudos_recommend_modal',
      title: { type: 'plain_text', text: 'Recommend Kudos' }, submit: { type: 'plain_text', text: 'Recommend' }, close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'to', label: { type: 'plain_text', text: 'Who' }, element: { type: 'users_select', action_id: 'v' } },
        { type: 'input', block_id: 'note', label: { type: 'plain_text', text: 'Why' }, element: { type: 'plain_text_input', action_id: 'v', multiline: true } },
      ] },
  });
}
async function submitGiveKudosSlack(payload) {
  const state = db.get();
  const by = empBySlackId(state, payload.user.id);
  if (!by) { await dm(payload.user.id, "⚠️ Your Slack account isn't linked to a Governance OS login, so I can't tell who you are."); return; }
  const v = payload.view.state.values;
  const toSlackId = v.to && v.to.v.selected_user;
  const to = toSlackId ? empBySlackId(state, toSlackId) : null;
  const level = v.level && v.level.v.selected_option && v.level.v.selected_option.value;
  const note = (v.note && v.note.v.value) || '';
  if (!to) { await dm(payload.user.id, "⚠️ Couldn't find that person in the task manager — pick someone whose Slack account is linked."); return; }
  const r = await awardKudos(state, { toId: to.id, byId: by.id, level, note });
  await dm(payload.user.id, r.ok ? `🏆 Kudos awarded to ${to.name}!` : `⚠️ ${r.error}`);
}
async function submitRecommendKudosSlack(payload) {
  const state = db.get();
  const by = empBySlackId(state, payload.user.id);
  if (!by) { await dm(payload.user.id, "⚠️ Your Slack account isn't linked to a Governance OS login, so I can't tell who you are."); return; }
  const v = payload.view.state.values;
  const toSlackId = v.to && v.to.v.selected_user;
  const to = toSlackId ? empBySlackId(state, toSlackId) : null;
  const note = (v.note && v.note.v.value) || '';
  if (!to) { await dm(payload.user.id, "⚠️ Couldn't find that person in the task manager — pick someone whose Slack account is linked."); return; }
  const r = await recommendKudos(state, { toId: to.id, byId: by.id, note });
  await dm(payload.user.id, r.ok ? `👍 Recommendation sent for ${to.name} — their manager will review it.` : `⚠️ ${r.error}`);
}
async function postTaskCard(row, task, ownerSlackId, byName, selfAssigned) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: selfAssigned ? '📌 Task Logged (Self-Assigned)' : '📌 New Task', emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Owner*\n<@${ownerSlackId}>` },
      { type: 'mrkdwn', text: `*Due*\n${fmtDate(task.internalDeadline)}` },
    ] },
    { type: 'section', text: { type: 'mrkdwn', text: `*Task:* ${esc(task.scope !== '—' ? task.scope : task.name, SLACK_TEXT_MAX)}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${selfAssigned ? '' : 'Assigned by *' + esc(byName) + '* · '}Task ${task.id} · 🟢 via Governance OS` }] },
    { type: 'divider' },
    { type: 'actions', elements: [buttonEl('▶ Start Work', 'task_start', task.id), buttonEl('✅ Mark Done', 'task_done', task.id)] },
  ];
  await slack('chat.postMessage', {
    channel: cfg().slackChannel, thread_ts: row.slackTs || undefined,
    text: `📌 Task for <@${ownerSlackId}>: ${task.name}`, blocks,
  });
}
// Start Work — the exact same state transition as the app's own Start/
// Resume button (server.js#resumeTaskCore, required lazily so it's the one
// shared implementation, not a re-guessed copy). Only works for whoever the
// task is actually assigned to; anyone else clicking it just sees why not,
// same message the app itself would show.
async function onTaskStart(payload, taskId) {
  const state = db.get();
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t) return;
  const who = payload.user.name || payload.user.username || payload.user.id;
  const emp = empBySlackId(state, payload.user.id);
  const blocks = removeButton(payload.message.blocks, 'task_start');
  if (!emp) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠️ Couldn't tell who you are — your Slack account isn't linked to a Governance OS login.` }] });
  } else {
    const { resumeTaskCore } = require('./server');
    const result = resumeTaskCore(state, t, emp, {});
    if (result.error) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠️ ${esc(result.error)}` }] });
    } else {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `▶ *Started* by *${esc(who)}* — ${new Date().toLocaleString('en-NZ')}` }] });
    }
  }
  await editMessage(payload, blocks);
}
async function onTaskDone(payload, taskId) {
  const state = db.get();
  const who = payload.user.name || payload.user.username || payload.user.id;
  completeTask(state, taskId, who);
  db.save();
  const blocks = removeButton(payload.message.blocks, 'task_done');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `✅ *Marked done* by *${esc(who)}* — ${new Date().toLocaleString('en-NZ')}` }] });
  await editMessage(payload, blocks);
}
async function onTaskSnooze(payload, taskId) {
  const state = db.get();
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t) return;
  const today = nzToday();
  const until = nzToday(new Date(Date.now() + 24 * 3600000));
  t.reminderState = t.reminderState || { escLevel: 0, escAt: null, snoozeUntil: null };
  t.reminderState.snoozeUntil = until;
  db.save();
  activity(state, t.assignedTo, `Snoozed reminders for "${esc(t.name)}" until ${until}.`);
  db.save();
  const blocks = removeButton(payload.message.blocks, 'task_snooze');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `😴 Snoozed until *${until}* — the ladder resumes after that if it's still open.` }] });
  await editMessage(payload, blocks);
}
async function onTaskNeedTime(payload, taskId) {
  await slack('views.open', {
    trigger_id: payload.trigger_id,
    view: { type: 'modal', callback_id: 'need_time_modal', private_metadata: taskId,
      title: { type: 'plain_text', text: 'Need more time' }, submit: { type: 'plain_text', text: 'Update' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'newdue', label: { type: 'plain_text', text: 'New due date' },
          element: { type: 'datepicker', action_id: 'v' } },
        { type: 'input', block_id: 'why', optional: true, label: { type: 'plain_text', text: 'Reason (shared with your team lead)' },
          element: { type: 'plain_text_input', action_id: 'v', multiline: true } },
      ] },
  });
}
async function submitNeedTime(payload) {
  const state = db.get();
  const taskId = payload.view.private_metadata;
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t) { clog('error', 'need-time submit — no task', { taskId }); return; }
  const v = payload.view.state.values;
  const newDue = v.newdue && v.newdue.v.selected_date;
  const why = (v.why && v.why.v.value) || '';
  if (!newDue) return;
  const old = t.internalDeadline;
  t.internalDeadline = newDue;
  t.reminderState = { escLevel: 0, escAt: null, snoozeUntil: null };
  db.save();
  const emp = empById(state, t.assignedTo);
  activity(state, t.assignedTo, `Moved "${esc(t.name)}" due date ${old || '—'} → <b>${newDue}</b>${why ? ` — ${esc(why)}` : ''}.`);
  db.save();
  await dm(payload.user.id, `🗓️ "${t.name}" is now due ${newDue}.`);
  if (emp) for (const target of escalationTargets(state, emp)) {
    await dm(target, `🗓️ *${esc(emp.name)}* moved a due date`,
      [{ type: 'section', text: { type: 'mrkdwn', text: `*${esc(t.name)}*\n${old || '—'} → *${newDue}*${why ? `\n_${esc(why)}_` : ''}` } }]);
  }
}
async function onPlayRecording(payload, rowId) {
  const state = db.get();
  const row = findCallByRowId(state, rowId);
  if (!row) return;
  const url = await freshRecordingUrl(row.aircallId);
  if (!url) {
    clog('warn', 'play recording — no url', { row: rowId });
    await slack('chat.postMessage', { channel: payload.channel.id, thread_ts: payload.message.ts, text: '⚠️ Recording not available from Aircall (it may have expired or is still processing).' });
    return;
  }
  const audio = await httpsRequest(url, { timeoutMs: 90000 });
  if (audio.status !== 200 || !audio.raw || !audio.raw.length) { clog('warn', 'play recording — audio fetch failed', { status: audio.status }); return; }
  if (audio.raw.length > 60 * 1024 * 1024) { clog('warn', 'play recording — file too large', { bytes: audio.raw.length }); return; }
  // Slack's external-upload flow is form-encoded, not JSON:
  const c = cfg();
  const form = 'filename=' + encodeURIComponent('call-' + row.aircallId + '.mp3') + '&length=' + audio.raw.length;
  const gu = await httpsRequest('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer ' + c.slackBotToken },
    body: form,
  });
  if (!gu.json || !gu.json.ok) { clog('warn', 'getUploadURLExternal failed', { e: gu.json && gu.json.error }); return; }
  const put = await httpsRequest(gu.json.upload_url, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio.raw, timeoutMs: 90000,
  });
  if (put.status >= 300 || put.status === 0) { clog('warn', 'audio upload failed', { status: put.status }); return; }
  await slack('files.completeUploadExternal', {
    files: [{ id: gu.json.file_id, title: 'Call recording — ' + row.aircallId }],
    channel_id: cfg().slackChannel, thread_ts: row.slackTs || undefined,
  });
  const blocks = removeButton(payload.message.blocks, 'play_recording');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '🎧 *Recording uploaded* — open the thread to play it ⬇' }] });
  await editMessage(payload, blocks);
}

// Log Outcome modal
async function openLogOutcomeModal(payload, rowId) {
  const state = db.get();
  const row = findCallByRowId(state, rowId);
  // The AI transcript/summary is hidden from staff by design — only the
  // founder gets the modal pre-filled from it. Everyone else starts blank.
  const ai = (row && (row.aiOutcome || row.aiAction) && isFounderSlackId(state, payload.user.id)) ? row : null;
  const blocks = [];
  if (ai) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '🤖 *AI draft (founder-only) — review and edit before submitting.*' }] });
  blocks.push(
    { type: 'input', block_id: 'outcome', label: { type: 'plain_text', text: 'Final Outcome' },
      element: Object.assign({ type: 'plain_text_input', action_id: 'v', multiline: true }, ai && ai.aiOutcome ? { initial_value: ai.aiOutcome } : {}) },
    { type: 'input', block_id: 'action', label: { type: 'plain_text', text: 'Action Taken' },
      element: Object.assign({ type: 'plain_text_input', action_id: 'v', multiline: true }, ai && ai.aiAction ? { initial_value: ai.aiAction } : {}) },
    { type: 'input', block_id: 'due', optional: true, label: { type: 'plain_text', text: 'Task Due Date' },
      element: Object.assign({ type: 'datepicker', action_id: 'v' }, ai && ai.aiDue ? { initial_date: ai.aiDue } : {}) },
    { type: 'input', block_id: 'mins', label: { type: 'plain_text', text: 'Estimated Time (minutes) — required' },
      element: Object.assign({ type: 'number_input', action_id: 'v', is_decimal_allowed: false, min_value: '1' }, ai && ai.aiMins ? { initial_value: String(ai.aiMins) } : {}) },
    { type: 'input', block_id: 'assignee', optional: true, label: { type: 'plain_text', text: 'Assign to (blank = yourself)' },
      element: { type: 'users_select', action_id: 'v' } }
  );
  await slack('views.open', {
    trigger_id: payload.trigger_id,
    view: { type: 'modal', callback_id: 'log_outcome_modal', private_metadata: rowId,
      title: { type: 'plain_text', text: 'Log Outcome' }, submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' }, blocks },
  });
}
async function submitLogOutcome(payload) {
  const state = db.get();
  const rowId = payload.view.private_metadata;
  const row = findCallByRowId(state, rowId);
  if (!row) { clog('error', 'log outcome submit — no row', { rowId }); return; }
  const v = payload.view.state.values;
  const outcome = (v.outcome && v.outcome.v.value) || '';
  const action = (v.action && v.action.v.value) || '';
  const due = (v.due && v.due.v.selected_date) || '';
  const mins = (v.mins && v.mins.v.value) || '';
  const pickedAssignee = v.assignee && v.assignee.v.selected_user;
  const assigneeSlackId = pickedAssignee || payload.user.id;

  row.finalOutcome = outcome; db.save();
  const title = (action.split('\n')[0] || (row.clientName && row.clientName.indexOf('Unknown') !== 0 ? 'Call — ' + row.clientName : 'Call follow-up')).slice(0, 140);
  const detail = [outcome, action].filter(Boolean).join('\n\n');

  const minsN = Number(mins);
  if (!(minsN > 0)) { await dm(payload.user.id, '⏱ That task needs an estimated time — reopen “Log Outcome” and add the minutes.'); return; }

  if (row.taskId) {
    const t = (state.tasks || []).find(x => x.id === row.taskId);
    if (t) {
      // Leaving the due-date field blank here means "keep whatever it already
      // has" (e.g. the placeholder set at self-assign), not "clear it" — a
      // null internal deadline permanently blocks the assignee's punch-out.
      t.name = title; t.scope = detail || '—'; t.internalDeadline = due || t.internalDeadline || cal.addWorkingDays(nzToday(), 1);
      const a = empBySlackId(state, assigneeSlackId); if (a) t.assignedTo = a.id;
      t.estMinutes = minsN;
      t.tat = Math.max(0.25, Math.round((minsN / 60) * 4) / 4);
      db.save();
    }
  } else {
    const task = createTask(state, {
      title, detail, source: 'call', sourceRef: slackPermalink(row),
      assigneeSlackId, clientName: row.clientName && row.clientName.indexOf('Unknown') !== 0 ? row.clientName : null,
      dueDate: due || null, estMinutes: minsN,
    });
    if (!task) { await dm(payload.user.id, '⏱ That task needs an estimated time to be created.'); return; }
    row.taskId = task.id; db.save();
    await postTaskCard(row, task, assigneeSlackId, payload.user.name || payload.user.id, !pickedAssignee);
  }
}

// Convert to Task message shortcut
async function openConvertModal(payload) {
  const src = deslackifyText((payload.message && payload.message.text) || '').trim();
  const meta = JSON.stringify({ channel: payload.channel.id, ts: payload.message.ts });
  // Slack rejects an empty initial_value — only pre-fill when there's text.
  const descEl = { type: 'plain_text_input', action_id: 'v', multiline: true };
  if (src) descEl.initial_value = src.slice(0, 2900);
  await slack('views.open', {
    trigger_id: payload.trigger_id,
    view: { type: 'modal', callback_id: 'convert_to_task_modal', private_metadata: meta,
      title: { type: 'plain_text', text: 'Convert to Task' }, submit: { type: 'plain_text', text: 'Create Task' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'desc', label: { type: 'plain_text', text: 'Task Description' }, element: descEl },
        { type: 'input', block_id: 'assignee', label: { type: 'plain_text', text: 'Assign To' },
          element: { type: 'users_select', action_id: 'v' } },
        { type: 'input', block_id: 'due', optional: true, label: { type: 'plain_text', text: 'Due Date' },
          element: { type: 'datepicker', action_id: 'v' } },
        { type: 'input', block_id: 'mins', label: { type: 'plain_text', text: 'Estimated Time (minutes) — required' },
          element: { type: 'number_input', action_id: 'v', is_decimal_allowed: false, min_value: '1' } },
      ] },
  });
}
async function submitConvert(payload) {
  const state = db.get();
  const meta = JSON.parse(payload.view.private_metadata || '{}');
  const v = payload.view.state.values;
  const desc = deslackifyText((v.desc && v.desc.v.value) || '');
  const assigneeSlackId = v.assignee && v.assignee.v.selected_user;
  const due = (v.due && v.due.v.selected_date) || '';
  const mins = (v.mins && v.mins.v.value) || '';
  const link = meta.channel && meta.ts ? `https://slack.com/archives/${meta.channel}/p${String(meta.ts).replace('.', '')}` : null;
  if (!(Number(mins) > 0)) { await dm(payload.user.id, '⏱ A task needs an estimated time — reopen “Convert to Task” and add the minutes.'); return; }
  const task = createTask(state, {
    title: (desc.split('\n')[0] || 'Task from Slack').slice(0, 140), detail: desc,
    source: 'slack_message', sourceRef: link, assigneeSlackId, dueDate: due || null, estMinutes: Number(mins),
  });
  if (!task) { await dm(payload.user.id, '⏱ That task needs an estimated time to be created.'); return; }
  db.save();
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `📌 *Task created* — <@${assigneeSlackId}>` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Task:* ${esc(desc, SLACK_TEXT_MAX)}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Task ${task.id} · 🟢 via Governance OS` }] },
    { type: 'divider' }, { type: 'actions', elements: [buttonEl('✅ Mark Done', 'task_done', task.id)] },
  ];
  const posted = await slack('chat.postMessage', { channel: meta.channel, thread_ts: meta.ts, text: `Task created for <@${assigneeSlackId}>`, blocks });
  if (!posted.ok) {
    await slack('chat.postMessage', { channel: assigneeSlackId, text: `📌 You've been assigned a task: ${desc}`, blocks });
  }
}

async function handleInteractivity(payload) {
  const type = payload.type;
  if (type === 'block_actions') {
    const a = payload.actions && payload.actions[0];
    if (!a) return;
    const map = {
      mark_listened: onMarkListened, no_action: onNoAction, self_assign: onSelfAssign,
      task_done: onTaskDone, task_start: onTaskStart, play_recording: onPlayRecording, log_outcome: openLogOutcomeModal,
      task_snooze: onTaskSnooze, task_need_time: onTaskNeedTime,
      kudos_give: openGiveKudosModalSlack, kudos_recommend: openRecommendKudosModalSlack,
    };
    if (map[a.action_id]) await map[a.action_id](payload, a.value);
    else clog('info', 'unhandled block action', { action: a.action_id });
  } else if (type === 'view_submission') {
    const cb = payload.view.callback_id;
    try {
      if (cb === 'log_outcome_modal') await submitLogOutcome(payload);
      else if (cb === 'convert_to_task_modal') await submitConvert(payload);
      else if (cb === 'need_time_modal') await submitNeedTime(payload);
      else if (cb === 'kudos_give_modal') await submitGiveKudosSlack(payload);
      else if (cb === 'kudos_recommend_modal') await submitRecommendKudosSlack(payload);
    } catch (e) {
      clog('error', 'modal submit "' + cb + '" failed: ' + (e && e.stack || e));
      if (payload.user && payload.user.id) {
        await slack('chat.postMessage', { channel: payload.user.id, text: "⚠️ Something went wrong saving that — nothing was created. Try again, or use the task manager directly." });
      }
    }
  } else if (type === 'message_action') {
    if (payload.callback_id === 'convert_to_task') await openConvertModal(payload);
  }
}

// ---------------------------------------------------------------------------
// Founder identity (Slack) — who may see the AI draft
// ---------------------------------------------------------------------------
function founderSlackIds(state) {
  return (state.employees || []).filter(e => e.isFounder && e.slackUserId).map(e => e.slackUserId);
}
function isFounderSlackId(state, sid) {
  if (!sid) return false;
  return founderSlackIds(state).includes(sid) || (process.env.FOUNDER_SLACK_IDS || '').split(',').map(s => s.trim()).includes(sid);
}

// ---------------------------------------------------------------------------
// Gemini — transcribe the recording and draft outcome + action item.
// Result is stored on the call row; it is NEVER shown to staff (founder-only
// modal pre-fill, founder-only App Home section).
// ---------------------------------------------------------------------------
async function generateAiDraft(rowId) {
  const state = db.get();
  const row = findCallByRowId(state, rowId);
  if (!row || !row.recordingUrl) return;
  const key = cfg().geminiApiKey;
  if (!key) return;

  const audio = await httpsRequest(row.recordingUrl);
  // Gemini's inline-data request cap is ~20MB; base64 inflates by ~33%, so
  // keep the raw audio under ~14MB.
  if (audio.status !== 200 || !audio.raw || !audio.raw.length || audio.raw.length > 14 * 1024 * 1024) {
    clog('warn', 'gemini: recording unavailable or too large', { row: rowId, status: audio.status, bytes: audio.raw && audio.raw.length });
    return;
  }
  const prompt =
    'You are assisting a New Zealand tax & accounting firm. Listen to this client phone call and return ONLY minified JSON ' +
    '(no markdown fence) with keys: "outcome" (2-3 sentence summary of what was discussed and decided), ' +
    '"action" (the concrete follow-up task for our team, imperative, one or two lines; empty string if none), ' +
    '"due" (ISO date YYYY-MM-DD if the call implies a deadline, else empty string). Keep it factual.';
  const bodyObj = {
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: audio.headers['content-type'] || 'audio/mpeg', data: audio.raw.toString('base64') } },
    ] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };
  const call = async (model) => {
    const b = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    let rr = await httpsRequest(b + '?key=' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyObj });
    if (rr.status === 401 || rr.status === 403) {
      rr = await httpsRequest(b, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: bodyObj });
    }
    return rr;
  };
  let r = await call(GEMINI_MODEL);
  // Self-heal on model churn: Google's 404 names the replacement model.
  if (r.status === 404 && r.json && r.json.error && r.json.error.message) {
    const m = r.json.error.message.match(/models\/([a-z0-9.\-]+)/i);
    if (m && m[1] && m[1] !== GEMINI_MODEL) { clog('info', 'gemini: retrying with ' + m[1]); r = await call(m[1]); }
  }
  const text = r.json && r.json.candidates && r.json.candidates[0] &&
    r.json.candidates[0].content && r.json.candidates[0].content.parts &&
    r.json.candidates[0].content.parts.map(p => p.text || '').join('');
  if (!text) { clog('warn', 'gemini: no candidate text', { row: rowId, status: r.status, err: r.json && r.json.error && r.json.error.message }); return; }
  let parsed = null;
  try { parsed = JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, '')); } catch (e) {}
  if (!parsed) { clog('warn', 'gemini: unparseable response', { row: rowId }); return; }

  const fresh = db.get();
  const r2 = findCallByRowId(fresh, rowId);
  if (!r2) return;
  r2.aiOutcome = String(parsed.outcome || '').slice(0, 1500);
  r2.aiAction = String(parsed.action || '').slice(0, 1500);
  r2.aiDue = /^\d{4}-\d{2}-\d{2}$/.test(parsed.due || '') ? parsed.due : null;
  db.save();
  clog('info', 'gemini draft stored (founder-only)', { row: rowId, hasAction: !!r2.aiAction });
}

// ---------------------------------------------------------------------------
// App Home tab — per-user view of what needs attention
// ---------------------------------------------------------------------------
// A mandatory call still needs a listen only when it hasn't been resolved
// some other way: nobody's logged an outcome, it wasn't marked "no action",
// AND it hasn't been turned into a task. Once there's a task the person is
// handling it through that — the digest shouldn't keep nagging to listen.
function callNeedsListen(c) {
  return !!c && c.mandatory && c.recordingUrl && !c.listenedBy
    && !c.finalOutcome && !c.taskId && c.status !== 'no_action';
}
function pendingListenCalls(state, { team } = {}) {
  const graceMs = LISTEN_GRACE_HOURS * 3600000;
  return (state.calls || []).filter(c =>
    callNeedsListen(c) &&
    Date.now() - new Date(c.recordingFetchedAt || c.occurredAt).getTime() > graceMs &&
    (!team || c.team === team));
}
function openCallTasksFor(state, empId) {
  return (state.tasks || []).filter(t =>
    t.assignedTo === empId && (t.source === 'call' || t.source === 'slack_message') &&
    t.status !== 'completed' && t.status !== 'cancelled');
}
function overdueIntegrationTasks(state) {
  const today = nzToday();
  return (state.tasks || []).filter(t =>
    (t.source === 'call' || t.source === 'slack_message') && t.status !== 'completed' && t.status !== 'cancelled' &&
    t.internalDeadline && t.internalDeadline < today);
}
function buildHomeView(state, slackUserId) {
  const emp = empBySlackId(state, slackUserId);
  const isFounder = isFounderSlackId(state, slackUserId);
  const myTeams = emp && Array.isArray(emp.memberships) ? emp.memberships.map(m => m.team) : [];
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: '📞 Governance OS — Calls', emoji: true } }];

  let mine = [];
  (state.calls || []).forEach(c => {
    if (!callNeedsListen(c)) return;
    if (isFounder || myTeams.includes(c.team) || agentSlackIds(state, c.agentAircallId).includes(slackUserId)) mine.push(c);
  });
  mine = mine.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt)).slice(0, 15);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🎧 Calls awaiting a listen* (${mine.length})` } });
  if (!mine.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Nothing outstanding. 🎉' }] });
  mine.forEach(c => {
    const link = slackPermalink(c);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `• *${esc(c.clientName || 'Unknown')}* — ${esc(c.team)} · ${esc(c.agentName)} · ${fmtDate(c.occurredAt)}` + (link ? `  <${link}|open>` : '') } });
  });

  blocks.push({ type: 'divider' });
  const tasks = emp ? openCallTasksFor(state, emp.id).slice(0, 15) : [];
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📋 Your open call / Slack tasks* (${tasks.length})` } });
  if (!emp) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Your Slack ID is not linked in the task manager yet — ask an admin to add it.' }] });
  else if (!tasks.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'No open tasks assigned to you.' }] });
  tasks.forEach(t => blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
    `• ${esc(t.name)}${t.internalDeadline ? ` — _due ${fmtDate(t.internalDeadline)}_` : ''}` } }));

  if (isFounder) {
    blocks.push({ type: 'divider' });
    const unlogged = (state.calls || []).filter(c => c.mandatory && c.recordingUrl && !c.finalOutcome && !c.taskId && c.status !== 'no_action').length;
    const overdue = overdueIntegrationTasks(state).length;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🔒 Founder view*\n• ${unlogged} mandatory calls not yet logged\n• ${overdue} call/Slack tasks overdue` } });
  }
  // Kudos — everyone gets "Recommend"; "Give" only shows for whoever has
  // award authority over at least one person (their team's kudos manager,
  // Shubam firm-wide, or superadmin — see canAwardKudosTo).
  blocks.push({ type: 'divider' });
  const recentKudos = (state.kudos || []).slice().sort((a, b) => (b.awardedAt || '').localeCompare(a.awardedAt || '')).slice(0, 3);
  const kudosLines = recentKudos.length
    ? recentKudos.map(k => {
        const to = (state.employees || []).find(e => e.id === k.toId);
        const badge = (KUDOS_LEVELS[k.level] || {}).badge || k.level;
        return `• ${badge} ${esc((to && to.name) || 'someone')}`;
      }).join('\n')
    : '_Nobody yet — be the first to recommend someone._';
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🏆 Kudos*\n${kudosLines}` } });
  const canGiveAny = emp && (state.employees || []).some(e => canAwardKudosTo(emp, e));
  const kudosButtons = [{ type: 'button', text: { type: 'plain_text', text: '👍 Recommend Kudos', emoji: true }, action_id: 'kudos_recommend' }];
  if (canGiveAny) kudosButtons.push({ type: 'button', text: { type: 'plain_text', text: '🏆 Give Kudos', emoji: true }, action_id: 'kudos_give', style: 'primary' });
  if (emp) blocks.push({ type: 'actions', elements: kudosButtons });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Updated ${new Date().toLocaleString('en-NZ', { timeZone: DIGEST_TZ })}` }] });
  return { type: 'home', blocks };
}
async function publishHome(slackUserId) {
  if (!slackUserId) return;
  const view = buildHomeView(db.get(), slackUserId);
  await slack('views.publish', { user_id: slackUserId, view });
}

// ---------------------------------------------------------------------------
// Digest — one channel post, only when something is pending
// ---------------------------------------------------------------------------
async function runDigest(reason) {
  const state = db.get();
  const pending = pendingListenCalls(state);
  const overdue = overdueIntegrationTasks(state);
  if (!pending.length && !overdue.length) { clog('info', 'digest: nothing pending', { reason }); return; }

  const byTeam = {};
  pending.forEach(c => { (byTeam[c.team] = byTeam[c.team] || []).push(c); });
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: '⏰ Call accountability digest', emoji: true } }];

  if (pending.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🎧 ${pending.length} mandatory call${pending.length === 1 ? '' : 's'} still need a listen*` } });
    Object.keys(byTeam).forEach(team => {
      const list = byTeam[team];
      const mentions = [...new Set(list.flatMap(c => agentSlackIds(state, c.agentAircallId)))].map(id => `<@${id}>`).join(' ');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
        (`*${esc(team)}* — ${list.length}  ${mentions}\n` + list.slice(0, 8).map(c => {
          const link = slackPermalink(c);
          return `• ${esc(c.clientName || 'Unknown', 80)} (${fmtDate(c.occurredAt)})` + (link ? ` <${link}|open>` : '');
        }).join('\n')).slice(0, SLACK_TEXT_MAX) } });
    });
  }
  if (overdue.length) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: (`*📋 ${overdue.length} call/Slack task${overdue.length === 1 ? '' : 's'} overdue*\n` +
      overdue.slice(0, 10).map(t => {
        const a = (state.employees || []).find(e => e.id === t.assignedTo);
        const m = a && a.slackUserId ? ` <@${a.slackUserId}>` : (a ? ` _${esc(a.name)}_` : '');
        return `• ${esc(t.name, 120)} — due ${fmtDate(t.internalDeadline)}${m}`;
      }).join('\n')).slice(0, SLACK_TEXT_MAX) } });
  }
  const posted = await slack('chat.postMessage', { channel: cfg().slackChannel, text: '⏰ Call accountability digest', blocks });
  clog('info', 'digest posted', { reason, pending: pending.length, overdue: overdue.length, ok: !!posted.ok });
}

// ---------------------------------------------------------------------------
// Phase 3 — task reminders + escalation ladder
// ---------------------------------------------------------------------------
function nzHour(d) {
  // hourCycle h23 so midnight is "00", not "24" (which some ICU builds emit
  // for hour12:false and would never match a configured digest hour).
  const h = parseInt((d || new Date()).toLocaleString('en-US', { timeZone: DIGEST_TZ, hour: '2-digit', hourCycle: 'h23' }), 10);
  return isNaN(h) ? new Date().getUTCHours() : (h === 24 ? 0 : h);
}
function nzToday(d) { return (d || new Date()).toLocaleDateString('en-CA', { timeZone: DIGEST_TZ }); } // YYYY-MM-DD
// The minute component of NZ wall-clock time — used only to land the Calls
// & Email digest inside a specific ~15-minute window (see the scheduler
// tick), since every other scheduled job here only needs hour precision.
function nzMinute(d) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: DIGEST_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d || new Date());
  const m = parts.find(p => p.type === 'minute');
  return m ? parseInt(m.value, 10) : new Date().getUTCMinutes();
}
function activeAssignedTasks(state) {
  return (state.tasks || []).filter(t => t.assignedTo && !['completed', 'cancelled'].includes(t.status));
}
function isSnoozed(t, today) {
  return !!(t.reminderState && t.reminderState.snoozeUntil && t.reminderState.snoozeUntil >= today);
}
function daysOverdue(t, today) {
  return Math.max(0, Math.round((new Date(today) - new Date(t.internalDeadline)) / 86400000));
}
function empById(state, id) { return (state.employees || []).find(e => e.id === id); }
// Who to escalate an assignee's overdue task to: admins of any team they're
// a member of, plus anyone whose legacy managesIds covers them.
function escalationTargets(state, emp) {
  const teams = Array.isArray(emp.memberships) ? emp.memberships.map(m => m.team) : [];
  const out = new Set();
  (state.employees || []).forEach(e => {
    if (e.id === emp.id || !e.slackUserId) return;
    const isTeamAdmin = Array.isArray(e.memberships) && e.memberships.some(m => m.level === 'admin' && teams.includes(m.team));
    const isLegacyMgr = Array.isArray(e.managesIds) && e.managesIds.includes(emp.id);
    if (isTeamAdmin || isLegacyMgr) out.add(e.slackUserId);
  });
  return [...out];
}
// Calls the CRM's own documented API (Settings > API Docs there) — used to
// write our own record's id back onto the matching CRM row. Never throws;
// the caller decides what a failure means (usually: log it, move on — the
// sync we received already saved, this is just closing the loop back).
async function crmApi(action, fields) {
  const c = cfg();
  if (!c.crmApiKey) return { ok: false, error: 'CRM_API_KEY not set' };
  const r = await httpsRequest(c.crmApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.crmApiKey },
    body: Object.assign({ action }, fields),
  });
  if (r.status !== 200 || !r.json || r.json.ok === false) {
    return { ok: false, error: (r.json && r.json.error) || r.error || ('HTTP ' + r.status) };
  }
  return { ok: true, result: r.json };
}
let _reminderDryRun = false; // toggled by /webhooks/run-reminders?dry=1
async function dm(slackUserId, text, blocks) {
  if (!slackUserId) return { ok: false };
  if (REMINDER_DRY_RUN || _reminderDryRun) { clog('info', 'reminder DRY-RUN → dm', { to: slackUserId, text }); return { ok: true }; }
  return slack('chat.postMessage', { channel: slackUserId, text, blocks });
}
function taskLine(state, t, today, withAssignee) {
  const a = withAssignee ? empById(state, t.assignedTo) : null;
  const who = a ? (a.slackUserId ? ` — <@${a.slackUserId}>` : ` — ${esc(a.name)}`) : '';
  const od = t.internalDeadline && t.internalDeadline < today ? ` · _${daysOverdue(t, today)}d overdue_` : (t.internalDeadline === today ? ' · _today_' : '');
  const src = (t.source && t.source !== 'manual') ? ` · ${t.source === 'call' ? '📞' : '💬'}` : '';
  return `• *${esc(t.name)}*${od}${src}${who}` + (t.sourceRef ? `  <${t.sourceRef}|open>` : '');
}
function reminderButtons(taskId) {
  return { type: 'actions', elements: [
    buttonEl('✅ Done', 'task_done', taskId),
    buttonEl('😴 Snooze 1 day', 'task_snooze', taskId),
    buttonEl('🗓️ Need more time', 'task_need_time', taskId),
  ] };
}

async function runReminders(reason) {
  const state = db.get();
  const manual = reason === 'manual';
  if (!REMINDERS_ON && !manual) return;
  if (!cfg().slackBotToken) return;
  const today = nzToday();
  const now = Date.now();
  state.reminderRun = state.reminderRun || {};
  let sent = 0;

  // A) Daily "what's on your plate" DM — once per assignee per day, at the
  //    configured hour (or immediately on a manual run).
  const digestSlot = today + ':' + REMINDER_DIGEST_HOUR;
  if (manual || (nzHour() === REMINDER_DIGEST_HOUR && state.reminderRun.digestSlot !== digestSlot)) {
    if (!manual) { state.reminderRun.digestSlot = digestSlot; db.save(); } // claim the slot before the slow DM loop, so a crash can't double-send
    const byAssignee = {};
    activeAssignedTasks(state).forEach(t => {
      if (!t.internalDeadline) return;
      if (t.internalDeadline > today) return;           // only due-today / overdue
      if (isSnoozed(t, today)) return;
      (byAssignee[t.assignedTo] = byAssignee[t.assignedTo] || []).push(t);
    });
    for (const empId of Object.keys(byAssignee)) {
      const emp = empById(state, empId);
      if (!emp || !emp.slackUserId) continue;
      if (emp.notifyPrefs && emp.notifyPrefs.channel === 'off') continue;
      const list = byAssignee[empId].sort((a, b) => (a.internalDeadline < b.internalDeadline ? -1 : 1));
      const overdue = list.filter(t => t.internalDeadline < today);
      const dueToday = list.filter(t => t.internalDeadline === today);
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `👋 *Your tasks* — ${overdue.length} overdue, ${dueToday.length} due today` } },
      ];
      const listBlock = (heading, arr) => {
        if (!arr.length) return;
        const shown = arr.slice(0, 20).map(t => taskLine(state, t, today)).join('\n');
        const more = arr.length > 20 ? `\n_…and ${arr.length - 20} more_` : '';
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${heading}*\n${shown}${more}`.slice(0, SLACK_TEXT_MAX) } });
      };
      listBlock('Overdue', overdue);
      listBlock('Due today', dueToday);
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Mark items done in Slack or the task manager · 🟢 Governance OS' }] });
      await dm(emp.slackUserId, `Your tasks — ${overdue.length} overdue, ${dueToday.length} due today`, blocks);
      sent++;
    }
  }

  // B) Overdue escalation ladder — evaluated every tick, advances one rung
  //    per REMINDER_ESCALATE_HOURS.
  for (const t of activeAssignedTasks(state)) {
    if (!t.internalDeadline || t.internalDeadline >= today) continue;
    if (isSnoozed(t, today)) continue;
    const emp = empById(state, t.assignedTo);
    if (!emp || !emp.slackUserId) continue;
    if (emp.notifyPrefs && emp.notifyPrefs.channel === 'off') continue;
    t.reminderState = t.reminderState || { escLevel: 0, escAt: null, snoozeUntil: null };
    const rs = t.reminderState;
    const hoursSince = rs.escAt ? (now - new Date(rs.escAt).getTime()) / 3600000 : Infinity;
    const od = daysOverdue(t, today);

    if (rs.escLevel === 0) {
      rs.escLevel = 1; rs.escAt = new Date().toISOString();
      // P2: the escalation ladder's first assignee chase is also a ledger
      // entry, so the productivity "reminder discipline" factor sees it.
      if (typeof db.logTaskEvent === 'function') db.logTaskEvent(state, t.id, 'reminded', null, { channel: 'slack_escalation', note: `overdue ${od}d` });
      await dm(emp.slackUserId, `⚠️ Overdue: ${t.name}`,
        [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *This task is overdue* (${od}d)\n${taskLine(state, t, today)}` } }, reminderButtons(t.id)]);
      clog('info', 'reminder L1 (assignee)', { task: t.id, od }); sent++;
    } else if (rs.escLevel === 1 && hoursSince >= REMINDER_ESCALATE_HOURS) {
      rs.escLevel = 2; rs.escAt = new Date().toISOString();
      await dm(emp.slackUserId, `⚠️ Still overdue: ${t.name}`,
        [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Still overdue* (${od}d) — your team lead has been notified.\n${taskLine(state, t, today)}` } }, reminderButtons(t.id)]);
      for (const target of escalationTargets(state, emp)) {
        await dm(target, `📣 Overdue task needs attention`,
          [{ type: 'section', text: { type: 'mrkdwn', text: `📣 *${esc(emp.name)}* has a task ${od}d overdue:\n${taskLine(state, t, today, true)}` } }]);
      }
      clog('info', 'reminder L2 (assignee + leads)', { task: t.id, od }); sent++;
    } else if (rs.escLevel === 2 && hoursSince >= REMINDER_ESCALATE_HOURS) {
      rs.escLevel = 3; rs.escAt = new Date().toISOString();
      const note = { type: 'section', text: { type: 'mrkdwn', text: `🚨 *Escalation* — ${od}d overdue, no movement.\n${taskLine(state, t, today, true)}` } };
      for (const f of founderSlackIds(state)) await dm(f, `🚨 Escalation: ${t.name}`, [note]);
      if (REMINDER_MGMT_CHANNEL) await slack('chat.postMessage', { channel: REMINDER_MGMT_CHANNEL, text: `🚨 Overdue escalation: ${t.name}`, blocks: [note] });
      clog('info', 'reminder L3 (founder)', { task: t.id, od }); sent++;
    }
  }

  db.save();
  clog('info', 'reminders run', { reason, sent, remindersOn: REMINDERS_ON, dryRun: REMINDER_DRY_RUN });
  return sent;
}

// Personal morning DM — "still open from yesterday" (missed, needs
// attention) + "due today" (today's work), per person, only sent when
// there's actually something to say. Everyone with open work and a linked
// Slack account gets this, not just whoever's tagged on calls — this is a
// general task-manager feature.
async function runPersonalDigests(reason) {
  const state = db.get();
  const today = nzToday();
  const yesterday = nzToday(new Date(Date.now() - 86400000));
  const line = t => `• ${esc(t.name, 100)}${t.clientName ? ' — ' + esc(t.clientName, 60) : ''}`;
  let sent = 0;
  for (const emp of (state.employees || [])) {
    if (!emp.slackUserId) continue;
    const mine = activeAssignedTasks(state).filter(t => t.assignedTo === emp.id);
    const missedYesterday = mine.filter(t => t.internalDeadline === yesterday);
    const dueToday = mine.filter(t => t.internalDeadline === today);
    if (!missedYesterday.length && !dueToday.length) continue;
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: '🗓️ Your day', emoji: true } }];
    if (missedYesterday.length) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
        (`*⚠️ ${missedYesterday.length} still open from yesterday*\n` + missedYesterday.slice(0, 8).map(line).join('\n')).slice(0, SLACK_TEXT_MAX) } });
    }
    if (dueToday.length) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
        (`*📋 ${dueToday.length} due today*\n` + dueToday.slice(0, 8).map(line).join('\n')).slice(0, SLACK_TEXT_MAX) } });
    }
    await dm(emp.slackUserId,
      `🗓️ Your day: ${missedYesterday.length} still open from yesterday, ${dueToday.length} due today.`, blocks);
    sent++;
  }
  clog('info', 'personal digests sent', { reason, sent });
  return sent;
}

// hourly tick; fires the digest once per DIGEST_HOURS slot per day + the
// reminder pass every tick
let _schedTimer = null;
let _gmailSchedTimer = null;
function startSchedulers() {
  if (_schedTimer) return;
  const tick = async () => {
    try {
      const state = db.get();
      if (!cfg().slackBotToken) return;
      const now = new Date();
      const hr = nzHour(now);
      const dayKey = nzToday(now);
      if (Array.isArray(DIGEST_HOURS) && DIGEST_HOURS.length && cfg().slackChannel) {
        state.connectorDigest = state.connectorDigest || {};
        const slot = dayKey + ':' + hr;
        if (DIGEST_HOURS.includes(hr) && state.connectorDigest.lastSlot !== slot) {
          state.connectorDigest.lastSlot = slot; db.save();
          await runDigest('scheduled ' + slot);
        }
      }
      if (Array.isArray(PERSONAL_DIGEST_HOURS) && PERSONAL_DIGEST_HOURS.length) {
        state.personalDigest = state.personalDigest || {};
        const pslot = dayKey + ':' + hr;
        if (PERSONAL_DIGEST_HOURS.includes(hr) && state.personalDigest.lastSlot !== pslot) {
          state.personalDigest.lastSlot = pslot; db.save();
          await runPersonalDigests('scheduled ' + pslot);
        }
      }
      await runReminders('scheduled ' + dayKey + ':' + hr);
      // Calls & Email WhatsApp digest — once daily, landing close to
      // configured digest hour:45 NZ. Ticks are 10 minutes apart, so a
      // 10-minute-wide window starting exactly at :45 (never earlier)
      // guarantees one tick falls inside it every day without ever firing
      // before :45; lastDay dedupes so only the first tick in that window
      // actually sends. Same {}-then-check-then-save-before-await pattern
      // as the other digests above, so two ticks racing can't double-send.
      const ceCfg = cfg();
      const whatsappReady = ceCfg.whatsappCloudToken && ceCfg.whatsappCloudPhoneNumberId && ceCfg.whatsappCloudRecipients.length;
      const gmailDigestReady = ceCfg.gmailSendServiceAccountJson && ceCfg.gmailDigestFromMailbox && ceCfg.gmailDigestRecipients.length;
      if (whatsappReady || gmailDigestReady) {
        const min = nzMinute(now);
        state.callsEmailsDigest = state.callsEmailsDigest || {};
        if (hr === CALLS_EMAILS_DIGEST_HOUR && min >= 45 && min < 55 && state.callsEmailsDigest.lastDay !== dayKey) {
          state.callsEmailsDigest.lastDay = dayKey; db.save();
          await runCallsEmailsDigest('scheduled ' + dayKey);
        }
      }
    } catch (e) { clog('error', 'scheduler tick threw: ' + (e && e.stack || e)); }
  };
  _schedTimer = setInterval(tick, 10 * 60 * 1000); // every 10 min
  if (_schedTimer.unref) _schedTimer.unref();
  setTimeout(tick, 15000);

  // One look back at recent voicemails shortly after boot (no-op without Aircall),
  // and move old 👍-only replies over to the new "acknowledged, not replied" state.
  setTimeout(() => {
    try { if (reclassifyThumbs(db.get())) db.save(); } catch (e) {}
    cleanVoicemails({ days: 30, max: 150 }).catch(e => clog('error', 'voicemail cleanup threw: ' + (e && e.stack || e)));
  }, 90 * 1000).unref();

  // Automatic marks — look for finished days to judge every 15 minutes (a day is only
  // judged once, from 08:00 NZ the next morning).
  const autoMarksTimer = setInterval(() => { try { runAutoMarks('scheduled'); } catch (e) { clog('error', 'automatic marks threw: ' + (e && e.stack || e)); } }, 15 * 60 * 1000);
  if (autoMarksTimer.unref) autoMarksTimer.unref();
  setTimeout(() => { try { runAutoMarks('startup'); } catch (e) { clog('error', 'automatic marks threw: ' + (e && e.stack || e)); } }, 60 * 1000).unref();

  // CRM client pull — every 15 min, but only once a superadmin has switched it
  // on (after reading a preview). Off by default.
  const crmPullTimer = setInterval(() => {
    try { if (db.get().crmSync && db.get().crmSync.autoPull && cfg().crmApiKey) pullCrmClients({ apply: true }).catch(e => clog('error', 'crm client pull threw: ' + (e && e.stack || e))); } catch (e) {}
  }, 15 * 60 * 1000);
  if (crmPullTimer.unref) crmPullTimer.unref();

  // Gmail poll — a separate timer, deliberately NOT nested inside the tick
  // above (which early-returns without a Slack bot token; Gmail has nothing
  // to do with Slack and shouldn't be gated on it).
  if (cfg().gmailServiceAccountJson || process.env.NODE_ENV !== 'production') {
    const gmailTick = () => { pollAllGmailMailboxes().catch(e => clog('error', 'gmail scheduler tick threw: ' + (e && e.stack || e))); };
    _gmailSchedTimer = setInterval(gmailTick, cfg().gmailPollMinutes * 60 * 1000);
    if (_gmailSchedTimer.unref) _gmailSchedTimer.unref();
    setTimeout(gmailTick, 20000);
  }
  console.log('[connector] schedulers started — digest NZ hours ' + DIGEST_HOURS.join(',') + '; personal digest NZ hours ' + PERSONAL_DIGEST_HOURS.join(',') + '; reminders ' + (REMINDERS_ON ? 'ON' : 'OFF') + (REMINDER_DRY_RUN ? ' (dry-run)' : ''));
}

// ---------------------------------------------------------------------------
// ET-CRM ↔ TASK MANAGER (production contract — see docs/crm-integration.md)
//
// ET-CRM is authoritative for employees, customers, attendance, leave and HR
// policy compliance. The Task Manager is authoritative for TASKS (there is no
// CRM task sync) and keeps productivity, review and Workshop Saturdays.
//
// Five live webhooks (Supabase Database Webhooks, header X-CRM-Webhook-Secret):
//   /webhooks/crm-user        → employees          (crm-apply.js applyUser)
//   /webhooks/crm-customer    → clients            (applyCustomer, then link-back)
//   /webhooks/crm-attendance  → attendance log     (applyAttendance)
//   /webhooks/crm-leave       → leave / capacity   (applyLeave)
//   /webhooks/crm-policy-compliance → see server.js (policy-compliance.js)
// Legacy /webhooks/crm-task is DISABLED (410): tasks are never imported.
//
// Real HTTP statuses: 200 applied · 202 safely skipped/waiting · 400 invalid ·
// 401 bad secret · 409 identity conflict · 500 real failure. A DELETE in ET-CRM
// never deletes history here. Every event and what became of it is recorded in
// state.crmSync (field NAMES only, never values) for Admin → CRM connection.
// ---------------------------------------------------------------------------

// Tell ET-CRM which Task Manager client a contact became (action
// `link-task-manager-client`). ET-CRM refuses to overwrite a DIFFERENT id — that
// comes back as a conflict we report, never retry or force.
async function doLinkBack(link, api) {
  const state = db.get();
  const r = await (api || crmApi)('link-task-manager-client', { id: link.crmContactId, task_manager_client_id: link.clientId });
  const cls = crmSync.classifyLinkBack(r);
  crmSync.record(state, 'linkback', 'LINK', cls.outcome, cls.note, link.crmContactId, null);
  db.save();
  return cls;
}

// What happens AFTER the HTTP answer has gone back: a welcome login on Slack, an
// alert when someone's access was switched off, the link-back to ET-CRM.
async function afterCrmEffects(result) {
  try {
    if (result.welcome) {
      const w = result.welcome;
      if (w.slackUserId) {
        await dm(w.slackUserId,
          `👋 Welcome! A login for *Elite Taxation Governance OS* has been created for you.\n\n*Email:* ${w.email}\n*Temporary password:* \`${w.tempPassword}\`\n\nYou'll be asked to set your own password the first time you log in.`);
      } else {
        clog('warn', 'new crm-synced employee has no Slack — temp password could not be delivered, needs manual handoff', { email: w.email });
      }
    }
    if (result.newlyDisabled) {
      const { notify } = require('./server');
      const state = db.get();
      (state.employees || []).filter(e => e.accessRole === 'superadmin' && !e.accessDisabled).forEach(e => {
        notify(state, e.id, 'crm', `ET-CRM switched off the login of ${result.name || 'an employee'}${result.openTasks ? ' — ' + result.openTasks + ' open task(s) need review' : ''}. Their history is kept and nothing was reassigned.`, null);
      });
      db.save();
    }
    if (result.linkBack) await doLinkBack(result.linkBack);
  } catch (e) { clog('error', 'crm after-effects threw: ' + (e && e.stack || e)); }
}

// One event → one result, applied to the live state. DELETE never deletes history.
function runCrmEvent(kind, ev, state) {
  const deps = { retired: db.RETIRED_EMAILS };
  const del = ev.type === 'DELETE';
  switch (kind) {
    case 'user': return del ? crmApply.applyUserDelete(state, ev.row, deps) : crmApply.applyUser(state, ev.row, deps);
    case 'customer': return del ? crmApply.applyCustomerDelete(state, ev.row) : crmApply.applyCustomer(state, ev.row, deps);
    case 'attendance': return del
      ? { http: 202, outcome: 'skipped', note: 'deleted in ET-CRM — attendance history is kept', crmId: crmSync.mapAttendance(ev.row).crmAttendanceId }
      : crmApply.applyAttendance(state, ev.row, deps);
    case 'leave': return del ? crmApply.applyLeaveDelete(state, ev.row, deps) : crmApply.applyLeave(state, ev.row, deps);
    default: return { http: 400, outcome: 'invalid', note: 'unknown webhook' };
  }
}

// list-pipeline's paging isn't documented to us. If the first answer is a round
// number (a typical page size), try the usual ways of asking for more — each is
// a harmless read — and keep whichever returns contacts we haven't seen.
async function fetchCrmContacts() {
  const first = await crmApi('list-pipeline', {});
  if (!first.ok) return { ok: false, error: first.error };
  const firstRows = crmSync.extractList(first.result);
  if (!firstRows) return { ok: true, rows: null, raw: first.result };
  const idOf = r => (r && r.id != null ? String(r.id) : null);
  const info = { pages: 1, how: [], mayBeIncomplete: false };
  const rows = firstRows.slice();
  const seen = new Set(rows.map(idOf));
  const ROUND = [20, 25, 30, 50, 100, 200, 250, 500, 1000];
  const fresh = async (params) => {
    const r = await crmApi('list-pipeline', params);
    const got = r.ok ? crmSync.extractList(r.result) : null;
    return got ? got.filter(x => idOf(x) && !seen.has(idOf(x))) : [];
  };
  const take = more => more.forEach(x => { seen.add(idOf(x)); rows.push(x); });
  if (rows.length >= 20 && ROUND.includes(rows.length)) {
    // 1. a bigger page size (a CRM often caps it — 200 here — so this is only a first step)
    const big = await fresh({ limit: 1000 });
    if (big.length) { take(big); info.how.push('limit'); info.pages++; }
    // 2. still a round number? keep going by offset, else by page number
    if (ROUND.includes(rows.length)) {
      const size = rows.length;
      const modes = [
        { how: 'offset', params: n => ({ offset: n * size, limit: size }) },
        { how: 'offset', params: n => ({ offset: n * size }) },
        { how: 'page', params: n => ({ page: n + 1, limit: size }) },
        { how: 'page', params: n => ({ page: n + 1 }) },
      ];
      let worked = false;
      for (const m of modes) {
        const more = await fresh(m.params(1));
        if (!more.length) continue;
        worked = true; info.how.push(m.how);
        take(more); info.pages++;
        for (let n = 2; n < 60; n++) {
          const next = await fresh(m.params(n));
          if (!next.length) break;
          take(next); info.pages++;
        }
        if (info.pages >= 60) info.mayBeIncomplete = true;
        break;
      }
      if (!worked) info.mayBeIncomplete = true; // a round number and no way past it
    }
  }
  info.how = [...new Set(info.how)].join(' + ') || null;
  return { ok: true, rows, info };
}

// Customers — REPAIR / RECONCILIATION. The webhook is the real-time path; this
// reads ET-CRM's contact list (action `list-pipeline`) and runs every contact
// through the SAME applyCustomer rule, so the two can never disagree. A preview
// (apply = false) runs on a copy and changes nothing.
async function pullCrmClients(opts) {
  const apply = !!(opts && opts.apply);
  const state = db.get();
  const sync = state.crmSync = state.crmSync || { events: [], counts: {} };
  const res = { at: new Date().toISOString(), mode: apply ? 'apply' : 'preview', ok: false };
  const finish = (note, outcome) => {
    const { samples, ...stored } = res; // names are shown once, never kept
    sync.pull = stored;
    crmSync.record(state, 'pull', res.mode, outcome, note, null, res.fieldNames || null);
    db.save();
    return res;
  };
  const got = await fetchCrmContacts();
  if (!got.ok) { res.error = got.error; return finish('could not fetch: ' + got.error, 'error'); }
  const rows = got.rows;
  if (!rows) {
    res.error = 'ET-CRM answered, but no list of contacts was found in the reply.';
    res.fieldNames = Object.keys(got.raw || {});
    return finish(res.error, 'error');
  }
  res.received = rows.length;
  res.paging = got.info;
  res.maybeTruncated = !!got.info.mayBeIncomplete;
  const names = new Set();
  rows.slice(0, 25).forEach(x => Object.keys(x || {}).forEach(k => names.add(k)));
  res.fieldNames = [...names].slice(0, 40);
  res.rule = crmSync.describeEligibility(sync.eligibility);

  const work = apply ? state : { clients: JSON.parse(JSON.stringify(state.clients || [])), employees: state.employees, crmSync: sync };
  const tally = { alreadyLinked: 0, linkable: 0, ambiguous: 0, conflicts: 0, toCreate: 0, notClients: 0, noId: 0, created: 0, linked: 0, updated: 0 };
  const evidence = { authoritySigned: 0, pbqDone: 0, both: 0 };
  const values = { status: {}, lead: {}, onboarding: {} };
  res.samples = { link: [], create: [], ambiguous: [], conflict: [] };
  const linkBacks = [];
  for (const row of rows) {
    const c = crmSync.mapContact(row);
    if (c.authoritySigned) evidence.authoritySigned++;
    if (c.pbqDone) evidence.pbqDone++;
    if (c.authoritySigned && c.pbqDone) evidence.both++;
    Object.keys(values).forEach(k => { const v = c.stages[k] || '(none)'; values[k][v] = (values[k][v] || 0) + 1; });
    const r = crmApply.applyCustomer(work, row, {});
    const label = c.name || c.id;
    if (r.outcome === 'invalid') tally.noId++;
    else if (r.outcome === 'ambiguous') { tally.ambiguous++; if (res.samples.ambiguous.length < 10) res.samples.ambiguous.push(label); }
    else if (r.outcome === 'conflict') { tally.conflicts++; if (res.samples.conflict.length < 10) res.samples.conflict.push(label + ' — ' + r.note); }
    else if (r.outcome === 'created') { tally.toCreate++; if (res.samples.create.length < 10) res.samples.create.push(label); }
    else if (r.outcome === 'updated' && /linked \(matched/.test(r.note)) { tally.linkable++; if (res.samples.link.length < 10) res.samples.link.push(label + ' → ' + r.note); }
    else if (r.outcome === 'updated') tally.alreadyLinked++;
    else if (/^not a working client/.test(r.note)) tally.notClients++;
    else tally.alreadyLinked++;
    if (apply && r.linkBack && linkBacks.length < 200) linkBacks.push(r.linkBack);
  }
  if (apply) { tally.created = tally.toCreate; tally.linked = tally.linkable; }
  res.evidence = evidence;
  res.values = values;
  Object.assign(res, tally);
  res.ok = true;
  const note = apply
    ? `linked ${tally.linked}, added ${tally.created} of ${rows.length} contacts (rule: ${res.rule})`
    : `preview of ${rows.length} contacts: ${tally.linkable} to link, ${tally.toCreate} to add, ${tally.ambiguous} unclear, ${tally.conflicts} conflicts`;
  finish(note, 'updated');
  // Close the loop in ET-CRM for what was linked or created. Best-effort and
  // capped per run; ET-CRM keeps its own conflict protection.
  for (const lb of linkBacks) await doLinkBack(lb);
  return res;
}

// Look back over recent "ended" calls and flag any that Aircall says were
// voicemails — takes their Slack card down and removes them from the totals.
// Safe to repeat: a call that has been checked is never checked again, and a
// call Aircall could not be asked about is simply tried next time.
async function cleanVoicemails(opts) {
  if (!cfg().aircallApiToken) return { ok: false, error: 'Aircall is not configured.' };
  const state = db.get();
  const days = (opts && opts.days) || 30, max = (opts && opts.max) || 150;
  const cutoff = Date.now() - days * 86400000;
  const todo = (state.calls || []).filter(c => c.status === 'ended' && !c.voicemail && !c.vmChecked && !c.stub && c.aircallId
    && c.occurredAt && new Date(c.occurredAt).getTime() >= cutoff);
  const batch = todo.slice(-max);
  let checked = 0, flagged = 0, failed = 0;
  for (const row of batch) {
    let call = null;
    try { call = await fetchAircallCall(row.aircallId); } catch (e) { call = null; }
    if (!call) { failed++; continue; }
    checked++; row.vmChecked = true;
    if (isVoicemail(call)) { await markVoicemail(state, row); flagged++; }
  }
  db.save();
  clog('info', 'voicemail cleanup', { checked, flagged, failed, left: todo.length - batch.length });
  return { ok: true, checked, flagged, failed, left: todo.length - batch.length };
}

// ---------------------------------------------------------------------------
// RECONCILIATION — safe to rerun, previewable. The webhooks are the real-time
// path; these repair drift. Without an ET-CRM list action for a thing, the
// local half still runs (audit + replay of what was waiting) and the remote
// half says plainly that ET-CRM does not offer it.
// ---------------------------------------------------------------------------
const RECONCILE_LIST_ACTIONS = { employees: 'list-users', attendance: 'list-attendance', leave: 'list-leave' };
async function reconcileCrm(kind, opts) {
  const apply = !!(opts && opts.apply);
  const state = db.get();
  if (kind === 'customers') return { kind, mode: apply ? 'apply' : 'preview', ...(await pullCrmClients({ apply })) };
  const out = { kind, mode: apply ? 'apply' : 'preview', at: new Date().toISOString(), local: {}, remote: { available: false } };
  const emps = state.employees || [];

  if (kind === 'policy') {
    const linked = emps.filter(e => e.crmUserId);
    const stale = linked.filter(e => policyCompliance.isStale(e));
    out.local = { linked: linked.length, unlinked: emps.length - linked.length, stale: stale.length, blockedNow: emps.filter(e => e.accessRole === 'employee' && policyCompliance.isBlocked(e)).length };
    if (apply) {
      let ok = 0, failed = 0, skipped = 0;
      for (const e of linked.slice(0, 100)) {
        const r = await policyCompliance.reconcileEmployee(e);
        if (r.ok) ok++; else if (r.skipped) skipped++; else failed++;
      }
      out.remote = { available: true, checked: ok + failed + skipped, ok, failed, skipped };
      crmSync.record(state, 'policy', 'RECONCILE', failed ? 'error' : 'updated', `reconciled ${ok} of ${linked.length} linked employees (${failed} failed)`, null, null);
      db.save();
    } else {
      out.remote = { available: true, wouldCheck: Math.min(linked.length, 100) };
    }
    return out;
  }

  // local audit (always)
  if (kind === 'employees') {
    const counts = {};
    emps.forEach(e => { if (e.crmUserId) counts[e.crmUserId] = (counts[e.crmUserId] || 0) + 1; });
    out.local = {
      linked: emps.filter(e => e.crmUserId).length,
      unlinked: emps.filter(e => !e.crmUserId).map(e => e.name),
      duplicateCrmIds: Object.keys(counts).filter(k => counts[k] > 1),
      disabledByCrm: emps.filter(e => e.accessDisabled && e.accessDisabled.by === 'crm').map(e => e.name),
    };
  } else {
    // replay anything waiting for a person who has since become resolvable
    const waiting = crmSync.unlinkedList(state).filter(e => e.kinds && e.kinds[kind]);
    let replayed = 0;
    for (const w of waiting) {
      const entry = (state.crmSync.unlinked || {})[w.key];
      if (!entry || !w.crmUserId) continue;
      const who = crmApply.resolveEmployee(state, { crmUserId: w.crmUserId, email: w.email });
      if (!who.employee) continue;
      if (apply) {
        const taken = crmSync.takeUnlinked(state, w.key);
        (taken.pending || []).forEach(p => { (p.kind === 'attendance' ? crmApply.applyAttendanceMapped : crmApply.applyLeaveMapped)(state, p.row, {}); replayed++; });
      } else replayed += (entry.pending || []).length;
    }
    out.local = { waitingPeople: waiting.length, replayable: replayed };
  }

  // remote half (only if ET-CRM offers a list action)
  const action = RECONCILE_LIST_ACTIONS[kind];
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const r = await crmApi(action, kind === 'employees' ? {} : { from });
  if (!r.ok) {
    out.remote = { available: false, action, note: /unknown|not supported|invalid action/i.test(String(r.error)) ? 'ET-CRM does not offer ' + action + ' yet — local checks only' : 'could not reach ET-CRM: ' + r.error };
  } else {
    const rows = crmSync.extractList(r.result) || [];
    const work = apply ? state : JSON.parse(JSON.stringify(state));
    const t = { created: 0, updated: 0, skipped: 0, unlinked: 0, ambiguous: 0, conflict: 0, invalid: 0 };
    const fn = { employees: crmApply.applyUser, attendance: crmApply.applyAttendance, leave: crmApply.applyLeave }[kind];
    rows.forEach(row => { const x = fn(work, row, { retired: db.RETIRED_EMAILS }); t[x.outcome] = (t[x.outcome] || 0) + 1; });
    out.remote = { available: true, action, received: rows.length, ...t };
  }
  if (apply) {
    crmSync.record(state, kind === 'employees' ? 'user' : kind, 'RECONCILE', 'updated', 'reconciliation run', null, null);
    db.save();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function mountConnector(app) {
  app.get('/webhooks/health', (req, res) => {
    const c = cfg();
    res.json({
      ok: true,
      configured: {
        slackBotToken: !!c.slackBotToken, slackSigningSecret: !!c.slackSigningSecret,
        slackChannel: !!c.slackChannel, slackTeamId: !!c.slackTeamId,
        aircall: !!(c.aircallApiId && c.aircallApiToken), aircallWebhookToken: !!c.aircallWebhookToken,
        gemini: !!c.geminiApiKey,
        interaktWebhookSecret: !!c.interaktWebhookSecret, interaktApiKey: !!c.interaktApiKey, interaktChannel: !!c.interaktChannel,
      },
      gmail: {
        configured: !!c.gmailServiceAccountJson,
        mode: c.gmailServiceAccountJson ? 'live' : 'fixture',
        mailboxes: (db.get().employees || []).reduce((n, e) => n + (e.gmailAddresses || []).length, 0),
        emails: (db.get().emails || []).length,
        pollMinutes: c.gmailPollMinutes,
      },
      whatsappCloud: {
        configured: !!(c.whatsappCloudToken && c.whatsappCloudPhoneNumberId),
        recipients: c.whatsappCloudRecipients.length,
        templateName: c.whatsappCloudTemplateName,
      },
      gmailDigest: {
        configured: !!(c.gmailSendServiceAccountJson && c.gmailDigestFromMailbox && c.gmailDigestRecipients.length),
        fromMailbox: c.gmailDigestFromMailbox || null,
        recipients: c.gmailDigestRecipients.length,
      },
      callsEmailDigestHourNZ: CALLS_EMAILS_DIGEST_HOUR,
      callsEmailDigestLastDaySent: (db.get().callsEmailsDigest || {}).lastDay || null,
      crmPolicyCompliance: { webhookConfigured: !!c.crmWebhookSecret, apiFallbackConfigured: !!(process.env.CRM_API_URL && process.env.CRM_API_KEY) },
      calls: (db.get().calls || []).length,
      waContacts: Object.keys(db.get().waContacts || {}).length,
      waAwaiting: Object.values(db.get().waContacts || {}).filter(c => c.status === 'awaiting').length,
      digestHoursNZ: DIGEST_HOURS,
      pendingListens: pendingListenCalls(db.get()).length,
      reminders: { enabled: REMINDERS_ON, dryRun: REMINDER_DRY_RUN, digestHourNZ: REMINDER_DIGEST_HOUR, escalateHours: REMINDER_ESCALATE_HOURS,
        envSeen: process.env.REMINDERS_ENABLED === undefined ? '(not set)' : JSON.stringify(process.env.REMINDERS_ENABLED) },
      // Fingerprints only (never the secret) — to diff against expected during a rotation.
      fp: {
        aircallWebhookToken: c.aircallWebhookToken ? { len: c.aircallWebhookToken.length, sha: crypto.createHash('sha256').update(c.aircallWebhookToken).digest('hex').slice(0, 12) } : null,
        slackSigningSecret: c.slackSigningSecret ? { len: c.slackSigningSecret.length, sha: crypto.createHash('sha256').update(c.slackSigningSecret).digest('hex').slice(0, 12) } : null,
      },
    });
  });

  // Diagnostic log — token-gated (same shared secret as the Aircall hook).
  app.get('/webhooks/log', (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    const state = db.get();
    const n = Math.min(parseInt(req.query.n, 10) || 60, 400);
    res.json({
      log: (state.connectorLog || []).slice(-n),
      calls: (state.calls || []).slice(-15).map(c => ({
        id: c.id, aircallId: c.aircallId, team: c.team, agent: c.agentName, client: c.clientName,
        status: c.status, recording: !!c.recordingUrl, listenedBy: c.listenedBy, taskId: c.taskId,
        slackTs: c.slackTs, occurredAt: c.occurredAt,
      })),
    });
  });

  // Roster — read current employees + teams, or set memberships / founder /
  // aircall id in bulk. Token-gated.
  //   GET  → { teams, employees:[{name,email,slackUserId,isFounder,aircallAgentId,memberships}] }
  //   POST { set: { "<email>": { memberships:[{team,level}], isFounder, aircallAgentId } } }
  //        ?dry=1 previews; unknown team names are created.
  app.get('/webhooks/roster', (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    const state = db.get();
    res.json({
      teams: (state.teams || []).map(t => t.name),
      employees: (state.employees || []).map(e => ({
        name: e.name, email: e.email || null, slackUserId: e.slackUserId || null,
        isFounder: !!e.isFounder, aircallAgentId: e.aircallAgentId || null,
        memberships: e.memberships || [], accessRole: e.accessRole || null, team: e.team || null,
      })),
    });
  });
  app.post('/webhooks/roster', (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    const state = db.get();
    const dry = req.query.dry === '1';
    const set = (req.body && req.body.set) || {};
    const known = new Set((state.teams || []).map(t => t.name.toLowerCase()));
    const applied = [], notFound = [], teamsCreated = [];
    for (const rawEmail of Object.keys(set)) {
      const email = rawEmail.toLowerCase();
      const emp = (state.employees || []).find(e => e.email && e.email.toLowerCase() === email);
      if (!emp) { notFound.push(rawEmail); continue; }
      const spec = set[rawEmail] || {};
      if (Array.isArray(spec.memberships)) {
        for (const m of spec.memberships) {
          if (m && m.team && !known.has(String(m.team).toLowerCase())) {
            known.add(String(m.team).toLowerCase()); teamsCreated.push(m.team);
            if (!dry) { state.teams = state.teams || []; state.teams.push({ id: 't-' + String(m.team).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36), name: m.team, createdAt: Date.now() }); }
          }
        }
        if (!dry) emp.memberships = spec.memberships.filter(m => m && m.team && ['member', 'admin'].includes(m.level)).map(m => ({ team: m.team, level: m.level }));
      }
      if (typeof spec.isFounder === 'boolean' && !dry) emp.isFounder = spec.isFounder;
      if (spec.aircallAgentId !== undefined && !dry) emp.aircallAgentId = spec.aircallAgentId ? String(spec.aircallAgentId) : null;
      applied.push({ name: emp.name, email: emp.email, memberships: spec.memberships || emp.memberships, isFounder: spec.isFounder !== undefined ? spec.isFounder : emp.isFounder });
    }
    if (!dry && (applied.length || teamsCreated.length)) db.save();
    clog('info', 'roster set', { dry, applied: applied.length, notFound: notFound.length, teamsCreated });
    res.json({ ok: true, dryRun: dry, applied, notFound, teamsCreated, teamsNow: (state.teams || []).map(t => t.name) });
  });

  // Backfill employees' slackUserId. Token-gated. Matches Slack profile
  // emails to employee emails; a body { overrides: { "<employee email>":
  // "<slack id>" } } fills the rest (Slack profiles here mostly use personal
  // gmail). ?dry=1 previews; ?overwrite=1 replaces IDs already set.
  app.post('/webhooks/backfill-slack-ids', async (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    try {
      const dry = req.query.dry === '1';
      const overwrite = req.query.overwrite === '1';
      const overrides = (req.body && req.body.overrides) || {};
      const byEmail = {};
      Object.keys(overrides).forEach(k => { if (overrides[k]) byEmail[k.toLowerCase()] = String(overrides[k]); });
      const directory = [];
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const r = await slack('users.list', { limit: 200, cursor: cursor || undefined });
        if (!r.ok) return res.status(502).json({ error: 'users.list failed: ' + (r.error || '?') + (r.error === 'missing_scope' ? ' — add users:read + users:read.email scopes and reinstall the app' : '') });
        (r.members || []).forEach(m => {
          if (m.deleted || m.is_bot || m.id === 'USLACKBOT') return;
          const em = m.profile && m.profile.email;
          directory.push({ id: m.id, name: m.profile && (m.profile.real_name || m.profile.display_name) || m.name, email: em || null });
          if (em && !byEmail[em.toLowerCase()]) byEmail[em.toLowerCase()] = m.id; // overrides win
        });
        cursor = r.response_metadata && r.response_metadata.next_cursor;
        if (!cursor) break;
      }
      const state = db.get();
      const matched = [], unmatched = [], skipped = [];
      (state.employees || []).forEach(e => {
        const hit = e.email && byEmail[e.email.toLowerCase()];
        if (!hit) { unmatched.push({ name: e.name, email: e.email || null }); return; }
        if (e.slackUserId && !overwrite) { skipped.push({ name: e.name, slackUserId: e.slackUserId }); return; }
        matched.push({ name: e.name, email: e.email, slackUserId: hit, was: e.slackUserId || null });
        if (!dry) e.slackUserId = hit;
      });
      if (!dry && matched.length) db.save();
      clog('info', 'backfill-slack-ids', { dry, matched: matched.length, unmatched: unmatched.length, skipped: skipped.length });
      res.json({ ok: true, dryRun: dry, slackUsersWithEmail: Object.keys(byEmail).length, matched, alreadySet: skipped, unmatched,
        slackDirectory: (req.query.dir === '1' ? directory.sort((a, b) => String(a.name).localeCompare(String(b.name))) : undefined) });
    } catch (e) { clog('error', 'backfill-slack-ids threw: ' + e); res.status(500).json({ error: String(e) }); }
  });

  app.post('/webhooks/aircall', (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) { clog('warn', 'aircall rejected', { why: v.why }); return res.status(401).send('unauthorized'); }
    res.status(200).send('ok'); // ack immediately; process after
    const event = req.body && req.body.event;
    const call = (req.body && req.body.data) || {};
    clog('info', 'aircall webhook in', { event, callId: call && call.id, hasRecording: !!(call && (call.recording || (call.asset && call.asset.url) || call.voicemail)) });
    (async () => {
      try {
        if (event === 'call.ended') await handleCallEnded(call);
        else if (event === 'call.comm_assets_generated' || event === 'call.recording_generated') await handleRecordingReady(call);
        else clog('info', 'aircall event ignored', { event });
      } catch (e) { clog('error', 'aircall handler threw: ' + (e && e.stack || e)); }
    })();
  });

  // Interakt (WhatsApp Business API). Point Interakt's webhook config at
  // https://<your-railway-domain>/webhooks/interakt and set
  // INTERAKT_WEBHOOK_SECRET to the secret key Interakt gives you for it.
  // Interakt requires a 200 within 3s, so this acks immediately and does the
  // real work after — same pattern as the Aircall hook.
  app.post('/webhooks/interakt', (req, res) => {
    const v = verifyInterakt(req);
    if (!v.ok) { clog('warn', 'interakt webhook rejected', { why: v.why }); return res.status(401).json({ error: v.why }); }
    res.status(200).json({ ok: true });
    handleInteraktWebhook(req.body).catch(e => clog('error', 'interakt handler threw: ' + (e && e.stack || e)));
  });

  app.post('/webhooks/slack/events', (req, res) => {
    if (req.body && req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });
    const v = verifySlack(req);
    if (!v.ok) { clog('warn', 'slack event rejected', { why: v.why }); return res.status(401).send('bad signature'); }
    if (!slackPayloadIsOurs(req.body)) return res.status(200).send('ignored');
    res.status(200).send('ok');
    const ev = req.body && req.body.event;
    (async () => {
      try {
        if (ev && ev.type === 'app_home_opened' && ev.tab === 'home') await publishHome(ev.user);
        else clog('info', 'slack event', { type: ev && ev.type });
      } catch (e) { clog('error', 'slack event handler threw: ' + (e && e.stack || e)); }
    })();
  });

  app.post('/webhooks/slack/interactivity', (req, res) => {
    const v = verifySlack(req);
    if (!v.ok) { clog('warn', 'slack interactivity rejected', { why: v.why }); return res.status(401).send('bad signature'); }
    let payload = {};
    try { payload = JSON.parse((req.body && req.body.payload) || '{}'); } catch (e) { return res.status(400).send('bad payload'); }
    if (!slackPayloadIsOurs(payload)) return res.status(200).send('');
    res.status(200).send(''); // ack within Slack's 3s; do the work after
    (async () => {
      try { await handleInteractivity(payload); }
      catch (e) { clog('error', 'interactivity handler threw: ' + (e && e.stack || e)); }
    })();
  });

  // Manual triggers, for testing — same shared secret as the Aircall hook.
  app.post('/webhooks/run-digest', (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    runDigest('manual').catch(e => clog('error', 'manual digest threw: ' + e));
    res.json({ ok: true, triggered: true });
  });
  app.post('/webhooks/run-personal-digest', async (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    try { res.json({ ok: true, sent: await runPersonalDigests('manual') }); }
    catch (e) { clog('error', 'manual personal digest threw: ' + e); res.status(500).json({ error: String(e) }); }
  });
  // A manual reminder run always executes (even with REMINDERS_ENABLED unset),
  // so add ?dry=1 the first time to see what it WOULD send without DMing anyone.
  app.post('/webhooks/run-reminders', async (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    const dry = req.query.dry === '1';
    if (dry) _reminderDryRun = true;
    try {
      const sent = await runReminders('manual');
      res.json({ ok: true, actions: sent, dryRun: dry || REMINDER_DRY_RUN });
    } catch (e) { clog('error', 'manual reminders threw: ' + e); res.status(500).json({ error: String(e) }); }
    finally { if (dry) _reminderDryRun = false; }
  });
  // Manual trigger for the Calls & Email WhatsApp digest — same shared
  // secret as the others. ?preview=1 returns the computed report text
  // without actually sending it, for checking the format/numbers before
  // wiring up real recipients.
  app.post('/webhooks/run-calls-email-digest', async (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    try {
      if (req.query.preview === '1') {
        const day = req.query.day || nzToday(new Date());
        const data = callsEmailsDigestData(db.get(), day);
        return res.json({ ok: true, preview: true, text: formatCallsEmailsDigestText(data), data });
      }
      res.json({ ok: true, ...(await runCallsEmailsDigest('manual')) });
    } catch (e) { clog('error', 'manual calls/email digest threw: ' + e); res.status(500).json({ error: String(e) }); }
  });

  // ET-CRM webhooks — all need X-CRM-Webhook-Secret (constant-time compare) and
  // answer with the REAL outcome (see the block comment above runCrmEvent).
  const crmRoute = (kind) => app.post('/webhooks/crm-' + kind, async (req, res) => {
    const v = verifyCrm(req);
    if (!v.ok) {
      try { crmSync.record(db.get(), kind, '—', 'error', 'rejected: ' + v.why, null, null); db.save(); } catch (e) {}
      clog('warn', 'crm-' + kind + ' webhook rejected', { why: v.why });
      return res.status(401).json({ error: v.why });
    }
    const ev = crmSync.normalizeEvent(req.body);
    const state = db.get();
    if (!ev.row || typeof ev.row !== 'object' || Array.isArray(ev.row)) {
      crmSync.record(state, kind, ev.type, 'invalid', 'the payload has no record', null, null); db.save();
      return res.status(400).json({ ok: false, outcome: 'invalid', error: 'The payload has no record.' });
    }
    const keys = Object.keys(ev.row);
    try {
      const result = runCrmEvent(kind, ev, state);
      crmSync.record(state, kind, ev.type, result.outcome, result.note, result.crmId, keys);
      db.save();
      res.status(result.http).json({ ok: result.http < 300, outcome: result.outcome, note: result.note });
      afterCrmEffects(result); // after the answer, so a slow Slack/ET-CRM call never delays the webhook
    } catch (e) {
      try { crmSync.record(state, kind, ev.type, 'error', 'processing failed: ' + String(e && e.message || e), null, keys); db.save(); } catch (e2) {}
      clog('error', 'crm-' + kind + ' handler threw: ' + (e && e.stack || e));
      res.status(500).json({ ok: false, outcome: 'error', error: 'Processing failed.' });
    }
  });
  ['user', 'customer', 'attendance', 'leave'].forEach(crmRoute);
  // LEGACY — ET-CRM's own task management is decommissioned and the Task
  // Manager is the permanent source of truth for tasks. Nothing is imported;
  // the call is refused so a leftover webhook is visible rather than silent.
  app.post('/webhooks/crm-task', (req, res) => {
    const v = verifyCrm(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    try { crmSync.record(db.get(), 'task', '—', 'skipped', 'legacy CRM task sync is disabled — nothing imported', null, null); db.save(); } catch (e) {}
    res.status(410).json({ ok: false, deprecated: true, error: 'CRM task sync is disabled. The Task Manager owns tasks; remove this webhook in ET-CRM.' });
  });

  startSchedulers();
  console.log('[connector] routes mounted: /webhooks/{aircall,interakt,slack/events,slack/interactivity,crm-user,crm-customer,crm-attendance,crm-leave,crm-task(disabled),run-digest,run-personal-digest,run-reminders,run-calls-email-digest,log,health}');
}

module.exports = {
  mountConnector, relayWaToSlack, prettyWaText, callStatsForSlackId, allCallsReport,
  awardKudos, recommendKudos, resolveKudosRecommendation, canAwardKudosTo, kudosManagerEmailFor, KUDOS_LEVELS,
  emailStatsForEmployee, allEmailsReport, pollGmailMailbox, pollAllGmailMailboxes,
  runAutoMarks, previewAutoMarksDay, pullCrmClients, reconcileCrm, doLinkBack, cleanVoicemails, reclassifyThumbs, agentRouting, awardPoints, reactToPoints, deleteKudos, deletePoints,
  callsEmailsDigestData, callsEmailsStats, callsEmailsDetail, formatCallsEmailsDigestText, formatCallsEmailsDigestHtml, runCallsEmailsDigest,
};
