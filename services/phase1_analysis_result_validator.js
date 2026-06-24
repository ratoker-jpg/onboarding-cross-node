/**
 * Phase 3E0 — Validator for analysis_result_v1 JSON produced by Codex.
 *
 * Validates the JSON document that Codex (or any LLM agent) returns after
 * analysing a candidate bundle. Does NOT compute scores — that's the job of
 * services/phase1_rubric_score_service.js. This module only checks that
 * the document is well-formed and consistent with the rubric.
 *
 * No external dependencies. Pure functions.
 */

'use strict';

const { loadRubric } = require('./phase1_rubric_score_service');

const SCHEMA_VERSION = 'analysis_result_v1';
const ANALYSIS_TYPES = new Set(['interview', 'calls']);
const TYPE_TO_RUBRIC_ID = {
  interview: 'interview_binary_v1',
  calls: 'calls_automanual_binary_v1',
};

// Strings that must never appear in a valid result (basic secret leakage guard).
const FORBIDDEN_SECRET_PATTERNS = [
  /ADMIN_KEY\s*[:=]/i,
  /VIEWER_KEY\s*[:=]/i,
  /ghp_[A-Za-z0-9]{20,}/i,           // GitHub PAT
  /github_pat_[A-Za-z0-9_]{20,}/i,   // GitHub fine-grained PAT
  /AA[A-Za-z0-9_-]{30,}/i,           // Telegram bot token fragment
  /x-access-token:/i,
];

// Optional fields on question_result — anything else is rejected.
const ALLOWED_QUESTION_RESULT_KEYS = new Set([
  'question_id', 'answer', 'evidence', 'quote', 'source', 'source_ref',
]);

// Optional top-level keys — anything else is rejected.
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'schema_version', 'base_key', 'analysis_type', 'rubric_id', 'rubric_version',
  'question_results', 'summary', 'strengths', 'growth_zones', 'red_flags',
  'coach_recommendations', 'risk_flags',
  // Phase 3E3E: calls-only optional fields for stage dynamics
  'stage_dynamics', 'call_results',
]);

/**
 * Validate an analysis_result_v1 document.
 *
 * @param {object} doc - parsed JSON document
 * @param {object} [options]
 * @param {boolean} [options.strictEvidence=true] - require evidence for yes/conflict
 * @returns {{ ok: boolean, errors: string[], warnings: string[], rubric: object|null, doc: object }}
 */
function validateAnalysisResult(doc, options = {}) {
  const errors = [];
  const warnings = [];
  const strictEvidence = options.strictEvidence !== false;

  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: ['document must be a JSON object'], warnings, rubric: null, doc };
  }

  // --- Top-level key allowlist ---
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`unknown_top_level_key:${key}`);
    }
  }

  // --- Required top-level fields ---
  if (doc.schema_version !== SCHEMA_VERSION) {
    errors.push(`invalid_schema_version:expected "${SCHEMA_VERSION}", got "${doc.schema_version}"`);
  }
  if (!doc.base_key || typeof doc.base_key !== 'string') {
    errors.push('base_key must be a non-empty string');
  }
  if (!ANALYSIS_TYPES.has(doc.analysis_type)) {
    errors.push(`invalid_analysis_type:${doc.analysis_type}`);
  }

  // --- Rubric cross-check ---
  let rubric = null;
  if (doc.analysis_type && TYPE_TO_RUBRIC_ID[doc.analysis_type]) {
    const expectedRubricId = TYPE_TO_RUBRIC_ID[doc.analysis_type];
    if (doc.rubric_id && doc.rubric_id !== expectedRubricId) {
      errors.push(`rubric_id_mismatch:analysis_type "${doc.analysis_type}" requires rubric_id "${expectedRubricId}", got "${doc.rubric_id}"`);
    }
    if (!doc.rubric_id) {
      errors.push('rubric_id is required');
    }
    try {
      rubric = loadRubric(expectedRubricId);
      if (doc.rubric_version && doc.rubric_version !== rubric.rubric_version) {
        warnings.push(`rubric_version_mismatch:document says "${doc.rubric_version}", loaded rubric is "${rubric.rubric_version}"`);
      }
    } catch (err) {
      errors.push(`rubric_load_failed:${err.message}`);
    }
  }

  // --- question_results array ---
  if (!Array.isArray(doc.question_results)) {
    errors.push('question_results must be an array');
  } else if (rubric) {
    const rubricQuestionIds = collectRubricQuestionIds(rubric);
    const seenIds = new Set();
    for (let i = 0; i < doc.question_results.length; i++) {
      const qr = doc.question_results[i];
      const prefix = `question_results[${i}]`;
      const qrErrors = validateQuestionResult(qr, rubric, rubricQuestionIds, seenIds, strictEvidence, prefix);
      errors.push(...qrErrors);
    }
    // Check for missing questions (every rubric question must appear)
    for (const qid of rubricQuestionIds) {
      if (!seenIds.has(qid)) {
        errors.push(`missing_question_result:${qid}`);
      }
    }
    // Check for unexpected extra question_ids (already covered by validateQuestionResult,
    // but double-check count mismatch)
    if (doc.question_results.length > rubricQuestionIds.size) {
      warnings.push(`question_results has ${doc.question_results.length} entries, rubric has ${rubricQuestionIds.size} questions`);
    }
  }

  // --- String fields ---
  if (doc.summary != null && typeof doc.summary !== 'string') {
    errors.push('summary must be a string');
  }
  if (doc.summary && doc.summary.length > 1000) {
    warnings.push(`summary is very long (${doc.summary.length} chars)`);
  }
  for (const field of ['strengths', 'growth_zones', 'red_flags', 'coach_recommendations']) {
    if (doc[field] != null) {
      if (!Array.isArray(doc[field])) {
        errors.push(`${field} must be an array`);
      } else {
        for (let i = 0; i < doc[field].length; i++) {
          if (typeof doc[field][i] !== 'string') {
            errors.push(`${field}[${i}] must be a string`);
          } else if (doc[field][i].length > 200) {
            warnings.push(`${field}[${i}] is long (${doc[field][i].length} chars)`);
          }
        }
      }
    }
  }

  // --- risk_flags array (different shape: { code, evidence, quote, source_ref }) ---
  if (doc.risk_flags != null) {
    if (!Array.isArray(doc.risk_flags)) {
      errors.push('risk_flags must be an array');
    } else {
      const validCodes = rubric && rubric.critical_errors
        ? new Set(rubric.critical_errors.map(e => e.code))
        : null;
      for (let i = 0; i < doc.risk_flags.length; i++) {
        const rf = doc.risk_flags[i];
        const prefix = `risk_flags[${i}]`;
        if (!rf || typeof rf !== 'object') {
          errors.push(`${prefix} must be an object`);
          continue;
        }
        if (!rf.code || typeof rf.code !== 'string') {
          errors.push(`${prefix}.code must be a string`);
        } else if (validCodes && !validCodes.has(rf.code)) {
          errors.push(`${prefix}.code unknown: ${rf.code}`);
        }
        if (!rf.evidence || typeof rf.evidence !== 'string') {
          errors.push(`${prefix}.evidence must be a non-empty string`);
        }
        if (rf.quote != null && typeof rf.quote !== 'string') {
          errors.push(`${prefix}.quote must be a string`);
        }
        if (rf.source_ref != null && typeof rf.source_ref !== 'string') {
          errors.push(`${prefix}.source_ref must be a string`);
        }
        // Allow only known keys
        for (const k of Object.keys(rf)) {
          if (!['code', 'evidence', 'quote', 'source_ref'].includes(k)) {
            errors.push(`${prefix} unknown_key:${k}`);
          }
        }
      }
    }
  }

  // --- Secret leakage guard ---
  const docStr = JSON.stringify(doc);
  for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
    const match = docStr.match(pattern);
    if (match) {
      errors.push(`potential_secret_leak:pattern ${match[0]} found in document`);
    }
  }

  // --- Phase 3E3C: calls source boundary guard ---
  // If analysis_type=calls, question_results evidence/source/source_ref must
  // NOT reference training bot dialogs, ROLE-* ids, or result_payload from
  // the training bot. This prevents Codex from analyzing training agents as
  // real calls.
  if (doc.analysis_type === 'calls' && Array.isArray(doc.question_results)) {
    const FORBIDDEN_CALLS_MARKERS = [
      'training_bot', 'training_bot_dialogs', 'bot_training',
      'учебн', 'ROLE-', 'role_id', 'result_payload',
    ];
    for (let i = 0; i < doc.question_results.length; i++) {
      const qr = doc.question_results[i];
      if (!qr) continue;
      const qrStr = JSON.stringify(qr).toLowerCase();
      for (const marker of FORBIDDEN_CALLS_MARKERS) {
        if (qrStr.includes(marker.toLowerCase())) {
          errors.push(`calls_analysis_source_violation:question_results[${i}] contains forbidden marker "${marker}". Calls analysis cannot use training bot dialogs as evidence.`);
          break;
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    rubric,
    doc,
  };
}

function collectRubricQuestionIds(rubric) {
  const ids = new Set();
  const units = rubric.evaluation_unit === 'block' ? rubric.blocks : rubric.stages;
  if (!Array.isArray(units)) return ids;
  for (const unit of units) {
    if (!Array.isArray(unit.questions)) continue;
    for (const q of unit.questions) {
      if (q.question_id) ids.add(q.question_id);
    }
  }
  return ids;
}

function validateQuestionResult(qr, rubric, rubricQuestionIds, seenIds, strictEvidence, prefix) {
  const errors = [];
  if (!qr || typeof qr !== 'object') {
    errors.push(`${prefix} must be an object`);
    return errors;
  }
  // Allowlist keys
  for (const k of Object.keys(qr)) {
    if (!ALLOWED_QUESTION_RESULT_KEYS.has(k)) {
      errors.push(`${prefix} unknown_key:${k}`);
    }
  }
  if (!qr.question_id || typeof qr.question_id !== 'string') {
    errors.push(`${prefix}.question_id must be a non-empty string`);
    return errors;
  }
  if (!rubricQuestionIds.has(qr.question_id)) {
    errors.push(`${prefix}.question_id unknown: ${qr.question_id}`);
    return errors;
  }
  if (seenIds.has(qr.question_id)) {
    errors.push(`${prefix}.question_id duplicate: ${qr.question_id}`);
  }
  seenIds.add(qr.question_id);

  // Find the rubric question to know if it's metadata and what answers are allowed
  const rubricQ = findRubricQuestion(rubric, qr.question_id);
  if (!rubricQ) {
    errors.push(`${prefix}.question_id not found in rubric: ${qr.question_id}`);
    return errors;
  }

  // answer validation
  const allowedAnswers = rubricQ.metadata && rubricQ.metadata_answers
    ? rubricQ.metadata_answers
    : rubric.allowed_answers;
  if (!qr.answer || typeof qr.answer !== 'string') {
    errors.push(`${prefix}.answer must be a non-empty string`);
  } else if (!allowedAnswers.includes(qr.answer)) {
    errors.push(`${prefix}.answer "${qr.answer}" not in allowed_answers [${allowedAnswers.join(', ')}]`);
  }

  // evidence rules
  if (strictEvidence) {
    if (qr.answer === 'yes' && (!qr.evidence || !String(qr.evidence).trim())) {
      errors.push(`${prefix}.answer=yes requires non-empty evidence`);
    }
    if (qr.answer === 'conflict' && (!qr.evidence || !String(qr.evidence).trim())) {
      errors.push(`${prefix}.answer=conflict requires non-empty evidence describing the contradiction`);
    }
  }

  // Field types
  if (qr.evidence != null && typeof qr.evidence !== 'string') {
    errors.push(`${prefix}.evidence must be a string`);
  }
  if (qr.quote != null && typeof qr.quote !== 'string') {
    errors.push(`${prefix}.quote must be a string`);
  }
  if (qr.source != null && typeof qr.source !== 'string') {
    errors.push(`${prefix}.source must be a string`);
  }
  if (qr.source_ref != null && typeof qr.source_ref !== 'string') {
    errors.push(`${prefix}.source_ref must be a string`);
  }
  // source_ref for yes should not be empty (warn, not error — Codex may not always have line numbers)
  if (qr.answer === 'yes' && (!qr.source_ref || qr.source_ref === '')) {
    // Promote to warning only — the prompt says "empty string only if truly unavailable".
    // We don't want to reject the whole document for this.
  }
  return errors;
}

function findRubricQuestion(rubric, questionId) {
  const units = rubric.evaluation_unit === 'block' ? rubric.blocks : rubric.stages;
  if (!Array.isArray(units)) return null;
  for (const unit of units) {
    if (!Array.isArray(unit.questions)) continue;
    for (const q of unit.questions) {
      if (q.question_id === questionId) return q;
    }
  }
  return null;
}

module.exports = {
  SCHEMA_VERSION,
  ANALYSIS_TYPES,
  TYPE_TO_RUBRIC_ID,
  validateAnalysisResult,
  // Exposed for testing
  _internal: {
    collectRubricQuestionIds,
    findRubricQuestion,
    FORBIDDEN_SECRET_PATTERNS,
    ALLOWED_QUESTION_RESULT_KEYS,
    ALLOWED_TOP_LEVEL_KEYS,
  },
};
