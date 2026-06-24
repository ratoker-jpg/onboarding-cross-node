# PATCH REPORT — FULL-CANDIDATE-CARD-V1

**Date:** 2026-06-24
**Goal:** after all candidate data is loaded via admin-v1, assemble ONE full
bundle, run ONE master prompt, and import ONE full candidate-card result.

Non-deploy patch. No production DB touched, no live import run, nothing deployed.

## Changed / new files

| File | Why |
|---|---|
| `public/report-v1.html` | Fix `[object Object]` in candidate experience (object values were `String()`-ed and shown raw) via `coerceExperienceText`; hero stage dates now go through `formatReportDate` (time stripped, clean `—` when missing). |
| `scripts/export_candidate_analysis_bundle.js` | Minimal refactor: guard `main()` with `require.main === module` and `module.exports = { exportBundle }` so the full-bundle exporter reuses the exact interview/calls logic (no duplication). |
| `scripts/export_candidate_full_bundle.js` | **New.** Builds one `full_candidate_bundle_v1` with blocks: interview, calls, training_agents, ops, test_day, immersion. Reuses `exportBundle` for interview/calls; training/ops kept separate; missing blocks → `{available:false, missing_data:true}`. Secret-leak scan before write. |
| `prompts/codex/full_candidate_card_analysis_v1.md` | **New.** Master prompt → `full_candidate_card_v1` JSON. Enforces the separation rules and "no invented data". |
| `schema/full_candidate_card_v1.schema.json` | **New.** JSON Schema for the result contract. |
| `examples/analysis/full_candidate_card_example.json` | **New.** Worked GTRAIN02 example (interview + calls(9 calls/78.3) + training + ops + overall). |
| `scripts/import_analysis_result.js` | Guard `main()`; export `runCallsSemanticChecks` + helpers so the full-card importer reuses the same calls guard (single source of truth). |
| `scripts/import_full_candidate_card.js` | **New.** Validates + scores each block, prints which blocks would update, reuses the calls semantic guard, aborts on a failing calls block. Dry-run does no DB writes. |

## How the constraints are honoured
- **Real calls ⇒ only `calls_automanual_binary_v1`.** The calls block is the
  calls analysis bundle/result; scored by the calls rubric + semantic guard.
- **Training agents are separate.** Exported as their own block (role portrait +
  transcript preview, no rubric); imported as a separate `training_agents`
  analysis run; **never** touches `call_quality_score`.
- **Operations is its own block** (separate sections / `ops_score`).
- **Calls and training never mixed** — the calls sub-bundle already excludes
  training dialogs; training lives only in `blocks.training_agents`.
- **No invented data** — absent blocks become `null` + `missing_data:true` on
  export and are `SKIP`-ped on import.

## Acceptance check (offline)
- GTRAIN02 full bundle: `export_candidate_full_bundle.js` composes the six
  blocks (runs against the Phase 1 DB on the server — see "Not verified here").
- Master prompt returns the full JSON — see the example document.
- Import dry-run shows which blocks update:
  ```
  node scripts/import_full_candidate_card.js --file examples/analysis/full_candidate_card_example.json --dry-run
  #   interview       UPDATE  soft=88.3 hard=100 learning=95.5
  #   calls           UPDATE  call_quality_score=78.3 [semantic: PASS]  (9 == expected 9)
  #   training_agents UPDATE  separate analysis run; does NOT affect call_quality_score
  #   ops             UPDATE  ops_score=72
  #   final_test      SKIP    missing_data
  #   overall         UPDATE  recommendation, strengths/growth/risks/coach
  ```
- report-v1 no longer prints `[object Object]`; dates render without time or as `—`.
- Training agents have a separate analysis; calls stay 9 / 78.3.
- `node scripts/test_rubric_scoring.js` → 24 passed, 0 failed.

## Checks run
```
node --check server.js / onboarding_core.js / sheets_client.js          # OK
node --check scripts/export_candidate_full_bundle.js                    # OK
node --check scripts/import_full_candidate_card.js                      # OK
node --check scripts/export_candidate_analysis_bundle.js (refactor)     # OK
node --check scripts/import_analysis_result.js (export guard)           # OK
# inline JS extracted from public/report-v1.html → node --check         # OK
node scripts/test_rubric_scoring.js                                     # 24/24
node scripts/import_full_candidate_card.js --file <example> --dry-run   # all blocks correct
node scripts/import_analysis_result.js --file <calls example> --dry-run # still PASS (CLI guard works)
```

## Not verified here / risks
- `better-sqlite3` is not installed in this environment and there is no local
  Phase 1 DB, so the **live export** (`export_candidate_full_bundle.js`) and the
  **live import persist** path were not executed here. Both are DB-bound and run
  on the server. The **import dry-run** is fully exercised offline (DB calls are
  guarded), and the calls scoring/guard is the same code already proven on
  GTRAIN02 (78.3 / 9 calls).
- The live persist writes interview/calls/training analysis runs + a merged
  `candidate_scores` patch in one transaction; verify on the server with a
  dry-run first, then a single live import on GTRAIN02.

## Rollback
Delivered as a branch/PR; rollback = revert the merge commit or
`git checkout main -- <file>`.
