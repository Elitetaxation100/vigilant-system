const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..'), SHOTS = path.join(__dirname, 'shots');
const port = 4700 + Math.floor(Math.random() * 200), base = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ui-'));
const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), TM_DATA_DIR: dir, LOGIN_RATE_LIMIT: '10000', NODE_ENV: 'test' }, stdio: 'ignore' });
const http = async (m, p, { token, body } = {}) => { const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token; const r = await fetch(base + p, { method: m, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => null) }; };
const login = async (e, pw, tab) => (await http('POST', '/api/auth/login', { body: { email: e + '@elitetaxation.co.nz', password: pw, expectedTab: tab } })).j.token;
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/webhooks/health')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 500)); }
  const SA = await login('shubham', 'Shubham@2026', 'admin'), PA = await login('parvinder', 'Parvinder@2026', 'admin'), RJ = await login('ranjit', 'Ranjit@2026', 'employee');
  const E = (await http('GET', '/api/employees', { token: SA })).j.employees, emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
  await http('PATCH', '/api/employees/' + emp('parvinder').id, { token: SA, body: { dashboardV2: true } });
  const cl = (await http('POST', '/api/clients', { token: SA, body: { name: 'UI Test Ltd', email: 'ui@t.co' } })).j.client.id;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await browser.newContext({ viewport: { width: 700, height: 800 } })).newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.addInitScript(t => { try { sessionStorage.setItem('governanceOsToken', t); } catch (e) {} }, PA);
  await page.goto(base + '/');
  await page.waitForFunction(() => typeof showView === 'function' && typeof session !== 'undefined' && !!session);
  await new Promise(r => setTimeout(r, 1000));
  // The shape in the screenshot: sent back for correction, a client query on 08 Oct resolved on 09 Oct (day-only), and a NEW hold at 1:36 pm on 09 Oct that is still open.
  const r = await page.evaluate(() => {
    const t = { id: 'T-X', name: 'GST Return', clientName: 'Flower Hub', assignedTo: session.id, status: 'on_hold', reviewStatus: 'error', reworkCount: 1, logged: 1, tat: 2, allocatedHours: 2,
      holdHistory: [
        { heldAt: '2026-10-08T06:00:00.000Z', reasonCode: 'CLIENT_QUERY', reason: 'Query', by: 'Ranjit Choudhary', resumedAt: '2026-10-09', queryId: 'q1' },
        { heldAt: '2026-10-09T00:36:00.000Z', reasonCode: 'BLOCKED_OTHER', reason: 'Discuss with parvindr sir', by: 'Ranjit Choudhary', resumedAt: null } ],
      queries: [{ id: 'q1', reasonCode: 'CLIENT_QUERY', sentAt: '2026-10-08', sentTs: '2026-10-08T06:00:00.000Z', replyAt: '2026-10-09', replySource: 'email', resumedAt: '2026-10-09' }] };
    window.__t = t; tasks.push(t);
    const { ev } = taskTimelineEvents(t);
    openTaskTrailModal('T-X');
    return { order: ev.map(e => e.text.replace(/<[^>]+>/g, '').slice(0, 60)), now: document.querySelector('#modalBox .modal-sub').textContent };
  });
  console.log(JSON.stringify(r, null, 1));
  const last = r.order[r.order.length - 1];
  ok(/put it on hold/.test(last), 'the open 1:36 pm hold is the LAST event (the day-only resume no longer jumps after it)');
  ok(/now: On hold/.test(r.now), 'header says On hold, not In rework: ' + r.now);
  await browser.close(); child.kill(); process.exit(fails ? 1 : 0);
})();
