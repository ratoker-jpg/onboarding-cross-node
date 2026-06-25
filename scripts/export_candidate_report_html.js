#!/usr/bin/env node
/**
 * STATIC-HTML-EXPORT-V1 — export a candidate's report as a self-contained HTML file.
 *
 * Thin wrapper around services/phase1_candidate_service.js →
 * exportCandidateReportHtml(). The same function powers the admin endpoint
 * POST /api/admin/phase1/candidates/:base_key/export-html.
 *
 * Usage:
 *   node scripts/export_candidate_report_html.js --base-key GTRAIN02 --confirm GTRAIN02
 *   node scripts/export_candidate_report_html.js --base-key GTRAIN02 --confirm GTRAIN02 --out tmp/exports/custom.html
 *
 * Safety:
 *   - --confirm <KEY> MUST equal --base-key. Fails fast before any DB work.
 *   - Writes only to <repoRoot>/tmp/exports/ (or --out if specified inside tmp/).
 *   - The generated HTML is self-contained: inline CSS, inline JSON card,
 *     no fetch(), no viewer key, no server dependency. Safe to open via file://.
 *   - base_key / session keys / source_links / import_summary are stripped
 *     from the embedded JSON before writing.
 *
 * Exit codes:
 *   0 — export succeeded
 *   1 — bad args / help
 *   2 — candidate not found
 *   3 — confirm mismatch
 *   5 — internal error (DB / fs)
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

const { exportCandidateReportHtml } = require('../services/phase1_candidate_service');

function parseArgs(argv) {
  const out = { baseKey: null, confirm: null, out: null, adminKey: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--base-key') out.baseKey = argv[++i];
    else if (a.startsWith('--base-key=')) out.baseKey = a.slice('--base-key='.length);
    else if (a === '--confirm') out.confirm = argv[++i];
    else if (a.startsWith('--confirm=')) out.confirm = a.slice('--confirm='.length);
    else if (a === '--out') out.out = argv[++i];
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
    else if (a === '--admin-key') out.adminKey = argv[++i];
    else if (a.startsWith('--admin-key=')) out.adminKey = a.slice('--admin-key='.length);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/export_candidate_report_html.js --base-key <KEY> --confirm <KEY> [options]

Options:
  --base-key <KEY>    Candidate base_key (e.g. GTRAIN02). Required.
  --confirm <KEY>     MUST equal --base-key. Safety guard against typos.
  --out <PATH>        Custom output path. Default: tmp/exports/<Name>_report_<date>.html
                      If specified, MUST be inside tmp/ (path-safety).
  --admin-key <KEY>   Admin key for audit_log. Defaults to "cli-export".
  --help, -h          Show this help.

Examples:
  node scripts/export_candidate_report_html.js --base-key GTRAIN02 --confirm GTRAIN02
  node scripts/export_candidate_report_html.js --base-key GTRAIN02 --confirm GTRAIN02 --out tmp/exports/GTRAIN02_report.html

Output:
  A self-contained HTML file. Open it via file:// — no server, no API calls,
  no viewer key. base_key / session keys / server paths are NOT in the file.
`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.baseKey) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const adminKey = args.adminKey || 'cli-export';

  console.log('=== STATIC-HTML-EXPORT-V1 — export_candidate_report_html ===');
  console.log(`base_key:  ${args.baseKey}`);
  console.log('');

  // Fail fast on confirm mismatch before any DB work.
  if (args.confirm !== args.baseKey) {
    console.error(`FAIL: --confirm (${args.confirm || '<empty>'}) must equal --base-key (${args.baseKey}).`);
    process.exit(3);
  }

  let result;
  try {
    result = exportCandidateReportHtml(args.baseKey, {
      confirm_base_key: args.confirm,
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
    console.error(`FAIL: ${err.message}`);
    if (process.env.STATIC_EXPORT_DEBUG) console.error(err.stack);
    process.exit(5);
  }

  // If --out was specified and differs from the default, copy/move the file.
  // The service always writes to tmp/exports/<filename>. If the user wants
  // a different name, we rename it — but only inside tmp/ (path safety).
  if (args.out) {
    const repoRoot = path.resolve(__dirname, '..');
    const tmpRoot = path.resolve(repoRoot, 'tmp');
    const targetAbs = path.resolve(repoRoot, args.out);
    // Path-safety: target must be inside <repoRoot>/tmp/.
    const rel = path.relative(tmpRoot, targetAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.error(`FAIL: --out must be inside tmp/, got: ${args.out}`);
      process.exit(5);
    }
    const defaultAbs = path.resolve(repoRoot, result.file.path);
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    if (targetAbs !== defaultAbs) {
      fs.renameSync(defaultAbs, targetAbs);
    }
    result.file.path = args.out.replace(/^.*tmp\//, 'tmp/');
    result.file.size_bytes = fs.statSync(targetAbs).size;
  }

  console.log(`OK: report exported`);
  console.log(`  filename: ${result.file.filename}`);
  console.log(`  path:     ${result.file.path}`);
  console.log(`  size:     ${result.file.size_bytes} bytes`);
  console.log('');
  console.log('Open the file via file:// — no server needed.');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, main };
