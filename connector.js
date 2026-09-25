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
const db = require('./db');
const cal = require('./calendar');

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
  // Supabase Edge Function; CRM_API_KEY needs `update-contact` permission.
  crmApiUrl: process.env.CRM_API_URL || 'https://ceqqphhqjqyfxxmaaglw.supabase.co/functions/v1/crm-api',
  crmApiKey: process.env.CRM_API_KEY || '',
});

// Agent → team routing. Mirrors the Apps Script AGENT_MAP. slackIds = who to
// @-mention on the card and who the pending digest nags (mandatory teams).
// A later phase can read this from employees' aircallAgentId + team config.
//
// `name`/`team` stay the real Aircall agent (Shubam/Parvinder/Disha still
// took the call, on record) — only slackIds changes, to whoever's actually
// doing the listening now. Deliberately not giving Diksha/Khushi/Manya
// their own AGENT_MAP entries — they don't take calls themselves, they
// just need the same per-call ping + end-of-day "still unlistened" nag
// their senior's calls already generate, without a whole separate agent
// identity cluttering the call notifier.
const AGENT_MAP = {
  '1660428': { name: 'Shubam Sharma',   team: 'Leads',              mandatory: true,  slackIds: ['U0BNTB31KBP'] }, // Diksha
  '1682239': { name: 'Parvinder Kumar', team: 'Companies',          mandatory: true,  slackIds: ['U0BNFGKDWDV'] }, // Manya (was already this id)
  '1674408': { name: 'Anjana Pandey',   team: 'Rideshare + Rental', mandatory: false, slackIds: [] }, // nobody listens to these — no tag, no nag
  '1937711': { name: 'Disha Chaudhary', team: 'Rideshare + Rental', mandatory: true,  slackIds: ['U0BNQHX4F4K'] }, // Khushi
};
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
function isVoicemail(call) { return !!call.voicemail || call.missed_call_reason === 'voicemail'; }
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
async function freshRecordingUrl(aircallId) {
  const r = await httpsRequest('https://api.aircall.io/v1/calls/' + encodeURIComponent(aircallId), {
    headers: { Authorization: aircallAuthHeader() },
  });
  const call = r.json && r.json.call;
  if (!call) return null;
  return call.recording || (call.asset && call.asset.url) || call.voicemail || null;
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
  const mentions = (AGENT_MAP[row.agentAircallId] ? AGENT_MAP[row.agentAircallId].slackIds : []).map(id => `<@${id}>`).join(' ');
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
    call.voicemail || null;
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
  const routing = agentId ? AGENT_MAP[agentId] : null;
  const callerPhone = normalizeNumber(call.raw_digits || '');
  const unanswered = isUnanswered(call);
  const vm = isVoicemail(call);
  const status = unanswered ? 'not_picked_up' : (vm ? 'voicemail' : 'ended');

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
    mandatory: routing ? !!routing.mandatory : false, status,
  };

  let row;
  if (existing && existing.stub) {
    Object.assign(existing, base, { stub: false });
    if (existing.recordingUrl && status === 'ended') existing.status = 'ended';
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
    const url = await freshRecordingUrl(aircallId);
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
      recordingUrl: url, recordingFetchedAt: new Date().toISOString(),
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

  row.recordingUrl = url;
  row.recordingFetchedAt = new Date().toISOString();
  if (vm) row.status = 'voicemail';
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
  const agentIds = Object.keys(AGENT_MAP).filter(id => (AGENT_MAP[id].slackIds || []).includes(slackUserId));
  // Rolling window, not the whole backlog — old unlistened calls (weeks back)
  // just buried the tile in noise. "Remaining" now means yesterday onward.
  const cutoff = nzToday(new Date(Date.now() - 86400000));
  // Ended calls AND ones explicitly marked "no action needed" — the latter
  // used to be excluded from this tile entirely, which is why there was no
  // way to see them here at all.
  const calls = (state.calls || []).filter(c => agentIds.includes(c.agentAircallId)
    && (c.status === 'ended' || c.status === 'no_action')
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
// Who's actually on the hook for listening to this call — the AGENT_MAP
// slackIds, resolved to real employee records via their Slack user ID (same
// mapping callStatsForSlackId uses in the other direction). An agent with no
// slackIds (nobody listens to those calls) has no responsible person.
function responsiblePeopleForCall(state, c) {
  const agent = AGENT_MAP[c.agentAircallId];
  const slackIds = (agent && agent.slackIds) || [];
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
    if (c.status !== 'ended' && c.status !== 'no_action') return false;
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
    const agent = AGENT_MAP[c.agentAircallId];
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
  if (!KUDOS_LEVELS[level]) return { ok: false, error: 'Pick a level: 3-Star, 4-Star, 5-Star or Legendary.' };
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
    if (isFounder || myTeams.includes(c.team) || (AGENT_MAP[c.agentAircallId] && (AGENT_MAP[c.agentAircallId].slackIds || []).includes(slackUserId))) mine.push(c);
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
      const mentions = [...new Set(list.flatMap(c => (AGENT_MAP[c.agentAircallId] && AGENT_MAP[c.agentAircallId].slackIds) || []))].map(id => `<@${id}>`).join(' ');
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
    } catch (e) { clog('error', 'scheduler tick threw: ' + (e && e.stack || e)); }
  };
  _schedTimer = setInterval(tick, 10 * 60 * 1000); // every 10 min
  if (_schedTimer.unref) _schedTimer.unref();
  setTimeout(tick, 15000);
  console.log('[connector] schedulers started — digest NZ hours ' + DIGEST_HOURS.join(',') + '; personal digest NZ hours ' + PERSONAL_DIGEST_HOURS.join(',') + '; reminders ' + (REMINDERS_ON ? 'ON' : 'OFF') + (REMINDER_DRY_RUN ? ' (dry-run)' : ''));
}

// ---------------------------------------------------------------------------
// CRM SYNC (crm.elitetaxation.co.nz, Supabase-backed) — one-way, CRM → here.
// A Supabase Database Webhook on the CRM's customer table and its user
// table each POST { type: 'INSERT'|'UPDATE'|'DELETE', table, record,
// old_record } whenever a row changes. Field names below (name/phone/
// email/category for a customer; name/email/role/slack_user_id for a user)
// are our best read of the CRM's own UI, not its confirmed schema — verify
// against a real payload (check the Railway logs after the CRM side sends
// its first webhook) and adjust here if their actual column names differ.
// A DELETE is logged but never acted on — we don't auto-remove a client or
// an employee's login just because a CRM row disappeared.
// ---------------------------------------------------------------------------
async function handleCrmCustomer(payload) {
  const row = payload && payload.record;
  const type = payload && payload.type;
  if (!row || !row.id) { clog('warn', 'crm-customer payload missing record.id', { payload }); return; }
  if (type === 'DELETE') { clog('info', 'crm customer delete — leaving the client as-is', { crmId: row.id }); return; }
  const state = db.get();
  state.clients = state.clients || [];
  const name = String(row.name || row.full_name || 'Unnamed').trim();
  const email = row.email ? String(row.email).trim() : null;
  const phone = row.phone ? String(row.phone).trim() : null;
  const category = row.category ? String(row.category).trim() : null;
  let client = state.clients.find(c => c.crmContactId === row.id);
  if (client) {
    client.name = name; client.email = email; client.phone = phone;
    if (category) client.type = category;
  } else {
    client = {
      id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
      name, email, phone, type: category,
      ownerId: null, addedBy: null,
      crmContactId: row.id,
    };
    state.clients.push(client);
  }
  db.save();
  clog('info', 'crm customer synced', { crmId: row.id, clientId: client.id, type });

  // Write our client id back onto the CRM's own contact record, so it's
  // visible from either side — not just us knowing their id. Best-effort:
  // the sync above already saved regardless of whether this succeeds.
  const link = await crmApi('update-contact', { id: row.id, task_manager_client_id: client.id });
  if (link.ok) clog('info', 'crm customer link-back ok', { crmId: row.id, clientId: client.id });
  else clog('warn', 'crm customer link-back failed', { crmId: row.id, clientId: client.id, why: link.error });
}

async function handleCrmUser(payload) {
  const row = payload && payload.record;
  const type = payload && payload.type;
  if (!row || !row.id) { clog('warn', 'crm-user payload missing record.id', { payload }); return; }
  if (type === 'DELETE') { clog('info', 'crm user delete — leaving the login as-is', { crmId: row.id }); return; }
  const state = db.get();
  const name = String(row.name || row.full_name || 'Unnamed').trim();
  const email = row.email ? String(row.email).trim().toLowerCase() : null;
  if (!email) { clog('warn', 'crm-user webhook has no email — skipping', { crmId: row.id }); return; }
  const slackUserId = row.slack_user_id || row.slackUserId || null;

  let emp = state.employees.find(e => e.crmUserId === row.id);
  if (!emp) emp = state.employees.find(e => e.email && e.email.toLowerCase() === email);
  if (emp) {
    emp.name = name;
    emp.crmUserId = row.id;
    if (slackUserId && !emp.slackUserId) emp.slackUserId = slackUserId;
    db.save();
    clog('info', 'crm user synced (existing employee updated)', { crmId: row.id, employeeId: emp.id });
    return;
  }

  // New CRM user → a brand-new, fully working login here. Starts as a plain
  // employee regardless of whatever role the CRM has them as — a sync bug
  // should never be able to hand out admin/superadmin; a real superadmin
  // promotes them by hand via Manage Access if they need more. Forced to
  // set their own password before they can do anything else in the app.
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const id = 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  const newEmp = {
    id, name, email, passwordHash: bcrypt.hashSync(tempPassword, 10),
    jobTitle: 'Team Member', team: 'Unassigned',
    accessRole: 'employee', managesIds: [],
    crmUserId: row.id, slackUserId: slackUserId || null,
    mustChangePassword: true,
  };
  state.employees.push(newEmp);
  db.save();
  clog('info', 'crm user synced (new employee created)', { crmId: row.id, employeeId: id, slackLinked: !!slackUserId });
  if (slackUserId) {
    await dm(slackUserId,
      `👋 Welcome! A login for *Elite Taxation Governance OS* has been created for you.\n\n*Email:* ${email}\n*Temporary password:* \`${tempPassword}\`\n\nYou'll be asked to set your own password the first time you log in.`);
  } else {
    clog('warn', 'new crm-synced employee has no linked Slack — temp password could not be delivered, needs manual handoff', { employeeId: id, email });
  }
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

  // CRM (crm.elitetaxation.co.nz) sync — a Supabase Database Webhook on the
  // CRM's customers table and its users table, each pointed at one of these
  // two URLs with header X-CRM-Webhook-Secret: <CRM_WEBHOOK_SECRET>.
  app.post('/webhooks/crm-customer', (req, res) => {
    const v = verifyCrm(req);
    if (!v.ok) { clog('warn', 'crm-customer webhook rejected', { why: v.why }); return res.status(401).json({ error: v.why }); }
    res.status(200).json({ ok: true });
    handleCrmCustomer(req.body).catch(e => clog('error', 'crm-customer handler threw: ' + (e && e.stack || e)));
  });
  app.post('/webhooks/crm-user', (req, res) => {
    const v = verifyCrm(req);
    if (!v.ok) { clog('warn', 'crm-user webhook rejected', { why: v.why }); return res.status(401).json({ error: v.why }); }
    res.status(200).json({ ok: true });
    handleCrmUser(req.body).catch(e => clog('error', 'crm-user handler threw: ' + (e && e.stack || e)));
  });

  startSchedulers();
  console.log('[connector] routes mounted: /webhooks/{aircall,interakt,slack/events,slack/interactivity,crm-customer,crm-user,run-digest,run-personal-digest,run-reminders,log,health}');
}

module.exports = {
  mountConnector, relayWaToSlack, prettyWaText, callStatsForSlackId, allCallsReport,
  awardKudos, recommendKudos, resolveKudosRecommendation, canAwardKudosTo, kudosManagerEmailFor, KUDOS_LEVELS,
};
