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
  if (o.footer) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: o.footer }] });
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
      duration: row.durationSec ? row.durationSec + 's' : '—', assignedLine: mentions,
      footer: row.mandatory ? '🎙️ Recording will follow once ready.' : null,
      buttons: endedButtons(row.id),
    };
  }
  return {
    icon: '🎙️', statusLabel: 'Recording Ready', team: row.team, agent: row.agentName,
    client: row.clientName || 'Unknown / not saved', phone: row.callerPhone ? '+' + row.callerPhone : '—',
    duration: row.durationSec ? row.durationSec + 's' : '—', assignedLine: mentions,
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
// ---------------------------------------------------------------------------
async function handleCallEnded(call) {
  const state = db.get();
  if (findCall(state, call.id)) { clog('info', 'call.ended dedup', { id: call.id }); return; }

  const agentId = call.user ? String(call.user.id) : null;
  const routing = agentId ? AGENT_MAP[agentId] : null;
  const callerPhone = normalizeNumber(call.raw_digits || '');
  const unanswered = isUnanswered(call);
  const vm = isVoicemail(call);

  // Transfer-leg merge: same number, another leg logged in the last 15 min.
  const cutoff = Date.now() - TRANSFER_MERGE_MINUTES * 60000;
  const priorLeg = (state.calls || []).filter(c => c.callerPhone === callerPhone && callerPhone &&
    new Date(c.occurredAt).getTime() >= cutoff).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0];
  if (priorLeg) {
    priorLeg.aircallId = String(call.id);
    priorLeg.agentName = routing ? routing.name : (call.user ? call.user.name : priorLeg.agentName);
    priorLeg.agentAircallId = agentId || priorLeg.agentAircallId;
    if (routing) { priorLeg.team = routing.team; priorLeg.mandatory = !!routing.mandatory; }
    priorLeg.status = unanswered ? 'not_picked_up' : (vm ? 'voicemail' : 'ended');
    db.save();
    clog('info', 'call.ended merged into transfer leg', { id: call.id, into: priorLeg.id });
    return;
  }

  const caller = await resolveCaller(state, call);
  state.callSeq = (state.callSeq || 0) + 1;
  const row = {
    id: 'call' + state.callSeq, aircallId: String(call.id), occurredAt: new Date().toISOString(),
    direction: call.direction || null, durationSec: call.duration || null, callerPhone,
    contactName: caller.name, clientId: caller.clientId,
    agentName: routing ? routing.name : (call.user ? call.user.name : 'Unknown agent'),
    agentAircallId: agentId, team: routing ? routing.team : 'Unmapped', mandatory: routing ? !!routing.mandatory : false,
    status: unanswered ? 'not_picked_up' : (vm ? 'voicemail' : 'ended'),
    clientName: caller.name,
    recordingUrl: null, recordingFetchedAt: null, listenedBy: null, listenedAt: null,
    slackChannel: null, slackTs: null, aiOutcome: null, aiAction: null, aiDue: null,
    taskId: null, finalOutcome: null, createdVia: 'node-connector',
  };
  state.calls.push(row);
  if (state.calls.length > 5000) state.calls.shift();
  db.save();

  // Post the card — but only for a mapped team, and not for unanswered /
  // voicemail calls (kept out of the channel, still logged).
  if (routing && !unanswered && !vm) {
    const opts = cardOptsFor(state, row, 'ended');
    const posted = await slack('chat.postMessage', {
      channel: cfg().slackChannel, text: callCardFallback(opts), blocks: buildCallCard(opts),
    });
    if (posted.ok) { row.slackChannel = posted.channel; row.slackTs = posted.ts; db.save(); }
  }
  clog('info', 'call.ended', { id: call.id, team: row.team, status: row.status, posted: !!row.slackTs });
}

async function handleRecordingReady(call) {
  const state = db.get();
  let row = findCall(state, call.id);
  if (!row) {
    // Aircall sometimes uses a different call.id — match on phone + time.
    const phone = normalizeNumber(call.raw_digits || '');
    const cutoff = Date.now() - RECORDING_MATCH_MINUTES * 60000;
    row = (state.calls || []).filter(c => c.callerPhone === phone && phone && !c.recordingUrl &&
      new Date(c.occurredAt).getTime() >= cutoff).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0];
    if (row) { row.aircallId = String(call.id); clog('warn', 'recording matched by phone fallback', { id: call.id, row: row.id }); }
  }
  if (!row) { clog('warn', 'recording ready — no call row', { id: call.id }); return; }

  row.recordingUrl = call.recording || (call.asset && call.asset.url) || call.voicemail || null;
  row.recordingFetchedAt = new Date().toISOString();
  const vm = isVoicemail(call);
  if (vm) row.status = 'voicemail';
  db.save();

  if (!row.slackTs || vm || row.team === 'Unmapped') { clog('info', 'recording logged, no card edit', { id: call.id }); return; }
  const opts = cardOptsFor(state, row, 'recording');
  const upd = await slack('chat.update', {
    channel: row.slackChannel || cfg().slackChannel, ts: row.slackTs,
    text: callCardFallback(opts), blocks: buildCallCard(opts),
  });
  if (!upd.ok) {
    // stale ts — post fresh and re-anchor
    const posted = await slack('chat.postMessage', { channel: cfg().slackChannel, text: callCardFallback(opts), blocks: buildCallCard(opts) });
    if (posted.ok) { row.slackChannel = posted.channel; row.slackTs = posted.ts; db.save(); }
  }
  clog('info', 'recording ready — card updated', { id: call.id });
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
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${selfAssigned ? '' : 'Assigned by *' + esc(byName) + '* · '}Task ${task.id}` }] },
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
  const ai = row && (row.aiOutcome || row.aiAction) ? row : null;
  const blocks = [];
  if (ai) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '🤖 *AI draft below — review and edit before submitting.*' }] });
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
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Task ${task.id}` }] },
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
    };
    if (map[a.action_id]) await map[a.action_id](payload, a.value);
    else clog('info', 'unhandled block action', { action: a.action_id });
  } else if (type === 'view_submission') {
    const cb = payload.view.callback_id;
    if (cb === 'log_outcome_modal') await submitLogOutcome(payload);
    else if (cb === 'convert_to_task_modal') await submitConvert(payload);
  } else if (type === 'message_action') {
    if (payload.callback_id === 'convert_to_task') await openConvertModal(payload);
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
      },
      calls: (db.get().calls || []).length,
    });
  });

  app.post('/webhooks/aircall', (req, res) => {
    const v = verifyAircall(req);
    if (!v.ok) { clog('warn', 'aircall rejected', { why: v.why }); return res.status(401).send('unauthorized'); }
    res.status(200).send('ok'); // ack immediately; process after
    const event = req.body && req.body.event;
    const call = (req.body && req.body.data) || {};
    (async () => {
      try {
        if (event === 'call.ended') await handleCallEnded(call);
        else if (event === 'call.comm_assets_generated') await handleRecordingReady(call);
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
    // App Home handling comes in 5.4
    clog('info', 'slack event', { type: req.body && req.body.event && req.body.event.type });
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

  console.log('[connector] routes mounted: /webhooks/{aircall,slack/events,slack/interactivity,health}');
}

module.exports = { mountConnector };
