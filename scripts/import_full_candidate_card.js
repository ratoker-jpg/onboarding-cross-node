#!/usr/bin/env node
/**
 * FULL-CANDIDATE-CARD-V1 — import ONE full candidate card result.
 *
 * Reads a full_candidate_card_v1 JSON document (produced by Codex against a
 * full bundle from scripts/export_candidate_full_bundle.js), validates and
 * scores each block independently, and (in live mode) persists:
 *   - interview block  → analysis_runs(interview) + soft/hard/learning scores
 *   - calls block      → analysis_runs(calls) + call_quality_score
 *                        (guarded by the calls semantic checks)
 *   - training_agents  → analysis_runs(training_agents) — SEPARATE, never
 *                        touches call_quality_score
 *   - ops              → ops_score / discipline_score (only if non-null)
 *   - final_test       → final_test_score (only if non-null)
 *   - overall          → recommendation / strengths / growth_zones /
 *                        red_flags (risks) / coach_recommendations
 *
 * Usage:
 *   node scripts/import_full_candidate_card.js --file examples/analysis/full_candidate_card_example.json --dry-run
 *
 * Safety:
 *   - --dry-run validates, scores and prints which blocks WOULD be updated,
 *     but writes nothing. The dry-run path performs no DB writes.
 *   - A failing calls semantic check aborts the live import (the calls block is
 *     the only block that can poison call_quality_score).
 *   - Missing blocks (missing_data:true or analysis:null) are skipped, never
 *     invented.
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
  runCallsSemanticChecks,
  enrichRubricResultWithQuestionEvidence,
  mergeUniqueStrings,
} = require('./import_analysis_result');

const SCHEMA_VERSION = 'full_candidate_card_v1';

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
  node scripts/import_full_candidate_card.js --file <path> [--dry-run] [--admin-key <key>]

Options:
  --file       Path to full_candidate_card_v1 JSON file
  --dry-run    Validate + score + print which blocks would update; no DB writes
  --admin-key  Admin key for audit log (defaults to "codex-pipeline")
  --help       Show this help
`);
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// ----------------------------------------------------------------------
// Per-block evaluation (pure — no DB)
// ----------------------------------------------------------------------

/**
 * Validate + score one inner analysis_result_v1 block (interview or calls).
 * Returns { ok, errors, warnings, rubricResult, semantic }.
 */
function evaluateAnalysisBlock(analysis, expectedType) {
  const out = { ok: false, errors: [], warnings: [], rubricResult: null, semantic: null };
  if (!analysis || typeof analysis !== 'object') {
    out.errors.push('analysis is missing');
    return out;
  }
  if (analysis.analysis_type !== expectedType) {
    out.errors.push(`analysis_type must be "${expectedType}", got "${analysis.analysis_type}"`);
    return out;
  }
  const validation = validateAnalysisResult(analysis);
  out.errors.push(...validation.errors);
  out.warnings.push(...validation.warnings);
  if (!validation.ok) return out;

  const rubric = validation.rubric || loadRubric(analysis.rubric_id);
  const raw = calculateRubricScore(rubric, analysis.question_results);
  out.rubricResult = enrichRubricResultWithQuestionEvidence(raw, analysis.question_results);

  if (expectedType === 'calls') {
    out.semantic = runCallsSemanticChecks(analysis, rubric, out.rubricResult);
    if (!out.semantic.ok) {
      out.errors.push('calls semantic checks failed');
      return out;
    }
  }
  out.ok = true;
  return out;
}

/**
 * Build the per-block plan describing what the import would change.
 * Pure: no DB access, safe for dry-run.
 */
function buildPlan(doc) {
  const blocks = doc.blocks || {};
  const plan = {
    interview: { action: 'skip', detail: '', derived: {}, eval: null },
    calls: { action: 'skip', detail: '', derived: {}, eval: null },
    training_agents: { action: 'skip', detail: '' },
    ops: { action: 'skip', detail: '', derived: {} },
    final_test: { action: 'skip', detail: '', derived: {} },
    overall: { action: 'skip', detail: '', derived: {} },
  };

  // interview
  const iv = blocks.interview;
  if (iv && !iv.missing_data && iv.analysis) {
    const ev = evaluateAnalysisBlock(iv.analysis, 'interview');
    plan.interview.eval = ev;
    if (ev.ok) {
      const d = (ev.rubricResult.candidate_scores_mapping_preview || {}).derived_fields || {};
      plan.interview.derived = {
        soft_score: num(d.soft_score),
        hard_score: num(d.hard_score),
        learning_score: num(d.learning_score),
      };
      plan.interview.action = 'update';
      plan.interview.detail = `soft=${plan.interview.derived.soft_score} hard=${plan.interview.derived.hard_score} learning=${plan.interview.derived.learning_score}`;
    } else {
      plan.interview.action = 'error';
      plan.interview.detail = ev.errors.join('; ');
    }
  } else {
    plan.interview.detail = 'missing_data';
  }

  // calls
  const cl = blocks.calls;
  if (cl && !cl.missing_data && cl.analysis) {
    const ev = evaluateAnalysisBlock(cl.analysis, 'calls');
    plan.calls.eval = ev;
    if (ev.ok) {
      plan.calls.derived = { call_quality_score: num(ev.rubricResult.overall_score_percent) };
      plan.calls.action = 'update';
      plan.calls.detail = `call_quality_score=${plan.calls.derived.call_quality_score} [semantic: PASS]`;
    } else {
      plan.calls.action = 'error';
      plan.calls.detail = ev.errors.join('; ');
    }
  } else {
    plan.calls.detail = 'missing_data';
  }

  // training agents (separate; never affects call_quality_score)
  const ta = blocks.training_agents;
  if (ta && !ta.missing_data) {
    plan.training_agents.action = 'update';
    plan.training_agents.detail = `separate analysis run; ${ta.dialogs_reviewed != null ? ta.dialogs_reviewed + ' dialogs reviewed; ' : ''}does NOT affect call_quality_score`;
  } else {
    plan.training_agents.detail = 'missing_data';
  }

  // ops
  const ops = blocks.ops;
  if (ops && !ops.missing_data) {
    const opsScore = num(ops.ops_score);
    const disc = num(ops.discipline_score);
    if (opsScore != null || disc != null) {
      plan.ops.action = 'update';
      plan.ops.derived = { ops_score: opsScore, discipline_score: disc };
      plan.ops.detail = `ops_score=${opsScore} discipline_score=${disc}`;
    } else {
      plan.ops.detail = 'no numeric score (null) — qualitative only, no score update';
    }
  } else {
    plan.ops.detail = 'missing_data';
  }

  // final test
  const ft = blocks.final_test;
  if (ft && !ft.missing_data && num(ft.final_test_score) != null) {
    plan.final_test.action = 'update';
    plan.final_test.derived = { final_test_score: num(ft.final_test_score) };
    plan.final_test.detail = `final_test_score=${plan.final_test.derived.final_test_score}`;
  } else {
    plan.final_test.detail = 'missing_data';
  }

  // overall
  const ov = blocks.overall;
  if (ov && (ov.recommendation || (ov.strengths || []).length || (ov.growth_zones || []).length || (ov.risks || []).length || (ov.coach_recommendations || []).length)) {
    plan.overall.action = 'update';
    plan.overall.derived = {
      recommendation: ov.recommendation || null,
      strengths: Array.isArray(ov.strengths) ? ov.strengths : [],
      growth_zones: Array.isArray(ov.growth_zones) ? ov.growth_zones : [],
      red_flags: Array.isArray(ov.risks) ? ov.risks : [],
      coach_recommendations: Array.isArray(ov.coach_recommendations) ? ov.coach_recommendations : [],
    };
    plan.overall.detail = `recommendation${ov.recommendation ? '' : '(none)'}, strengths=${plan.overall.derived.strengths.length}, growth=${plan.overall.derived.growth_zones.length}, risks=${plan.overall.derived.red_flags.length}, coach=${plan.overall.derived.coach_recommendations.length}`;
  } else {
    plan.overall.detail = 'nothing to set';
  }

  return plan;
}

// ----------------------------------------------------------------------
// Top-level validation (shape of the full card)
// ----------------------------------------------------------------------

function validateFullCard(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['document must be a JSON object'];
  if (doc.schema_version !== SCHEMA_VERSION) errors.push(`invalid_schema_version:expected "${SCHEMA_VERSION}", got "${doc.schema_version}"`);
  if (!doc.base_key || typeof doc.base_key !== 'string') errors.push('base_key must be a non-empty string');
  if (!doc.blocks || typeof doc.blocks !== 'object') errors.push('blocks must be an object');
  return errors;
}

// ----------------------------------------------------------------------
// Persistence (live only) — guarded; not exercised in dry-run.
// ----------------------------------------------------------------------

function persistFullCard(doc, plan, adminKey) {
  const { getPhase1Db } = require('../lib/phase1_db');
  const { createCandidatesRepo } = require('../repositories/phase1_candidates_repo');
  const { createAnalysisRunsRepo } = require('../repositories/phase1_analysis_runs_repo');
  const { createCandidateScoresRepo } = require('../repositories/phase1_candidate_scores_repo');
  const { recalculateCandidateScores } = require('../services/phase1_candidate_service');

  const db = getPhase1Db();
  const candidatesRepo = createCandidatesRepo(db);
  const analysisRunsRepo = createAnalysisRunsRepo(db);
  const candidateScoresRepo = createCandidateScoresRepo(db);

  const candidate = candidatesRepo.findByBaseKey(doc.base_key);
  if (!candidate) throw new Error(`candidate_not_found:${doc.base_key}`);

  const now = new Date().toISOString();
  const existing = candidateScoresRepo.getByCandidateId(candidate.id) || {};
  const blocks = doc.blocks || {};

  // Merge candidate_scores from existing + per-block derived values.
  const row = {
    candidate_id: candidate.id,
    base_key: doc.base_key,
    hard_score: plan.interview.action === 'update' ? plan.interview.derived.hard_score : (existing.hard_score ?? null),
    soft_score: plan.interview.action === 'update' ? plan.interview.derived.soft_score : (existing.soft_score ?? null),
    learning_score: plan.interview.action === 'update' ? plan.interview.derived.learning_score : (existing.learning_score ?? null),
    discipline_score: plan.ops.action === 'update' && plan.ops.derived.discipline_score != null ? plan.ops.derived.discipline_score : (existing.discipline_score ?? null),
    call_quality_score: plan.calls.action === 'update' ? plan.calls.derived.call_quality_score : (existing.call_quality_score ?? null),
    ops_score: plan.ops.action === 'update' && plan.ops.derived.ops_score != null ? plan.ops.derived.ops_score : (existing.ops_score ?? null),
    final_test_score: plan.final_test.action === 'update' ? plan.final_test.derived.final_test_score : (existing.final_test_score ?? null),
    risk_score: existing.risk_score ?? null,
    overall_score: existing.overall_score ?? null,
    risk_level: existing.risk_level ?? null,
    final_status: existing.final_status ?? null,
    recommendation: plan.overall.action === 'update' && plan.overall.derived.recommendation ? plan.overall.derived.recommendation : (existing.recommendation ?? null),
    source: 'mixed',
    analysis_run_id: existing.analysis_run_id ?? null,
    score_breakdown_json: existing.score_breakdown_json ?? null,
    strengths_json: JSON.stringify(plan.overall.action === 'update' ? mergeUniqueStrings(safeArr(existing.strengths), plan.overall.derived.strengths) : safeArr(existing.strengths)),
    growth_zones_json: JSON.stringify(plan.overall.action === 'update' ? mergeUniqueStrings(safeArr(existing.growth_zones), plan.overall.derived.growth_zones) : safeArr(existing.growth_zones)),
    red_flags_json: JSON.stringify(plan.overall.action === 'update' ? mergeUniqueStrings(safeArr(existing.red_flags), plan.overall.derived.red_flags) : safeArr(existing.red_flags)),
    coach_recommendations_json: JSON.stringify(plan.overall.action === 'update' ? mergeUniqueStrings(safeArr(existing.coach_recommendations), plan.overall.derived.coach_recommendations) : safeArr(existing.coach_recommendations)),
    has_calls_data: plan.calls.action === 'update' ? 1 : (existing.has_calls_data ? 1 : 0),
    created_at: existing.created_at || now,
    updated_at: now,
  };

  const tx = db.transaction(() => {
    const createRun = (type, inputObj, outputObj) => analysisRunsRepo.create({
      candidate_id: candidate.id,
      base_key: doc.base_key,
      analysis_type: type,
      source: 'codex',
      status: 'success',
      input_payload_json: JSON.stringify(inputObj || {}),
      output_payload_json: JSON.stringify(outputObj || {}),
      error_text: null,
      created_at: now,
      finished_at: now,
    });

    if (plan.interview.action === 'update') {
      createRun('interview', { schema_version: 'full_candidate_card_v1', block: 'interview' }, { rubric_result: plan.interview.eval.rubricResult, analysis: blocks.interview.analysis });
    }
    if (plan.calls.action === 'update') {
      const a = blocks.calls.analysis;
      createRun('calls', { schema_version: 'full_candidate_card_v1', block: 'calls' }, {
        rubric_result: plan.calls.eval.rubricResult,
        summary: a.summary || '',
        stage_dynamics: a.stage_dynamics || null,
        call_results: Array.isArray(a.call_results) ? a.call_results : null,
      });
    }
    if (plan.training_agents.action === 'update') {
      // SEPARATE run; no candidate_scores.call_quality_score impact.
      createRun('training_agents', { schema_version: 'full_candidate_card_v1', block: 'training_agents' }, blocks.training_agents);
    }
    const upserted = candidateScoresRepo.upsert(row);
    return { scores: upserted };
  });

  const result = tx();
  let recalculated = null;
  try { recalculated = recalculateCandidateScores(doc.base_key, adminKey); } catch (_) { /* ignore */ }
  return { scores: result.scores, recalculated };
}

function safeArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; } }
  return [];
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

  console.log('=== FULL-CANDIDATE-CARD-V1 import_full_candidate_card ===');
  console.log(`file: ${args.file}`);
  console.log(`dry-run: ${dryRun}`);
  console.log('');

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } catch (err) {
    console.error(`FAIL: cannot read/parse file: ${err.message}`);
    process.exit(1);
  }

  const topErrors = validateFullCard(doc);
  console.log(`1. Top-level validation: ${topErrors.length ? 'FAIL' : 'PASS'}`);
  for (const e of topErrors) console.log(`   ERROR: ${e}`);
  if (topErrors.length) process.exit(2);
  console.log(`   base_key: ${doc.base_key}`);

  const plan = buildPlan(doc);

  // Print the calls semantic block (if a calls analysis was present).
  const callsEval = plan.calls.eval;
  if (callsEval && callsEval.semantic) {
    const c = callsEval.semantic.checks;
    console.log('');
    console.log('2. Calls semantic checks:');
    console.log(`   - question_results: ${c.question_results}`);
    console.log(`   - call_results: ${c.call_results}`);
    console.log(`   - stage_dynamics: ${c.stage_dynamics}`);
    console.log(`   - score consistency: ${c.score_consistency}`);
    console.log(`   - forbidden markers: ${c.forbidden_markers}`);
    for (const d of callsEval.semantic.details) console.log(`     · ${d}`);
  }

  console.log('');
  console.log('3. Blocks to update:');
  const order = ['interview', 'calls', 'training_agents', 'ops', 'final_test', 'overall'];
  const labels = {
    interview: 'interview       ', calls: 'calls           ', training_agents: 'training_agents ',
    ops: 'ops             ', final_test: 'final_test      ', overall: 'overall         ',
  };
  let hasError = false;
  for (const key of order) {
    const p = plan[key];
    const tag = p.action === 'update' ? 'UPDATE' : p.action === 'error' ? 'ERROR ' : 'SKIP  ';
    if (p.action === 'error') hasError = true;
    console.log(`   - ${labels[key]} ${tag}  ${p.detail}`);
  }

  if (hasError) {
    console.log('');
    console.error('One or more blocks failed validation. Aborting (no DB writes).');
    process.exit(3);
  }

  if (dryRun) {
    console.log('');
    console.log('DRY-RUN complete. No DB writes performed.');
    process.exit(0);
  }

  try {
    const { scores, recalculated } = persistFullCard(doc, plan, adminKey);
    console.log('');
    console.log('4. Persisted:');
    console.log(`   candidate_scores.id: ${scores.id}`);
    if (recalculated) {
      console.log(`   After recalculate → overall=${recalculated.overall_score} risk=${recalculated.risk_level} status=${recalculated.final_status}`);
    }
    console.log('');
    console.log('Import complete. Open report-v1.html to see the updated card.');
    process.exit(0);
  } catch (err) {
    console.error(`FAIL: persistence error: ${err.message}`);
    if (process.env.PHASE3E0_DEBUG) console.error(err.stack);
    process.exit(4);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildPlan, evaluateAnalysisBlock, validateFullCard };
