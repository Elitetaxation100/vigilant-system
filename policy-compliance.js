const crypto = require('crypto');

const STALE_MS = 5 * 60 * 1000;

function secretsEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function validatePayload(body) {
  if (!body || body.version !== 1 || body.event !== 'policy.compliance.updated') return { ok: false, error: 'Unsupported policy compliance event.' };
  const crmUserId = String(body.employee && body.employee.crm_user_id || '').trim();
  const pendingCount = body.compliance && body.compliance.pending_count;
  const compliant = body.compliance && body.compliance.compliant;
  if (!crmUserId) return { ok: false, error: 'employee.crm_user_id is required.' };
  if (typeof pendingCount !== 'number' || !Number.isFinite(pendingCount) || pendingCount < 0) return { ok: false, error: 'compliance.pending_count must be a non-negative number.' };
  if (typeof compliant !== 'boolean') return { ok: false, error: 'compliance.compliant must be boolean.' };
  return { ok: true, crmUserId, email: String(body.employee.email || '').trim().toLowerCase(), pendingCount, compliant };
}

function findEmployee(state, crmUserId, email) {
  const direct = (state.employees || []).find(employee => employee.crmUserId === crmUserId);
  if (direct) return { employee: direct, linkedByEmail: false };
  if (!email) return { employee: null, linkedByEmail: false };
  const matches = (state.employees || []).filter(employee => String(employee.email || '').trim().toLowerCase() === email);
  return matches.length === 1 ? { employee: matches[0], linkedByEmail: true } : { employee: null, linkedByEmail: false };
}

function applyCompliance(state, validated, now = new Date().toISOString(), policy = {}) {
  const match = findEmployee(state, validated.crmUserId, validated.email);
  if (!match.employee) return { ok: false, status: 404, error: 'Linked employee not found or email match is ambiguous.' };
  if (match.linkedByEmail) match.employee.crmUserId = validated.crmUserId;
  match.employee.policyCompliance = { compliant: validated.compliant, pendingCount: validated.pendingCount, lastSyncedAt: now };
  match.employee.lastPolicyVersionId = policy.version_id || null;
  match.employee.lastPolicyName = policy.name || null;
  return { ok: true, employee: match.employee, linkedByEmail: match.linkedByEmail };
}

function isBlocked(employee) {
  const compliance = employee && employee.policyCompliance;
  return !!compliance && (compliance.compliant === false || Number(compliance.pendingCount) > 0);
}

function lockResponse(employee) {
  if (!employee || employee.accessRole !== 'employee' || !isBlocked(employee)) return null;
  return { status: 423, body: { error: 'policy_acknowledgement_required', pendingCount: Number(employee.policyCompliance.pendingCount) || 0 } };
}

function isStale(employee, now = Date.now()) {
  const syncedAt = employee && employee.policyCompliance && Date.parse(employee.policyCompliance.lastSyncedAt || '');
  return !Number.isFinite(syncedAt) || now - syncedAt > STALE_MS;
}

async function reconcileEmployee(employee, options = {}) {
  const apiUrl = options.apiUrl || process.env.CRM_API_URL;
  const apiKey = options.apiKey || process.env.CRM_API_KEY;
  const fetcher = options.fetcher || fetch;
  if (!apiUrl || !apiKey || !employee.crmUserId) return { ok: false, skipped: 'not_configured_or_unlinked' };
  const response = await fetcher(apiUrl, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get-policy-compliance', crm_user_id: employee.crmUserId }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) return { ok: false, status: response.status, error: result.error || 'CRM compliance check failed.' };
  employee.policyCompliance = { compliant: result.compliant === true, pendingCount: Number(result.pending_count) || 0,
    lastSyncedAt: result.checked_at || new Date().toISOString() };
  return { ok: true, policyCompliance: employee.policyCompliance };
}

module.exports = { STALE_MS, secretsEqual, validatePayload, findEmployee, applyCompliance, isBlocked, lockResponse, isStale, reconcileEmployee };
