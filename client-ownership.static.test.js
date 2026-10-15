// The Clients page is two tabs (Client ownership, Client directory); a client name opens a profile with four sub-tabs; tasks carry a financial year.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8').replace(/\r\n/g, '\n');

test('Clients opens on Client ownership; the directory (add, edit, owner, remove) is the second tab and nothing in it is lost', () => {
  const v = html.slice(html.indexOf('id="view-clients"'), html.indexOf('id="view-cprofile"'));
  assert.ok(v.includes('id="coTabOwn"') && v.includes('Client ownership') && v.includes('id="coTabDir"') && v.includes('Client directory'));
  assert.ok(v.includes('id="coOwnership"') && v.includes('id="clDirectory"'));
  for (const s of ['openAddClientModal()', 'id="clientSearch"', 'id="clientTypeFilter"', 'id="clientOwnerFilter"', 'id="clientGrid"']) assert.ok(v.includes(s), s);
  assert.ok(html.includes("if(id === 'clients') renderClientsPage();") && html.includes("if(id === 'cprofile') renderClientProfile();"));
  for (const s of ["openEditClientModal('${c.id}')", "openAssignClientOwner('${c.id}')", "removeClient('${c.id}'"]) assert.ok(html.includes(s), s);
});

test('ownership screen: clients per owner (largest red), the owner\'s four numbers, the checklist list, and the explanation', () => {
  const fn = html.slice(html.indexOf('function drawOwnership('), html.indexOf('/* ---------- the client profile'));
  for (const s of ['Client ownership', 'Clients per owner (', 'Counted from the Client Directory', 'Clients owned', 'With late work', 'Waiting on client', 'Up to date', 'Red = the largest list', 'Yearly checklist', 'Next due', 'How it works:', 'accountable for every row']) assert.ok(fn.includes(s), s);
  assert.ok(fn.includes("i === 0 && d.maxCount > 0 ? ' big'"), 'only the largest list is red');
  assert.ok(fn.includes('cpOpen('), 'a client name opens the profile');
});

test('profile: header pills, owner / email / hours / open tasks, four sub-tabs, history by year, checklist and hours cards, edit and new task', () => {
  const fn = html.slice(html.indexOf('function drawClientProfile('), html.indexOf('function cpNewTask('));
  for (const s of ['GST registered', 'Balance date', '>Owner<', '>Email<', 'Hours this year', 'Open tasks', 'Work history', 'Yearly checklist', 'Hours & fee', 'Notes & documents', '+ New task for this client', 'openEditClientModal(', 'Yearly fee', 'Hours spent']) assert.ok(fn.includes(s) || html.includes(s), s);
  assert.ok(fn.includes("cpChecklistHtml(d.checklist, 'Yearly checklist '") && fn.includes("class=\"co-yr\""), 'history is grouped by year next to the checklist');
  assert.ok(fn.includes('d.canSeeFee') && fn.includes('d.canSeeMore'), 'fee, notes and documents are only drawn for those allowed');
});

test('a task carries the financial year: a picker on New task (under More options on the simple form), an optional client on an Admin task, and a way to change it on the profile', () => {
  assert.ok(html.includes('id="atFY"') && html.includes('function atFYOptions()') && html.includes('payload.financialYear = fyPick'));
  assert.ok(html.includes("fieldOf('atPriority'), fieldOf('atFY'), $('atClientDateWrap')"), 'the simple form keeps it under More options');
  assert.ok(html.includes("refw.style.display = internal ? '' : 'none'") && html.includes("iref.style.display = isInternal ? '' : 'none'"), 'an Admin task can name its client');
  assert.ok(html.includes('/financial-year') && html.includes('function cpSetFY('));
});

test('edit client has GST registered and the balance date; the directory name opens the profile', () => {
  assert.ok(html.includes('id="ecGst"') && html.includes('id="ecBalM"') && html.includes('id="ecBalD"') && html.includes("gstRegistered: document.getElementById('ecGst').checked"));
  assert.ok(html.includes('class="co-link" onclick="cpOpen(\'${c.id}\')"'));
});
