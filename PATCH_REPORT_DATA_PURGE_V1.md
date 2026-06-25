# PATCH REPORT — DATA-PURGE-V1

**Date:** 2026-06-25
**Goal:** add a safe, audited way to purge sensitive candidate data from the server by `base_key`. Requested by security to remove interview/calls/files/transcripts/training/ops/LLM-analysis results/tmp bundle files for a candidate without dropping the candidate row itself.

Non-deploy patch. No production DB touched, no live purge run, nothing deployed.

## What was built

### Admin endpoint
`POST /api/admin/phase1/candidates/:base_key/purge` — admin-only (`X-Admin-Key`).

Body:
```json
{ "mode": "candidate_data", "confirm_base_key": "GTRAIN02", "dry_run": true }
```

- `mode` — only `candidate_data` is supported in v1.
- `confirm_base_key` — MUST equal the `:base_key` from the URL. Returns 400 `confirm_base_key_mismatch` otherwise.
- `dry_run` — defaults to `true`. An explicit `dry_run: false` triggers a live purge. Missing / truey / non-`false` values all stay in dry-run.

Response (dry-run):
```json
{
  "ok": true,
  "dry_run": true,
  "mode": "candidate_data",
  "base_key": "GTRAIN02",
  "candidate": { "full_name": "...", "seller_segment": "...", "direction": "...", "mentor": "...", "recruiter": "...", "status": "..." },
  "would_delete": {
    "manual_inputs": 5, "candidate_files": 3, "ai_profile": 1, "source_links": 2,
    "test_day_snapshot": 1, "immersion_snapshot": 1, "training_bot_dialogs": 8,
    "candidate_scores": 1, "analysis_runs": 4, "import_runs": 6,
    "legacy_targets_map": 3, "tmp_files": 2
  }
}
```

Response (live):
```json
{
  "ok": true,
  "dry_run": false,
  "mode": "candidate_data",
  "base_key": "GTRAIN02",
  "candidate": { ... },
  "deleted": { ...same shape as would_delete, plus actual counts... },
  "audit_log_id": 123,
  "tmp_files_failed": 0,
  "tmp_files_failed_paths": []
}
```

### CLI script
`scripts/purge_candidate_data.js` — thin wrapper around the same `purgeCandidateData()` service function.

```bash
# Dry-run — see what would be deleted:
node scripts/purge_candidate_data.js --base-key GTRAIN02 --mode candidate_data --dry-run

# Live purge — deletes everything for GTRAIN02 (candidate_data mode keeps
# the candidates row + candidate_keys):
node scripts/purge_candidate_data.js --base-key GTRAIN02 --mode candidate_data --confirm GTRAIN02
```

Exit codes: `0` success / dry-run, `1` bad args, `2` candidate not found, `3` confirm mismatch, `4` unsupported mode, `5` internal error.

### Service function
`services/phase1_candidate_service.js` → `purgeCandidateData(baseKey, opts)`.

Safety properties:
- `confirm_base_key` MUST equal `baseKey` — checked before any DB access.
- `dry_run` defaults to `true`. Only `dry_run: false` triggers deletes.
- All DB deletes run inside a single `db.transaction()`. If any delete throws, the whole transaction rolls back.
- `tmp/` file unlinking happens **after** the DB transaction commits. A failed unlink is reported in the response (`tmp_files_failed`, `tmp_files_failed_paths`) but does NOT roll back the DB.
- `audit_log` row is written **inside** the same transaction (so a rollback also drops the audit row). Payload contains ONLY counts + mode + dry_run + public candidate profile — never raw call/interview text, session_keys, or `payload_json` from manual_inputs.

### Repo delete helpers (new)
Added `deleteByCandidateId` / `deleteByBaseKey` to every repo that stores candidate data:

| Repo | Method | Returns |
|---|---|---|
| `phase1_manual_inputs_repo.js` | `deleteByCandidateId(id)` | row count |
| `phase1_candidate_files_repo.js` | `deleteByCandidateId(id)` | `{ count, stored_paths }` (paths returned so the service can unlink the files after commit) |
| `phase1_ai_profile_repo.js` | `deleteByCandidateId(id)` | row count (0 or 1) |
| `phase1_source_links_repo.js` | `deleteByCandidateId(id)` | row count |
| `phase1_snapshots_repo.js` | `deleteByCandidateId(id)` | `{ test_day_snapshot, immersion_snapshot, training_bot_dialogs }` per-table counts |
| `phase1_candidate_scores_repo.js` | `deleteByCandidateId(id)` | row count (0 or 1) |
| `phase1_analysis_runs_repo.js` | `deleteByBaseKey(baseKey)` | row count (analysis_runs is keyed by base_key) |
| `phase1_import_runs_repo.js` | `deleteByBaseKey(baseKey)` | row count (import_runs is keyed by base_key) |

`legacy_targets_map` has no repo — the service deletes directly via `db.prepare('DELETE FROM legacy_targets_map WHERE candidate_id = ?')` inside the same transaction. The delete is wrapped in try/catch because the table may not exist on very old DBs (treated as 0 rows deleted).

## What `candidate_data` mode removes

| Entity | Why |
|---|---|
| `manual_inputs` | interview transcripts, calls, ops, phone metrics, trainer comments |
| `candidate_files` | uploaded transcripts / screenshots + their `text_content` |
| `ai_profile` | legacy AI summary text + scores |
| `candidate_source_links` | legacy_key / legacy_id mappings to external systems |
| `test_day_snapshot` | test-day scores, open answers, voice result, raw payload |
| `immersion_snapshot` | immersion progress, materials, help requests, raw payload |
| `training_bot_dialogs` | training bot transcripts, role profiles, analysis_json, result_payload |
| `candidate_scores` | rubric scores, recommendation, strengths, growth_zones, red_flags, coach_recommendations |
| `analysis_runs` | Codex interview/calls/training_agents/ops analysis runs + their output_payload |
| `import_runs` | Google Sheets import history for this candidate |
| `legacy_targets_map` | session_key → legacy_target mappings (contains session_key) |
| `tmp/<base_key>*` files | bundle + result JSON files produced by the Codex pipeline |

## What `candidate_data` mode KEEPS

- `candidates` row (id, base_key, full_name, segment, direction, mentor, recruiter, dates, status) — the candidate stays listed in the admin UI and viewer picker.
- `candidate_keys` (session_key / key_type / product_code / legacy_target) — needed for re-imports and for the candidate's identity chain. Removing keys would break the Google Sheets sync for this candidate.
- `audit_log` rows (including the new `candidate_data_purge` entry).

Rationale: security asked to remove sensitive data (call/interview/training transcripts + LLM analysis), not to delete the candidate entirely. Keeping the candidate row lets the operator see that this person existed and was purged, without leaving their PII in the DB.

## `full_delete` mode — NOT implemented in v1

The spec asked for a `full_delete` mode that would also remove `candidates` + `candidate_keys`. This is intentionally deferred to a follow-up PR because:

1. `candidate_keys` removal would break the Google Sheets sync for the candidate (the sync uses `session_key` to match rows). Removing keys without also disabling sync risks silent re-creation of orphan candidate rows on the next import.
2. Removing the `candidates` row triggers `ON DELETE CASCADE` on most tables — which is fine, but we'd want a separate `confirm_full_name` field (per spec) and a two-step confirmation (dry-run → confirm → live) to prevent fat-finger deletes.
3. The audit_log row for `full_delete` should probably be retained even after the candidate row is gone (currently `audit_log.base_key` is a TEXT column, not a FK, so it would survive — but we'd want to verify that explicitly).

The endpoint already returns `400 unsupported_purge_mode:full_delete` if someone tries it, so the API surface is safe. A follow-up PR can add `full_delete` with the extra `confirm_full_name` field and the cascade-safe key removal.

## Files changed / new

| File | Change |
|---|---|
| `services/phase1_candidate_service.js` | New `purgeCandidateData()` + private helpers (`listTmpFilesForBaseKey`, `unlinkFiles`, `countCandidateData`). Exported via `module.exports`. |
| `routes/phase1_admin_routes.js` | New `POST /api/admin/phase1/candidates/:base_key/purge` route + `PURGE_CONFIRM_MISMATCH` / `PURGE_UNSUPPORTED_MODE` error codes in `handleError`. |
| `scripts/purge_candidate_data.js` | **New.** CLI wrapper around `purgeCandidateData()`. `--dry-run` default, `--confirm <KEY>` for live. |
| `repositories/phase1_manual_inputs_repo.js` | `deleteByCandidateId(id)`. |
| `repositories/phase1_candidate_files_repo.js` | `deleteByCandidateId(id)` → `{ count, stored_paths }`. |
| `repositories/phase1_ai_profile_repo.js` | `deleteByCandidateId(id)`. |
| `repositories/phase1_source_links_repo.js` | `deleteByCandidateId(id)`. |
| `repositories/phase1_snapshots_repo.js` | `deleteByCandidateId(id)` → per-table counts. |
| `repositories/phase1_candidate_scores_repo.js` | `deleteByCandidateId(id)`. |
| `repositories/phase1_analysis_runs_repo.js` | `deleteByBaseKey(baseKey)`. |
| `repositories/phase1_import_runs_repo.js` | `deleteByBaseKey(baseKey)`. |
| `PATCH_REPORT_DATA_PURGE_V1.md` | **New.** This file. |

## Not changed (per spec constraints)

- DB schema (no migrations — existing tables already have `ON DELETE CASCADE` on `candidate_id` FKs, but we don't rely on it because `candidate_data` mode keeps the candidate row).
- Scoring logic, master prompt, report-v1 design, viewer auth.
- Admin UI (no button added — the endpoint + CLI are enough for v1; a follow-up can add a button to `admin-v1.html` once the UX is agreed).

## Checks run

```
node --check server.js                                              # OK
node --check routes/phase1_admin_routes.js                          # OK
node --check services/phase1_candidate_service.js                   # OK
node --check scripts/purge_candidate_data.js                        # OK
node --check repositories/phase1_*.js (all 11 repos)                # OK
node scripts/test_rubric_scoring.js                                 # 24/24 (no scoring changes)
node /home/z/my-project/scripts/test_purge_candidate_data.js        # 8/8 PASS
```

### Mock-based unit tests (`scripts/test_purge_candidate_data.js`)

better-sqlite3 is not installed in this environment, so the test extracts `purgeCandidateData` + helpers via vm sandboxing and runs them against stub repos/db/fs. 8 tests pass:

1. **dry_run returns counts, no deletes** — verifies `would_delete` shape + that no DB writes / file unlinks happen.
2. **confirm_base_key mismatch throws** `PURGE_CONFIRM_MISMATCH`.
3. **candidate not found throws** `CANDIDATE_NOT_FOUND`.
4. **unsupported mode throws** `PURGE_UNSUPPORTED_MODE` for `full_delete`.
5. **live purge runs deletes in transaction** — verifies `db.transaction()` is used, all 11 entities are deleted, audit log is written, audit_log_id is returned, tmp files are unlinked.
6. **audit log payload has counts only, no raw text** — verifies the audit row's `payload_json` contains `mode` / `dry_run` / `deleted_counts` / `candidate` (public profile only), and does NOT contain `session_key`, `transcript_text`, or `payload_json` from manual_inputs.
7. **failed tmp unlink does not roll back the DB** — makes all `unlinkSync` calls fail; verifies the DB purge still succeeds, `tmp_files_failed` is reported, and the audit log row is still written.
8. **missing dry_run defaults to true** — verifies a payload without `dry_run` is treated as dry-run.

Plus a real-tmp-dir test for `listTmpFilesForBaseKey` + `unlinkFiles` that creates 3 files, matches 2 by base_key substring, unlinks them, leaves the third, and verifies `ENOENT` is not counted as a failure.

## Server verification steps (for the reviewer on prod-VPS)

These steps require a real Phase 1 DB and are NOT run in this environment.

1. **Dry-run on a real candidate:**
   ```bash
   node scripts/purge_candidate_data.js --base-key GTRAIN02 --mode candidate_data --dry-run
   ```
   Expected: prints `Candidate: ...`, then `Would delete:` with non-zero counts for `manual_inputs`, `candidate_files`, `analysis_runs`, etc. Exit 0.

2. **Dry-run via API:**
   ```bash
   curl -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
     -d '{"mode":"candidate_data","confirm_base_key":"GTRAIN02","dry_run":true}' \
     http://localhost:8020/api/admin/phase1/candidates/GTRAIN02/purge
   ```
   Expected: `{"ok":true,"dry_run":true,...,"would_delete":{...}}`.

3. **Live purge on a TEST candidate (not GTRAIN02 — create a throwaway candidate first):**
   ```bash
   node scripts/purge_candidate_data.js --base-key TESTPURG01 --mode candidate_data --confirm TESTPURG01
   ```
   Expected: prints `Deleted:` with the same counts as the dry-run, `audit_log_id: <N>`, exit 0.

4. **Verify the candidate is still listed** (candidate_data mode keeps the row):
   ```sql
   SELECT id, base_key, full_name, status FROM candidates WHERE base_key = 'TESTPURG01';
   -- expected: 1 row
   SELECT COUNT(*) FROM manual_inputs WHERE base_key = 'TESTPURG01';
   -- expected: 0
   SELECT COUNT(*) FROM candidate_files WHERE base_key = 'TESTPURG01';
   -- expected: 0
   SELECT COUNT(*) FROM analysis_runs WHERE base_key = 'TESTPURG01';
   -- expected: 0
   SELECT COUNT(*) FROM candidate_scores WHERE base_key = 'TESTPURG01';
   -- expected: 0
   ```

5. **Verify audit_log:**
   ```sql
   SELECT id, action, entity_type, entity_id, base_key, payload_json, created_at
   FROM audit_log
   WHERE base_key = 'TESTPURG01' AND action = 'candidate_data_purge'
   ORDER BY id DESC LIMIT 1;
   ```
   Expected: 1 row. `payload_json` contains `{"mode":"candidate_data","dry_run":false,"deleted_counts":{...},"candidate":{...}}` — NO raw call/interview text, NO session_keys.

6. **Verify report-v1 shows no old data:**
   Open `report-v1.html` for the purged candidate. Expected: the candidate is still in the picker list (row kept), but the report shows empty states for calls / interview / training / ops / scores (all sensitive data removed).

7. **Verify tmp/ files are gone:**
   ```bash
   ls tmp/TESTPURG01* 2>/dev/null
   # expected: no such file or directory
   ```

8. **Negative test — confirm mismatch:**
   ```bash
   node scripts/purge_candidate_data.js --base-key GTRAIN02 --confirm WRONG
   # expected: FAIL: --confirm (WRONG) must equal --base-key (GTRAIN02). Exit 3.
   ```

9. **Negative test — candidate not found:**
   ```bash
   node scripts/purge_candidate_data.js --base-key NOPE9999 --confirm NOPE9999 --dry-run
   # expected: FAIL: candidate_not_found:NOPE9999. Exit 2.
   ```

## Rollback

Delivered as a branch/PR; rollback = revert the merge commit or `git checkout main -- <file>` for each changed file. The new `scripts/purge_candidate_data.js`, `scripts/test_purge_candidate_data.js`, and `PATCH_REPORT_DATA_PURGE_V1.md` can be deleted outright.

---

# Fixup — path-safe unlink + test file committed (post-review)

**Date:** 2026-06-25
**Goal:** close two blockers identified during PR #21 review before merge.

## BLOCKER 1 — file unlink must be path-safe

**Problem:** the original `unlinkFiles()` did `fs.unlinkSync(p)` on every path from `candidate_files.stored_path` + `tmp/<base_key>*` without any allowlist. If a compromised DB row contained `stored_path = "/etc/passwd"` or `"../../.env"`, the purge would delete that file — a path-traversal / arbitrary-file-delete vulnerability in a security-focused PR.

**Fix:** added a path-safety allowlist to `unlinkFiles()`.

- New `PURGE_ALLOWED_ROOTS` const (computed at module load):
  - `<repoRoot>/tmp/` — Codex bundle/result JSON files
  - `<process.cwd()>/data/uploads/phase1/` — uploaded candidate files (matches `saveCandidateFile`'s `uploadDir`)
- New `isPathInside(resolvedTarget, allowedRoot)` helper — uses `path.relative()` (not prefix matching) so `/tmp-evil` does NOT match root `/tmp`.
- New `redactPath(p)` helper — returns basename-only for paths outside allowed roots, or path-relative-to-root for paths inside. Never leaks absolute server paths.
- `unlinkFiles()` now:
  1. resolves each path to absolute form
  2. checks `isPathInsideAnyRoot(resolved)` — if OUTSIDE, pushes a redacted basename to `unsafe` and continues (no unlink, no crash)
  3. only calls `fs.unlinkSync(resolved)` for paths inside allowed roots
  4. ENOENT → silently skipped (not failed, not unsafe)
  5. other unlink errors → `failed` with redacted path
- Response shape extended:
  - `unsafe_paths_count` — number of paths flagged unsafe
  - `unsafe_paths` — array of redacted basenames (never absolute paths, never the original traversal payload)
  - `tmp_files_failed_paths` — now also redacted (was raw absolute path before)
- Audit log payload unchanged in shape — it already contained only counts + mode + dry_run + public candidate profile, never raw paths.

**Behaviour:** a compromised `stored_path` is now safely ignored. The DB row is still deleted (that's the point of the purge), but the file on disk is NOT touched. The operator sees `unsafe_paths: ["passwd", ".env", "auth.log"]` in the response and can investigate the DB row.

## BLOCKER 2 — test file was not committed

**Problem:** `PATCH_REPORT` and PR body referenced `scripts/test_purge_candidate_data.js`, but the file lived outside the repo (in `/home/z/my-project/scripts/`) and was not in the PR's changed files. The check was not reproducible.

**Fix:** committed `scripts/test_purge_candidate_data.js` into the repo. The test was also extended to cover the new path-safety behaviour:

- **TEST 0** (new) — real-filesystem test in `<repoRoot>/tmp/`: creates 2 safe files (deleted) + verifies 4 unsafe paths (`/etc/passwd`, `../../.env`, `/tmp/../../etc/shadow`, `<os.tmpdir()>/attacker.json`) are flagged `unsafe` with redacted basenames and the attacker file survives on disk.
- **TEST 5** updated — now expects 3 files unlinked (2 tmp + 1 stored) and `unsafe_paths_count: 0`.
- **TEST 6** updated — `deleted_counts.tmp_files` is now 3 (1 stored + 2 tmp).
- **TEST 7** updated — 3 paths fail unlink (was 2), `unsafe_paths_count: 0`.
- **TEST 9** (new) — simulates compromised DB: `candidate_files.deleteByCandidateId` returns `['/etc/passwd', '../../.env', '<tmp>/attacker.json']`. Verifies 3 unsafe paths flagged + redacted, 2 safe tmp files still deleted, DB purge permanent, audit log written.
- **TEST 10** (new) — verifies the response JSON and audit payload NEVER contain raw `/etc/passwd`, `../../.env`, or `/var/log/` strings.

Total: 11 tests (TEST 0 + 1-10), all pass.

## Files changed in this fixup

| File | Change |
|---|---|
| `services/phase1_candidate_service.js` | Added `PURGE_ALLOWED_ROOTS`, `isPathInside`, `isPathInsideAnyRoot`, `redactPath`. Rewrote `unlinkFiles()` to use the allowlist. Extended `purgeCandidateData()` response with `unsafe_paths_count` + `unsafe_paths` (redacted). Redacted `tmp_files_failed_paths`. |
| `scripts/test_purge_candidate_data.js` | **New (committed).** 11 mock-based tests including path-safety + redaction + compromised-DB scenarios. |

## Checks run

```
node --check server.js                                    # OK
node --check routes/phase1_admin_routes.js                # OK
node --check services/phase1_candidate_service.js         # OK
node --check scripts/purge_candidate_data.js              # OK
node --check scripts/test_purge_candidate_data.js         # OK
node scripts/test_purge_candidate_data.js                 # 11/11 PASS
node scripts/test_rubric_scoring.js                       # 24/24 (no scoring changes)
```

## Server verification steps (additions for the fixup)

After running the original 9 server verification steps from the main PATCH_REPORT section, also verify:

10. **Path-safety negative test:** manually insert a compromised `stored_path` into `candidate_files` for a test candidate:
    ```sql
    INSERT INTO candidate_files (candidate_id, base_key, section, file_type, original_name,
      stored_path, mime_type, size_bytes, text_content, comment, created_at, updated_at)
    VALUES (<id>, 'TESTPURG01', 'other', 'test', 'evil.txt',
      '/etc/passwd', 'text/plain', 0, null, 'compromised row', '<now>', '<now>');
    ```
    Then run the purge. Expected: `deleted.candidate_files` includes the row, but `unsafe_paths_count: 1` and `unsafe_paths: ["passwd"]`. The real `/etc/passwd` is NOT deleted (verify with `ls -la /etc/passwd` — ownership/size unchanged).

11. **Response redaction:** verify the response JSON does NOT contain the string `/etc/passwd` anywhere:
    ```bash
    node scripts/purge_candidate_data.js --base-key TESTPURG01 --confirm TESTPURG01 2>&1 | grep -c '/etc/passwd'
    # expected: 0
    ```
