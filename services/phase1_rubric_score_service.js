/**
 * Phase 3C0 — Rubric Contract & Scoring Engine.
 *
 * Loads binary rubric JSON configs from config/rubrics/, validates them,
 * and computes block/stage/overall scores from binary question answers.
 *
 * Per docs/16_BINARY_RUBRIC_FIXUP_NOTES.md:
 *   - block = evaluation unit (interview), stage = evaluation unit (calls)
 *   - no 3-point scale, only 0–100%
 *   - allowed answers differ per rubric (see rubric.allowed_answers)
 *   - yes  → weight contributes to numerator AND denominator
 *   - no   → weight contributes to denominator only
 *   - not_checked / not_applicable → excluded from numerator AND denominator
 *   - not_enough_data → excluded from calculation, lowers confidence
 *   - conflict → excluded from calculation, raises risk flag
 *   - objections_05 (calls) is metadata only, NOT in weighted score
 *
 * No AI calls. No DB writes. No HTTP endpoints. Pure compute module.
 */

const fs = require('fs');
const path = require('path');

const RUBRICS_DIR = path.join(__dirname, '..', 'config', 'rubrics');

const RUBRIC_FILES = {
  interview_binary_v1: 'interview_binary_v1.json',
  calls_automanual_binary_v1: 'calls_automanual_binary_v1.json',
};

// Answer classification — kept in sync with rubric.answer_groups
const ANSWER_GROUPS_DEFAULTS = {
  contributes_to_numerator: ['yes'],
  contributes_to_denominator_only: ['no'],
  excluded_from_calculation: ['not_checked', 'not_applicable', 'not_enough_data', 'conflict'],
  raises_risk_flag: ['conflict'],
  lowers_confidence: ['not_checked', 'not_enough_data'],
};

const METADATA_ANSWER_FALLBACK = {
  relevance_objection_present: ['yes', 'no', 'not_enough_data'],
};

// ----------------------------------------------------------------------
// Loading & validation
// ----------------------------------------------------------------------

const rubricCache = {};

function loadRubric(rubricId) {
  if (!Object.prototype.hasOwnProperty.call(RUBRIC_FILES, rubricId)) {
    const error = new Error(`unknown_rubric_id:${rubricId}`);
    error.code = 'UNKNOWN_RUBRIC_ID';
    error.rubricId = rubricId;
    throw error;
  }
  if (rubricCache[rubricId]) return rubricCache[rubricId];
  const filePath = path.join(RUBRICS_DIR, RUBRIC_FILES[rubricId]);
  if (!fs.existsSync(filePath)) {
    const error = new Error(`rubric_file_not_found:${rubricId}`);
    error.code = 'RUBRIC_FILE_NOT_FOUND';
    error.rubricId = rubricId;
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const error = new Error(`rubric_file_invalid_json:${rubricId}`);
    error.code = 'RUBRIC_FILE_INVALID_JSON';
    error.rubricId = rubricId;
    error.cause = err.message;
    throw error;
  }
  validateRubric(raw);
  rubricCache[rubricId] = raw;
  return raw;
}

function validateRubric(rubric) {
  const errors = [];
  if (!rubric || typeof rubric !== 'object') {
    throw new Error('rubric_must_be_object');
  }
  if (!rubric.rubric_id) errors.push('missing rubric_id');
  if (!rubric.rubric_version) errors.push('missing rubric_version');
  if (!rubric.evaluation_unit) errors.push('missing evaluation_unit');
  if (!Array.isArray(rubric.allowed_answers) || rubric.allowed_answers.length === 0) {
    errors.push('allowed_answers must be non-empty array');
  }
  if (!rubric.answer_groups || typeof rubric.answer_groups !== 'object') {
    errors.push('missing answer_groups');
  } else {
    for (const key of Object.keys(ANSWER_GROUPS_DEFAULTS)) {
      if (!Array.isArray(rubric.answer_groups[key])) {
        errors.push(`answer_groups.${key} must be array`);
      }
    }
  }
  if (!rubric.score_formula || typeof rubric.score_formula !== 'object') {
    errors.push('missing score_formula');
  }
  if (!rubric.candidate_scores_mapping || typeof rubric.candidate_scores_mapping !== 'object') {
    errors.push('missing candidate_scores_mapping');
  }
  if (!rubric.evidence_schema || !Array.isArray(rubric.evidence_schema.required_fields)) {
    errors.push('missing evidence_schema.required_fields');
  }

  // Block / stage structure
  const unitKey = rubric.evaluation_unit === 'block' ? 'blocks' : 'stages';
  if (!Array.isArray(rubric[unitKey]) || rubric[unitKey].length === 0) {
    errors.push(`${unitKey} must be non-empty array`);
  } else {
    const seenIds = new Set();
    rubric[unitKey].forEach((unit, idx) => {
      const unitId = unit.block_id || unit.stage_id;
      if (!unitId) errors.push(`unit[${idx}] missing block_id/stage_id`);
      if (seenIds.has(unitId)) errors.push(`duplicate unit id: ${unitId}`);
      seenIds.add(unitId);
      if (typeof unit.unit_weight === 'number' && typeof unit.block_weight === 'number') {
        errors.push(`unit ${unitId} has both unit_weight and block_weight`);
      }
      const weight = unit.unit_weight != null ? unit.unit_weight : unit.block_weight != null ? unit.block_weight : unit.stage_weight;
      if (typeof weight !== 'number') errors.push(`unit ${unitId} missing weight (block_weight/unit_weight/stage_weight)`);
      if (!Array.isArray(unit.questions) || unit.questions.length === 0) {
        errors.push(`unit ${unitId} questions must be non-empty array`);
      } else {
        const qSeen = new Set();
        let weightSum = 0;
        unit.questions.forEach((q, qIdx) => {
          if (!q.question_id) errors.push(`unit ${unitId} question[${qIdx}] missing question_id`);
          if (qSeen.has(q.question_id)) errors.push(`unit ${unitId} duplicate question_id ${q.question_id}`);
          qSeen.add(q.question_id);
          if (typeof q.weight !== 'number') errors.push(`question ${q.question_id} weight must be number`);
          if (!q.metadata) weightSum += q.weight;
        });
        // Allow small float tolerance
        const nonMetadataCount = unit.questions.filter(q => !q.metadata).length;
        if (nonMetadataCount > 0 && Math.abs(weightSum - 1.0) > 0.001) {
          errors.push(`unit ${unitId} non-metadata weights sum to ${weightSum.toFixed(4)}, expected 1.0`);
        }
      }
    });
  }

  if (errors.length > 0) {
    const error = new Error(`rubric_validation_failed:${rubric.rubric_id || 'unknown'}\n  - ${errors.join('\n  - ')}`);
    error.code = 'RUBRIC_VALIDATION_FAILED';
    error.errors = errors;
    throw error;
  }
  return true;
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function getAnswerGroups(rubric) {
  return rubric.answer_groups || ANSWER_GROUPS_DEFAULTS;
}

function isMetadataQuestion(question) {
  return Boolean(question && question.metadata);
}

function getUnitWeight(unit) {
  if (typeof unit.unit_weight === 'number') return unit.unit_weight;
  if (typeof unit.block_weight === 'number') return unit.block_weight;
  if (typeof unit.stage_weight === 'number') return unit.stage_weight;
  return null;
}

function getUnitId(unit) {
  return unit.block_id || unit.stage_id;
}

function getUnitName(unit) {
  return unit.block_name || unit.stage_name || getUnitId(unit);
}

function getUnitCollection(rubric) {
  return rubric.evaluation_unit === 'block' ? rubric.blocks : rubric.stages;
}

function normalizeQuestionResults(questionResults) {
  // Accept both { question_id: { answer, ... } } and [{ question_id, answer, ... }, ...]
  if (Array.isArray(questionResults)) {
    const out = {};
    for (const item of questionResults) {
      if (!item || !item.question_id) continue;
      out[item.question_id] = item;
    }
    return out;
  }
  return questionResults || {};
}

function validateEvidenceForAnswer(answer, evidence) {
  // Returns list of warnings (not errors — caller decides whether to fail)
  const warnings = [];
  const ev = evidence || {};
  if (answer === 'yes') {
    if (!ev.evidence || String(ev.evidence).trim() === '') {
      warnings.push('answer=yes requires non-empty evidence');
    }
  }
  if (answer === 'conflict') {
    if (!ev.evidence || String(ev.evidence).trim() === '') {
      warnings.push('answer=conflict requires evidence describing the conflict');
    }
  }
  return warnings;
}

// ----------------------------------------------------------------------
// Block / stage score
// ----------------------------------------------------------------------

/**
 * Calculate score for one block (interview) or one stage (calls).
 *
 * `answerGroups` is optional; if omitted, ANSWER_GROUPS_DEFAULTS is used.
 * `calculateRubricScore` passes `rubric.answer_groups` so that rubrics with
 * non-standard answer sets (e.g. a future rubric that uses `ok` instead of
 * `yes`) are honoured.
 *
 * Returns:
 *   {
 *     unit_id, unit_name, stage (for interview),
 *     score_percent: number | null,        // 0..100, or null if no applicable questions
 *     confidence: 'normal' | 'low',
 *     status: 'applicable' | 'not_enough_data' | 'not_applicable' | 'has_conflict',
 *     applicable_weight: number,
 *     yes_weight: number,
 *     not_enough_data_weight: number,
 *     not_checked_or_na_weight: number,
 *     conflict_weight: number,
 *     risk_flags: [{ question_id, answer, weight, reason }],
 *     evidence_warnings: string[],
 *     metadata: { [metadata_field]: value },   // collected from metadata questions
 *     question_details: [{ question_id, answer, weight, applicable, contributes_to_score, evidence }]
 *   }
 */
function calculateBlockScore(rubricBlock, questionResults, answerGroups = ANSWER_GROUPS_DEFAULTS) {
  const results = normalizeQuestionResults(questionResults);
  const groups = getAnswerGroups({ answer_groups: answerGroups });
  const unitId = getUnitId(rubricBlock);
  const unitName = getUnitName(rubricBlock);

  let yesWeight = 0;
  let applicableWeight = 0; // yes + no
  let notCheckedOrNaWeight = 0;
  let notEnoughDataWeight = 0;
  let conflictWeight = 0;
  const riskFlags = [];
  const evidenceWarnings = [];
  const metadata = {};
  const questionDetails = [];

  for (const question of rubricBlock.questions) {
    const qId = question.question_id;
    const weight = question.weight || 0;

    // Metadata question — collect but skip from weighted calc
    if (isMetadataQuestion(question)) {
      const result = results[qId];
      const answer = result ? result.answer : null;
      const metadataField = question.metadata_field || qId;
      const allowedMetadataAnswers = question.metadata_answers || METADATA_ANSWER_FALLBACK[metadataField] || [];
      if (answer && allowedMetadataAnswers.includes(answer)) {
        metadata[metadataField] = answer;
      } else {
        metadata[metadataField] = answer || 'not_enough_data';
      }
      questionDetails.push({
        question_id: qId,
        answer,
        weight: 0,
        applicable: false,
        contributes_to_score: false,
        metadata: true,
        evidence: result ? result.evidence : null,
      });
      continue;
    }

    const result = results[qId];
    const answer = result ? result.answer : null;

    if (!answer) {
      // Missing answer = treat as not_checked (interview) / not_enough_data (calls).
      // We cannot know which rubric this is from just the block, so we leave it out
      // of the calculation entirely. Confidence will be flagged low because the
      // weight is effectively uncounted.
      notCheckedOrNaWeight += weight;
      questionDetails.push({
        question_id: qId,
        answer: null,
        weight,
        applicable: false,
        contributes_to_score: false,
        evidence_warnings: ['answer_missing'],
      });
      continue;
    }

    // Evidence sanity
    const warnings = validateEvidenceForAnswer(answer, result);
    if (warnings.length > 0) evidenceWarnings.push(...warnings.map(w => `${qId}: ${w}`));

    if (groups.contributes_to_numerator.includes(answer)) {
      yesWeight += weight;
      applicableWeight += weight;
      questionDetails.push({ question_id: qId, answer, weight, applicable: true, contributes_to_score: true });
    } else if (groups.contributes_to_denominator_only.includes(answer)) {
      applicableWeight += weight;
      questionDetails.push({ question_id: qId, answer, weight, applicable: true, contributes_to_score: false });
    } else if (answer === 'not_enough_data') {
      notEnoughDataWeight += weight;
      questionDetails.push({ question_id: qId, answer, weight, applicable: false, contributes_to_score: false });
    } else if (answer === 'conflict') {
      conflictWeight += weight;
      riskFlags.push({ question_id: qId, answer, weight, reason: 'conflict_answer' });
      questionDetails.push({ question_id: qId, answer, weight, applicable: false, contributes_to_score: false });
    } else if (groups.excluded_from_calculation.includes(answer)) {
      notCheckedOrNaWeight += weight;
      questionDetails.push({ question_id: qId, answer, weight, applicable: false, contributes_to_score: false });
    } else {
      // Unknown answer — treat as excluded + warn
      notCheckedOrNaWeight += weight;
      evidenceWarnings.push(`${qId}: unknown_answer_${answer}`);
      questionDetails.push({ question_id: qId, answer, weight, applicable: false, contributes_to_score: false });
    }
  }

  // Score
  let scorePercent = null;
  if (applicableWeight > 0) {
    scorePercent = Math.round((yesWeight / applicableWeight) * 1000) / 10; // 1 decimal
  }

  // Confidence: low if more than 50% of unit weight is not_checked/not_enough_data
  const totalWeight = rubricBlock.questions
    .filter(q => !isMetadataQuestion(q))
    .reduce((s, q) => s + (q.weight || 0), 0);
  const uncountedWeight = notCheckedOrNaWeight + notEnoughDataWeight;
  const confidence = totalWeight > 0 && (uncountedWeight / totalWeight) > 0.50 ? 'low' : 'normal';

  // Status
  let status;
  if (applicableWeight === 0 && conflictWeight === 0 && notEnoughDataWeight > 0) {
    status = 'not_enough_data';
  } else if (applicableWeight === 0 && conflictWeight === 0 && notCheckedOrNaWeight > 0) {
    // Whole block was not_checked / not_applicable
    status = 'not_applicable';
  } else if (conflictWeight > 0) {
    status = 'has_conflict';
  } else {
    status = 'applicable';
  }

  return {
    unit_id: unitId,
    unit_name: unitName,
    stage: rubricBlock.stage || null,
    score_percent: scorePercent,
    confidence,
    status,
    applicable_weight: Math.round(applicableWeight * 10000) / 10000,
    yes_weight: Math.round(yesWeight * 10000) / 10000,
    not_checked_or_na_weight: Math.round(notCheckedOrNaWeight * 10000) / 10000,
    not_enough_data_weight: Math.round(notEnoughDataWeight * 10000) / 10000,
    conflict_weight: Math.round(conflictWeight * 10000) / 10000,
    risk_flags: riskFlags,
    evidence_warnings: evidenceWarnings,
    metadata,
    question_details: questionDetails,
  };
}

// ----------------------------------------------------------------------
// Rubric-level score
// ----------------------------------------------------------------------

/**
 * Calculate full rubric score.
 *
 * Returns:
 *   {
 *     rubric_id, rubric_version, evaluation_unit,
 *     stages: { [stage_id]: { score_percent, confidence, units: [...] } },
 *     units: [block results],         // flat list, in rubric order
 *     metadata: { ... },              // collected metadata from all blocks
 *     overall_score_percent: number | null,
 *     overall_confidence: 'normal' | 'low',
 *     overall_status: 'applicable' | 'not_enough_data' | 'partial' | 'has_conflict',
 *     risk_flags: [...],              // aggregated from all units
 *     evidence_warnings: [...],
 *     candidate_scores_mapping_preview: { ... }   // see mapRubricResultToCandidateScores
 *   }
 */
function calculateRubricScore(rubric, questionResults) {
  if (!rubric || !rubric.rubric_id) {
    const error = new Error('invalid_rubric');
    error.code = 'INVALID_RUBRIC';
    throw error;
  }
  const units = getUnitCollection(rubric);
  const results = normalizeQuestionResults(questionResults);
  const answerGroups = rubric.answer_groups || ANSWER_GROUPS_DEFAULTS;

  const unitResults = units.map(unit => calculateBlockScore(unit, results, answerGroups));

  // Group by stage (for interview) — for calls, stage_id IS the unit_id
  const stages = {};
  const allMetadata = {};
  const allRiskFlags = [];
  const allEvidenceWarnings = [];

  for (const ur of unitResults) {
    if (ur.metadata && Object.keys(ur.metadata).length > 0) {
      Object.assign(allMetadata, ur.metadata);
    }
    if (ur.risk_flags && ur.risk_flags.length > 0) {
      allRiskFlags.push(...ur.risk_flags);
    }
    if (ur.evidence_warnings && ur.evidence_warnings.length > 0) {
      allEvidenceWarnings.push(...ur.evidence_warnings);
    }

    const stageKey = ur.stage || ur.unit_id;
    if (!stages[stageKey]) {
      stages[stageKey] = {
        stage_id: stageKey,
        score_percent: null,
        confidence: 'normal',
        units: [],
      };
    }
    stages[stageKey].units.push(ur);
  }

  // Per-stage aggregate: weighted average of unit scores by unit weight
  const stageWeights = rubric.stage_weights || {};
  for (const stageKey of Object.keys(stages)) {
    const stageUnits = stages[stageKey].units;
    let totalScore = 0;
    let totalWeight = 0;
    let hasNull = false;
    let hasConflict = false;
    for (const ur of stageUnits) {
      const unit = units.find(u => getUnitId(u) === ur.unit_id);
      const unitWeight = getUnitWeight(unit);
      if (ur.score_percent == null) {
        hasNull = true;
        continue;
      }
      if (ur.status === 'has_conflict') hasConflict = true;
      totalScore += ur.score_percent * unitWeight;
      totalWeight += unitWeight;
    }
    if (totalWeight > 0) {
      stages[stageKey].score_percent = Math.round((totalScore / totalWeight) * 10) / 10;
    } else {
      stages[stageKey].score_percent = null;
    }
    stages[stageKey].confidence = (hasNull || stageUnits.some(u => u.confidence === 'low')) ? 'low' : 'normal';
    stages[stageKey].has_conflict = hasConflict;
  }

  // Overall: weighted by stage_weights
  let overallScore = null;
  let overallWeight = 0;
  let overallSum = 0;
  let anyStageNull = false;
  for (const [stageKey, weight] of Object.entries(stageWeights)) {
    const stageScore = stages[stageKey] ? stages[stageKey].score_percent : null;
    if (stageScore == null) {
      anyStageNull = true;
      continue;
    }
    overallSum += stageScore * weight;
    overallWeight += weight;
  }
  if (overallWeight > 0) {
    overallScore = Math.round((overallSum / overallWeight) * 10) / 10;
  }

  const overallConfidence = Object.values(stages).some(s => s.confidence === 'low') ? 'low' : 'normal';
  const applicableCount = Object.values(stages).filter(s => s.score_percent != null).length;
  const totalCount = Object.keys(stageWeights).length;
  let overallStatus;
  if (applicableCount === 0) overallStatus = 'not_enough_data';
  else if (applicableCount < totalCount) overallStatus = 'partial';
  else if (allRiskFlags.length > 0) overallStatus = 'has_conflict';
  else overallStatus = 'applicable';

  return {
    rubric_id: rubric.rubric_id,
    rubric_version: rubric.rubric_version,
    evaluation_unit: rubric.evaluation_unit,
    stages,
    units: unitResults,
    metadata: allMetadata,
    overall_score_percent: overallScore,
    overall_confidence: overallConfidence,
    overall_status: overallStatus,
    risk_flags: allRiskFlags,
    evidence_warnings: allEvidenceWarnings,
    candidate_scores_mapping_preview: mapRubricResultToCandidateScores({
      rubric_id: rubric.rubric_id,
      stages,
      units: unitResults,
      metadata: allMetadata,
      overall_score_percent: overallScore,
      risk_flags: allRiskFlags,
    }),
  };
}

// ----------------------------------------------------------------------
// Mapping to candidate_scores
// ----------------------------------------------------------------------

/**
 * Map rubric result to candidate_scores fields.
 *
 * For interview_binary_v1:
 *   soft_score         ← soft stage score_percent
 *   hard_score         ← hard stage score_percent
 *   learning_score     ← weighted avg of soft_flexibility + soft_antifragility + soft_proactivity
 *   risk_score_adjust  ← conflict count * 15 + red_flag count * 10 (capped)
 *
 * For calls_automanual_binary_v1:
 *   call_quality_score ← overall_score_percent
 *   risk_score_adjust  ← critical_errors + conflicts (capped)
 *
 * NOTE: This function returns only the partial fields derivable from this rubric.
 * The caller (Phase 3B-min service or future Phase 3C AI runner) merges these
 * with other sources (manual scores, other rubrics) and computes the final
 * candidate_scores row. We do NOT write to DB here.
 */
function mapRubricResultToCandidateScores(rubricResult) {
  const rubricId = rubricResult.rubric_id;
  const stages = rubricResult.stages || {};
  const out = {
    rubric_id: rubricId,
    derived_fields: {},
    notes: [],
  };

  if (rubricId === 'interview_binary_v1') {
    const softStage = stages.soft;
    const hardStage = stages.hard;
    out.derived_fields.soft_score = softStage ? softStage.score_percent : null;
    out.derived_fields.hard_score = hardStage ? hardStage.score_percent : null;

    // learning_score: weighted avg of soft_flexibility + soft_antifragility + soft_proactivity
    // We need per-unit scores, which are in rubricResult.units (full result) — but
    // mapRubricResultToCandidateScores may be called with a slimmed-down result.
    // If units are available, compute; otherwise null.
    const units = rubricResult.units || [];
    const flex = units.find(u => u.unit_id === 'soft_flexibility');
    const anti = units.find(u => u.unit_id === 'soft_antifragility');
    const proact = units.find(u => u.unit_id === 'soft_proactivity');
    const learningComponents = [
      { score: flex && flex.score_percent, weight: 0.40 },
      { score: anti && anti.score_percent, weight: 0.30 },
      { score: proact && proact.score_percent, weight: 0.30 },
    ].filter(c => c.score != null);
    if (learningComponents.length > 0) {
      const total = learningComponents.reduce((s, c) => s + c.score * c.weight, 0);
      const weightSum = learningComponents.reduce((s, c) => s + c.weight, 0);
      out.derived_fields.learning_score = Math.round((total / weightSum) * 10) / 10;
      if (learningComponents.length < 3) {
        out.notes.push('learning_score computed from partial components (some blocks null)');
      }
    } else {
      out.derived_fields.learning_score = null;
    }

    // risk_score adjustment from conflicts
    const conflictCount = (rubricResult.risk_flags || []).length;
    let riskAdjust = Math.min(60, conflictCount * 15);
    out.derived_fields.risk_score_adjust = riskAdjust;
    out.notes.push(`risk_score_adjust=${riskAdjust} from ${conflictCount} conflict(s); caller adds red_flag-derived risk separately`);
    return out;
  }

  if (rubricId === 'calls_automanual_binary_v1') {
    out.derived_fields.call_quality_score = rubricResult.overall_score_percent;
    const conflictCount = (rubricResult.risk_flags || []).length;
    let riskAdjust = Math.min(50, conflictCount * 10);
    out.derived_fields.risk_score_adjust = riskAdjust;
    if (rubricResult.metadata && rubricResult.metadata.relevance_objection_present) {
      out.notes.push(`relevance_objection_present=${rubricResult.metadata.relevance_objection_present} (metadata, not in score)`);
    }
    out.notes.push(`risk_score_adjust=${riskAdjust} from ${conflictCount} conflict(s); caller adds critical-error-derived risk separately`);
    return out;
  }

  out.notes.push(`no mapping defined for rubric ${rubricId}`);
  return out;
}

// ----------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------

module.exports = {
  RUBRIC_FILES,
  RUBRICS_DIR,
  ANSWER_GROUPS_DEFAULTS,
  loadRubric,
  validateRubric,
  calculateBlockScore,
  calculateRubricScore,
  mapRubricResultToCandidateScores,
  // exposed for testing
  _internal: {
    normalizeQuestionResults,
    isMetadataQuestion,
    getUnitWeight,
    getUnitId,
    getUnitName,
    getUnitCollection,
    validateEvidenceForAnswer,
  },
};
