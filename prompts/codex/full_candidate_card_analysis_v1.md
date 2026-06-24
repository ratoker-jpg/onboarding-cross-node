# Full Candidate Card Analysis Prompt v1 — Codex (master prompt)

You receive ONE full candidate bundle (`schema_version: full_candidate_bundle_v1`,
produced by `scripts/export_candidate_full_bundle.js`) and return ONE strict JSON
document (`schema_version: full_candidate_card_v1`) that
`scripts/import_full_candidate_card.js` validates, scores and imports.

The bundle has a `blocks` object: `interview`, `calls`, `training_agents`,
`ops`, `test_day`, `immersion`. Each block carries `available` / `missing_data`.

## Hard separation rules (do not break)

1. **Real calls are analysed ONLY via `calls_automanual_binary_v1`.** The calls
   block contains the calls analysis bundle (`real_calls[]`, `product_dictionary`,
   `rubric`). Follow `prompts/codex/calls_analysis_v1.md` exactly for it.
2. **Training agents are separate.** Analyse `blocks.training_agents.dialogs[]`
   qualitatively (role portrait, what went well / poorly). **Never** score them
   with the calls rubric and **never** let them affect `call_quality_score`.
3. **Operations is its own block.** Do not fold ops into calls or interview.
4. **Interview** is analysed via `interview_binary_v1`
   (`prompts/codex/interview_analysis_v1.md`).
5. **No invented data.** If a block has `missing_data: true` or no usable data,
   set its result to `missing_data: true` and its analysis/score fields to
   `null`. Never fabricate calls, dialogs, scores or quotes.
6. **Russian only** in every user-facing text field (summaries, strengths,
   growth zones, risks, coach recommendations, comments). No English in the UI.

## Output schema (`full_candidate_card_v1`)

```json
{
  "schema_version": "full_candidate_card_v1",
  "base_key": "<from bundle.base_key>",
  "blocks": {
    "interview": {
      "missing_data": false,
      "analysis": { "...": "analysis_result_v1 with analysis_type=interview (see interview prompt)" }
    },
    "calls": {
      "missing_data": false,
      "analysis": { "...": "analysis_result_v1 with analysis_type=calls (see calls prompt): expected_real_calls_count, 16 question_results, call_results, stage_dynamics, products_detected" }
    },
    "training_agents": {
      "missing_data": false,
      "dialogs_reviewed": 5,
      "summary": "Краткий вывод по учебным агентам (1-3 предложения).",
      "strengths": [],
      "growth_zones": [],
      "note": "Учебные агенты не влияют на call_quality_score."
    },
    "ops": {
      "missing_data": false,
      "ops_score": null,
      "discipline_score": null,
      "summary": "Вывод по операционке.",
      "notes": []
    },
    "final_test": {
      "missing_data": true,
      "final_test_score": null,
      "summary": null
    },
    "overall": {
      "recommendation": "Итоговая рекомендация по новичку.",
      "strengths": [],
      "growth_zones": [],
      "risks": [],
      "coach_recommendations": []
    }
  }
}
```

### Field rules

- `blocks.interview.analysis`: a full `analysis_result_v1` document with
  `analysis_type: "interview"`, exactly as the interview prompt specifies. If
  `bundle.blocks.interview.available` is false → `{ "missing_data": true,
  "analysis": null }`.
- `blocks.calls.analysis`: a full `analysis_result_v1` document with
  `analysis_type: "calls"`. It MUST include `expected_real_calls_count` (equal
  to `bundle.blocks.calls.bundle.real_calls.length`), all 16 `question_results`,
  one `call_results[]` entry per real call, `stage_dynamics`
  (start/middle/final) and `products_detected[]`. The per-call average must be
  consistent with the rubric overall. If `bundle.blocks.calls.available` is
  false → `{ "missing_data": true, "analysis": null }`.
- `blocks.training_agents`: qualitative only. `dialogs_reviewed` = number of
  dialogs you read. No rubric score. If no dialogs →
  `{ "missing_data": true, ... }` with empty arrays.
- `blocks.ops`: `ops_score` / `discipline_score` are numbers 0–100 **only if the
  ops data clearly supports a value**; otherwise `null` + a note. Never guess.
- `blocks.final_test`: `final_test_score` (0–100) only if the bundle carries
  graduation-test data; otherwise `missing_data: true` + `null`.
- `blocks.overall`: synthesis across the available blocks. `risks` replaces the
  old "red flags" wording.

## What the import script does (for your context)

1. Validates the full document.
2. For `blocks.interview.analysis` → `interview_binary_v1` scoring → soft / hard
   / learning scores.
3. For `blocks.calls.analysis` → `calls_automanual_binary_v1` scoring **plus the
   calls semantic guard** (16 question_results; `call_results.length ==
   expected_real_calls_count`; stage_dynamics start/middle/final; per-call
   average ≈ rubric overall; no training-bot markers). A failing calls block
   aborts the live import.
4. `training_agents` → stored as a separate analysis run; **does not** change
   `call_quality_score`.
5. `ops` / `final_test` → `ops_score` / `final_test_score` (only if non-null).
6. `overall` → recommendation / strengths / growth_zones / red_flags(risks) /
   coach_recommendations.
7. `overall_score` / `risk_level` / `final_status` are recomputed by the service
   with limiters — you do not set them.

You only produce the JSON. You do not run any of these steps.
