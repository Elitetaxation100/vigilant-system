// ---------------------------------------------------------------------------
// CONNECTOR — Aircall + Slack, in Node (calls-into-tasks, Phase 5)
//
// This replaces the Google Apps Script "Call Notifier". Same job: an Aircall
// call becomes a Slack card with accountability buttons; the outcome and any
// follow-up task are tracked. The Google Sheet is retired — the call log now
// lives in Postgres (state.calls).
//
// Phase 5.1 (this file so far): the three inbound webhook endpoints, each
// verified, plus a bare call-log row on call.ended. Card posting, buttons,
// modals, App Home and the digest come in 5.2–5.4.
//
// Env vars (Railway → vigilant-system → Variables). Copy the values from the
// Apps Script Script Properties; SLACK_SIGNING_SECRET is the one extra:
//   SLACK_BOT_TOKEN        xoxb-…
//   SLACK_SIGNING_SECRET   (Slack app → Basic Information → Signing Secret)
//   SLACK_APP_ID           A…
//   SLACK_TEAM_ID          T…
//   SLACK_CALL_CHANNEL     C…            (the #call-notifications channel id)
//   AIRCALL_API_ID         …
//   AIRCALL_API_TOKEN      …
//   AIRCALL_WEBHOOK_TOKEN  (any random string; also set on the Aircall webhook)
//   GEMINI_API_KEY         …
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const db = require('./db');

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
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

// Slack signs every request: an HMAC-SHA256 over `v0:{ts}:{rawBody}` with the
// signing secret, sent as `X-Slack-Signature: v0=…`. Reject anything older
// than 5 minutes (replay protection) or that doesn't match.
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

// A second, cheap check on the parsed Slack payload — the workspace and app
// must be ours. (The signature above is the real gate; this catches a
// misdirected but validly-signed payload from another install.)
function slackPayloadIsOurs(p) {
  const c = cfg();
  const team = (p && p.team && p.team.id) || (p && p.team_id);
  if (c.slackTeamId && team && team !== c.slackTeamId) return false;
  const appId = p && p.api_app_id;
  if (c.slackAppId && appId && appId !== c.slackAppId) return false;
  return true;
}

// Aircall webhooks: a shared token we set both here and on the webhook in
// Aircall's dashboard. Accept it in the body (`token`) or as `?token=`.
function verifyAircall(req) {
  const expected = cfg().aircallWebhookToken;
  if (!expected) return { ok: false, why: 'AIRCALL_WEBHOOK_TOKEN not set' };
  const got = (req.body && req.body.token) || req.query.token || req.headers['x-aircall-token'];
  return got === expected ? { ok: true } : { ok: false, why: 'bad token' };
}

// ---------------------------------------------------------------------------
// Small logging — replaces the Sheet's "Errors" tab
// ---------------------------------------------------------------------------
function clog(level, msg, meta) {
  const line = `[connector] ${level.toUpperCase()} ${msg}` + (meta ? ' ' + JSON.stringify(meta) : '');
  if (level === 'error') console.error(line); else console.log(line);
  try {
    const state = db.get();
    if (!Array.isArray(state.connectorLog)) state.connectorLog = [];
    state.connectorLog.push({ at: new Date().toISOString(), level, msg, meta: meta || null });
    if (state.connectorLog.length > 400) state.connectorLog.shift();
    // fire-and-forget; a log line is not worth blocking a webhook ack
    db.save();
  } catch (e) { /* never let logging throw */ }
}

// ---------------------------------------------------------------------------
// Aircall payload helpers (best-effort against Aircall's shape, mirroring
// what the Apps Script connector already relies on)
// ---------------------------------------------------------------------------
function normalizeNumber(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').slice(-9);
}
function isUnanswered(call) { return !!call.missed_call_reason || !call.answered_at; }
function isVoicemail(call) { return !!call.voicemail || call.missed_call_reason === 'voicemail'; }

// The connector's routing table. Phase 5.2 will read this from the employees'
// `aircallAgentId` + team config; for now it's the same map the Apps Script
// uses, so 5.1 can log calls against the right team.
const AGENT_MAP = {
  '1674408': { name: 'Anjana Pandey', team: 'Rideshare + Rental', mandatory: false },
  '1682239': { name: 'Parvinder Kumar', team: 'Companies', mandatory: true },
  '1660428': { name: 'Shubam Sharma', team: 'Leads', mandatory: true },
  '1937711': { name: 'Disha Chaudhary', team: 'Rideshare + Rental', mandatory: false },
};

// Find an existing call-log row by Aircall id.
function findCall(state, aircallId) {
  return (state.calls || []).find(c => String(c.aircallId) === String(aircallId));
}

// call.ended — create the call-log row (no Slack card yet; that's 5.2).
function handleCallEnded(call) {
  const state = db.get();
  if (findCall(state, call.id)) { clog('info', 'call.ended dedup — already logged', { id: call.id }); return; }

  const agentId = call.user ? String(call.user.id) : null;
  const routing = agentId ? AGENT_MAP[agentId] : null;
  state.callSeq = (state.callSeq || 0) + 1;
  const row = {
    id: 'call' + state.callSeq,
    aircallId: String(call.id),
    occurredAt: new Date().toISOString(),
    direction: call.direction || null,
    durationSec: call.duration || null,
    callerPhone: normalizeNumber(call.raw_digits || ''),
    contactName: (call.contact && call.contact.name) || null,
    clientId: null,
    agentName: routing ? routing.name : (call.user ? call.user.name : 'Unknown agent'),
    agentAircallId: agentId,
    team: routing ? routing.team : 'Unmapped',
    mandatory: routing ? !!routing.mandatory : false,
    status: isUnanswered(call) ? 'not_picked_up' : (isVoicemail(call) ? 'voicemail' : 'ended'),
    recordingUrl: null,
    recordingFetchedAt: null,
    listenedBy: null,
    listenedAt: null,
    slackChannel: null,
    slackTs: null,
    aiOutcome: null,
    aiAction: null,
    aiDue: null,
    taskId: null,
    finalOutcome: null,
    createdVia: 'node-connector',
  };
  state.calls.push(row);
  if (state.calls.length > 5000) state.calls.shift();
  db.save();
  clog('info', 'call.ended logged', { id: call.id, team: row.team, agent: row.agentName, status: row.status });
}

function handleRecordingReady(call) {
  const state = db.get();
  const row = findCall(state, call.id);
  if (!row) { clog('warn', 'recording ready but no call row', { id: call.id }); return; }
  row.recordingUrl = call.recording || (call.asset && call.asset.url) || call.voicemail || null;
  row.recordingFetchedAt = new Date().toISOString();
  if (isVoicemail(call)) row.status = 'voicemail';
  db.save();
  clog('info', 'recording ready logged', { id: call.id });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function mountConnector(app) {
  // Health / config check — booleans only, never the secret values.
  app.get('/webhooks/health', (req, res) => {
    const c = cfg();
    res.json({
      ok: true,
      configured: {
        slackBotToken: !!c.slackBotToken,
        slackSigningSecret: !!c.slackSigningSecret,
        slackChannel: !!c.slackChannel,
        slackTeamId: !!c.slackTeamId,
        aircall: !!(c.aircallApiId && c.aircallApiToken),
        aircallWebhookToken: !!c.aircallWebhookToken,
        gemini: !!c.geminiApiKey,
      },
      calls: (db.get().calls || []).length,
    });
  });

  // Aircall webhooks.
  app.post('/webhooks/aircall', (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) { clog('warn', 'aircall webhook rejected', { why: v.why }); return res.status(401).send('unauthorized'); }
    const event = req.body && req.body.event;
    const call = (req.body && req.body.data) || {};
    try {
      if (event === 'call.ended') handleCallEnded(call);
      else if (event === 'call.comm_assets_generated') handleRecordingReady(call);
      else clog('info', 'aircall event ignored', { event });
    } catch (e) {
      clog('error', 'aircall handler threw: ' + e);
    }
    res.status(200).send('ok'); // always ack fast so Aircall doesn't retry
  });

  // Slack Events API (App Home, the one-time URL verification handshake).
  app.post('/webhooks/slack/events', (req, res) => {
    // The url_verification handshake is sent before you'd have anything to
    // verify against — echo the challenge.
    if (req.body && req.body.type === 'url_verification') {
      return res.status(200).json({ challenge: req.body.challenge });
    }
    const v = verifySlack(req);
    if (!v.ok) { clog('warn', 'slack event rejected', { why: v.why }); return res.status(401).send('bad signature'); }
    if (!slackPayloadIsOurs(req.body)) { clog('warn', 'slack event from another workspace/app'); return res.status(200).send('ignored'); }
    const ev = req.body && req.body.event;
    clog('info', 'slack event', { type: ev && ev.type });
    // App Home handling comes in 5.4.
    res.status(200).send('ok');
  });

  // Slack interactivity (button clicks, modal submissions, message shortcuts).
  app.post('/webhooks/slack/interactivity', (req, res) => {
    const v = verifySlack(req);
    if (!v.ok) { clog('warn', 'slack interactivity rejected', { why: v.why }); return res.status(401).send('bad signature'); }
    let payload = {};
    try { payload = JSON.parse((req.body && req.body.payload) || '{}'); } catch (e) {
      clog('error', 'slack interactivity: bad payload json');
      return res.status(400).send('bad payload');
    }
    if (!slackPayloadIsOurs(payload)) { clog('warn', 'slack interactivity from another workspace/app'); return res.status(200).send(''); }
    clog('info', 'slack interactivity', { type: payload.type, action: payload.actions && payload.actions[0] && payload.actions[0].action_id });
    // Buttons / modals / shortcuts come in 5.3.
    res.status(200).send('');
  });

  console.log('[connector] webhook routes mounted: /webhooks/{aircall,slack/events,slack/interactivity,health}');
}

module.exports = { mountConnector };
