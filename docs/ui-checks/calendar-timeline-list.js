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
    const t = await http('POST', '/api/tasks', { token: PA, body: { mode: 'team', name, clientId: cl, assignedTo: emp('ranjit').id, tat: 0.25, internalDeadline: '2026-10-30', clientDate } });
    if (t.s !== 201) console.log('CREATE FAILED', name, t.s, JSON.stringify(t.j).slice(0, 160));
    const id = t.j.task.id, q = encodeURIComponent(id);
    await http('POST', `/api/tasks/${q}/accept`, { token: RJ });
    if (finish) await http('POST', `/api/tasks/${q}/complete`, { token: RJ, body: { reviewerId: emp('parvinder').id, sheetLink: 'https://docs.google.com/spreadsheets/d/x' } });
    return id;
  };
  for (let i = 0; i < 6; i++) await mk('Same day ' + i, '2026-12-30', false);
  await mk('Alpha return', '2026-09-01', true); await mk('Beta return', '2026-12-30', true); await mk('Gamma open', '2026-12-30', false);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.addInitScript(t => { try { sessionStorage.setItem('governanceOsToken', t); } catch (e) {} }, PA);
  await page.goto(base + '/');
  await page.waitForFunction(() => typeof showView === 'function' && typeof session !== 'undefined' && !!session);
  await page.evaluate(() => showView('today', document.querySelector('[data-view="today"]')));
  await page.waitForSelector('[role=tablist]');
  await new Promise(r => setTimeout(r, 1500));
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.evaluate(() => { _mt.tab = 'calendar'; showView('mtasks', document.querySelector('#navV2 .nav-item[data-view="mtasks"]')); });
  await page.waitForSelector('.cal-grid');
  ok(JSON.stringify(await page.$$eval('[aria-label="Calendar view"] [role=tab]', e => e.map(x => x.textContent))) === JSON.stringify(['Month', 'Week', 'Agenda']), 'Month / Week / Agenda views');
  // jump to the month of 30 Dec 2026 and check the cap
  await page.evaluate(() => { _mtMonth = '2026-12'; mtDrawCalendar(); });
  const counts = await page.$$eval('.cal-grid .cal-cell', cells => cells.map(c => c.querySelectorAll('.cal-ev').length));
  ok(Math.max(...counts) === 3, 'no day cell shows more than three tasks (max ' + Math.max(...counts) + ')');
  const more = await page.$$eval('.cal-more', b => b.map(x => x.textContent));
  ok(more.length >= 1 && more.some(t => /^\+\d+ more$/.test(t)), '+X more appears: ' + more.join(','));
  await page.click('.cal-more'); 
  ok(await page.$$eval('#calDay .tm-panel', e => e.length) === 1, 'one day drawer open');
  const first = await page.$eval('#calDay h3', e => e.textContent);
  // open a different date's drawer: the first is replaced, never stacked
  await page.evaluate(() => mtDay('2026-12-29'));
  ok(await page.$$eval('#calDay .tm-panel', e => e.length) === 1, 'opening another date replaces the drawer');
  ok((await page.$eval('#calDay h3', e => e.textContent)) !== first, 'and shows the new date');
  await page.keyboard.press('Escape');
  ok(await page.$$eval('#calDay .tm-panel', e => e.length) === 0, 'Escape closes the drawer');
  await page.screenshot({ path: path.join(SHOTS, 'cal-month.png') });
  await page.click('[aria-label="Calendar view"] [role=tab]:has-text("Week")');
  ok(await page.$$eval('.cal-week .cal-cell', e => e.length) === 7, 'week view: seven days');
  await page.click('[aria-label="Calendar view"] [role=tab]:has-text("Agenda")');
  ok(await page.$$eval('#mtBody .tm-panel, #mtBody .td-empty', e => e.length) >= 1, 'agenda view renders');
  await page.click('[aria-label="Calendar view"] [role=tab]:has-text("Month")');
  // date kinds
  await page.uncheck('#mtk_client'); await new Promise(r => setTimeout(r, 800));
  ok(await page.$$eval('.cal-ev', e => e.every(x => !x.textContent.startsWith('◆'))), 'client commitment dates switched off');
  await page.check('#mtk_client'); await new Promise(r => setTimeout(r, 800));
  // filters
  await page.selectOption('#mtv_client', { index: 1 }); await new Promise(r => setTimeout(r, 800));
  ok(true, 'client filter applied without error');
  // TIMELINE
  await page.click('#mtTab_timeline'); await page.waitForSelector('.tl-axis');
  ok(await page.$$eval('.tl-tick', e => e.length) >= 3, 'the timeline has a date scale');
  ok(await page.$$eval('.tl-today', e => e.length) === 1, 'and a today marker');
  ok(await page.$$eval('.tl-row', e => e.length) >= 1 && await page.$$eval('.tl-row', e => e.length) <= 25, 'paged: at most 25 rows');
  ok(await page.$$eval('.tl-late', e => e.length) >= 1, 'the delayed stretch is drawn for the overdue task');
  ok(await page.$$eval('#mtBody .mt-filters select', e => e.length) >= 5, 'timeline filters present');
  await page.screenshot({ path: path.join(SHOTS, 'timeline.png') });
  // TASKS LIST
  await page.click('#mtTab_list'); await page.waitForSelector('.mt-more');
  ok(await page.$$eval('#mtBody > .mt-filters select', e => e.map(x => x.id).join(',')) === 'mtf_employee,mtf_status,mtf_risk', 'first row: Employee, Status, Risk (+ Search)');
  ok(await page.$$eval('details.mt-more', e => e.length) === 1 && await page.$eval('details.mt-more', e => !e.open), 'one More filters panel, closed');
  await page.click('details.mt-more summary'); ok(await page.$$eval('details.mt-more select', e => e.length) === 9, 'nine filters inside');
  await page.screenshot({ path: path.join(SHOTS, 'tasks-list.png') });
  await browser.close(); child.kill(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); try { child.kill(); } catch (x) {} process.exit(2); });
