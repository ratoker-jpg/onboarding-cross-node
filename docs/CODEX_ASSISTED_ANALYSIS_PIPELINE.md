# Codex-assisted Analysis Pipeline (Phase 3E0)

This document describes the manual Codex-assisted pipeline for analysing
candidate interviews and calls without embedding AI API calls into the
server. Codex (or any capable LLM agent) runs against exported bundles and
returns strict JSON that the server validates, scores, and persists.

## Workflow

```
1. Admin uploads raw data via admin-v1.html
   (interview transcript, call transcripts, phone metrics, ops sections,
    training-bot imports, files)

2. Operator exports a bundle for a candidate + analysis type:
   node scripts/export_candidate_analysis_bundle.js \
     --base-key GTRAIN01 --type interview \
     --out tmp/GTRAIN01_interview_bundle.json

3. Operator gives Codex:
   - the bundle JSON file
   - the prompt template: prompts/codex/interview_analysis_v1.md
     (or calls_analysis_v1.md for calls)

4. Codex reads the bundle, follows the prompt, and returns a strict JSON
   document matching schemas/analysis_result_v1 (informally — the validator
   in services/phase1_analysis_result_validator.js is the source of truth).

5. Operator saves Codex's JSON to a file, e.g.
   tmp/GTRAIN01_interview_result.json

6. Operator runs dry-run import to validate without writing to DB:
   node scripts/import_analysis_result.js \
     --file tmp/GTRAIN01_interview_result.json --dry-run

7. If dry-run passes, operator runs the live import:
   node scripts/import_analysis_result.js \
     --file tmp/GTRAIN01_interview_result.json

8. Operator opens report-v1.html to verify the updated scores:
   /onboarding_cross/report-v1.html?base_key=GTRAIN01
```

## Files

### Scripts

| File | Purpose |
|---|---|
| `scripts/export_candidate_analysis_bundle.js` | Read candidate from SQLite, write bundle JSON for Codex |
| `scripts/import_analysis_result.js` | Validate Codex JSON, score via rubric engine, persist to `analysis_runs` + `candidate_scores` (partial update) |

### Prompt templates

| File | Used for |
|---|---|
| `prompts/codex/interview_analysis_v1.md` | Interview analysis → fills `interview_binary_v1` rubric |
| `prompts/codex/calls_analysis_v1.md` | Calls analysis → fills `calls_automanual_binary_v1` rubric |

### Validator + scoring

| File | Purpose |
|---|---|
| `services/phase1_analysis_result_validator.js` | Pure-function validator for `analysis_result_v1` JSON |
| `services/phase1_rubric_score_service.js` | (existing, PR #2) Computes block/stage/overall scores from question answers |
| `config/rubrics/interview_binary_v1.json` | (existing, PR #2) Interview rubric config |
| `config/rubrics/calls_automanual_binary_v1.json` | (existing, PR #2) Calls rubric config |

### Examples

| File | Purpose |
|---|---|
| `examples/analysis/interview_result_example.json` | Valid interview analysis result (synthetic data, no real PII) |
| `examples/analysis/calls_result_example.json` | Valid calls analysis result (synthetic data, no real PII) |

## JSON contracts

### Bundle (`analysis_bundle_v1`)

Exported by `scripts/export_candidate_analysis_bundle.js`. Shape:

```json
{
  "schema_version": "analysis_bundle_v1",
  "base_key": "GTRAIN01",
  "analysis_type": "interview",
  "exported_at": "2026-06-23T...",
  "candidate": { "base_key": "...", "full_name": "...", "seller_segment": "...", ... },
  "scores": { ... } | null,
  "manual_inputs": [
    { "section": "interview_transcript", "payload": { "text_content": "..." }, "updated_at": "...", "full_text_included": true }
  ],
  "training_bot_dialogs": [ ... ],
  "call_stats": { ... } | null,
  "interview_summary": { ... } | null,
  "files": [ { "section": "...", "stored_path": "...", "mime_type": "...", "text_content_preview": "...", "source_ref": "file:..." } ],
  "source_links": [ ... ],
  "rubric": { "rubric_id": "...", "blocks": [...], "allowed_answers": [...], "answer_groups": {...}, ... },
  "source_refs": [ "manual_inputs.section=interview_transcript", "file:data/uploads/...", ... ]
}
```

Safety guarantees:
- No `ADMIN_KEY` / `VIEWER_KEY` / env secrets ever exported.
- Long transcripts capped at 2000 chars (preview + length metadata) EXCEPT
  for the transcript of the requested `analysis_type`, which is exported in
  full so Codex can quote line numbers. The `full_text_included` flag on
  each manual_input tells Codex whether it has the complete source.
- Training-bot dialogs: transcripts are included only for `calls` bundles
  (capped at 20K chars per dialog); omitted for `interview` bundles.
- Files: binary content never embedded. Only metadata + a 500-char
  text_content_preview for text files.

### Result (`analysis_result_v1`)

Returned by Codex, validated by `services/phase1_analysis_result_validator.js`.
Shape:

```json
{
  "schema_version": "analysis_result_v1",
  "base_key": "GTRAIN01",
  "analysis_type": "interview",
  "rubric_id": "interview_binary_v1",
  "rubric_version": "1.0.0",
  "question_results": [
    {
      "question_id": "soft_motivation_01",
      "answer": "yes",
      "evidence": "Кандидат прямо говорит ...",
      "quote": "хочу работать в активных продажах",
      "source": "interview_transcript",
      "source_ref": "line:12"
    }
  ],
  "summary": "Краткий вывод ...",
  "strengths": [ "..." ],
  "growth_zones": [ "..." ],
  "red_flags": [ "..." ],
  "coach_recommendations": [ "..." ],
  "risk_flags": [
    { "code": "dangerous_promises", "evidence": "...", "quote": "...", "source_ref": "calls_final:line:42" }
  ]
}
```

Validation rules (enforced by `validateAnalysisResult`):
- `schema_version` must be `"analysis_result_v1"`.
- `base_key` non-empty string.
- `analysis_type` in `{interview, calls}`.
- `rubric_id` must match the type (`interview_binary_v1` for interview,
  `calls_automanual_binary_v1` for calls).
- Every `question_results[].question_id` must exist in the rubric.
- Every `question_results[].answer` must be in `rubric.allowed_answers`
  (or in `question.metadata_answers` for metadata questions).
- `answer=yes` requires non-empty `evidence` (strict mode, default on).
- `answer=conflict` requires non-empty `evidence`.
- Every rubric question must appear in `question_results[]` (no skipping).
- No duplicate `question_id`.
- Top-level allowlist: only `schema_version, base_key, analysis_type,
  rubric_id, rubric_version, question_results, summary, strengths,
  growth_zones, red_flags, coach_recommendations, risk_flags`. Unknown
  keys rejected.
- `risk_flags[].code` must be in `rubric.critical_errors[].code` (calls
  rubric only).
- Secret-leakage guard: document must not contain patterns like
  `ghp_...`, `github_pat_...`, `ADMIN_KEY=`, `VIEWER_KEY=`, Telegram bot
  token fragments.

## How scoring works

1. `validateAnalysisResult(doc)` checks shape, loads the rubric, verifies
   every `question_id` and `answer`.
2. `calculateRubricScore(rubric, doc.question_results)` (from
   `services/phase1_rubric_score_service.js`, PR #2) computes:
   - per-block/stage score_percent (0–100 or null)
   - per-block confidence (normal/low)
   - overall_score_percent
   - overall_status (`applicable` / `not_enough_data` / `partial` /
     `has_conflict`)
   - risk_flags from `conflict` answers
   - candidate_scores_mapping_preview with derived fields
3. `buildScoresPatch()` (in import script) maps the rubric result to a
   `candidate_scores` patch:
   - **interview** → `soft_score`, `hard_score`, `learning_score` from
     rubric; `risk_score` bumped by `risk_score_adjust` (capped at 100).
   - **calls** → `call_quality_score` from rubric; `risk_score` bumped;
     critical-error caps applied to `call_quality_score` based on
     `risk_flags[].code`.
   - `discipline_score`, `ops_score`, `final_test_score` are PRESERVED
     (not overwritten by Codex).
   - `recommendation`, `strengths`, `growth_zones`, `red_flags`,
     `coach_recommendations` are overridden ONLY if the result document
     provides non-empty values; otherwise existing manual values preserved.
4. `persistResult()` creates an `analysis_runs` row with `source=codex`,
   `status=success`, and full input/output payload for audit. Then upserts
   `candidate_scores` with the patch.
5. `recalculateCandidateScores()` runs after the upsert to recompute
   `overall_score`, `risk_level`, `final_status` with limiters from
   `docs/11_EVALUATION_RUBRICS_BY_STAGE_V1.md §12` (e.g. `hard<50 →
   needs_practice`, `risk>=76 → ready_with_control`).

## How Codex is prevented from writing to DB directly

- Codex does not receive DB credentials. The bundle does not contain
  `DATABASE_PATH`, `ADMIN_KEY`, or any connection string.
- Codex does not receive SQL instructions. The prompt explicitly says
  "do not modify code, DB, or files; your only output is the JSON document."
- The only way Codex's output reaches the DB is through
  `scripts/import_analysis_result.js`, which:
  1. Validates the JSON (rejects malformed or unknown fields).
  2. Scores it through the deterministic rubric engine.
  3. Persists through the same repositories/services the admin UI uses.
- The import script never executes arbitrary SQL from the JSON. It only
  calls fixed repo methods (`analysisRunsRepo.create`,
  `candidateScoresRepo.upsert`).
- `--dry-run` lets the operator preview the patch without any DB write.

## How to verify

### Syntax checks

```bash
node --check scripts/export_candidate_analysis_bundle.js
node --check scripts/import_analysis_result.js
node --check services/phase1_analysis_result_validator.js
node --check services/phase1_rubric_score_service.js
```

### Export bundle (requires a candidate in DB)

```bash
node scripts/export_candidate_analysis_bundle.js \
  --base-key GTRAIN01 --type interview \
  --out tmp/GTRAIN01_interview_bundle.json
```

If `GTRAIN01` does not exist locally, create a test candidate via the admin
UI first, or use any existing `base_key`.

### Dry-run import (no DB writes)

```bash
node scripts/import_analysis_result.js \
  --file examples/analysis/interview_result_example.json --dry-run
```

Expected output: validation PASS, rubric score computed, candidate_scores
patch printed, "DRY-RUN complete. No DB writes performed."

Note: the example file uses `base_key: EXAMPLE01` which likely does not
exist in your DB. The dry-run will still succeed through validation and
scoring, but the patch preview will show `existing=null` for all fields.
To see a realistic patch, edit the example to use a real `base_key`.

### Live import

```bash
node scripts/import_analysis_result.js \
  --file tmp/GTRAIN01_interview_result.json
```

Expected: `analysis_runs.id` printed, `candidate_scores.id` printed,
recalculated `overall`/`risk`/`status` printed.

### Verify in report

Open `/onboarding_cross/report-v1.html?base_key=GTRAIN01` — the
"Оценка по этапам" tab should show updated `hard_score` / `soft_score` /
`learning_score` (for interview) or `call_quality_score` (for calls).

## What this pipeline does NOT do

- ❌ No OpenAI / Anthropic / Claude / GPT API calls from the server.
- ❌ No background jobs. The operator manually runs export + import.
- ❌ No direct SQL workflow for Codex. Codex only reads bundles and writes
  JSON.
- ❌ No new DB tables. Uses existing `candidate_scores`, `analysis_runs`.
- ❌ No new external dependencies. Pure Node.js, no `npm install` needed.
- ❌ No PDF generation.
- ❌ No `report_snapshots` (Phase 3D proper).
- ❌ No dashboard or admin UI changes.
