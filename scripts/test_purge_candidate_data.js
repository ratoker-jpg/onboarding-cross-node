#!/usr/bin/env node
/**
 * DATA-PURGE-V1 — unit test for purgeCandidateData() helpers + a stub-based
 * logic test for the main function.
 *
 * better-sqlite3 is NOT installed in this environment, so we can't spin up
 * a real in-memory DB. Instead we:
 *
 *   1. Extract the pure helpers (listTmpFilesForBaseKey, unlinkFiles) and
 *      exercise them against a real tmp dir on disk.
 *   2. Extract purgeCandidateData via vm sandboxing with stubbed ensureDb /
 *      buildRepos / fs / path, and verify:
 *      - dry_run returns counts without touching anything
 *      - confirm_base_key mismatch → throws PURGE_CONFIRM_MISMATCH
 *      - candidate not found → throws CANDIDATE_NOT_FOUND
 *      - unsupported mode → throws PURGE_UNSUPPORTED_MODE
 *      - live purge runs all deletes inside a transaction, returns counts
 *      - audit log payload contains ONLY counts + mode + dry_run (no raw text)
 *      - tmp/ file unlink happens after tx commits
 *      - failed unlink does NOT roll back the DB
 *
 * This is NOT a substitute for a real DB integration test — see the
 * "Server verification steps" section in PATCH_REPORT_DATA_PURGE_V1.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const servicePath = path.join(repoRoot, 'services', 'phase1_candidate_service.js');
const src = fs.readFileSync(servicePath, 'utf8');

// ----------------------------------------------------------------------
// Part 1 — extract + test the pure helpers (listTmpFilesForBaseKey, unlinkFiles)
// against a real tmp dir on disk.
// ----------------------------------------------------------------------

function extractFunction(name) {
  const re = new RegExp(`function ${name}\\b[\\s\\S]*?^\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`function ${name} not found in service source`);
  return m[0];
}

// Extract the helper functions + the PURGE_ALLOWED_ROOTS const block.
// We grab everything from `function listTmpFilesForBaseKey` up to (but not
// including) `function countCandidateData` — that span includes:
//   listTmpFilesForBaseKey, PURGE_ALLOWED_ROOTS, isPathInside,
//   isPathInsideAnyRoot, redactPath, unlinkFiles.
function extractHelperBlock() {
  const start = src.indexOf('function listTmpFilesForBaseKey');
  if (start < 0) throw new Error('listTmpFilesForBaseKey not found in source');
  const end = src.indexOf('function countCandidateData', start);
  if (end < 0) throw new Error('countCandidateData not found in source');
  return src.slice(start, end);
}
const helpersSrc = extractHelperBlock();
const helpersSandbox = { module: { exports: {} }, fs, path, process, console, __dirname: path.join(repoRoot, 'services') };
helpersSandbox.globalThis = helpersSandbox;
vm.createContext(helpersSandbox);
vm.runInContext(helpersSrc + '\nmodule.exports = { listTmpFilesForBaseKey, unlinkFiles, isPathInside, isPathInsideAnyRoot, redactPath, PURGE_ALLOWED_ROOTS };', helpersSandbox, {
  filename: 'purge_helpers_extract.js',
});
const { listTmpFilesForBaseKey, unlinkFiles, isPathInside, isPathInsideAnyRoot, redactPath, PURGE_ALLOWED_ROOTS } = helpersSandbox.module.exports;

// Part 1 — real-filesystem test for listTmpFilesForBaseKey + unlinkFiles.
// We create files inside the REAL <repoRoot>/tmp/ directory (which is in
// PURGE_ALLOWED_ROOTS) so unlinkFiles actually unlinks them. We also test
// path-traversal safety: a stored_path like "/etc/passwd" or "../../.env"
// must NOT be unlinked and must land in `unsafe`.
const realTmpDir = path.join(repoRoot, 'tmp');
try { fs.mkdirSync(realTmpDir, { recursive: true }); } catch (_) {}
const tmpFilesCreated = [];
try {
  // Create 3 files in <repoRoot>/tmp/: two match GTRAIN02, one doesn't.
  const match1 = path.join(realTmpDir, 'GTRAIN02_calls_bundle.json');
  const match2 = path.join(realTmpDir, 'GTRAIN02_calls_result.json');
  const other = path.join(realTmpDir, 'OTHER_candidate_purge_test.json');
  fs.writeFileSync(match1, '{}');
  fs.writeFileSync(match2, '{}');
  fs.writeFileSync(other, '{}');
  tmpFilesCreated.push(match1, match2, other);

  // listTmpFilesForBaseKey reads <repoRoot>/tmp/ (resolved via __dirname
  // in the sandbox, which we set to <repoRoot>/services). It returns
  // absolute paths for files whose name contains the base_key.
  const matched = listTmpFilesForBaseKey('GTRAIN02');
  // Filter out any pre-existing GTRAIN02 files in tmp/ from other runs.
  const ours = matched.filter(p => p.endsWith('GTRAIN02_calls_bundle.json') || p.endsWith('GTRAIN02_calls_result.json'));
  assert.ok(ours.length >= 2, `expected at least 2 GTRAIN02 matches in tmp/, got ${ours.length}: ${ours.join(', ')}`);
  assert.ok(ours.every(p => p.includes('GTRAIN02')));

  // unlinkFiles: 2 safe paths (inside <repoRoot>/tmp/) → deleted.
  const unlinkResult = unlinkFiles(ours);
  assert.strictEqual(unlinkResult.deleted, ours.length, `expected ${ours.length} deleted, got ${unlinkResult.deleted}`);
  assert.strictEqual(unlinkResult.failed.length, 0);
  assert.strictEqual(unlinkResult.unsafe.length, 0, 'safe paths must not be flagged unsafe');
  assert.ok(!fs.existsSync(match1), 'match1 must be unlinked');
  assert.ok(!fs.existsSync(match2), 'match2 must be unlinked');
  assert.ok(fs.existsSync(other), 'other file must remain');

  // ENOENT (already gone) → skipped, not failed, not unsafe.
  const r2 = unlinkFiles([path.join(realTmpDir, 'does-not-exist.json')]);
  assert.strictEqual(r2.deleted, 0);
  assert.strictEqual(r2.failed.length, 0, 'ENOENT must not count as failed');
  assert.strictEqual(r2.unsafe.length, 0, 'ENOENT must not count as unsafe');

  // BLOCKER 1: path-traversal safety. stored_path values that resolve
  // OUTSIDE PURGE_ALLOWED_ROOTS must NOT be unlinked, must NOT crash, and
  // must land in `unsafe` with a redacted basename.
  const unsafePaths = [
    '/etc/passwd',                              // absolute, outside roots
    '../../.env',                               // traversal above repo root
    '/tmp/../../etc/shadow',                    // traversal via /tmp
    path.join(os.tmpdir(), 'purge-test-attacker.json'), // absolute, outside roots
  ];
  // Pre-create the last one so we can verify it survives.
  fs.writeFileSync(unsafePaths[3], 'attacker');
  tmpFilesCreated.push(unsafePaths[3]);
  const r3 = unlinkFiles(unsafePaths);
  assert.strictEqual(r3.deleted, 0, 'no unsafe path must be deleted');
  assert.strictEqual(r3.failed.length, 0, 'unsafe paths must not count as failed');
  assert.strictEqual(r3.unsafe.length, 4, `expected 4 unsafe, got ${r3.unsafe.length}`);
  // Redacted paths must NOT contain the original absolute path or the
  // original traversal payload. They should be basename-only.
  for (const u of r3.unsafe) {
    assert.ok(typeof u.path === 'string' && u.path.length > 0, 'unsafe path must be a non-empty string');
    assert.ok(!u.path.includes('/etc/'), `unsafe path must not leak "/etc/": ${u.path}`);
    assert.ok(!u.path.includes('..'), `unsafe path must not contain "..": ${u.path}`);
    assert.ok(!u.path.startsWith('/'), `unsafe path must not be absolute: ${u.path}`);
  }
  // The attacker file must still exist (purge did NOT unlink it).
  assert.ok(fs.existsSync(unsafePaths[3]), 'attacker file outside allowed roots must survive');
  console.log('TEST 0: unlinkFiles path-safety (real tmp/ + traversal payloads)');
  console.log('  ✓ 2 safe files deleted, 4 unsafe paths flagged + redacted, attacker file survives');
} finally {
  for (const p of tmpFilesCreated) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
}

// ----------------------------------------------------------------------
// Part 2 — vm-sandbox logic test for purgeCandidateData with stubbed DB.
// ----------------------------------------------------------------------

// Extract the full DATA-PURGE-V1 block + the helpers it calls.
const purgeBlockStart = src.indexOf('// DATA-PURGE-V1');
if (purgeBlockStart < 0) throw new Error('DATA-PURGE-V1 block not found in service source');
const lineStart = src.lastIndexOf('\n// ----', purgeBlockStart);
const blockStart = lineStart >= 0 ? lineStart + 1 : purgeBlockStart;
const purgeBlockEnd = src.indexOf('module.exports = {', purgeBlockStart);
if (purgeBlockEnd < 0) throw new Error('module.exports not found after DATA-PURGE-V1 block');
const purgeBlock = src.slice(blockStart, purgeBlockEnd);

const allHelpersSrc = [
  extractFunction('hashAdminKey'),
  extractFunction('nowIso'),
  extractFunction('ensureDb'),
  extractFunction('buildRepos'),
  extractFunction('appendAuditLog'),
].join('\n\n');

// Mock repos / db / fs
function makeReposMock(candidate, counts) {
  // stored_paths must be inside <cwd>/data/uploads/phase1/ so they pass
  // unlinkFiles' allowlist. We don't actually create these files on disk
  // (the mock fs will pretend they don't exist → ENOENT → skipped).
  const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads', 'phase1');
  const safeStoredPath = path.join(uploadsRoot, candidate.base_key, 'file.json');
  return {
    candidatesRepo: { findByBaseKey: () => candidate },
    manualInputsRepo: {
      listByCandidateId: () => Array(counts.manual_inputs).fill({}),
      deleteByCandidateId: () => counts.manual_inputs,
    },
    candidateFilesRepo: {
      listByCandidateId: () => Array(counts.candidate_files).fill({ stored_path: safeStoredPath }),
      deleteByCandidateId: () => ({ count: counts.candidate_files, stored_paths: counts.candidate_files ? [safeStoredPath] : [] }),
    },
    aiProfileRepo: {
      getByCandidateId: () => (counts.ai_profile ? {} : null),
      deleteByCandidateId: () => counts.ai_profile,
    },
    sourceLinksRepo: {
      listByCandidateId: () => Array(counts.source_links).fill({}),
      deleteByCandidateId: () => counts.source_links,
    },
    snapshotsRepo: {
      getTestDayByCandidateId: () => (counts.test_day_snapshot ? {} : null),
      getImmersionByCandidateId: () => (counts.immersion_snapshot ? {} : null),
      listTrainingBotDialogsByCandidateId: () => Array(counts.training_bot_dialogs).fill({}),
      deleteByCandidateId: () => ({
        test_day_snapshot: counts.test_day_snapshot,
        immersion_snapshot: counts.immersion_snapshot,
        training_bot_dialogs: counts.training_bot_dialogs,
      }),
    },
    candidateScoresRepo: {
      getByCandidateId: () => (counts.candidate_scores ? {} : null),
      deleteByCandidateId: () => counts.candidate_scores,
    },
    analysisRunsRepo: {
      listByBaseKey: () => Array(counts.analysis_runs).fill({}),
      deleteByBaseKey: () => counts.analysis_runs,
    },
    importRunsRepo: {
      listByBaseKey: () => Array(counts.import_runs).fill({}),
      deleteByBaseKey: () => counts.import_runs,
    },
  };
}

function makeDbMock(counts) {
  const calls = { transaction: 0, delete_legacy: 0, count_legacy: 0, audit_lookup: 0 };
  const auditRows = [];
  const db = {
    transaction(fn) { calls.transaction += 1; fn(); return () => {}; },
    prepare(sql) {
      return {
        run(...args) {
          if (sql.includes('DELETE FROM legacy_targets_map')) { calls.delete_legacy += 1; return { changes: counts.legacy_targets_map }; }
          if (sql.includes('INSERT INTO audit_log')) { auditRows.push(args); return { changes: 1 }; }
          return { changes: 0 };
        },
        get(...args) {
          if (sql.includes('SELECT COUNT(*) AS c FROM legacy_targets_map')) { calls.count_legacy += 1; return { c: counts.legacy_targets_map }; }
          if (sql.includes("SELECT id FROM audit_log WHERE base_key = ? AND action = 'candidate_data_purge'")) {
            calls.audit_lookup += 1; return auditRows.length ? { id: 999 } : null;
          }
          return null;
        },
        all: () => [],
      };
    },
  };
  return { db, calls, auditRows };
}

function makeFsMock(existingFiles) {
  // existingFiles = absolute paths that unlinkSync should treat as "exists"
  // (and successfully delete). Anything else → EACCES (failed) or ENOENT
  // (skipped) depending on whether the mock wants to simulate a missing
  // file. For simplicity, anything not in the list throws EACCES — the
  // allowlist check in unlinkFiles already filters out unsafe paths before
  // unlinkSync is called, so EACCES here simulates a permission error on
  // a real file. Tests that want ENOENT behaviour can pre-populate the
  // list and then remove the entry.
  const unlinked = [];
  return {
    readdirSync(dir) {
      // listTmpFilesForBaseKey reads <repoRoot>/tmp/. Return the basenames
      // of existingFiles that live inside dir.
      const base = path.basename(dir);
      if (base === 'tmp') {
        return existingFiles
          .filter(p => path.dirname(p) === dir)
          .map(p => path.basename(p));
      }
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    },
    unlinkSync(p) {
      if (!existingFiles.includes(p)) {
        const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
      }
      unlinked.push(p);
    },
    existsSync: (p) => existingFiles.includes(p),
    __unlinked: unlinked,
  };
}

// Sandbox: stub ensureDb + buildRepos to read from globalThis.__db / __repos.
// Stub fs + path so listTmpFilesForBaseKey uses our mock. process.cwd() is
// needed by PURGE_ALLOWED_ROOTS (uploadsRoot = cwd/data/uploads/phase1).
const sandbox = {
  module: { exports: {} },
  process: { env: { PHASE1_ADMIN_ENABLED: '1' }, cwd: () => process.cwd() },
  console,
  Date,
  crypto: require('crypto'),
  fs: require('fs'),
  path: require('path'),
  // __dirname is used by listTmpFilesForBaseKey to find the repo root.
  // Point it at the real services/ dir so path.resolve(__dirname, '..')
  // resolves to the repo root — same as in production.
  __dirname: path.join(repoRoot, 'services'),
  __db: null,
  __repos: null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const stubs = `
  function ensureDb() { return globalThis.__db; }
  function buildRepos(db) { return globalThis.__repos; }
`;
const fullSrc = allHelpersSrc + '\n\n' + stubs + '\n\n' + purgeBlock +
  '\nmodule.exports = { purgeCandidateData };';
vm.runInContext(fullSrc, sandbox, { filename: 'purge_service_extract.js' });
const { purgeCandidateData } = sandbox.module.exports;

const CANDIDATE = {
  id: 42, base_key: 'GTRAIN02', full_name: 'Иванов Иван', seller_segment: 'S',
  direction: 'Грузоперевозки', mentor: 'Петрова', recruiter: 'Калинкина', status: 'in_progress',
};
const COUNTS = {
  manual_inputs: 5, candidate_files: 3, ai_profile: 1, source_links: 2,
  test_day_snapshot: 1, immersion_snapshot: 1, training_bot_dialogs: 8,
  candidate_scores: 1, analysis_runs: 4, import_runs: 6, legacy_targets_map: 3, tmp_files: 2,
};

function setup() {
  const repos = makeReposMock(CANDIDATE, COUNTS);
  const { db, calls, auditRows } = makeDbMock(COUNTS);
  // Use REAL <repoRoot>/tmp paths so unlinkFiles' allowlist check passes
  // (the allowlist includes <repoRoot>/tmp/). The mock fs will pretend
  // these files exist for readdirSync + unlinkSync.
  const realTmpDir = path.join(repoRoot, 'tmp');
  const tmpBundleFiles = [
    path.join(realTmpDir, 'GTRAIN02_calls_bundle.json'),
    path.join(realTmpDir, 'GTRAIN02_calls_result.json'),
  ];
  // The candidate_files stored_path (from makeReposMock) is also a real
  // path inside <cwd>/data/uploads/phase1/. Add it to existingFiles so
  // unlinkSync succeeds — simulates the uploaded file being on disk.
  const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads', 'phase1');
  const storedFilePath = path.join(uploadsRoot, CANDIDATE.base_key, 'file.json');
  const existingFiles = tmpBundleFiles.concat([storedFilePath]);
  const fsMock = makeFsMock(existingFiles);
  sandbox.__db = db;
  sandbox.__repos = repos;
  sandbox.fs = fsMock;
  // Use the REAL path module — no overrides. PURGE_ALLOWED_ROOTS was
  // computed at sandbox init using the real path + __dirname + process.cwd(),
  // so <repoRoot>/tmp + <cwd>/data/uploads/phase1 are both in the allowlist.
  sandbox.path = require('path');
  return { repos, db, calls, auditRows, tmpFiles: tmpBundleFiles, storedFilePath, fsMock };
}

// TEST 1: dry_run
console.log('TEST 1: dry_run returns counts, no deletes');
{
  const ctx = setup();
  const result = purgeCandidateData('GTRAIN02', {
    mode: 'candidate_data', confirm_base_key: 'GTRAIN02', dry_run: true, admin_key: 'test-admin',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.dry_run, true);
  assert.strictEqual(result.base_key, 'GTRAIN02');
  assert.strictEqual(result.candidate.full_name, 'Иванов Иван');
  const wd = result.would_delete;
  assert.strictEqual(wd.manual_inputs, 5);
  assert.strictEqual(wd.candidate_files, 3);
  assert.strictEqual(wd.analysis_runs, 4);
  assert.strictEqual(wd.candidate_scores, 1);
  assert.strictEqual(wd.tmp_files, 2);
  assert.strictEqual(wd.legacy_targets_map, 3);
  assert.strictEqual(ctx.calls.delete_legacy, 0);
  assert.strictEqual(ctx.auditRows.length, 0);
  assert.strictEqual(ctx.fsMock.__unlinked.length, 0);
  console.log('  ✓ dry_run returns all counts, no DB writes, no file unlinks');
}

// TEST 2: confirm mismatch
console.log('TEST 2: confirm_base_key mismatch throws');
{
  setup();
  let threw = null;
  try { purgeCandidateData('GTRAIN02', { mode: 'candidate_data', confirm_base_key: 'WRONG', dry_run: true }); }
  catch (err) { threw = err; }
  assert.ok(threw);
  assert.strictEqual(threw.code, 'PURGE_CONFIRM_MISMATCH');
  console.log('  ✓ PURGE_CONFIRM_MISMATCH thrown');
}

// TEST 3: candidate not found
console.log('TEST 3: candidate not found throws');
{
  setup();
  sandbox.__repos.candidatesRepo.findByBaseKey = () => null;
  let threw = null;
  try { purgeCandidateData('GTRAIN02', { mode: 'candidate_data', confirm_base_key: 'GTRAIN02', dry_run: true }); }
  catch (err) { threw = err; }
  assert.ok(threw);
  assert.strictEqual(threw.code, 'CANDIDATE_NOT_FOUND');
  console.log('  ✓ CANDIDATE_NOT_FOUND thrown');
}

// TEST 4: unsupported mode
console.log('TEST 4: unsupported mode throws');
{
  setup();
  let threw = null;
  try { purgeCandidateData('GTRAIN02', { mode: 'full_delete', confirm_base_key: 'GTRAIN02', dry_run: true }); }
  catch (err) { threw = err; }
  assert.ok(threw);
  assert.strictEqual(threw.code, 'PURGE_UNSUPPORTED_MODE');
  console.log('  ✓ PURGE_UNSUPPORTED_MODE thrown for "full_delete"');
}

// TEST 5: live purge runs deletes in transaction
console.log('TEST 5: live purge runs deletes in transaction');
{
  const ctx = setup();
  const result = purgeCandidateData('GTRAIN02', {
    mode: 'candidate_data', confirm_base_key: 'GTRAIN02', dry_run: false, admin_key: 'test-admin',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.dry_run, false);
  assert.strictEqual(ctx.calls.transaction, 1);
  assert.strictEqual(ctx.calls.delete_legacy, 1);
  assert.strictEqual(ctx.auditRows.length, 1);
  assert.strictEqual(ctx.calls.audit_lookup, 1);
  assert.strictEqual(result.audit_log_id, 999);
  const d = result.deleted;
  assert.strictEqual(d.manual_inputs, 5);
  assert.strictEqual(d.candidate_files, 3);
  assert.strictEqual(d.ai_profile, 1);
  assert.strictEqual(d.source_links, 2);
  assert.strictEqual(d.test_day_snapshot, 1);
  assert.strictEqual(d.immersion_snapshot, 1);
  assert.strictEqual(d.training_bot_dialogs, 8);
  assert.strictEqual(d.candidate_scores, 1);
  assert.strictEqual(d.analysis_runs, 4);
  assert.strictEqual(d.import_runs, 6);
  assert.strictEqual(d.legacy_targets_map, 3);
  assert.strictEqual(d.tmp_files, 3, '3 paths unlinked: 2 tmp/* bundle files + 1 candidate_files stored_path');
  assert.strictEqual(ctx.fsMock.__unlinked.length, 3);
  assert.strictEqual(result.unsafe_paths_count, 0, 'no unsafe paths in this test (all paths inside allowed roots)');
  console.log('  ✓ live purge: transaction used, all deletes ran, audit log written, 3 files unlinked (2 tmp + 1 stored)');
}

// TEST 6: audit log payload has counts only
console.log('TEST 6: audit log payload has counts only, no raw text');
{
  const ctx = setup();
  purgeCandidateData('GTRAIN02', {
    mode: 'candidate_data', confirm_base_key: 'GTRAIN02', dry_run: false, admin_key: 'test-admin',
  });
  const row = ctx.auditRows[0];
  assert.strictEqual(row[0], 'admin');
  assert.strictEqual(row[2], 'candidate_data_purge');
  assert.strictEqual(row[3], 'candidate');
  assert.strictEqual(row[4], '42');
  assert.strictEqual(row[5], 'GTRAIN02');
  const payload = JSON.parse(row[6]);
  assert.strictEqual(payload.mode, 'candidate_data');
  assert.strictEqual(payload.dry_run, false);
  assert.strictEqual(payload.deleted_counts.manual_inputs, 5);
  assert.strictEqual(payload.deleted_counts.analysis_runs, 4);
  assert.strictEqual(payload.deleted_counts.tmp_files, 3,
    'tmp_files count = 1 candidate_files stored_path + 2 tmp/* bundle files = 3');
  assert.strictEqual(payload.candidate.full_name, 'Иванов Иван');
  assert.ok(!('session_key' in payload.candidate));
  const payloadStr = JSON.stringify(payload);
  assert.ok(!payloadStr.includes('transcript_text'));
  assert.ok(!payloadStr.includes('payload_json'));
  console.log('  ✓ audit payload: counts + mode + dry_run + public candidate profile only');
}

// TEST 7: failed unlink does not roll back DB
console.log('TEST 7: failed tmp unlink does not roll back the DB');
{
  const ctx = setup();
  sandbox.fs.unlinkSync = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  const result = purgeCandidateData('GTRAIN02', {
    mode: 'candidate_data', confirm_base_key: 'GTRAIN02', dry_run: false, admin_key: 'test-admin',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.deleted.manual_inputs, 5);
  assert.strictEqual(result.deleted.tmp_files, 0);
  // 3 paths attempt unlink (2 tmp + 1 stored), all fail with EACCES.
  assert.strictEqual(result.tmp_files_failed, 3, 'all 3 paths fail unlink in this mock');
  // No unsafe paths — all 3 are inside allowed roots, they just fail on unlink.
  assert.strictEqual(result.unsafe_paths_count, 0);
  assert.strictEqual(ctx.auditRows.length, 1);
  console.log('  ✓ DB purge permanent, tmp unlink failures reported but not fatal');
}

// TEST 8: missing dry_run defaults to true
console.log('TEST 8: missing dry_run defaults to true');
{
  const ctx = setup();
  const result = purgeCandidateData('GTRAIN02', {
    mode: 'candidate_data', confirm_base_key: 'GTRAIN02',
  });
  assert.strictEqual(result.dry_run, true);
  assert.strictEqual(ctx.calls.transaction, 0);
  console.log('  ✓ missing dry_run → dry-run mode');
}

// TEST 9: BLOCKER 1 — unsafe stored_path in candidate_files does NOT get
// unlinked, lands in `unsafe_paths`, DB purge still succeeds.
console.log('TEST 9: unsafe stored_path (/etc/passwd, ../../.env) → unsafe, not deleted');
{
  const ctx = setup();
  // Override candidate_files.deleteByCandidateId to return traversal paths
  // as if the DB was compromised.
  const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads', 'phase1');
  const safeStoredPath = path.join(uploadsRoot, CANDIDATE.base_key, 'file.json');
  const unsafeStoredPaths = [
    '/etc/passwd',
    '../../.env',
    path.join(os.tmpdir(), 'attacker.json'), // absolute, outside allowlist
  ];
  sandbox.__repos.candidateFilesRepo.deleteByCandidateId = () => ({
    count: 3,
    stored_paths: unsafeStoredPaths,
  });
  // The 2 tmp/* files are still safe (from setup) → they get deleted.
  // The 3 unsafe stored_paths → unsafe, NOT deleted.
  const result = purgeCandidateData('GTRAIN02', {
    mode: 'candidate_data', confirm_base_key: 'GTRAIN02', dry_run: false, admin_key: 'test-admin',
  });
  assert.strictEqual(result.ok, true, 'purge must still succeed');
  assert.strictEqual(result.deleted.candidate_files, 3, 'DB rows deleted regardless of file safety');
  // 2 safe tmp files unlinked; 3 unsafe stored_paths NOT unlinked.
  assert.strictEqual(result.deleted.tmp_files, 2, 'only the 2 safe tmp/* files unlinked');
  assert.strictEqual(result.tmp_files_failed, 0, 'unsafe paths are NOT failures — they are unsafe');
  assert.strictEqual(result.unsafe_paths_count, 3, '3 unsafe paths flagged');
  assert.strictEqual(result.unsafe_paths.length, 3);
  // Redacted paths must not leak absolute paths or traversal payloads.
  for (const u of result.unsafe_paths) {
    assert.ok(typeof u === 'string' && u.length > 0);
    assert.ok(!u.includes('/etc/'), `unsafe path must not leak "/etc/": ${u}`);
    assert.ok(!u.includes('..'), `unsafe path must not contain "..": ${u}`);
    assert.ok(!u.startsWith('/'), `unsafe path must not be absolute: ${u}`);
    assert.ok(!u.includes('attacker.json') || u === 'attacker.json',
      `unsafe path must be basename-only, got: ${u}`);
  }
  // Audit log still written (DB purge succeeded).
  assert.strictEqual(ctx.auditRows.length, 1);
  console.log('  ✓ 3 unsafe paths flagged + redacted, 2 safe tmp files deleted, DB purge permanent');
}

// TEST 10: response never leaks absolute paths or traversal payloads
console.log('TEST 10: response + audit payload never leak absolute paths');
{
  const ctx = setup();
  const unsafePaths = ['/etc/passwd', '../../.env', '/var/log/auth.log'];
  sandbox.__repos.candidateFilesRepo.deleteByCandidateId = () => ({
    count: 3,
    stored_paths: unsafePaths,
  });
  const result = purgeCandidateData('GTRAIN02', {
    mode: 'candidate_data', confirm_base_key: 'GTRAIN02', dry_run: false, admin_key: 'test-admin',
  });
  const responseStr = JSON.stringify(result);
  assert.ok(!responseStr.includes('/etc/passwd'), 'response must not contain raw /etc/passwd');
  assert.ok(!responseStr.includes('../../.env'), 'response must not contain raw ../../.env');
  assert.ok(!responseStr.includes('/var/log/'), 'response must not contain raw /var/log/');
  // Audit payload must also be clean.
  const auditPayload = JSON.parse(ctx.auditRows[0][6]);
  const auditStr = JSON.stringify(auditPayload);
  assert.ok(!auditStr.includes('/etc/passwd'), 'audit payload must not contain raw /etc/passwd');
  assert.ok(!auditStr.includes('../../.env'), 'audit payload must not contain raw ../../.env');
  console.log('  ✓ response + audit payload redacted — no absolute paths, no traversal payloads');
}

console.log('\nALL TESTS PASSED');
