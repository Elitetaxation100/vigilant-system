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
  const SA = await login('shubham', 'Shubham@2026', 'admin'), PA = await login('shubham', 'Shubham@2026', 'admin'), RJ = await login('ranjit', 'Ranjit@2026', 'employee');
  const E = (await http('GET', '/api/employees', { token: SA })).j.employees, emp = n => E.find(e => e.email === n + '@elitetaxation.co.nz');
  await http('PATCH', '/api/employees/' + emp('parvinder').id, { token: SA, body: { dashboardV2: true } });
  const cl = (await http('POST', '/api/clients', { token: SA, body: { name: 'UI Test Ltd', email: 'ui@t.co' } })).j.client.id;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.addInitScript(t => { try { sessionStorage.setItem('governanceOsToken', t); } catch (e) {} }, SA);
  await page.goto(base + '/');
  await page.waitForFunction(() => typeof showView === 'function' && typeof session !== 'undefined' && !!session);
  await page.evaluate(() => { showView('kudos', document.querySelector('[data-view="kudos"]')); setRecTab('marks'); });
  await page.waitForSelector('#marksGivePanel', { state: 'visible' }); await new Promise(r => setTimeout(r, 1500));
  // a real 1x1 PNG, dropped as a file on the snip box
  const drop = (name, type, b64) => page.evaluate(({ name, type, b64 }) => {
    const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer(); dt.items.add(new File([u], name, { type }));
    const z = document.getElementById('markSnipZone');
    z.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const over = z.classList.contains('drag');
    z.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return over;
  }, { name, type, b64 });
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const over = await drop('snip.png', 'image/png', PNG);
  ok(over, 'the box highlights while a file is dragged over it');
  await page.waitForSelector('#markSnipPreview img', { timeout: 5000 });
  ok(true, 'dropping an image attaches it and shows the preview');
  ok(await page.evaluate(() => !!_markShot), 'the snip is held, ready to be sent with the mark');
  await page.screenshot({ path: path.join(SHOTS, 'marks-drop.png') });
  await page.evaluate(() => { _markShot = null; renderMarkSnipPreview(); });
  await drop('notes.txt', 'text/plain', 'aGVsbG8=');
  await new Promise(r => setTimeout(r, 400));
  ok(await page.evaluate(() => !_markShot), 'a non-image file is refused (nothing attached)');
  ok(await page.evaluate(() => !document.getElementById('markSnipZone').classList.contains('drag')), 'the highlight clears after the drop');
  await browser.close(); child.kill(); process.exit(fails ? 1 : 0);
})();
