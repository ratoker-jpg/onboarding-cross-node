const REAL_CALL_SUFFIX = {
  real_call_start: 'REAL-START',
  real_call_middle: 'REAL-MID',
  real_call_final: 'REAL-FINAL',
};

function sanitizeProductCode(value, fallback = 'BOT') {
  const raw = String(value || fallback).trim().toUpperCase();
  const cleaned = raw.replace(/[^A-Z0-9]/g, '');
  return cleaned || fallback;
}

function padSequence(value) {
  return String(value).padStart(2, '0');
}

function parseBaseKeyNumber(baseKey, prefix) {
  const match = String(baseKey || '').match(new RegExp(`^${prefix}(\\d+)$`));
  return match ? Number(match[1]) : 0;
}

function buildNextBaseKey(lastBaseKey, prefix) {
  const nextNumber = parseBaseKeyNumber(lastBaseKey, prefix) + 1;
  return `${prefix}${String(nextNumber).padStart(2, '0')}`;
}

function buildSessionKey(baseKey, keyInput, keysRepo) {
  const keyType = String(keyInput.key_type || '').trim();
  if (keyType === 'test_day') return `${baseKey}-TD`;
  if (keyType === 'immersion') return `${baseKey}-IMM`;
  if (REAL_CALL_SUFFIX[keyType]) return `${baseKey}-${REAL_CALL_SUFFIX[keyType]}`;
  if (keyType === 'training_bot') {
    const productCode = sanitizeProductCode(keyInput.product_code, 'BOT');
    const nextIndex = keysRepo.countByType(baseKey, keyType, productCode) + 1;
    return `${baseKey}-${productCode}-${padSequence(nextIndex)}`;
  }
  const productCode = sanitizeProductCode(keyInput.product_code, 'OTHER');
  const nextIndex = keysRepo.countByType(baseKey, keyType, productCode) + 1;
  return `${baseKey}-${productCode}-${padSequence(nextIndex)}`;
}

function normalizeKeyInput(baseKey, candidateId, input, keysRepo) {
  const now = new Date().toISOString();
  const finalEqualsLimit = Boolean(input.final_equals_limit);
  const limitValue = input.limit_value === undefined || input.limit_value === null || input.limit_value === ''
    ? null
    : Number(input.limit_value);
  const requestedFinalLimit = input.final_limit === undefined || input.final_limit === null || input.final_limit === ''
    ? null
    : Number(input.final_limit);
  const finalLimit = finalEqualsLimit ? limitValue : requestedFinalLimit;

  return {
    candidate_id: candidateId,
    base_key: baseKey,
    session_key: buildSessionKey(baseKey, input, keysRepo),
    key_type: String(input.key_type || '').trim(),
    product_code: input.product_code ? sanitizeProductCode(input.product_code) : null,
    team_id: input.team_id ? String(input.team_id).trim() : null,
    team_name: input.team_name ? String(input.team_name).trim() : null,
    legacy_target: input.legacy_target ? String(input.legacy_target).trim() : null,
    limit_value: Number.isFinite(limitValue) ? limitValue : null,
    final_limit: Number.isFinite(finalLimit) ? finalLimit : null,
    final_equals_limit: finalEqualsLimit ? 1 : 0,
    status: String(input.status || 'active').trim() || 'active',
    created_at: now,
    updated_at: now,
  };
}

module.exports = {
  buildNextBaseKey,
  normalizeKeyInput,
};
