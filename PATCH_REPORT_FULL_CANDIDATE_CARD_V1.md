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

---

# Fixup — focused UI/import/scoring alignment (post-review)

**Date:** 2026-06-25
**Goal:** close four functional gaps between `import_full_candidate_card.js`
and `report-v1.html` / the viewer card assembly. No new tabs, no DB schema
change, no auth/secrets, no deploy, no live import.

## Blockers addressed

### BLOCKER 1 — training_agents analysis visible in UI
**Problem:** `import_full_candidate_card.js` created `analysis_runs` with
`analysis_type='training_agents'`, but `renderTrainingTab()` always showed
the "ещё не рассчитан" placeholder and never read
`card.latest_analysis.training_agents`.

**Fix:**
- `services/phase1_candidate_service.js` — `buildLatestAnalysis()` now
  fetches `training_agents` and `ops` types in addition to `interview` /
  `calls`. `projectAnalysisRunForViewer()` passes through block-specific
  extras (`dialogs_reviewed`, `note`, `ops_score`, `discipline_score`,
  `notes`) so the report can render them. These fields are `null`/`[]` for
  interview/calls runs (no shape change for those types).
- `public/report-v1.html` — new `renderTrainingAgentsAnalysisBlock()`
  renders the qualitative analysis (summary / strengths / growth_zones /
  note / dialogs_reviewed) when `latest_analysis.training_agents` is
  present. The old placeholder stays when the analysis is absent.
- training_agents never touches `call_quality_score` and is never mixed
  with real calls (the block is persisted as its own `analysis_run`, not
  merged into the calls run).

### BLOCKER 2 — ops analysis visible + persisted
**Problem:** `import_full_candidate_card.js` updated `ops_score` /
`discipline_score` in `candidate_scores`, but `blocks.ops` was NOT persisted
as an `analysis_run`, so `renderOpsTab()` had nothing to render.

**Fix:**
- `scripts/import_full_candidate_card.js` — `persistFullCard()` now creates
  an `analysis_runs(ops)` row with `output_payload = blocks.ops` whenever
  `plan.ops.action === 'update'`. The plan also widens: an ops block with
  all-null numeric scores is still persisted as a qualitative-only run so
  the summary + notes are visible. Numeric scores are only applied to
  `candidate_scores` when non-null (existing values preserved otherwise).
- `public/report-v1.html` — new `renderOpsAnalysisBlock()` renders the ops
  analysis (summary / notes / score explanation via `renderScoreBandCard`)
  when `latest_analysis.ops` is present. The old "ops analysis is missing"
  placeholder stays when ops data is loaded but no analysis run exists.
- ops never touches `call_quality_score`.

### BLOCKER 3 — full import reuses single-import scoring semantics
**Problem:** `persistFullCard()` built the `candidate_scores` row directly
from raw `rubricResult` derived fields, bypassing `buildScoresPatch()` from
`scripts/import_analysis_result.js`. This meant:
  - calls `risk_flags` caps (`applyCriticalErrorCaps`) were NOT applied
  - `risk_score_adjust` from interview and calls were NOT accumulated
  - per-block `strengths` / `growth_zones` / `red_flags` /
    `coach_recommendations` were NOT merged (only `overall` lists were)
  - `recommendation` did not fall back to `interview.analysis.summary`

**Fix:**
- `scripts/import_full_candidate_card.js` now imports `buildScoresPatch`
  from `./import_analysis_result` and chains the patches:
  1. Start from `existing` candidate_scores
  2. `buildScoresPatch('interview_binary_v1', ivRubricResult, ivAnalysis, existing)`
     → bumps soft/hard/learning + risk_score_adjust, merges interview lists
  3. `buildScoresPatch('calls_automanual_binary_v1', clRubricResult, clAnalysis, <step 2 result>)`
     → sets call_quality_score + risk_score_adjust (accumulated on top of
     interview) + applies `applyCriticalErrorCaps` for `risk_flags`
  4. ops/final_test numeric scores applied directly (no rubric, no caps)
  5. `overall` block: `recommendation` overrides if present; lists merged
     on top via `mergeUniqueStrings` (idempotent)
- The interview/calls `analysis_runs` rows now persist `summary` /
  `strengths` / `growth_zones` / `red_flags` / `coach_recommendations` /
  `scores_patch` at the top level of `output_payload` so
  `projectAnalysisRunForViewer` can pick them up the same way it does for
  single-import runs.
- The calls semantic guard is unchanged — `runCallsSemanticChecks` still
  runs and a failing calls block still aborts the live import.

**Verification (mock-based, no DB):**
  - 9 unit tests in `scripts/test_full_card_scoring_semantics.js`:
    - calls `risk_flags` caps (dangerous_promises→50, distorted_product_terms→60, multiple→lowest wins, cap does not raise low score)
    - chained interview + calls patches accumulate `risk_score_adjust` (10→15→18)
    - `mergeUniqueStrings` idempotency for strengths (re-import does not duplicate)
    - `recommendation` fallback to `interview.summary`, override by `overall.recommendation`, preservation of manual recommendation
    - full-card merge scenario (interview + calls with cap + ops + overall) produces the exact expected `candidate_scores` patch
  - `node scripts/test_rubric_scoring.js` → 24/24 pass
  - `node scripts/import_full_candidate_card.js --file examples/analysis/full_candidate_card_example.json --dry-run` → all blocks correct, calls 9/78.3, semantic PASS

### BLOCKER 4 — PR body stale after retarget
PR #19 retargeted to `main` (PR #18 already merged). PR body updated to
drop the "Stacked on #18" / "After #18 merges, rebase this onto main"
wording. The PR now contains only FULL-CANDIDATE-CARD-V1 changes.

## Files changed in this fixup

| File | Change |
|---|---|
| `services/phase1_candidate_service.js` | `buildLatestAnalysis()` fetches training_agents + ops; `projectAnalysisRunForViewer()` passes through block-specific extras. |
| `public/report-v1.html` | New `renderTrainingAgentsAnalysisBlock()` + `renderOpsAnalysisBlock()`; `renderTrainingTab()` and `renderOpsTab()` now render the analysis when present, fall back to the existing placeholders when absent. |
| `scripts/import_full_candidate_card.js` | Imports `buildScoresPatch`; `persistFullCard()` refactored to chain interview + calls patches via `buildScoresPatch` (preserves risk_flags caps, risk_score_adjust accumulation, mergeUniqueStrings, recommendation fallback). Adds `ops` analysis_run creation. Persists summary/lists/scores_patch at top level of interview/calls output_payload. `buildPlan()` widens ops plan: qualitative-only ops block is now `UPDATE` (creates analysis_run) even when numeric scores are null. |

## Not verified here / server verification steps
- `better-sqlite3` is not installed in this environment and there is no local
  Phase 1 DB, so the **live persist** path was not executed here. The
  **import dry-run** is fully exercised offline (DB calls are guarded).
- Server verification steps for the reviewer:
  1. `node scripts/import_full_candidate_card.js --file examples/analysis/full_candidate_card_example.json --dry-run` → all blocks UPDATE, calls 9/78.3 semantic PASS.
  2. On a staging candidate, run a single live import: `node scripts/import_full_candidate_card.js --file <full_card.json>`.
  3. Open `report-v1.html` for that candidate:
     - Training tab → "Анализ по нашему мануалу" card shows the Codex summary / strengths / growth_zones (NOT the "ещё не рассчитан" placeholder).
     - Ops tab → "Анализ операционки" card shows the Codex summary / notes / score band (NOT the "ещё не рассчитан" placeholder).
     - Calls tab → call_quality_score unchanged (9 calls / 78.3).
     - Overview tab → recommendation + lists reflect the merged per-block + overall lists.
  4. Verify in DB: `SELECT analysis_type, status, created_at FROM analysis_runs WHERE base_key = '<key>' ORDER BY created_at DESC` → should include `interview`, `calls`, `training_agents`, `ops` rows.
  5. If the calls block has `risk_flags`, verify the cap was applied: `SELECT call_quality_score FROM candidate_scores WHERE base_key = '<key>'` should be ≤ the lowest cap for the flags present.
- If a calls risk_flag cap should apply but the score is unchanged, the
  reviewer should diff `scripts/import_full_candidate_card.js` against
  `scripts/import_analysis_result.js` to confirm `buildScoresPatch` is
  being called with the calls rubric id and the doc's `risk_flags` array.
