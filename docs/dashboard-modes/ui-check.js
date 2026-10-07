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
  const mk = async (name, clientDate, finish) => {
    const t = await http('POST', '/api/tasks', { token: SA, body: { mode: 'team', name, clientId: cl, assignedTo: emp('ranjit').id, tat: 2, internalDeadline: '2026-10-30', clientDate } });
    const id = t.j.task.id, q = encodeURIComponent(id);
    await http('POST', `/api/tasks/${q}/accept`, { token: RJ });
    if (finish) await http('POST', `/api/tasks/${q}/complete`, { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x' } });
    return id;
  };
  await mk('Alpha return', '2026-09-01', true); await mk('Beta return', '2026-12-30', true); await mk('Gamma open', '2026-12-30', false);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.addInitScript(t => { try { sessionStorage.setItem('governanceOsToken', t); } catch (e) {} }, PA);
  await page.goto(base + '/');
  await page.waitForFunction(() => typeof showView === 'function' && typeof session !== 'undefined' && !!session);
  await page.evaluate(() => showView('today', document.querySelector('[data-view="today"]')));
  await page.waitForSelector('[role=tablist]');
  const labels = () => page.$$eval('#tdBody .td-count .l', els => els.map(e => e.textContent));
  const tabs = () => page.$$eval('[role=tab]', els => els.map(e => e.textContent + ':' + e.getAttribute('aria-selected')));
  ok(JSON.stringify(await tabs()) === JSON.stringify(['Today:true', 'Manager View:false', 'Review View:false']), 'tabs are role=tab with aria-selected');
  const L = { today: ['Needs My Review', 'Client Delivery at Risk', 'Waiting for My Decision', 'Reports I Must Send', 'My Overdue Actions', 'Actions Completed Today'], manager: ['Team Delivery at Risk', 'Team Overdue', 'Reviews Blocking Delivery', 'Reports Not Sent', 'Waiting on Client', 'Needs Manager Attention'], review: ['Urgent Reviews', 'New Submissions', 'Corrections Resubmitted', 'Waiting on Employee Correction', 'Reviews Completed Today', 'Review SLA Breached'] };
  ok(JSON.stringify(await labels()) === JSON.stringify(L.today), 'Today shows only the Today tiles');
  await page.screenshot({ path: path.join(SHOTS, '1-today.png') });
  // open a task, then switch view: everything from the old view must be gone
  await page.click('#tdList .td-card'); ok(await page.$$eval('#tdDetail h3', e => e.length) === 1, 'one task detail open');
  await page.click('#tdList .td-card >> nth=1').catch(() => {});
  ok(await page.$$eval('#tdDetail h3', e => e.length) === 1, 'selecting another task REPLACES the detail (still one panel)');
  await page.click('#tdTab_manager');
  ok(JSON.stringify(await labels()) === JSON.stringify(L.manager), 'Manager View removes the Today tiles and shows only Manager tiles');
  ok(await page.$$eval('#tdDetail h3', e => e.length) === 0, 'changing view closes the selected task');
  ok(await page.$$eval('.td-count.on', e => e.length) === 0, 'no tile is selected after switching');
  await page.screenshot({ path: path.join(SHOTS, '2-manager.png') });
  // tile: only one selected, list matches count
  const n = +(await page.$eval('#tdBody .td-count >> nth=3', e => e.querySelector('.n').textContent).catch(async () => 0));
  await page.click('#tdBody .td-count >> nth=1');
  await page.click('#tdBody .td-count >> nth=0');
  ok(await page.$$eval('.td-count.on', e => e.length) === 1, 'only one tile is selected');
  ok((await page.$eval('.td-count.on .l', e => e.textContent)) === 'Team Delivery at Risk', 'and it is the one just clicked');
  const cnt = +(await page.$eval('.td-count.on .n', e => e.textContent)), cards = await page.$$eval('#tdList .td-card', e => e.length);
  ok(cnt > 0 && cnt === cards, 'tile count (' + cnt + ') = cards in the list (' + cards + ')');
  await page.screenshot({ path: path.join(SHOTS, '2b-manager-tile.png') });
  await page.click('#tdList .td-card'); await page.screenshot({ path: path.join(SHOTS, '2c-manager-detail.png') });
  await page.click('#tdTab_review');
  ok(JSON.stringify(await labels()) === JSON.stringify(L.review), 'Review View removes the Manager tiles and shows only Review tiles');
  ok(await page.$$eval('.td-count.on', e => e.length) === 0, 'tile selection cleared on view change');
  await page.screenshot({ path: path.join(SHOTS, '3-review.png') });
  // keyboard arrows
  await page.focus('#tdTab_review'); await page.keyboard.press('ArrowRight');
  ok((await page.$eval('#tdTab_today', e => e.getAttribute('aria-selected'))) === 'true', 'ArrowRight moves to the next tab (wraps) and selects it');
  await page.keyboard.press('ArrowLeft');
  ok((await page.$eval('#tdTab_review', e => e.getAttribute('aria-selected'))) === 'true', 'ArrowLeft goes back');
  // accordion: only one secondary open
  const heads = await page.$$('.td-acc-h');
  if (heads.length >= 2) { await heads[0].click(); await (await page.$$('.td-acc-h'))[1].click(); ok(await page.$$eval('.td-acc-h[aria-expanded=true]', e => e.length) === 1, 'only one secondary section open at a time'); }
  else console.log('SKIP accordion (fewer than 2 secondary sections with data)');
  // search
  await page.click('#tdTab_today');
  await page.fill('#tdSearch', 'alpha');
  const found = await page.$$eval('#tdList .td-card', e => e.map(x => x.textContent));
  ok(found.length >= 1 && found.every(t => /alpha/i.test(t)), 'search filters the lists');
  await page.click('#tdTab_manager'); ok((await page.$eval('#tdSearch', e => e.value)) === '', 'search is cleared when the view changes');
  // refresh restores the saved mode
  await page.reload(); await page.waitForFunction(() => typeof showView === 'function' && typeof session !== 'undefined' && !!session);
  await page.evaluate(() => showView('today', document.querySelector('[data-view="today"]'))); await page.waitForSelector('[role=tablist]');
  ok((await page.$eval('#tdTab_manager', e => e.getAttribute('aria-selected'))) === 'true', 'refresh restores the saved view');
  // page search on a list page that had none (Employees), and newest-first on the manager Tasks list
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => showView('employees', document.querySelector('[data-view="employees"]')));
  console.log('active view:', await page.evaluate(() => document.querySelector('.view.active').id));
  await page.waitForSelector('#view-employees .pg-search input', { state: 'attached' });
  console.log('active after wait:', await page.evaluate(() => document.querySelector('.view.active').id + ' | grid kids ' + document.querySelectorAll('#employeeGrid > *').length + ' | modal ' + document.getElementById('modalOverlay').classList.contains('active')));
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  console.log('children', await page.evaluate(() => [...document.querySelectorAll('#employeeGrid > *')].map(e => e.tagName + '.' + e.className + ':' + e.textContent.length)));
  const before = await page.$$eval('#employeeGrid > *', e => e.filter(r => r.style.display !== 'none').length);
  await page.fill('#view-employees .pg-search input', 'ranjit');
  const after = await page.$$eval('#employeeGrid > *', e => e.filter(r => r.style.display !== 'none').length);
  ok(before > 1 && after >= 1 && after < before, 'page search filters the Employees list (' + before + ' -> ' + after + ')');
  ok((await page.$eval('#view-employees .pg-count', e => e.textContent)).includes('shown'), 'and says how many are shown');
  const r = await http('GET', '/api/workflow/tasks?pageSize=25', { token: PA });
  console.log('order', JSON.stringify(r.j.rows.map(x => [x.id, x.createdAt, x.name])));
  const ids = (r.j.rows || r.j.tasks || r.j.items || []).map(x => x.id); ok(ids.length >= 2 && ids.join() === ids.slice().sort().reverse().join(), 'manager Tasks list is newest first by default');
  await browser.close(); child.kill(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); try { child.kill(); } catch (x) {} process.exit(2); });
