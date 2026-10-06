// File store — attachments and screenshots live HERE, not inside the one big state row.
//
// Why: screenshots used to be saved as base64 text inside the main Postgres row, so every save
// re-wrote every image, and the volume filled. Now the state only holds a small reference
// ({ id, name, mime, size }) and the bytes live in their own table (app_files) on Postgres, or in
// data/files/ when there is no database (local development and the tests).
//
// Pure helpers (validate, dataUrlToBuffer) have no I/O and are unit-tested on their own.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 15 * 1024 * 1024;            // one file
const MAX_PER_REVIEW = 5;                      // files on a single rework

// What may be attached. The content type we SERVE comes from this table (never from the client), so a
// file can't pose as something else, and nothing here can run in the browser (no html/svg/js).
const KINDS = {
  pdf:  { mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  png:  { mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg:  { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  gif:  { mime: 'image/gif', magic: [[0x47, 0x49, 0x46, 0x38]] },
  webp: { mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  xls:  { mime: 'application/vnd.ms-excel', magic: [[0xd0, 0xcf, 0x11, 0xe0]] },
  doc:  { mime: 'application/msword', magic: [[0xd0, 0xcf, 0x11, 0xe0]] },
  csv:  { mime: 'text/csv', text: true },
  txt:  { mime: 'text/plain', text: true },
};
const ALLOWED_LABEL = 'PDF, image, Excel, Word, PowerPoint, CSV or text';

function extOf(name) { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
function cleanName(name) {
  // keep it readable and harmless: no path bits, no control characters
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim();
  return (base || 'file').slice(0, 120);
}

// { ok:true, name, ext, mime, size } or { ok:false, error }
function validate(name, buf) {
  const nm = cleanName(name);
  const ext = extOf(nm);
  const kind = KINDS[ext];
  if (!kind) return { ok: false, error: `That file type isn't allowed. Attach a ${ALLOWED_LABEL} file.` };
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: 'That file is empty.' };
  if (buf.length > MAX_BYTES) return { ok: false, error: `That file is too large — the limit is ${Math.round(MAX_BYTES / 1048576)} MB.` };
  if (kind.magic && !kind.magic.some(sig => sig.every((b, i) => buf[i] === b))) {
    return { ok: false, error: `That doesn't look like a real .${ext} file.` };
  }
  if (kind.text && buf.subarray(0, 4096).includes(0)) return { ok: false, error: `That doesn't look like a real .${ext} file.` };
  return { ok: true, name: nm, ext, mime: kind.mime, size: buf.length };
}

// "data:image/png;base64,...." → { mime, buf } or null
function dataUrlToBuffer(s) {
  const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(s || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  return buf.length ? { mime: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], buf } : null;
}

// ---------------------------------------------------------------------------
// Storage. `host` is db.js (it knows the pool, whether Postgres is live, and the data folder).
// ---------------------------------------------------------------------------
let host = null;
let tableReady = null;
function init(h) { host = h; tableReady = null; }

function usePg() { return !!(host && host._mode && host._mode() === 'postgres' && host._pool && host._pool()); }
function dirPath() { return path.join(host._dataDir(), 'files'); }
function newId() { return 'f_' + crypto.randomBytes(12).toString('hex'); }
const safeId = id => /^f_[0-9a-f]{24}$/.test(String(id || ''));

async function ensureTable() {
  if (!tableReady) {
    tableReady = host._pool().query(`
      CREATE TABLE IF NOT EXISTS app_files (
        id         text PRIMARY KEY,
        name       text NOT NULL,
        mime       text NOT NULL,
        size       integer NOT NULL,
        data       bytea NOT NULL,
        created_by text,
        task_id    text,
        kind       text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`).catch(e => { tableReady = null; throw e; });
  }
  return tableReady;
}

const rowMeta = r => ({ id: r.id, name: r.name, mime: r.mime, size: Number(r.size), createdBy: r.created_by || null, taskId: r.task_id || null, kind: r.kind || null, createdAt: (r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at) });

// Store bytes. `info` = { name, mime, createdBy, taskId?, kind? } — the caller has already validated.
async function put(buf, info) {
  const id = newId();
  const meta = { id, name: cleanName(info.name), mime: info.mime, size: buf.length, createdBy: info.createdBy || null, taskId: info.taskId || null, kind: info.kind || null, createdAt: new Date().toISOString() };
  if (usePg()) {
    await ensureTable();
    await host._pool().query('INSERT INTO app_files (id, name, mime, size, data, created_by, task_id, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, meta.name, meta.mime, meta.size, buf, meta.createdBy, meta.taskId, meta.kind]);
  } else {
    const d = dirPath(); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, id + '.bin'), buf);
    fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify(meta));
  }
  return meta;
}

async function meta(id) {
  if (!safeId(id)) return null;
  if (usePg()) {
    await ensureTable();
    const { rows } = await host._pool().query('SELECT id,name,mime,size,created_by,task_id,kind,created_at FROM app_files WHERE id=$1', [id]);
    return rows.length ? rowMeta(rows[0]) : null;
  }
  try { return JSON.parse(fs.readFileSync(path.join(dirPath(), id + '.json'), 'utf8')); } catch (e) { return null; }
}

async function get(id) {
  const m = await meta(id);
  if (!m) return null;
  if (usePg()) {
    const { rows } = await host._pool().query('SELECT data FROM app_files WHERE id=$1', [id]);
    return rows.length ? { meta: m, data: rows[0].data } : null;
  }
  try { return { meta: m, data: fs.readFileSync(path.join(dirPath(), id + '.bin')) }; } catch (e) { return null; }
}

// Tie an uploaded file to a task once it is attached to something.
async function attach(id, taskId, kind) {
  if (!safeId(id)) return;
  if (usePg()) { await ensureTable(); await host._pool().query('UPDATE app_files SET task_id=$2, kind=$3 WHERE id=$1', [id, taskId, kind || null]); return; }
  const m = await meta(id); if (!m) return;
  m.taskId = taskId; m.kind = kind || null;
  fs.writeFileSync(path.join(dirPath(), id + '.json'), JSON.stringify(m));
}

async function remove(id) {
  if (!safeId(id)) return;
  if (usePg()) { await ensureTable(); await host._pool().query('DELETE FROM app_files WHERE id=$1', [id]); return; }
  for (const ext of ['.bin', '.json']) { try { fs.unlinkSync(path.join(dirPath(), id + ext)); } catch (e) {} }
}

// Files uploaded but never attached to anything (someone picked a file and closed the form).
async function sweepOrphans(olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  let n = 0;
  if (usePg()) {
    await ensureTable();
    const r = await host._pool().query('DELETE FROM app_files WHERE task_id IS NULL AND kind IS NULL AND created_at < $1', [new Date(cutoff)]);
    return r.rowCount || 0;
  }
  let names = []; try { names = fs.readdirSync(dirPath()).filter(f => f.endsWith('.json')); } catch (e) { return 0; }
  for (const f of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dirPath(), f), 'utf8'));
      if (!m.taskId && !m.kind && new Date(m.createdAt).getTime() < cutoff) { await remove(m.id); n++; }
    } catch (e) {}
  }
  return n;
}

async function totals() {
  if (usePg()) {
    await ensureTable();
    const { rows } = await host._pool().query('SELECT count(*)::int AS n, coalesce(sum(size),0)::bigint AS bytes FROM app_files');
    return { files: rows[0].n, bytes: Number(rows[0].bytes) };
  }
  let n = 0, bytes = 0;
  try { for (const f of fs.readdirSync(dirPath()).filter(x => x.endsWith('.json'))) { n++; bytes += JSON.parse(fs.readFileSync(path.join(dirPath(), f), 'utf8')).size || 0; } } catch (e) {}
  return { files: n, bytes };
}

module.exports = { init, put, meta, get, attach, remove, sweepOrphans, totals, validate, dataUrlToBuffer, cleanName, safeId, MAX_BYTES, MAX_PER_REVIEW, ALLOWED_LABEL, KINDS };
