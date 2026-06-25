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
   objections questions when client raised no objections).
6. **`not_enough_data`** is for questions where the transcript exists but
   does not let you verify the action (e.g. product-dictionary-dependent
   questions when dictionary is unavailable).
7. **`conflict`** requires evidence describing the contradiction.
8. **Do not skip questions.** Every question in every stage must appear in
   `question_results[]`.
9. **Do not write a free-text report.** JSON only.
10. **Do not modify code, DB, or files.**
11. **Honour `rubric.model_prohibitions`** — including "не засчитывать
    продукт без проверки по словарю", "не считать 'вам актуально?' полноценным
    выявлением потребности", "не штрафовать блок возражений, если клиент не
    возражал".

## Product dictionary

The bundle contains `product_dictionary[]` — a list of sellable products
from the official Точка product sheet. Each entry has:
- `product_id` — stable slug
- `product_name` — full name
- `aliases[]` — abbreviations and colloquial names
- `description` — product description
- `status` — selling status (e.g. "Продается", "Продается (минимально)")
- `segments` — target segments
- `product_type` — category

### Rules for presentation questions

**B11 / `presentation_any_product`**: `yes` only if operator named a
product from `product_dictionary` by name or alias, or described it
specifically enough to match `description`. `no` if operator said
generic "у нас есть сервисы" or product not in dictionary.

**B12 / `presentation_asked_opinion`**: `yes` only if operator asked
opinion/interest about a **specific** product found in
`product_dictionary`. Generic "вам актуально?" without product = `no`.

**B14 / `presentation_linked_to_problem`**: `yes` only if operator
linked a specific `product_dictionary` product to the client's stated
problem.

### Rules for objections questions

Objection counts as product-related only if it refers to a product from
`product_dictionary`. General bank-level doubts without a specific
product = `not_applicable`.

**B18 / `objections_compared_competitors`**: `yes` only if operator
compared a `product_dictionary` product's conditions with a competitor's
equivalent.

### If product_dictionary is empty or missing

If `product_dictionary` is empty or not in the bundle, set all
`requires_product_dictionary` questions to `not_enough_data` with
`evidence: "Product dictionary not available in bundle."`

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
  "expected_real_calls_count": 9,
  "question_results": [
    {
      "question_id": "contact_call_reason",
      "answer": "yes",
      "evidence": "Оператор сообщил причину звонка.",
      "quote": "звоню по поводу предложения для вашего бизнеса",
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
  ],
  "stage_dynamics": {
    "start":  { "label": "Начало",   "overall": 4.1, "percent": 82.0, "blocks": { "contact": 1.0, "needs": 0.75, "presentation": 0.9, "objections": 0.5, "close": 0.8 }, "comment": "..." },
    "middle": { "label": "Середина", "overall": 4.0, "percent": 80.0, "blocks": { "contact": 1.0, "needs": 0.75, "presentation": 0.9, "objections": 0.4, "close": 1.0 }, "comment": "..." },
    "final":  { "label": "Выпуск",   "overall": 3.7, "percent": 74.0, "blocks": { "contact": 1.0, "needs": 0.7, "presentation": 0.85, "objections": 0.5, "close": 0.7 }, "comment": "..." }
  },
  "call_results": [
    {
      "stage": "start",
      "stage_label": "Начало",
      "call_index": 1,
      "source_ref": "candidate_files.calls_start:6#call_1",
      "overall_percent": 81.25,
      "overall_score": 4.06,
      "blocks": { "contact": 1.0, "needs": 0.75, "presentation": 1.0, "objections": 0.25, "close": 1.0 },
      "products_detected": [
        { "product_id": "internet_ekvayring", "product_name": "Интернет-эквайринг", "matched_by": "dictionary", "matched_text": "интернет-эквайринг", "source_ref": "candidate_files.calls_start:6#call_1" }
      ],
      "comment": "..."
    }
  ]
}
```

### Field rules

- `schema_version`: always `"analysis_result_v1"`.
- `base_key`: copy from `bundle.base_key`.
- `analysis_type`: always `"calls"` for this prompt.
- `rubric_id`: always `"calls_automanual_binary_v1"` for this prompt.
- `rubric_version`: copy from `bundle.rubric.rubric_version`.
- `expected_real_calls_count` (**required for calls**): the number of real calls
  you analysed — equal to `bundle.real_calls.length` and to the number of
  `call_results[]` entries you emit. The import semantic guard rejects a result
  where `call_results.length` does not equal `expected_real_calls_count`, so it
  must not be guessed: count the real calls in the bundle.
- `question_results[]`: **exactly one entry per rubric question** — the
  `calls_automanual_binary_v1` v1.1.0 rubric has **16 questions** (contact 2,
  needs 4, presentation 4, objections 4, close 2), so `question_results[]`
  must contain all 16. Every question in the rubric must appear; no extra ids.
  - `question_id` must exist in `bundle.rubric.stages[].questions[]`.
  - `answer` must be in `bundle.rubric.allowed_answers`.
- `summary`: 1-3 sentences, concrete. **Russian only** — no English in any
  user-facing text (`summary`, `strengths`, `growth_zones`, `red_flags`,
  `coach_recommendations`, stage/call `comment`).
- `strengths[]`, `growth_zones[]`, `red_flags[]`, `coach_recommendations[]`:
  arrays of short concrete strings.
- `risk_flags[]`: array of `{ code, evidence, quote, source_ref }` objects
  for critical errors. May be empty.
- `stage_dynamics` (**required for calls**): object with `start`, `middle`,
  `final` keys. Each value: `{ label, overall, percent, blocks: { contact,
  needs, presentation, objections, close }, comment }`. If data is insufficient
  for a stage, still emit the key with `overall: null, percent: null` and
  `comment` explaining why.
- `call_results[]` (**required for calls**): array of per-call results, one
  object per real call from `real_calls[]`. The number of `call_results` must
  match the number of analysed real calls, and the average of their
  `overall_percent` must be consistent with the overall rubric score.
  Each: `{ stage, stage_label, call_index, source_ref, overall_percent,
  overall_score, blocks: { contact, needs, presentation, objections, close },
  products_detected: [ ... ], comment }`.
- `products_detected[]` (inside each `call_result`): products from
  `product_dictionary` mentioned in that call. Each:
  `{ product_id, product_name, matched_by, matched_text, source_ref }`.
  Empty array if no dictionary product was presented in the call.

> **Consistency contract.** `import_analysis_result.js` runs semantic checks
> for calls: 16 `question_results`, `call_results` with one scored entry per
> real call (`call_results.length` must equal `expected_real_calls_count`),
> `stage_dynamics` with start/middle/final, the per-call average consistent with
> the rubric overall score, and no training-bot markers in any semantic field. A document that fails these checks is **rejected on live
> import** — keep the numbers internally consistent and never mix in
> `training_bot_dialogs` / учебные agents.

## Source references for calls

Use only sources from `real_calls[]`.

Allowed `source` values:
- `call_transcript` — for content from `real_calls[].transcript`;
- `base_manual` — for rule references, rarely needed;
- `segment_manual` — if segment-specific behaviour is observed;
- `product_dictionary` — when checking product validity;
- `client_card_or_role` — only for candidate/client context included in the calls bundle, not from training agents.

Allowed `source_ref` format:
- use exactly `real_calls[].source_ref`, for example:
  - `candidate_files.calls_start:6#call_1`
  - `candidate_files.calls_middle:7#call_2`
  - `candidate_files.calls_final:5#call_3`

Forbidden `source_ref` values:
- `dialog:*`
- `ROLE-*`
- `training_bot*`
- `training_bot_dialogs*`
- `result_payload*`

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

If `real_calls[]` is empty, return JSON with all answers `not_enough_data`, summary = "Нет транскриптов реальных звонков для анализа.", empty arrays. Do not use training agents as fallback.
