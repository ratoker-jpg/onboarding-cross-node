#!/usr/bin/env node
/**
 * Phase 3E0 — Import Codex analysis result into the database.
 *
 * Reads an analysis_result_v1 JSON document (produced by Codex against a
 * bundle exported via scripts/export_candidate_analysis_bundle.js), validates
 * it, scores it via the rubric engine, and persists the result into
 * analysis_runs + candidate_scores (partial update only — manually-filled
 * fields are preserved).
 *
 * Usage:
 *   node scripts/import_analysis_result.js --file tmp/GTRAIN01_interview_result.json
 *   node scripts/import_analysis_result.js --file tmp/GTRAIN01_interview_result.json --dry-run
 *
 * Safety:
 *   - --dry-run validates and computes everything but writes nothing to DB.
 *   - candidate_scores is updated PARTIALLY: only fields derived from this
 *     rubric (soft/hard/learning/risk for interview; call_quality/risk for
 *     calls). Manually-set fields (ops_score, final_test_score, recommendation,
 *     strengths, growth_zones, red_flags, coach_recommendations) are preserved
 *     unless the result document explicitly provides non-empty values for them.
 *   - overall_score / risk_level / final_status are recomputed by
 *     services/phase1_candidate_service.js recalculateCandidateScores()
 *     after the partial update, so limiters from
 *     docs/11_EVALUATION_RUBRICS_BY_STAGE_V1.md §12 are honoured.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));
if (!process.env.PHASE1_ADMIN_ENABLED) process.env.PHASE1_ADMIN_ENABLED = '1';

const { validateAnalysisResult } = require('../services/phase1_analysis_result_validator');
const { loadRubric, calculateRubricScore } = require('../services/phase1_rubric_score_service');
const {
  getCandidateScores,
  recalculateCandidateScores,
  // We need direct DB write for analysis_runs + candidate_scores partial update.
  // Reuse the same repos the service uses, but write through a thin helper here.
} = require('../services/phase1_candidate_service');

const { getPhase1Db } = require('../lib/phase1_db');
const { createAnalysisRunsRepo } = require('../repositories/phase1_analysis_runs_repo');
const { createCandidateScoresRepo } = require('../repositories/phase1_candidate_scores_repo');
const { createCandidatesRepo } = require('../repositories/phase1_candidates_repo');

// ----------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------

function parseArgs(argv) {
  const out = { file: null, dryRun: false, help: false, adminKey: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--admin-key') out.adminKey = argv[++i];
    else if (a.startsWith('--file=')) out.file = a.slice('--file='.length);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/import_analysis_result.js --file <path> [--dry-run] [--admin-key <key>]

Options:
  --file        Path to analysis_result_v1 JSON file
  --dry-run     Validate + compute scores, but do NOT write to DB
  --admin-key   Admin key for audit log (defaults to "codex-pipeline")
  --help        Show this help

Examples:
  node scripts/import_analysis_result.js --file examples/analysis/interview_result_example.json --dry-run
  node scripts/import_analysis_result.js --file tmp/GTRAIN01_interview_result.json
`);
}

// ----------------------------------------------------------------------
// Scoring + mapping
// ----------------------------------------------------------------------

const ANALYSIS_RUN_TYPE = {
  interview: 'interview',
  calls: 'calls',
};

/**
 * Map rubric result to a candidate_scores patch.
 * Only includes fields this rubric can derive; everything else stays null
 * and the caller preserves existing values.
 */
function buildScoresPatch(rubricId, rubricResult, doc, existingScores) {
  const patch = {
    // Start from existing values so we don't blow away manual fields.
    hard_score: existingScores ? existingScores.hard_score : null,
    soft_score: existingScores ? existingScores.soft_score : null,
    learning_score: existingScores ? existingScores.learning_score : null,
    discipline_score: existingScores ? existingScores.discipline_score : null,
    call_quality_score: existingScores ? existingScores.call_quality_score : null,
    ops_score: existingScores ? existingScores.ops_score : null,
    final_test_score: existingScores ? existingScores.final_test_score : null,
    risk_score: existingScores ? existingScores.risk_score : null,
    // recommendation + list fields: preserve existing, override only if doc provides non-empty.
    recommendation: existingScores ? existingScores.recommendation : null,
    strengths: existingScores ? (existingScores.strengths || []) : [],
    growth_zones: existingScores ? (existingScores.growth_zones || []) : [],
    red_flags: existingScores ? (existingScores.red_flags || []) : [],
    coach_recommendations: existingScores ? (existingScores.coach_recommendations || []) : [],
  };

  // Apply rubric-derived partial fields
  const mapping = rubricResult.candidate_scores_mapping_preview || {};
  const derived = mapping.derived_fields || {};

  if (rubricId === 'interview_binary_v1') {
    if (derived.soft_score != null) patch.soft_score = derived.soft_score;
    if (derived.hard_score != null) patch.hard_score = derived.hard_score;
    if (derived.learning_score != null) patch.learning_score = derived.learning_score;
    // risk_score: adjust existing by adding risk_score_adjust (conflict-derived).
    // We do NOT replace the whole risk_score — only bump it by the adjust amount,
    // capped at 100.
    if (derived.risk_score_adjust != null && derived.risk_score_adjust > 0) {
      const base = patch.risk_score != null ? patch.risk_score : 0;
      patch.risk_score = Math.min(100, base + derived.risk_score_adjust);
    }
  } else if (rubricId === 'calls_automanual_binary_v1') {
    if (derived.call_quality_score != null) patch.call_quality_score = derived.call_quality_score;
    if (derived.risk_score_adjust != null && derived.risk_score_adjust > 0) {
      const base = patch.risk_score != null ? patch.risk_score : 0;
      patch.risk_score = Math.min(100, base + derived.risk_score_adjust);
    }
  }

  // Override list fields if the doc provides non-empty values
  if (doc.summary && (!patch.recommendation || doc.summary.length > patch.recommendation.length)) {
    // Use summary as recommendation if no manual recommendation exists.
    if (!patch.recommendation) patch.recommendation = doc.summary;
  }
  if (Array.isArray(doc.strengths) && doc.strengths.length) patch.strengths = doc.strengths;
  if (Array.isArray(doc.growth_zones) && doc.growth_zones.length) patch.growth_zones = doc.growth_zones;
  if (Array.isArray(doc.red_flags) && doc.red_flags.length) patch.red_flags = patch.red_flags.concat(doc.red_flags);
  if (Array.isArray(doc.coach_recommendations) && doc.coach_recommendations.length) {
    patch.coach_recommendations = doc.coach_recommendations;
  }

  // Apply critical-error score caps (calls rubric only)
  if (rubricId === 'calls_automanual_binary_v1' && Array.isArray(doc.risk_flags) && doc.risk_flags.length) {
    applyCriticalErrorCaps(patch, doc.risk_flags);
  }

  return patch;
}

function applyCriticalErrorCaps(patch, riskFlags) {
  // Risk flags may cap the call_quality_score. Apply conservative caps
  // based on the codes that appear (mirrors docs/15_CALLS_AUTOMANUAL_BINARY_RUBRIC.md §11).
  const codes = new Set(riskFlags.map(rf => rf.code));
  let cap = 100;
  if (codes.has('dangerous_promises')) cap = Math.min(cap, 50);
  if (codes.has('distorted_product_terms')) cap = Math.min(cap, 60);
  if (codes.has('no_needs_discovery')) cap = Math.min(cap, 65);
  if (codes.has('presentation_without_needs')) cap = Math.min(cap, 70);
  if (codes.has('pressure_instead_of_handling')) cap = Math.min(cap, 70);
  if (codes.has('agreed_but_not_fixed')) cap = Math.min(cap, 75);
  if (codes.has('no_close_or_next_step')) cap = Math.min(cap, 80);
  if (patch.call_quality_score != null && patch.call_quality_score > cap) {
    patch.call_quality_score = cap;
  }
}

// ----------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function persistResult(doc, rubricResult, scoresPatch, adminKey) {
  const db = getPhase1Db();
  const candidatesRepo = createCandidatesRepo(db);
  const analysisRunsRepo = createAnalysisRunsRepo(db);
  const candidateScoresRepo = createCandidateScoresRepo(db);

  const candidate = candidatesRepo.findByBaseKey(doc.base_key);
  if (!candidate) {
    throw new Error(`candidate_not_found:${doc.base_key}`);
  }

  const now = nowIso();

  // 1. Create analysis_run record
  const analysisRun = analysisRunsRepo.create({
    candidate_id: candidate.id,
    base_key: doc.base_key,
    analysis_type: ANALYSIS_RUN_TYPE[doc.analysis_type] || doc.analysis_type,
    source: 'codex',
    status: 'success',
    input_payload_json: JSON.stringify({
      schema_version: doc.schema_version,
      rubric_id: doc.rubric_id,
      rubric_version: doc.rubric_version,
      question_results_count: doc.question_results.length,
      summary: doc.summary,
      risk_flags: doc.risk_flags || [],
    }),
    output_payload_json: JSON.stringify({
      rubric_result: rubricResult,
      scores_patch: scoresPatch,
    }),
    error_text: null,
    created_at: now,
    finished_at: now,
  });

  // 2. Upsert candidate_scores with the patch.
  // We need to preserve created_at if row exists, set updated_at = now.
  const existing = candidateScoresRepo.getByCandidateId(candidate.id);
  const created_at = existing ? existing.created_at : now;

  // 3. Apply scores patch.
  // Use the same upsert path that saveCandidateScores uses, but bypass its
  // full-overwrite semantics by passing through fields we want to preserve.
  // Since candidate_scores has UNIQUE(candidate_id), upsert either creates
  // or updates. We assemble the full row from existing + patch.
  const scoresRow = {
    candidate_id: candidate.id,
    base_key: doc.base_key,
    hard_score: scoresPatch.hard_score,
    soft_score: scoresPatch.soft_score,
    learning_score: scoresPatch.learning_score,
    discipline_score: scoresPatch.discipline_score,
    call_quality_score: scoresPatch.call_quality_score,
    ops_score: scoresPatch.ops_score,
    final_test_score: scoresPatch.final_test_score,
    risk_score: scoresPatch.risk_score,
    // overall_score, risk_level, final_status are recalculated by recalculateCandidateScores
    overall_score: existing ? existing.overall_score : null,
    risk_level: existing ? existing.risk_level : null,
    final_status: existing ? existing.final_status : null,
    recommendation: scoresPatch.recommendation,
    source: 'mixed', // mix of manual + codex
    analysis_run_id: analysisRun.id,
    score_breakdown_json: existing ? existing.score_breakdown_json : null,
    strengths_json: JSON.stringify(scoresPatch.strengths || []),
    growth_zones_json: JSON.stringify(scoresPatch.growth_zones || []),
    red_flags_json: JSON.stringify(scoresPatch.red_flags || []),
    coach_recommendations_json: JSON.stringify(scoresPatch.coach_recommendations || []),
    has_calls_data: existing ? (existing.has_calls_data ? 1 : 0) : 0,
    created_at,
    updated_at: now,
  };
  const upserted = candidateScoresRepo.upsert(scoresRow);

  return { analysisRun, scores: upserted };
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.file) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const adminKey = args.adminKey || 'codex-pipeline';
  const dryRun = args.dryRun;

  console.log(`=== Phase 3E0 import_analysis_result ===`);
  console.log(`file: ${args.file}`);
  console.log(`dry-run: ${dryRun}`);
  console.log('');

  // 1. Read JSON
  let doc;
  try {
    const raw = fs.readFileSync(args.file, 'utf8');
    doc = JSON.parse(raw);
  } catch (err) {
    console.error(`FAIL: cannot read/parse file: ${err.message}`);
    process.exit(1);
  }
  console.log(`1. Loaded document: schema=${doc.schema_version} base_key=${doc.base_key} type=${doc.analysis_type} rubric=${doc.rubric_id}`);

  // 2. Validate
  const validation = validateAnalysisResult(doc);
  console.log('');
  console.log(`2. Validation: ${validation.ok ? 'PASS' : 'FAIL'} (${validation.errors.length} errors, ${validation.warnings.length} warnings)`);
  if (validation.errors.length) {
    for (const e of validation.errors) console.log(`   ERROR: ${e}`);
  }
  if (validation.warnings.length) {
    for (const w of validation.warnings) console.log(`   WARN:  ${w}`);
  }
  if (!validation.ok) {
    console.log('');
    console.log('Aborting: validation failed.');
    process.exit(2);
  }

  // 3. Load rubric + compute score
  const rubric = validation.rubric || loadRubric(doc.rubric_id);
  const rubricResult = calculateRubricScore(rubric, doc.question_results);
  console.log('');
  console.log(`3. Rubric scoring:`);
  console.log(`   overall_score_percent: ${rubricResult.overall_score_percent}`);
  console.log(`   overall_confidence: ${rubricResult.overall_confidence}`);
  console.log(`   overall_status: ${rubricResult.overall_status}`);
  console.log(`   risk_flags from conflicts: ${rubricResult.risk_flags.length}`);
  if (rubricResult.units) {
    for (const u of rubricResult.units) {
      console.log(`   unit ${u.unit_id}: score=${u.score_percent} confidence=${u.confidence} status=${u.status}`);
    }
  }

  // 4. Build candidate_scores patch
  let existingScores = null;
  try {
    existingScores = getCandidateScores(doc.base_key);
  } catch (_) { /* candidate may not have scores yet */ }
  const scoresPatch = buildScoresPatch(doc.rubric_id, rubricResult, doc, existingScores);
  console.log('');
  console.log(`4. Candidate_scores patch:`);
  console.log(`   hard_score:        ${existingScores ? existingScores.hard_score : null} → ${scoresPatch.hard_score}`);
  console.log(`   soft_score:        ${existingScores ? existingScores.soft_score : null} → ${scoresPatch.soft_score}`);
  console.log(`   learning_score:    ${existingScores ? existingScores.learning_score : null} → ${scoresPatch.learning_score}`);
  console.log(`   discipline_score:  ${existingScores ? existingScores.discipline_score : null} → ${scoresPatch.discipline_score} (preserved)`);
  console.log(`   call_quality_score:${existingScores ? existingScores.call_quality_score : null} → ${scoresPatch.call_quality_score}`);
  console.log(`   ops_score:         ${existingScores ? existingScores.ops_score : null} → ${scoresPatch.ops_score} (preserved)`);
  console.log(`   final_test_score:  ${existingScores ? existingScores.final_test_score : null} → ${scoresPatch.final_test_score} (preserved)`);
  console.log(`   risk_score:        ${existingScores ? existingScores.risk_score : null} → ${scoresPatch.risk_score}`);
  console.log(`   recommendation:    ${scoresPatch.recommendation ? scoresPatch.recommendation.slice(0, 60) + '...' : '(unchanged)'}`);
  console.log(`   strengths:         ${scoresPatch.strengths.length} items`);
  console.log(`   growth_zones:      ${scoresPatch.growth_zones.length} items`);
  console.log(`   red_flags:         ${scoresPatch.red_flags.length} items`);
  console.log(`   coach_recommendations: ${scoresPatch.coach_recommendations.length} items`);

  // 5. Dry-run or persist
  if (dryRun) {
    console.log('');
    console.log(`5. DRY-RUN: skipping DB write.`);
    console.log(`   Would create analysis_runs row:`);
    console.log(`     candidate_id: ${doc.base_key}`);
    console.log(`     analysis_type: ${ANALYSIS_RUN_TYPE[doc.analysis_type] || doc.analysis_type}`);
    console.log(`     source: codex`);
    console.log(`     status: success`);
    console.log(`   Would upsert candidate_scores with patch above.`);
    console.log(`   (overall_score / risk_level / final_status would be recomputed by recalculateCandidateScores)`);
    console.log('');
    console.log('DRY-RUN complete. No DB writes performed.');
    process.exit(0);
  }

  // Live run
  try {
    const { analysisRun, scores } = persistResult(doc, rubricResult, scoresPatch, adminKey);
    console.log('');
    console.log(`5. Persisted:`);
    console.log(`   analysis_runs.id: ${analysisRun.id}`);
    console.log(`   candidate_scores.id: ${scores.id}`);
    console.log(`   candidate_scores.source: ${scores.source}`);

    // 6. Recalculate overall/risk/final_status with limiters
    try {
      const recalculated = recalculateCandidateScores(doc.base_key, adminKey);
      console.log(`   After recalculate → overall=${recalculated.overall_score} risk=${recalculated.risk_level} status=${recalculated.final_status}`);
    } catch (recalcErr) {
      console.log(`   WARN: recalculateCandidateScores failed (may be expected if no scores row): ${recalcErr.message}`);
    }

    console.log('');
    console.log('Import complete. Open report-v1.html to see the updated card.');
    process.exit(0);
  } catch (err) {
    console.error(`FAIL: persistence error: ${err.message}`);
    if (process.env.PHASE3E0_DEBUG) console.error(err.stack);
    process.exit(3);
  }
}

main();
