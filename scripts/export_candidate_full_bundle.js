#!/usr/bin/env node
/**
 * FULL-CANDIDATE-CARD-V1 — export ONE full candidate bundle.
 *
 * After all candidate data is loaded via admin-v1, this script assembles a
 * single bundle covering every block of the newbie card so a single master
 * prompt (prompts/codex/full_candidate_card_analysis_v1.md) can produce one
 * full_candidate_card_v1 result, imported by
 * scripts/import_full_candidate_card.js.
 *
 * Usage:
 *   node scripts/export_candidate_full_bundle.js --base-key GTRAIN02 --out tmp/GTRAIN02_full_bundle.json
 *
 * Hard separation rules (kept intentionally):
 *   - Real calls are analysed ONLY via calls_automanual_binary_v1 (reused from
 *     the calls analysis bundle). Training bot dialogs are NEVER part of the
 *     calls block.
 *   - Training agents are a separate block — they do not feed call_quality_score.
 *   - Operations is its own block.
 *   - If a block has no data, it is emitted as { available:false,
 *     missing_data:true, ... } — nothing is invented.
 *
 * Safety: read-only. Writes only the output JSON. Runs a secret-leak scan
 * before writing. No DB writes, no live import, no deploy.
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

const { exportBundle } = require('./export_candidate_analysis_bundle');
const { getPhase1Db } = require('../lib/phase1_db');
const { createCandidatesRepo } = require('../repositories/phase1_candidates_repo');
const { createManualInputsRepo } = require('../repositories/phase1_manual_inputs_repo');
const { createSnapshotsRepo } = require('../repositories/phase1_snapshots_repo');

// Mirrors the secret patterns used by the analysis export/validator.
const FORBIDDEN_SECRET_PATTERNS = [
  /ADMIN_KEY\s*[:=]/i,
  /VIEWER_KEY\s*[:=]/i,
  /ghp_[A-Za-z0-9]{20,}/i,
  /github_pat_[A-Za-z0-9_]{20,}/i,
  /AA[A-Za-z0-9_-]{30,}/i,
  /x-access-token:/i,
];

const OPS_SECTIONS = ['phone_metrics', 'ops_xsales', 'ops_overdue_goals', 'ops_statuses', 'ops_comments'];
const TRANSCRIPT_PREVIEW_CAP = 1200;

// ----------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------

function parseArgs(argv) {
  const out = { baseKey: null, out: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--base-key') out.baseKey = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a.startsWith('--base-key=')) out.baseKey = a.slice('--base-key='.length);
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/export_candidate_full_bundle.js --base-key <KEY> --out <path>

Options:
  --base-key  Candidate base_key (e.g. GTRAIN02)
  --out       Output JSON file path
  --help      Show this help

Example:
  node scripts/export_candidate_full_bundle.js --base-key GTRAIN02 --out tmp/GTRAIN02_full_bundle.json
`);
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function assertNoForbiddenSecrets(docStr, context) {
  for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
    const match = docStr.match(pattern);
    if (match) {
      const err = new Error(`forbidden_secret_in_bundle:${context}:pattern ${match[0]}`);
      err.code = 'FORBIDDEN_SECRET_IN_BUNDLE';
      throw err;
    }
  }
}

function previewText(value, cap = TRANSCRIPT_PREVIEW_CAP) {
  if (typeof value !== 'string') return null;
  if (value.length <= cap) return value;
  return { preview: value.slice(0, cap), truncated: true, length: value.length };
}

/**
 * Project a training bot dialog for the full bundle: role portrait + metadata +
 * a transcript preview. No rubric, no score — training agents are analysed
 * separately and must never feed call_quality_score.
 */
function projectTrainingForFull(d) {
  if (!d) return null;
  return {
    session_key: d.training_key || null,
    dialog_date: d.dialog_date || null,
    role: {
      role_id: d.role_id || null,
      role_title: d.role_title || null,
      role_company: d.role_company || null,
      role_client_name: d.role_client_name || null,
      role_tax_system: d.role_tax_system || null,
      role_business_type: d.role_business_type || null,
      role_success_criteria: d.role_success_criteria || null,
      role_failure_criteria: d.role_failure_criteria || null,
      role_target_action: d.role_target_action || null,
      role_objections: d.role_objections || null,
      role_tone: d.role_tone || null,
    },
    result: d.result_payload || null,
    transcript_preview: previewText(d.transcript_text),
    source_ref: d.dedup_key ? `dialog:${d.dedup_key}` : `dialog:id:${d.id}`,
  };
}

async function buildAnalysisBlock(baseKey, type) {
  // Reuse the existing analysis bundle (real_calls, product dictionary, rubric).
  // If the data isn't there (e.g. no real calls), mark the block missing
  // instead of failing the whole export.
  try {
    const bundle = await exportBundle(baseKey, type);
    return { available: true, missing_data: false, reason: null, bundle };
  } catch (err) {
    return { available: false, missing_data: true, reason: err.message, bundle: null };
  }
}

async function buildFullBundle(baseKey) {
  const db = getPhase1Db();
  const candidatesRepo = createCandidatesRepo(db);
  const manualInputsRepo = createManualInputsRepo(db);
  const snapshotsRepo = createSnapshotsRepo(db);

  const candidate = candidatesRepo.findByBaseKey(baseKey);
  if (!candidate) throw new Error(`candidate_not_found:${baseKey}`);

  // --- Interview + Calls: reuse the analysis bundles verbatim ---
  const interview = await buildAnalysisBlock(baseKey, 'interview');
  const calls = await buildAnalysisBlock(baseKey, 'calls');

  // --- Training agents (separate; does NOT feed call_quality_score) ---
  const dialogsRaw = snapshotsRepo.listTrainingBotDialogsByCandidateId(candidate.id);
  const training_agents = {
    available: dialogsRaw.length > 0,
    missing_data: dialogsRaw.length === 0,
    count: dialogsRaw.length,
    note: 'Учебные агенты анализируются отдельно (training agents). Это не реальные звонки и они не влияют на call_quality_score.',
    dialogs: dialogsRaw.map(projectTrainingForFull).filter(Boolean),
  };

  // --- Operations (separate block) ---
  const manualInputsRaw = manualInputsRepo.listByCandidateId(candidate.id);
  const opsSections = OPS_SECTIONS
    .map(code => {
      const mi = manualInputsRaw.find(m => m.section === code);
      if (!mi) return null;
      return { section: code, payload: previewText(JSON.stringify(mi.payload)) || mi.payload, updated_at: mi.updated_at || null };
    })
    .filter(Boolean);
  const ops = {
    available: opsSections.length > 0,
    missing_data: opsSections.length === 0,
    note: 'Операционка считается отдельно от звонков и собеседования.',
    sections: opsSections,
  };

  // --- Test day / immersion snapshots ---
  const testDaySnap = snapshotsRepo.getTestDayByCandidateId(candidate.id);
  const test_day = { available: Boolean(testDaySnap), missing_data: !testDaySnap, snapshot: testDaySnap || null };
  const immersionSnap = snapshotsRepo.getImmersionByCandidateId(candidate.id);
  const immersion = { available: Boolean(immersionSnap), missing_data: !immersionSnap, snapshot: immersionSnap || null };

  return {
    schema_version: 'full_candidate_bundle_v1',
    base_key: baseKey,
    exported_at: new Date().toISOString(),
    candidate: {
      base_key: candidate.base_key,
      full_name: candidate.full_name,
      seller_segment: candidate.seller_segment,
      direction: candidate.direction,
      mentor: candidate.mentor,
      recruiter: candidate.recruiter,
      test_day_started_at: candidate.test_day_started_at,
      immersion_started_at: candidate.immersion_started_at,
      immersion_finished_at: candidate.immersion_finished_at || null,
      experience_summary: candidate.experience_summary || null,
      status: candidate.status,
    },
    rubrics: {
      interview: 'interview_binary_v1',
      calls: 'calls_automanual_binary_v1',
    },
    separation_rules: [
      'Реальные звонки анализируются ТОЛЬКО через calls_automanual_binary_v1.',
      'Учебные агенты (training_bot_dialogs) анализируются отдельно и не влияют на call_quality_score.',
      'Операционка считается отдельным блоком.',
      'Если данных нет — ставить null и missing_data, ничего не выдумывать.',
    ],
    blocks: {
      interview,
      calls,
      training_agents,
      ops,
      test_day,
      immersion,
    },
  };
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.baseKey || !args.out) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  try {
    const bundle = await buildFullBundle(args.baseKey);
    const bundleStr = JSON.stringify(bundle, null, 2);
    assertNoForbiddenSecrets(bundleStr, `full_bundle:${args.baseKey}`);
    const outDir = path.dirname(path.resolve(args.out));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(args.out, bundleStr, 'utf8');
    const b = bundle.blocks;
    console.log('OK full bundle exported:');
    console.log(`  base_key: ${args.baseKey}`);
    console.log(`  blocks present:`);
    console.log(`    interview:        ${b.interview.available ? 'yes' : 'NO (' + b.interview.reason + ')'}`);
    console.log(`    calls:            ${b.calls.available ? 'yes' : 'NO (' + b.calls.reason + ')'}`);
    console.log(`    training_agents:  ${b.training_agents.available ? b.training_agents.count + ' dialogs' : 'NO'}`);
    console.log(`    ops:              ${b.ops.available ? b.ops.sections.length + ' sections' : 'NO'}`);
    console.log(`    test_day:         ${b.test_day.available ? 'yes' : 'NO'}`);
    console.log(`    immersion:        ${b.immersion.available ? 'yes' : 'NO'}`);
    console.log(`  out: ${args.out} (${fs.statSync(args.out).size} bytes)`);
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    if (process.env.PHASE3E0_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildFullBundle, projectTrainingForFull };
