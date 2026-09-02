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

// Agent → team routing. Mirrors the Apps Script AGENT_MAP. slackIds = who to
// @-mention on the card and who the pending digest nags (mandatory teams).
// A later phase can read this from employees' aircallAgentId + team config.
const AGENT_MAP = {
  '1660428': { name: 'Shubam Sharma',   team: 'Leads',              mandatory: true,  slackIds: ['U0BNFG5T1LP', 'U0BNTB31KBP'] },
  '1682239': { name: 'Parvinder Kumar', team: 'Companies',          mandatory: true,  slackIds: ['U0BNFGKDWDV'] },
  '1674408': { name: 'Anjana Pandey',   team: 'Rideshare + Rental', mandatory: false, slackIds: ['U0BNYP84A9X'] },
  '1937711': { name: 'Disha Chaudhary', team: 'Rideshare + Rental', mandatory: false, slackIds: ['U0BNYP84A9X'] },
};
const TRANSFER_MERGE_MINUTES = 15;
const RECORDING_MATCH_MINUTES = 120;
// Digest: reminder about un-listened mandatory calls + overdue call/Slack
// tasks, posted to the call channel at these NZ hours (24h, comma list).
const DIGEST_HOURS = (process.env.CALL_DIGEST_HOURS || '9,15').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
const DIGEST_TZ = process.env.CALL_DIGEST_TZ || 'Pacific/Auckland';
const LISTEN_GRACE_HOURS = 2;   // don't nag about a recording younger than this
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Phase 3 — per-person task reminders + escalation ladder (Slack DM).
// OFF by default: nothing is DM'd to staff until REMINDERS_ENABLED=true is
// set on Railway. REMINDER_DRY_RUN=true logs what it *would* send instead.
const REMINDERS_ON = process.env.REMINDERS_ENABLED === 'true';
const REMINDER_DRY_RUN = process.env.REMINDER_DRY_RUN === 'true';
const REMINDER_DIGEST_HOUR = parseInt(process.env.REMINDER_DIGEST_HOUR || '8', 10);   // NZ hour for the daily "what's on your plate" DM
const REMINDER_ESCALATE_HOURS = parseFloat(process.env.REMINDER_ESCALATE_HOURS || '24'); // gap between escalation rungs
const REMINDER_MGMT_CHANNEL = process.env.REMINDER_MGMT_CHANNEL || '';                 // optional channel for level-3 escalations

// ---------------------------------------------------------------------------
// tiny HTTPS JSON client (Node 18 — avoid depending on global fetch)
// ---------------------------------------------------------------------------
function httpsRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(raw.toString('utf8')); } catch (e) {}
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, json: null, error: String(e) }));
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
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
  if (!r.json || !r.json.ok) clog('error', 'slack ' + method + ' failed', { error: (r.json && r.json.error) || r.status });
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
    db.save();
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
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
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
          buttonEl('✅ Mark Listened', 'mark_listened', rowId),
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
    clientDate: null, internalDeadline: o.dueDate || null, points: 0,
    assignedTo: assignee ? assignee.id : null, assignedBy: assignee ? assignee.id : null,
    assignedAt: now, reassignHistory: [], status: 'accepted', logged: 0, tat: 0,
    acceptedAt: now, timerStartedAt: null, completedAt: null, reviewStatus: null, reviewedBy: null,
    reviewNote: null, reviewedAt: null, reworkCount: 0, reviewerId: null, awaitingClientDecision: false,
    sentToClient: null, sentToClientAt: null, sentToClientBy: null, reworkStartedAt: null, faultType: null,
    reworkHistory: [], source: o.source || 'call', sourceRef: o.sourceRef || null,
    estMinutes: o.estMinutes != null && !isNaN(Number(o.estMinutes)) ? Number(o.estMinutes) : null, priority: null,
  };
  state.tasks.unshift(task);
  activity(state, task.assignedTo, `Task from ${task.source === 'call' ? 'a call' : 'Slack'}: "${esc(task.name)}"${assignee ? ` — assigned to <b>${esc(assignee.name)}</b>` : ' — unassigned'}.`, { source: task.source });
  return task;
}
function completeTask(state, taskId, byName) {
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t || t.status === 'completed') return t;
  if (t.timerStartedAt) { t.logged += (Date.now() - new Date(t.timerStartedAt).getTime()) / 3600000; t.timerStartedAt = null; }
  t.status = 'completed'; t.completedAt = new Date().toISOString(); t.reviewStatus = null;
  activity(state, t.assignedTo, `"${esc(t.name)}" marked done from Slack${byName ? ' by <b>' + esc(byName) + '</b>' : ''}.`);
  return t;
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

  // Transfer-leg merge: same number, another (real, non-stub) leg in the
  // last 15 min. Skipped when this call.id already has a stub of its own.
  if (!existing) {
    const cutoff = Date.now() - TRANSFER_MERGE_MINUTES * 60000;
    const priorLeg = (state.calls || []).filter(c => !c.stub && c.callerPhone === callerPhone && callerPhone &&
      new Date(c.occurredAt).getTime() >= cutoff).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0];
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
    if (!row.aiOutcome && cfg().geminiApiKey) generateAiDraft(rowId).catch(() => {});
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
  });
  row.taskId = task.id; db.save();
  await postTaskCard(row, task, payload.user.id, payload.user.name || payload.user.id, true);
}
function slackPermalink(row) {
  if (!row.slackChannel || !row.slackTs) return null;
  return `https://slack.com/archives/${row.slackChannel}/p${String(row.slackTs).replace('.', '')}`;
}
async function postTaskCard(row, task, ownerSlackId, byName, selfAssigned) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: selfAssigned ? '📌 Task Logged (Self-Assigned)' : '📌 New Task', emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Owner*\n<@${ownerSlackId}>` },
      { type: 'mrkdwn', text: `*Due*\n${fmtDate(task.internalDeadline)}` },
    ] },
    { type: 'section', text: { type: 'mrkdwn', text: `*Task:* ${esc(task.scope !== '—' ? task.scope : task.name)}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${selfAssigned ? '' : 'Assigned by *' + esc(byName) + '* · '}Task ${task.id} · 🟢 via Governance OS` }] },
    { type: 'divider' },
    { type: 'actions', elements: [buttonEl('✅ Mark Done', 'task_done', task.id)] },
  ];
  await slack('chat.postMessage', {
    channel: cfg().slackChannel, thread_ts: row.slackTs || undefined,
    text: `📌 Task for <@${ownerSlackId}>: ${task.name}`, blocks,
  });
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
  if (!url) { clog('warn', 'play recording — no url', { row: rowId }); return; }
  const audio = await httpsRequest(url);
  if (audio.status !== 200 || !audio.raw) { clog('error', 'play recording — audio fetch failed', { status: audio.status }); return; }
  // Slack's external-upload flow is form-encoded, not JSON:
  const c = cfg();
  const form = 'filename=' + encodeURIComponent('call-' + row.aircallId + '.mp3') + '&length=' + audio.raw.length;
  const gu = await httpsRequest('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer ' + c.slackBotToken },
    body: form,
  });
  if (!gu.json || !gu.json.ok) { clog('error', 'getUploadURLExternal failed', { e: gu.json && gu.json.error }); return; }
  const put = await httpsRequest(gu.json.upload_url, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio.raw,
  });
  if (put.status >= 300) { clog('error', 'audio upload failed', { status: put.status }); return; }
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
    { type: 'input', block_id: 'mins', optional: true, label: { type: 'plain_text', text: 'Estimated Time (minutes)' },
      element: { type: 'number_input', action_id: 'v', is_decimal_allowed: false } },
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

  if (row.taskId) {
    const t = (state.tasks || []).find(x => x.id === row.taskId);
    if (t) {
      t.name = title; t.scope = detail || '—'; t.internalDeadline = due || null;
      const a = empBySlackId(state, assigneeSlackId); if (a) t.assignedTo = a.id;
      if (mins) t.estMinutes = Number(mins);
      db.save();
    }
  } else {
    const task = createTask(state, {
      title, detail, source: 'call', sourceRef: slackPermalink(row),
      assigneeSlackId, clientName: row.clientName && row.clientName.indexOf('Unknown') !== 0 ? row.clientName : null,
      dueDate: due || null, estMinutes: mins || null,
    });
    row.taskId = task.id; db.save();
    await postTaskCard(row, task, assigneeSlackId, payload.user.name || payload.user.id, !pickedAssignee);
  }
}

// Convert to Task message shortcut
async function openConvertModal(payload) {
  const src = (payload.message && payload.message.text) || '';
  const meta = JSON.stringify({ channel: payload.channel.id, ts: payload.message.ts });
  await slack('views.open', {
    trigger_id: payload.trigger_id,
    view: { type: 'modal', callback_id: 'convert_to_task_modal', private_metadata: meta,
      title: { type: 'plain_text', text: 'Convert to Task' }, submit: { type: 'plain_text', text: 'Create Task' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'desc', label: { type: 'plain_text', text: 'Task Description' },
          element: { type: 'plain_text_input', action_id: 'v', multiline: true, initial_value: src.slice(0, 2900) } },
        { type: 'input', block_id: 'assignee', label: { type: 'plain_text', text: 'Assign To' },
          element: { type: 'users_select', action_id: 'v' } },
        { type: 'input', block_id: 'due', optional: true, label: { type: 'plain_text', text: 'Due Date' },
          element: { type: 'datepicker', action_id: 'v' } },
        { type: 'input', block_id: 'mins', optional: true, label: { type: 'plain_text', text: 'Estimated Time (minutes)' },
          element: { type: 'number_input', action_id: 'v', is_decimal_allowed: false } },
      ] },
  });
}
async function submitConvert(payload) {
  const state = db.get();
  const meta = JSON.parse(payload.view.private_metadata || '{}');
  const v = payload.view.state.values;
  const desc = (v.desc && v.desc.v.value) || '';
  const assigneeSlackId = v.assignee && v.assignee.v.selected_user;
  const due = (v.due && v.due.v.selected_date) || '';
  const mins = (v.mins && v.mins.v.value) || '';
  const link = meta.channel && meta.ts ? `https://slack.com/archives/${meta.channel}/p${String(meta.ts).replace('.', '')}` : null;
  const task = createTask(state, {
    title: (desc.split('\n')[0] || 'Task from Slack').slice(0, 140), detail: desc,
    source: 'slack_message', sourceRef: link, assigneeSlackId, dueDate: due || null, estMinutes: mins || null,
  });
  db.save();
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `📌 *Task created* — <@${assigneeSlackId}>` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Task:* ${esc(desc)}` } },
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
      task_done: onTaskDone, play_recording: onPlayRecording, log_outcome: openLogOutcomeModal,
      task_snooze: onTaskSnooze, task_need_time: onTaskNeedTime,
    };
    if (map[a.action_id]) await map[a.action_id](payload, a.value);
    else clog('info', 'unhandled block action', { action: a.action_id });
  } else if (type === 'view_submission') {
    const cb = payload.view.callback_id;
    if (cb === 'log_outcome_modal') await submitLogOutcome(payload);
    else if (cb === 'convert_to_task_modal') await submitConvert(payload);
    else if (cb === 'need_time_modal') await submitNeedTime(payload);
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
  if (audio.status !== 200 || !audio.raw || audio.raw.length > 19 * 1024 * 1024) {
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
function pendingListenCalls(state, { team } = {}) {
  const graceMs = LISTEN_GRACE_HOURS * 3600000;
  return (state.calls || []).filter(c =>
    c.mandatory && c.recordingUrl && !c.listenedBy && !c.finalOutcome && c.status !== 'no_action' &&
    Date.now() - new Date(c.recordingFetchedAt || c.occurredAt).getTime() > graceMs &&
    (!team || c.team === team));
}
function openCallTasksFor(state, empId) {
  return (state.tasks || []).filter(t =>
    t.assignedTo === empId && (t.source === 'call' || t.source === 'slack_message') &&
    t.status !== 'completed' && t.status !== 'cancelled');
}
function overdueIntegrationTasks(state) {
  const today = new Date().toISOString().slice(0, 10);
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
    if (!c.mandatory || !c.recordingUrl || c.listenedBy || c.finalOutcome || c.status === 'no_action') return;
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
    const unlogged = (state.calls || []).filter(c => c.mandatory && c.recordingUrl && !c.finalOutcome && c.status !== 'no_action').length;
    const overdue = overdueIntegrationTasks(state).length;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🔒 Founder view*\n• ${unlogged} mandatory calls not yet logged\n• ${overdue} call/Slack tasks overdue` } });
  }
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
        `*${esc(team)}* — ${list.length}  ${mentions}\n` + list.slice(0, 8).map(c => {
          const link = slackPermalink(c);
          return `• ${esc(c.clientName || 'Unknown')} (${fmtDate(c.occurredAt)})` + (link ? ` <${link}|open>` : '');
        }).join('\n') } });
    });
  }
  if (overdue.length) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📋 ${overdue.length} call/Slack task${overdue.length === 1 ? '' : 's'} overdue*\n` +
      overdue.slice(0, 10).map(t => {
        const a = (state.employees || []).find(e => e.id === t.assignedTo);
        const m = a && a.slackUserId ? ` <@${a.slackUserId}>` : (a ? ` _${esc(a.name)}_` : '');
        return `• ${esc(t.name)} — due ${fmtDate(t.internalDeadline)}${m}`;
      }).join('\n') } });
  }
  const posted = await slack('chat.postMessage', { channel: cfg().slackChannel, text: '⏰ Call accountability digest', blocks });
  clog('info', 'digest posted', { reason, pending: pending.length, overdue: overdue.length, ok: !!posted.ok });
}

// ---------------------------------------------------------------------------
// Phase 3 — task reminders + escalation ladder
// ---------------------------------------------------------------------------
function nzHour(d) { return parseInt((d || new Date()).toLocaleString('en-NZ', { timeZone: DIGEST_TZ, hour: '2-digit', hour12: false }), 10); }
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
    state.reminderRun.digestSlot = digestSlot;
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
      if (overdue.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Overdue*\n' + overdue.map(t => taskLine(state, t, today)).join('\n') } });
      if (dueToday.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Due today*\n' + dueToday.map(t => taskLine(state, t, today)).join('\n') } });
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
      await runReminders('scheduled ' + dayKey + ':' + hr);
    } catch (e) { clog('error', 'scheduler tick threw: ' + (e && e.stack || e)); }
  };
  _schedTimer = setInterval(tick, 10 * 60 * 1000); // every 10 min
  if (_schedTimer.unref) _schedTimer.unref();
  setTimeout(tick, 15000);
  console.log('[connector] schedulers started — digest NZ hours ' + DIGEST_HOURS.join(',') + '; reminders ' + (REMINDERS_ON ? 'ON' : 'OFF') + (REMINDER_DRY_RUN ? ' (dry-run)' : ''));
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
      },
      calls: (db.get().calls || []).length,
      digestHoursNZ: DIGEST_HOURS,
      pendingListens: pendingListenCalls(db.get()).length,
      reminders: { enabled: REMINDERS_ON, dryRun: REMINDER_DRY_RUN, digestHourNZ: REMINDER_DIGEST_HOUR, escalateHours: REMINDER_ESCALATE_HOURS },
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

  // Backfill employees' slackUserId by matching Slack profile emails to the
  // task manager's employee emails. Token-gated. ?dry=1 previews without
  // writing; ?overwrite=1 also replaces IDs that are already set.
  app.post('/webhooks/backfill-slack-ids', async (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) return res.status(401).json({ error: v.why });
    try {
      const dry = req.query.dry === '1';
      const overwrite = req.query.overwrite === '1';
      const byEmail = {};
      const directory = [];
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const r = await slack('users.list', { limit: 200, cursor: cursor || undefined });
        if (!r.ok) return res.status(502).json({ error: 'users.list failed: ' + (r.error || '?') + (r.error === 'missing_scope' ? ' — add users:read + users:read.email scopes and reinstall the app' : '') });
        (r.members || []).forEach(m => {
          if (m.deleted || m.is_bot || m.id === 'USLACKBOT') return;
          const em = m.profile && m.profile.email;
          directory.push({ id: m.id, name: m.profile && (m.profile.real_name || m.profile.display_name) || m.name, email: em || null });
          if (em) byEmail[em.toLowerCase()] = m.id;
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

  startSchedulers();
  console.log('[connector] routes mounted: /webhooks/{aircall,slack/events,slack/interactivity,run-digest,run-reminders,log,health}');
}

module.exports = { mountConnector };
