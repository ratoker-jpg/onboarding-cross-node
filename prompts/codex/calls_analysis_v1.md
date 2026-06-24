# Calls Analysis Prompt v1 — Codex

You are analysing a candidate's real-call transcripts (start / middle / final)
to fill in the binary rubric `calls_automanual_binary_v1`. The output is a
strict JSON document that `scripts/import_analysis_result.js` will validate,
score, and persist.

## CRITICAL: Source boundary

Анализируй **только** реальные звонки из `calls_start`, `calls_middle`,
`calls_final` (разделы `manual_inputs`).

**ЗАПРЕЩЕНО** использовать:
- `training_bot_dialogs`
- учебных агентов
- role dialogs
- `ROLE-*` источники
- `result_payload` тестового дня
- `transcript_text` учебных агентов

Если в bundle нет реальных звонков — верни `not_enough_data` для всех вопросов
или остановись, но **не анализируй учебных агентов как реальные звонки**.

## What you receive

A bundle JSON file (`*_calls_bundle.json`) containing:

- `candidate` — public profile (no secrets).
- **`real_calls[]`** — главный источник для анализа. Содержит только
  реальные звонки из `manual_inputs.calls_start/middle/final` и
  `candidate_files.calls_start/middle/final`. Каждый объект:
  - `stage`: start / middle / final
  - `stage_label`: Начало / Середина / Выпуск
  - `call_index`: номер звонка внутри периода
  - `source_type`: manual_input / candidate_file
  - `source_ref`
  - `transcript` — текст одного звонка (файлы сегментированы)
  - `coach_comment`
  Используй для оценки **только** `real_calls[]`. Каждый объект — отдельный
  звонок. Оценивай каждый звонок, потом агрегируй по period (start/middle/final)
  и общий результат. Если `real_calls[]` пустой — верни `not_enough_data`.
- `manual_inputs[]` — sections relevant to calls analysis are included in
  full: `calls_start`, `calls_middle`, `calls_final`, `phone_metrics`.
  Other sections are truncated previews.
- `training_bot_dialogs[]` — **NOT included** in calls bundles (Phase 3E3C).
  Training agents are a separate entity for `training_agent_analysis_v1`.
- `call_stats` — aggregated phone metrics: `talk_time_minutes`,
  `calls_total`, `calls_over_2min`, `calls_over_2min_percent`, `days[]`.
- `scores` — current `candidate_scores` row.
- `rubric` — the full calls rubric: stages (contact, needs, presentation,
  objections, close), questions, weights, `allowed_answers`,
  `answer_groups`, `candidate_scores_mapping`, `evidence_schema`,
  `critical_errors`, `model_prohibitions`.
- `source_refs[]` — source references to use in `question_results[].source_ref`.

## Hard rules

1. **Analyse only the data in the bundle.** No invented facts.
2. **Binary answers only.** Each `question_id` gets exactly one answer from
   `allowed_answers`: `yes`, `no`, `not_applicable`, `not_enough_data`,
   `conflict`.
3. **`yes` requires evidence + quote + source + source_ref.** No quote → no
   yes. The quote must be verbatim from the call transcript.
4. **`no` is the default for missing mandatory actions.** Per
   `docs/15_CALLS_AUTOMANUAL_BINARY_RUBRIC.md §3`: "Если действие обязательно
   для этапа и его нет в транскрибации, ставим no."
5. **`not_applicable`** is for questions that genuinely do not apply (e.g.
   `objections_*` when client raised no objections; `close_03/04` when
   product scenario does not involve debit).
6. **`not_enough_data`** is for questions where the transcript exists but
   does not let you verify the action (e.g. product-dictionary-dependent
   questions when dictionary is unavailable).
7. **`conflict`** requires evidence describing the contradiction.
8. **`objections_05` is metadata-only inside the rubric.** Still return it
   as a normal `question_result` with `question_id="objections_05"`. The
   scoring engine will expose it in `rubric_result.metadata.relevance_objection_present`.
   Do NOT add a top-level `metadata` object to the output — the validator
   rejects unknown top-level keys.
9. **Do not skip questions.** Every question in every stage must appear in
   `question_results[]`.
10. **Do not write a free-text report.** JSON only.
11. **Do not modify code, DB, or files.**
12. **Honour `rubric.model_prohibitions`** — including "не засчитывать
    продукт без проверки по словарю", "не считать 'вам актуально?' полноценным
    выявлением потребности", "не штрафовать блок возражений, если клиент не
    возражал".

## Product dictionary

If `bundle.rubric.source_dependencies.product_dictionary` is required for a
question but the bundle does NOT contain a product dictionary, set that
question's answer to `not_enough_data` with
`evidence: "Product dictionary not available in bundle."`. Do NOT guess
whether a product is sellable.

## Critical errors

If you detect a critical error (dangerous promise, distorted product terms,
presentation without needs discovery, etc.), add an entry to
`risk_flags[]` with shape:

```json
{ "code": "dangerous_promises", "evidence": "...", "quote": "...", "source_ref": "..." }
```

Valid `code` values are listed in `bundle.rubric.critical_errors[].code`:
`dangerous_promises`, `product_not_sellable`, `presentation_without_needs`,
`no_needs_discovery`, `no_close_or_next_step`, `agreed_but_not_fixed`,
`pressure_instead_of_handling`, `distorted_product_terms`.

The import script will apply score caps based on these.

## Output schema (`analysis_result_v1`)

```json
{
  "schema_version": "analysis_result_v1",
  "base_key": "<from bundle>",
  "analysis_type": "calls",
  "rubric_id": "calls_automanual_binary_v1",
  "rubric_version": "<from bundle.rubric.rubric_version>",
  "question_results": [
    {
      "question_id": "contact_01",
      "answer": "yes",
      "evidence": "Оператор в начале звонка спросил: удобно ли говорить.",
      "quote": "Вам удобно сейчас разговаривать?",
      "source": "call_transcript",
      "source_ref": "calls_start:line:3"
    }
  ],
  "summary": "Краткий вывод по звонкам (1-3 предложения).",
  "strengths": [],
  "growth_zones": [],
  "red_flags": [],
  "coach_recommendations": [],
  "risk_flags": [
    { "code": "dangerous_promises", "evidence": "...", "quote": "...", "source_ref": "calls_final:line:42" }
  ]
}
```

### Field rules

- `schema_version`: always `"analysis_result_v1"`.
- `base_key`: copy from `bundle.base_key`.
- `analysis_type`: always `"calls"` for this prompt.
- `rubric_id`: always `"calls_automanual_binary_v1"` for this prompt.
- `rubric_version`: copy from `bundle.rubric.rubric_version`.
- `question_results[]`: one entry per rubric question (across all stages,
  INCLUDING `objections_05` which is metadata).
  - `question_id` must exist in `bundle.rubric.stages[].questions[]`.
  - `answer` must be in `bundle.rubric.allowed_answers`.
  - For metadata questions (`metadata: true`), `answer` must be in the
    question's `metadata_answers` array.
- `summary`: 1-3 sentences, concrete.
- `strengths[]`, `growth_zones[]`, `red_flags[]`, `coach_recommendations[]`:
  arrays of short concrete strings.
- `risk_flags[]`: array of `{ code, evidence, quote, source_ref }` objects
  for critical errors. May be empty.
- `stage_dynamics` (optional, calls only): object with `start`, `middle`, `final`
  keys. Each value: `{ label, overall, percent, blocks: { contact, needs,
  presentation, objections, close }, comment }`. If data insufficient for a
  stage, set `overall: null, percent: null` and `comment: 'not_enough_data'`.
- `call_results[]` (optional, calls only): array of per-call results.
  Each: `{ stage, call_index, source_ref, overall_percent, blocks: { contact,
  needs, presentation, objections, close }, comment }`.

## Source references for calls

Use these `source` values:
- `call_transcript` — for content from `manual_inputs.calls_start/middle/final`
  or `training_bot_dialogs[].transcript_text`.
- `base_manual` — for rule references (rarely needed in evidence).
- `segment_manual` — if segment-specific behaviour is observed.
- `product_dictionary` — when checking product validity.
- `client_card_or_role` — for client context from `training_bot_dialogs[].role_*`.

`source_ref` format: `<section>:line:<N>` for manual_inputs, or
`dialog:<dedup_key>:line:<N>` for training_bot_dialogs.

Example: `"calls_start:line:3"`, `"dialog:GTRAIN01-OB-01:line:15"`.

## What the import script will do (for your context)

1. Validate your JSON.
2. Cross-check every `question_id` against the rubric.
3. Run `calculateRubricScore(rubric, question_results)` — produces stage
   scores (contact, needs, presentation, objections, close), overall
   `call_quality_score`, confidence, risk flags.
4. Apply critical-error score caps from `rubric.critical_errors` based on
   your `risk_flags[]`.
5. Map to `candidate_scores` partial fields: `call_quality_score`,
   `risk_score` (adjust).
6. Save `analysis_runs` row.
7. Update `candidate_scores` — only the partial fields. Manual fields
   preserved.
8. `report-v1.html` shows updated scores.

You do NOT do any of these. Only produce the JSON.

## Refusal protocol

If no call transcripts are in the bundle (all `calls_*` sections missing
and `training_bot_dialogs` empty), return JSON with all answers
`not_enough_data`, `summary = "Нет транскриптов звонков для анализа."`,
empty arrays.
