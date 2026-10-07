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
  const mine = async (name, state) => {
    const t = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId: cl, assignedTo: emp('parvinder').id, tat: 0.25, internalDeadline: '2026-12-20', clientDate: '2026-12-30' } });
    if (t.s !== 201) console.log('CREATE FAILED', name, t.s, JSON.stringify(t.j).slice(0, 200));
    const id = t.j.task.id, q = encodeURIComponent(id);
    if (state !== 'new') await http('POST', `/api/tasks/${q}/accept`, { token: PA });
    if (state === 'hold') await http('POST', `/api/tasks/${q}/hold`, { token: PA, body: { reasonCode: 'CLIENT_QUERY', detail: 'asked', responsibility: 'client', followUpDate: '2026-10-12' } });
    return id;
  };
  const idNew = await mine('GST Return', 'progress');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.addInitScript(t => { try { sessionStorage.setItem('governanceOsToken', t); } catch (e) {} }, PA);
  await page.goto(base + '/');
  await page.waitForFunction(() => typeof showView === 'function' && typeof session !== 'undefined' && !!session);
  await page.evaluate(() => showView('today', document.querySelector('[data-view="today"]')));
  await page.waitForSelector('[role=tablist]'); await new Promise(r => setTimeout(r, 1500));
  await page.click('#tdBody .td-count:has-text("My Work")');
  await page.click('#tdList .td-row:has-text("GST Return")'); await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SHOTS, 'panel-structured.png') });
  await browser.close(); child.kill(); process.exit(0);
})();
