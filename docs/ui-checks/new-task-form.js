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
  await new Promise(r => setTimeout(r, 1500));
  page.on('pageerror', e => console.log('PAGEERROR', e.message)); page.on('console', m => { if(m.type()==='error') console.log('CONSOLE', m.text()); });
  await page.evaluate(() => openNewTask('choose'));
  await page.waitForSelector('#atName');
  const vis = id => page.evaluate(i => { const e = document.getElementById(i); if(!e) return null; return !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }, id);
  const openDetails = () => page.evaluate(() => document.querySelector('details.at-more').open);
  // CLIENT TASK — everything the spec lists is on the main form (not hidden under More)
  const main = { client:'atClientId', name:'atName', assignee:'atAssignee', reviewer:'atReviewer', due:'atDeadline', clientDate:'atClientDate', hours:'atTat', priority:'atPriority', instructions:'atInstructions', reportReq:'atV2Delivery', sender:'atReportSender' };
  for (const [k, id] of Object.entries(main)) ok(await vis(id) === true, 'client task shows ' + k + ' without opening More');
  ok(await openDetails() === false, 'Supporting work is collapsed');
  ok(await page.evaluate(() => document.querySelector('details.at-more summary').textContent.includes('Supporting work')), 'collapsible is named Supporting work');
  // ADMIN TASK
  await page.click('.atKindBtn[data-kind=internal]');
  for (const id of ['atClientId', 'atClientDate', 'atV2Delivery', 'atReportSender', 'atInternalRefWrap', 'atCashWrap']) ok(await vis(id) !== true, 'admin task hides ' + id);
  for (const id of ['atName', 'atAssignee', 'atDeadline', 'atTat', 'atPriority', 'atInstructions', 'atReviewReq']) ok(await vis(id) === true, 'admin task shows ' + id);
  ok(await vis('atReviewer') !== true, 'admin: reviewer hidden until review is required');
  await page.check('#atReviewReq');
  ok(await vis('atReviewer') === true, 'admin: reviewer appears when review is required');
  await page.uncheck('#atReviewReq');
  // back to client: reviewer-later flow
  await page.click('.atKindBtn[data-kind=client]');
  await page.fill('#atName', 'UI created task');
  await page.fill('#atClientId', 'UI Test Ltd');
  await page.selectOption('#atAssignee', { label: await page.$eval('#atAssignee option:nth-child(3)', e => e.textContent) });
  await page.click('#atReviewerLater'); ok(await vis('atReviewerLaterReason') === true, 'later: a reason box appears'); ok(await page.$eval('#atReviewer', e => e.disabled), 'later: reviewer select disabled');
  await page.click('#atSubmitBtn');
  ok((await page.$eval('#assignError', e => e.textContent)).includes('Say why'), 'later without a reason is refused on the page');
  await new Promise(r => setTimeout(r, 1500));   // the page ignores a second click on the same button within a moment
  await page.fill('#atReviewerLaterReason', 'Waiting to see who is free');
  await page.selectOption('#atPriority', 'high'); await page.fill('#atInstructions', 'From the UI');
  await page.check('input[name=atProfitReq][value=yes]');
  await page.evaluate(() => { document.getElementById('atAcceptOverload') && (document.getElementById('atAcceptOverload').checked = true); });
  await page.evaluate(() => { const e = document.getElementById('assignError'); e.textContent = 'CLEARED'; });
  page.on('response', r => { if(r.url().includes('/api/tasks')) r.text().then(t => console.log('RESP', r.request().method(), r.status(), t.slice(0, 200))).catch(() => {}); });
  await page.click('#atSubmitBtn');
  await new Promise(r => setTimeout(r, 2500));
  const made = (await http('GET', '/api/tasks', { token: PA })).j.tasks.find(t => t.name === 'UI created task');
  ok(!!made && made.priority === 'high' && made.instructions === 'From the UI' && made.profitRequiredDefault === true && !!made.reviewerLater, 'the UI created the task with priority, instructions, profit default and reviewer-later: ' + JSON.stringify(made && { p: made.priority, i: made.instructions, pr: made.profitRequiredDefault, rl: !!made.reviewerLater }));
  await page.screenshot({ path: path.join(SHOTS, 'newtask-after.png') });
  await browser.close(); child.kill(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); try { child.kill(); } catch (x) {} process.exit(2); });
