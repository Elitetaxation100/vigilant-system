const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('./policy-compliance');

const valid = (overrides = {}) => ({ version: 1, event: 'policy.compliance.updated',
  employee: { crm_user_id: 'crm-1', email: 'person@example.com' },
  compliance: { pending_count: 1, compliant: false }, policy: {}, ...overrides });

test('valid compliance webhook payload', () => assert.equal(policy.validatePayload(valid()).ok, true));
test('invalid secret is rejected by constant-time verifier', () => assert.equal(policy.secretsEqual('wrong', 'right'), false));
test('employee is matched by crmUserId', () => {
  const employee = { id: 'e1', crmUserId: 'crm-1', email: 'other@example.com' };
  assert.equal(policy.findEmployee({ employees: [employee] }, 'crm-1', 'person@example.com').employee, employee);
});
test('legacy unique email fallback links crmUserId', () => {
  const employee = { id: 'e1', email: 'Person@Example.com' }; const state = { employees: [employee] };
  const parsed = policy.validatePayload(valid()); const result = policy.applyCompliance(state, parsed, '2026-01-01T00:00:00.000Z');
  assert.equal(result.linkedByEmail, true); assert.equal(employee.crmUserId, 'crm-1');
});
test('ambiguous email fallback does not guess', () => {
  const employees = [{ email: 'person@example.com' }, { email: 'PERSON@example.com' }];
  assert.equal(policy.findEmployee({ employees }, 'missing', 'person@example.com').employee, null);
});
test('pending policy blocks a normal employee', () => assert.equal(policy.isBlocked({ policyCompliance: { compliant: false, pendingCount: 3 } }), true));
test('HTTP 423 response is returned only for blocked normal employees', () => {
  const blocked = policy.lockResponse({ accessRole: 'employee', policyCompliance: { compliant: false, pendingCount: 2 } });
  assert.equal(blocked.status, 423); assert.deepEqual(blocked.body, { error: 'policy_acknowledgement_required', pendingCount: 2 });
  assert.equal(policy.lockResponse({ accessRole: 'admin', policyCompliance: { compliant: false, pendingCount: 2 } }), null);
});
test('compliant state unlocks and replay stays idempotent', () => {
  const employee = { id: 'e1', crmUserId: 'crm-1', email: 'person@example.com' }; const state = { employees: [employee] };
  const parsed = policy.validatePayload(valid({ compliance: { pending_count: 0, compliant: true } }));
  policy.applyCompliance(state, parsed); policy.applyCompliance(state, parsed);
  assert.equal(state.employees.length, 1); assert.equal(policy.isBlocked(employee), false);
});
test('multiple pending policies remain blocked', () => assert.equal(policy.isBlocked({ policyCompliance: { compliant: false, pendingCount: 2 } }), true));
test('fallback reconciliation uses server credentials and updates state', async () => {
  const employee = { crmUserId: 'crm-1' }; let authorization = '';
  const result = await policy.reconcileEmployee(employee, { apiUrl: 'https://crm.test', apiKey: 'server-only', fetcher: async (_url, options) => {
    authorization = options.headers.Authorization; return { ok: true, json: async () => ({ ok: true, compliant: true, pending_count: 0, checked_at: '2026-01-01T00:00:00.000Z' }) };
  } });
  assert.equal(result.ok, true); assert.equal(authorization, 'Bearer server-only'); assert.equal(employee.policyCompliance.compliant, true);
});
test('CRM API key is never present in browser source', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  assert.equal(html.includes('CRM_API_KEY'), false);
});

test('malformed payloads are rejected', () => {
  assert.equal(policy.validatePayload({ version: 2, event: 'policy.compliance.updated' }).ok, false);
  assert.equal(policy.validatePayload(valid({ compliance: { pending_count: '1', compliant: false } })).ok, false);
});
