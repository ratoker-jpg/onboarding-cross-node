#!/usr/bin/env node
/**
 * Phase 3E0 — Export candidate analysis bundle for Codex.
 *
 * Reads candidate data from SQLite and writes a JSON bundle that Codex
 * (or any LLM agent) consumes together with a prompt template to produce
 * an analysis_result_v1 JSON. The result is then imported via
 * scripts/import_analysis_result.js.
 *
 * Usage:
 *   node scripts/export_candidate_analysis_bundle.js \
 *     --base-key GTRAIN01 \
 *     --type interview \
 *     --out tmp/GTRAIN01_interview_bundle.json
 *
 * Safety:
 *   - Never exports ADMIN_KEY / VIEWER_KEY / env secrets.
 *   - Long transcripts are capped (preview + length metadata) EXCEPT for the
 *     transcript of the requested analysis_type, which is exported in full
 *     with explicit source_ref markers so Codex can quote line numbers.
 *   - Files / screenshots are exported as metadata (path, mime, size) only —
 *     binary content is never embedded.
 *   - All sections outside the analysis_type's needs are omitted or capped.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// We need DB access without booting the full HTTP server.
// loadDotEnv is the same minimal parser used by server.js.
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

// Force admin feature on for the script — we read DB directly.
if (!process.env.PHASE1_ADMIN_ENABLED) process.env.PHASE1_ADMIN_ENABLED = '1';

const { getPhase1Db } = require('../lib/phase1_db');
const { getPhase1Config } = require('../lib/phase1_config');
const { loadRubric } = require('../services/phase1_rubric_score_service');

const {
  createCandidatesRepo,
} = require('../repositories/phase1_candidates_repo');
const { createManualInputsRepo } = require('../repositories/phase1_manual_inputs_repo');
const { createCandidateFilesRepo } = require('../repositories/phase1_candidate_files_repo');
const { createSourceLinksRepo } = require('../repositories/phase1_source_links_repo');
const { createCandidateScoresRepo } = require('../repositories/phase1_candidate_scores_repo');
const { createSnapshotsRepo } = require('../repositories/phase1_snapshots_repo');

// ----------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------

function parseArgs(argv) {
  const out = { baseKey: null, type: null, out: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--base-key') out.baseKey = argv[++i];
    else if (a === '--type') out.type = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a.startsWith('--base-key=')) out.baseKey = a.slice('--base-key='.length);
    else if (a.startsWith('--type=')) out.type = a.slice('--type='.length);
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/export_candidate_analysis_bundle.js --base-key <KEY> --type <interview|calls> --out <path>

Options:
  --base-key  Candidate base_key (e.g. GTRAIN01)
  --type      Analysis type: "interview" or "calls"
  --out       Output JSON file path
  --help      Show this help

Examples:
  node scripts/export_candidate_analysis_bundle.js --base-key GTRAIN01 --type interview --out tmp/GTRAIN01_interview_bundle.json
  node scripts/export_candidate_analysis_bundle.js --base-key GTRAIN01 --type calls --out tmp/GTRAIN01_calls_bundle.json
`);
}

// ----------------------------------------------------------------------
// Safety: payload projection
// ----------------------------------------------------------------------

const ANALYSIS_TYPE_TO_RUBRIC = {
  interview: 'interview_binary_v1',
  calls: 'calls_automanual_binary_v1',
};

// Secret-leakage patterns. Mirrors services/phase1_analysis_result_validator.js
// FORBIDDEN_SECRET_PATTERNS so the same checks run on export (before the
// bundle leaves the server) AND on import (before the result reaches the DB).
const FORBIDDEN_SECRET_PATTERNS = [
  /ADMIN_KEY\s*[:=]/i,
  /VIEWER_KEY\s*[:=]/i,
  /ghp_[A-Za-z0-9]{20,}/i,
  /github_pat_[A-Za-z0-9_]{20,}/i,
  /AA[A-Za-z0-9_-]{30,}/i,
  /x-access-token:/i,
];

/**
 * Scan a stringified JSON for forbidden secret patterns. Throws if any match.
 * Export uses this BEFORE fs.writeFileSync so a leaked secret never leaves
 * the server in the bundle file.
 *
 * @param {string} docStr - JSON.stringify(bundle) output
 * @param {string} context - human-readable label for error messages
 * @throws {Error} if a forbidden pattern is found
 */
function assertNoForbiddenSecrets(docStr, context) {
  for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
    const match = docStr.match(pattern);
    if (match) {
      const err = new Error(`forbidden_secret_in_bundle:${context}:pattern ${match[0]}`);
      err.code = 'FORBIDDEN_SECRET_IN_BUNDLE';
      err.pattern = match[0];
      err.context = context;
      throw err;
    }
  }
}

// Sections needed in full for each analysis type.
// For interview: we want the full transcript text.
// For calls: we want full transcripts of calls_start / calls_middle / calls_final.
const FULL_TEXT_SECTIONS_BY_TYPE = {
  interview: new Set(['interview', 'interview_transcript']),
  calls: new Set(['calls_start', 'calls_middle', 'calls_final', 'phone_metrics']),
};

// Cap for sections not in FULL_TEXT_SECTIONS_BY_TYPE.
const BUNDLE_PREVIEW_LIMIT = 2000;

function safeStringifyOnce(obj) {
  try { return JSON.stringify(obj); } catch (_) { return '[unserializable]'; }
}

function truncateForBundle(value, allowFull) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (allowFull || value.length <= BUNDLE_PREVIEW_LIMIT) return value;
    return { preview: value.slice(0, BUNDLE_PREVIEW_LIMIT), truncated: true, length: value.length };
  }
  if (typeof value === 'object') {
    const clone = Array.isArray(value) ? [...value] : { ...value };
    for (const key of Object.keys(clone)) {
      if (typeof clone[key] === 'string') {
        if (!(allowFull) && clone[key].length > BUNDLE_PREVIEW_LIMIT) {
          const full = clone[key];
          clone[key] = { preview: full.slice(0, BUNDLE_PREVIEW_LIMIT), truncated: true, length: full.length };
        }
      } else if (typeof clone[key] === 'object' && clone[key] !== null) {
        clone[key] = truncateForBundle(clone[key], allowFull);
      }
    }
    return clone;
  }
  return value;
}

function projectManualInputForBundle(raw, analysisType) {
  if (!raw) return null;
  const allowFull = FULL_TEXT_SECTIONS_BY_TYPE[analysisType].has(raw.section);
  const payload = truncateForBundle(raw.payload, allowFull);
  return {
    section: raw.section,
    payload,
    updated_at: raw.updated_at || null,
    // Mark whether the payload text is full or truncated, so Codex knows
    // whether it has the complete source for evidence quoting.
    full_text_included: allowFull,
  };
}

function projectTrainingDialogForBundle(raw, analysisType) {
  if (!raw) return null;
  // For calls analysis: include full transcript_text so Codex can quote it.
  // For interview analysis: only metadata (transcript not needed).
  const includeTranscript = analysisType === 'calls';
  const out = {
    session_key: raw.training_key || null,
    dialog_date: raw.dialog_date || null,
    role_id: raw.role_id || null,
    role_title: raw.role_title || null,
    role_client: raw.role_client || raw.role_client_name || null,
    role_business: raw.role_business || raw.role_company || null,
    role_tax_system: raw.role_tax_system || null,
    role_business_type: raw.role_business_type || null,
    role_success_criteria: raw.role_success_criteria || null,
    role_failure_criteria: raw.role_failure_criteria || null,
    role_target_action: raw.role_target_action || null,
    role_objections: raw.role_objections || null,
    role_tone: raw.role_tone || null,
    result: raw.result || null,
    result_payload: raw.result_payload || null,
    source_ref: raw.dedup_key ? `dialog:${raw.dedup_key}` : `dialog:id:${raw.id}`,
  };
  if (includeTranscript) {
    // Cap individual dialog transcript at 20K chars to keep bundle manageable.
    const cap = 20000;
    const text = raw.transcript_text || '';
    if (text.length > cap) {
      out.transcript_text = {
        preview: text.slice(0, cap),
        truncated: true,
        length: text.length,
      };
    } else {
      out.transcript_text = text;
    }
    out.transcript_full_text_included = text.length <= cap;
  } else {
    out.transcript_text_omitted = true;
  }
  return out;
}

function projectFileForBundle(raw) {
  if (!raw) return null;
  // Files are exported as metadata only — no binary content.
  return {
    section: raw.section,
    file_type: raw.file_type || null,
    original_name: raw.original_name || null,
    stored_path: raw.stored_path || null,
    mime_type: raw.mime_type || null,
    size_bytes: raw.size_bytes || null,
    comment: raw.comment || null,
    // text_content is included only if it's a text file and within cap
    text_content_preview: typeof raw.text_content === 'string' && raw.text_content.length > 0
      ? raw.text_content.slice(0, 500)
      : null,
    source_ref: raw.stored_path ? `file:${raw.stored_path}` : `file:id:${raw.id}`,
  };
}

// ----------------------------------------------------------------------
// Bundle assembly
// ----------------------------------------------------------------------

function buildCallStatsBundle(manualInputs) {
  // Mirror services/phase1_candidate_service.js buildCallStats() logic
  // but kept local to avoid pulling the whole service (which asserts admin).
  const phoneMetrics = manualInputs.find(m => m && m.section === 'phone_metrics');
  if (!phoneMetrics || !phoneMetrics.payload) {
    return {
      talk_time_minutes: null, calls_total: null, reached_calls: null,
      calls_over_2min: null, calls_over_2min_percent: null,
      calls_over_10min: null, effective_minutes: null, days: [],
    };
  }
  const p = phoneMetrics.payload;
  const days = Array.isArray(p.days) ? p.days : [];
  if (!days.length) {
    return {
      talk_time_minutes: null, calls_total: null, reached_calls: null,
      calls_over_2min: null, calls_over_2min_percent: null,
      calls_over_10min: null, effective_minutes: null, days: [],
    };
  }
  let talkTime = 0, callsTotal = 0, callsOver2min = 0, callsOver10min = 0, effectiveMinutes = 0;
  for (const d of days) {
    const minutes = Number(d.minutes) || 0;
    const callsCount = Number(d.calls_count) || 0;
    const pct = Number(d.calls_over_2min_percent);
    talkTime += minutes;
    callsTotal += callsCount;
    effectiveMinutes += minutes;
    if (typeof d.calls_over_2min === 'number') callsOver2min += d.calls_over_2min;
    else if (callsCount > 0 && Number.isFinite(pct)) callsOver2min += Math.round((callsCount * pct) / 100);
    if (typeof d.calls_over_10min === 'number') callsOver10min += d.calls_over_10min;
  }
  return {
    talk_time_minutes: talkTime || null,
    calls_total: callsTotal || null,
    reached_calls: callsTotal || null,
    calls_over_2min: callsOver2min || null,
    calls_over_2min_percent: callsTotal ? Math.round((callsOver2min / callsTotal) * 1000) / 10 : null,
    calls_over_10min: callsOver10min || null,
    effective_minutes: effectiveMinutes || null,
    days: days.map((d, idx) => ({
      day: d.day != null ? d.day : idx + 1,
      minutes: Number(d.minutes) || 0,
      calls_count: Number(d.calls_count) || 0,
      calls_over_2min_percent: Number.isFinite(Number(d.calls_over_2min_percent)) ? Number(d.calls_over_2min_percent) : null,
    })),
  };
}

function exportBundle(baseKey, analysisType) {
  if (!ANALYSIS_TYPE_TO_RUBRIC[analysisType]) {
    throw new Error(`invalid_analysis_type:${analysisType}`);
  }
  const db = getPhase1Db();
  const candidatesRepo = createCandidatesRepo(db);
  const manualInputsRepo = createManualInputsRepo(db);
  const candidateFilesRepo = createCandidateFilesRepo(db);
  const sourceLinksRepo = createSourceLinksRepo(db);
  const candidateScoresRepo = createCandidateScoresRepo(db);
  const snapshotsRepo = createSnapshotsRepo(db);

  const candidate = candidatesRepo.findByBaseKey(baseKey);
  if (!candidate) {
    throw new Error(`candidate_not_found:${baseKey}`);
  }

  // Raw manual inputs
  const manualInputsRaw = manualInputsRepo.listByCandidateId(candidate.id);
  const manualInputs = manualInputsRaw
    .map(m => projectManualInputForBundle(m, analysisType))
    .filter(Boolean);

  // Training dialogs — ONLY included for interview bundles.
  // Phase 3E3C: calls analysis must NEVER use training bot dialogs.
  // Training agents are a separate entity for training_agent_analysis_v1.
  const trainingDialogsRaw = analysisType === 'calls'
    ? []
    : snapshotsRepo.listTrainingBotDialogsByCandidateId(candidate.id);
  const trainingBotDialogs = trainingDialogsRaw
    .map(d => projectTrainingDialogForBundle(d, analysisType))
    .filter(Boolean);

  // Phase 3E3C: for calls analysis, verify that real calls exist.
  // If no real calls are found, abort with a clear error — do NOT fall back
  // to training bot dialogs.
  if (analysisType === 'calls') {
    const callsSections = ['calls_start', 'calls_middle', 'calls_final'];
    let totalCalls = 0;
    for (const sec of callsSections) {
      const mi = manualInputsRaw.find(m => m.section === sec);
      if (mi && mi.payload) {
        if (Array.isArray(mi.payload.calls)) totalCalls += mi.payload.calls.length;
        else if (mi.payload.transcript) totalCalls += 1; // legacy single-call shape
      }
    }
    if (totalCalls === 0) {
      throw new Error('No real calls found for calls analysis. Upload calls_start/calls_middle/calls_final first.');
    }
  }

  // Files as metadata only
  const filesRaw = candidateFilesRepo.listByCandidateId(candidate.id);
  const files = filesRaw.map(projectFileForBundle).filter(Boolean);

  // Candidate scores (current)
  const scores = candidateScoresRepo.getByCandidateId(candidate.id);

  // Source links
  const sourceLinks = sourceLinksRepo.listByCandidateId(candidate.id);

  // Call stats (only relevant for calls; null for interview)
  const callStats = analysisType === 'calls' ? buildCallStatsBundle(manualInputsRaw) : null;

  // Interview summary (only relevant for interview)
  let interviewSummary = null;
  if (analysisType === 'interview') {
    const transcript = manualInputsRaw.find(m => m.section === 'interview_transcript');
    const interview = manualInputsRaw.find(m => m.section === 'interview');
    let text = '';
    let updatedAt = null;
    if (transcript && transcript.payload) {
      const p = transcript.payload;
      text = typeof p === 'string' ? p : (p.text_content || p.transcript || p.text || '');
      updatedAt = transcript.updated_at || null;
    }
    if (!text && interview && interview.payload) {
      const p = interview.payload;
      text = typeof p === 'string' ? p : (p.text_content || p.transcript || p.text || '');
      updatedAt = updatedAt || interview.updated_at || null;
    }
    interviewSummary = {
      has_interview: Boolean(interview),
      has_transcript: Boolean(transcript),
      full_text_included: true,
      length: text.length,
      updated_at: updatedAt,
      // Note: the full text itself is in manual_inputs[interview_transcript].payload
      // (not duplicated here) so Codex reads it from there with a stable source_ref.
    };
  }

  // Rubric
  const rubricId = ANALYSIS_TYPE_TO_RUBRIC[analysisType];
  const rubric = loadRubric(rubricId);

  // Source refs collected for traceability
  const sourceRefs = [];
  if (interviewSummary) sourceRefs.push('manual_inputs.section=interview_transcript');
  if (callStats) sourceRefs.push('manual_inputs.section=phone_metrics');
  if (trainingBotDialogs.length) sourceRefs.push('training_bot_dialogs[]');
  for (const f of files) {
    if (f.source_ref) sourceRefs.push(f.source_ref);
  }
  for (const sl of sourceLinks) {
    sourceRefs.push(`source_link:${sl.source_code}:${sl.legacy_key || sl.legacy_id || ''}`);
  }

  // Compose safe candidate public profile (no internal id, no secrets)
  const candidatePublic = {
    base_key: candidate.base_key,
    full_name: candidate.full_name,
    seller_segment: candidate.seller_segment,
    direction: candidate.direction,
    mentor: candidate.mentor,
    recruiter: candidate.recruiter,
    test_day_started_at: candidate.test_day_started_at,
    immersion_started_at: candidate.immersion_started_at,
    status: candidate.status,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };

  return {
    schema_version: 'analysis_bundle_v1',
    base_key: baseKey,
    analysis_type: analysisType,
    exported_at: new Date().toISOString(),
    candidate: candidatePublic,
    completeness: null, // populated below
    scores: scores,
    manual_inputs: manualInputs,
    training_bot_dialogs: trainingBotDialogs,
    call_stats: callStats,
    ops_summary: null, // not needed for codex prompt — omitted for size
    interview_summary: interviewSummary,
    files: files,
    source_links: sourceLinks.map(sl => ({
      source_code: sl.source_code,
      source_name: sl.source_name,
      legacy_key: sl.legacy_key,
      legacy_id: sl.legacy_id,
      comment: sl.comment,
    })),
    rubric: {
      rubric_id: rubric.rubric_id,
      rubric_version: rubric.rubric_version,
      evaluation_unit: rubric.evaluation_unit,
      allowed_answers: rubric.allowed_answers,
      answer_groups: rubric.answer_groups,
      stage_weights: rubric.stage_weights,
      blocks: rubric.blocks,
      stages: rubric.stages,
      candidate_scores_mapping: rubric.candidate_scores_mapping,
      evidence_schema: rubric.evidence_schema,
      source_dependencies: rubric.source_dependencies,
      fallback_rules: rubric.fallback_rules,
      interpretation_percent_zones: rubric.interpretation_percent_zones,
      model_prohibitions: rubric.model_prohibitions,
    },
    source_refs: sourceRefs,
  };
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.baseKey || !args.type || !args.out) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  try {
    const bundle = exportBundle(args.baseKey, args.type);
    // Secret-leak guard: scan BEFORE writing the file. If a forbidden pattern
    // is found (e.g. an env var accidentally ended up in a manual_input
    // payload), the bundle must not leave the server.
    const bundleStr = JSON.stringify(bundle, null, 2);
    assertNoForbiddenSecrets(bundleStr, `export_bundle:${args.baseKey}:${args.type}`);
    const outDir = path.dirname(path.resolve(args.out));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(args.out, bundleStr, 'utf8');
    const size = fs.statSync(args.out).size;
    console.log(`OK bundle exported:`);
    console.log(`  base_key: ${args.baseKey}`);
    console.log(`  analysis_type: ${args.type}`);
    console.log(`  rubric: ${bundle.rubric.rubric_id} v${bundle.rubric.rubric_version}`);
    console.log(`  manual_inputs: ${bundle.manual_inputs.length}`);
    console.log(`  training_bot_dialogs: ${bundle.training_bot_dialogs.length}`);
    console.log(`  files (metadata only): ${bundle.files.length}`);
    console.log(`  source_refs: ${bundle.source_refs.length}`);
    console.log(`  out: ${args.out} (${size} bytes)`);
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    if (process.env.PHASE3E0_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
