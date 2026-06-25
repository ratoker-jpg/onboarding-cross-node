#!/usr/bin/env node
/**
 * DATA-PURGE-V1 — purge sensitive candidate data via CLI.
 *
 * This is a thin wrapper around services/phase1_candidate_service.js →
 * purgeCandidateData(). The same function powers the admin endpoint
 * POST /api/admin/phase1/candidates/:base_key/purge, so CLI and API
 * behaviour stay in lockstep.
 *
 * Usage:
 *   node scripts/purge_candidate_data.js --base-key GTRAIN02 --mode candidate_data --dry-run
 *   node scripts/purge_candidate_data.js --base-key GTRAIN02 --mode candidate_data --confirm GTRAIN02
 *
 * Safety:
 *   - --dry-run (default): nothing is deleted. Prints counts of what WOULD
 *     be removed.
 *   - live purge requires --confirm <base_key> AND --base-key <base_key>
 *     to be equal. The service also enforces this, but we fail fast here
 *     so the operator sees the mismatch before any DB work.
 *   - All DB deletes run inside one transaction. tmp/ file unlink happens
 *     after the tx commits; a failed unlink is reported but does NOT roll
 *     back the DB.
 *   - Writes an audit_log row (action=candidate_data_purge) with counts
 *     only — never raw call/interview text.
 *
 * Exit codes:
 *   0 — dry-run printed counts, or live purge succeeded
 *   1 — bad args / help
 *   2 — candidate not found
 *   3 — confirm mismatch
 *   4 — unsupported mode
 *   5 — internal error (DB / unlink)
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

const { purgeCandidateData } = require('../services/phase1_candidate_service');

function parseArgs(argv) {
  const out = { baseKey: null, mode: 'candidate_data', dryRun: true, confirm: null, adminKey: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--base-key') out.baseKey = argv[++i];
    else if (a.startsWith('--base-key=')) out.baseKey = a.slice('--base-key='.length);
    else if (a === '--mode') out.mode = argv[++i];
    else if (a.startsWith('--mode=')) out.mode = a.slice('--mode='.length);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--confirm') { out.confirm = argv[++i]; out.dryRun = false; }
    else if (a.startsWith('--confirm=')) { out.confirm = a.slice('--confirm='.length); out.dryRun = false; }
    else if (a === '--admin-key') out.adminKey = argv[++i];
    else if (a.startsWith('--admin-key=')) out.adminKey = a.slice('--admin-key='.length);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/purge_candidate_data.js --base-key <KEY> [options]

Options:
  --base-key <KEY>      Candidate base_key (e.g. GTRAIN02). Required.
  --mode <MODE>         Purge mode. Only "candidate_data" is supported in v1.
                        Default: candidate_data
  --dry-run             Default. Print what WOULD be deleted; change nothing.
  --confirm <KEY>       Live purge. MUST equal --base-key. Implicitly clears
                        --dry-run.
  --admin-key <KEY>     Admin key for audit_log. Defaults to "cli-purge".
  --help, -h            Show this help.

Examples:
  # Dry-run — see what would be deleted for GTRAIN02:
  node scripts/purge_candidate_data.js --base-key GTRAIN02 --mode candidate_data --dry-run

  # Live purge — deletes everything for GTRAIN02 (candidate_data mode keeps
  # the candidates row + candidate_keys):
  node scripts/purge_candidate_data.js --base-key GTRAIN02 --mode candidate_data --confirm GTRAIN02

What "candidate_data" mode removes:
  - manual_inputs (interview transcripts, calls, ops, phone metrics, ...)
  - candidate_files (uploaded transcripts / screenshots + their text_content)
  - ai_profile (legacy AI summary)
  - candidate_source_links
  - test_day_snapshot, immersion_snapshot, training_bot_dialogs
  - candidate_scores (rubric scores, recommendations, strengths, red_flags, ...)
  - analysis_runs (Codex interview/calls/training_agents/ops analyses)
  - import_runs (Google Sheets import history for this candidate)
  - legacy_targets_map (session_key → legacy_target mappings)
  - tmp/<base_key>* bundle/result JSON files

What it KEEPS:
  - candidates row (id, base_key, full_name, segment, direction, mentor,
    recruiter, dates, status) — the candidate stays listed
  - candidate_keys (session_key/key_type/etc.) — needed for re-imports
  - audit_log rows (including the new candidate_data_purge entry)

A separate "full_delete" mode (removes candidates + keys too) is described
in PATCH_REPORT_DATA_PURGE_V1.md but not implemented in v1.
`);
}

function fmtCounts(counts) {
  // counts is an object with string keys → number values. Print one per line.
  // Skip non-count fields: tmp_files_preview is a redacted array (printed
  // separately), tmp_file_paths is legacy and no longer returned.
  const SKIP = new Set(['tmp_file_paths', 'tmp_files_preview']);
  const lines = [];
  for (const k of Object.keys(counts)) {
    if (SKIP.has(k)) continue;
    lines.push(`    ${k}: ${counts[k]}`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.baseKey) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const adminKey = args.adminKey || 'cli-purge';
  const isLive = !args.dryRun; // --confirm clears dry-run

  console.log('=== DATA-PURGE-V1 — purge_candidate_data ===');
  console.log(`base_key:  ${args.baseKey}`);
  console.log(`mode:      ${args.mode}`);
  console.log(`dry_run:   ${args.dryRun}`);
  if (isLive) console.log(`confirm:   ${args.confirm}`);
  console.log('');

  // Fail fast on confirm mismatch before any DB work.
  if (isLive && args.confirm !== args.baseKey) {
    console.error(`FAIL: --confirm (${args.confirm || '<empty>'}) must equal --base-key (${args.baseKey}).`);
    process.exit(3);
  }

  let result;
  try {
    result = purgeCandidateData(args.baseKey, {
      mode: args.mode,
      confirm_base_key: isLive ? args.confirm : args.baseKey, // dry-run still needs a matching confirm_base_key
      dry_run: args.dryRun,
      admin_key: adminKey,
    });
  } catch (err) {
    if (err.code === 'CANDIDATE_NOT_FOUND') {
      console.error(`FAIL: candidate_not_found:${args.baseKey}`);
      process.exit(2);
    }
    if (err.code === 'PURGE_CONFIRM_MISMATCH') {
      console.error(`FAIL: confirm_base_key_mismatch (expected ${args.baseKey}).`);
      process.exit(3);
    }
    if (err.code === 'PURGE_UNSUPPORTED_MODE') {
      console.error(`FAIL: ${err.message}`);
      process.exit(4);
    }
    console.error(`FAIL: ${err.message}`);
    if (process.env.DATA_PURGE_DEBUG) console.error(err.stack);
    process.exit(5);
  }

  // Pretty-print the result.
  const c = result.candidate || {};
  console.log(`Candidate: ${c.full_name || '—'} · ${c.seller_segment || '—'} · ${c.direction || '—'} (status: ${c.status || '—'})`);
  console.log('');

  if (result.dry_run) {
    console.log('Would delete:');
    console.log(fmtCounts(result.would_delete || {}));
    console.log('');
    console.log('DRY-RUN complete. No DB writes performed.');
    // SECURITY: tmp_files_preview contains redacted paths only (basename
    // or relative-to-allowed-root). Never print raw absolute paths.
    const preview = (result.would_delete || {}).tmp_files_preview;
    if (Array.isArray(preview) && preview.length > 0) {
      console.log('tmp files that would be unlinked (redacted):');
      for (const p of preview) {
        console.log(`  - ${p}`);
      }
    }
    process.exit(0);
  }

  // Live result
  console.log('Deleted:');
  console.log(fmtCounts(result.deleted || {}));
  console.log('');
  console.log(`audit_log_id: ${result.audit_log_id == null ? '—' : result.audit_log_id}`);
  if (result.tmp_files_failed > 0) {
    console.log(`WARN: ${result.tmp_files_failed} tmp file(s) could not be unlinked:`);
    for (const p of result.tmp_files_failed_paths || []) {
      console.log(`  - ${p}`);
    }
    console.log('The DB purge is still permanent; remove these files manually if needed.');
  }
  // SECURITY: unsafe_paths are already redacted (basename-only) by the
  // service. Print them so the operator can investigate compromised DB rows.
  if (result.unsafe_paths_count > 0) {
    console.log(`WARN: ${result.unsafe_paths_count} path(s) outside allowed roots were NOT unlinked (suspected compromised DB row):`);
    for (const p of result.unsafe_paths || []) {
      console.log(`  - ${p}`);
    }
    console.log('Inspect candidate_files.stored_path for these candidates.');
  }
  console.log('');
  console.log('Purge complete. The candidates row + candidate_keys are kept; the candidate stays listed.');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, main };
