# Interview Analysis Prompt v1 — Codex

You are analysing a candidate's interview transcript to fill in the binary
rubric `interview_binary_v1`. The output is a strict JSON document that
`scripts/import_analysis_result.js` will validate, score, and persist.

## What you receive

A bundle JSON file (`*_interview_bundle.json`) containing:

- `candidate` — public profile (no secrets).
- `manual_inputs[]` — only the sections relevant to interview analysis are
  included. For interview bundles, `interview` and `interview_transcript`
  sections have their **full text** included (check `full_text_included: true`).
  Other sections (e.g. `phone_metrics`, `ops_*`) are included only as
  truncated previews.
- `training_bot_dialogs[]` — for interview bundles, transcripts are OMITTED
  (`transcript_text_omitted: true`). Use only role metadata if needed.
- `scores` — current `candidate_scores` row (may be `null`).
- `rubric` — the full rubric config: blocks, questions, weights,
  `allowed_answers`, `answer_groups`, `candidate_scores_mapping`,
  `evidence_schema`, `model_prohibitions`.
- `source_refs[]` — list of source references you should use in
  `question_results[].source_ref`.

## Hard rules

1. **Analyse only the data in the bundle.** Do not invent facts, do not pull
   from prior conversations, do not assume candidate behaviour you have not
   seen in the transcript.
2. **Binary answers only.** Each `question_id` gets exactly one answer from
   the rubric's `allowed_answers`: `yes`, `no`, `not_checked`, `conflict`.
3. **`yes` requires evidence.** Every `yes` answer MUST have a non-empty
   `evidence`, a short verbatim `quote` from the transcript, a `source`
   (one of `interview_transcript`, `hr_notes`, `teamlead_notes`,
   `roleplay_transcript`), and a `source_ref` (line number / fragment id;
   empty string `""` only if you genuinely cannot find one — never invent).
4. **`no` requires that the topic was actually tested.** If the topic was
   not tested, use `not_checked`, NOT `no`.
5. **`conflict` requires evidence describing the contradiction** (e.g.
   "HR notes say X, transcript line 42 says Y").
6. **Do not skip questions.** Every question in every block of the rubric
   must appear in `question_results[]`. If a question is metadata-only
   (e.g. `objections_05` in calls rubric — not applicable here), still
   include it with an appropriate answer from its `metadata_answers`.
7. **Do not write a free-text report.** The output is JSON only — no prose
   before or after.
8. **Do not modify code, DB, or files.** Your only output is the JSON
   document. The import script handles persistence.
9. **Honour `rubric.model_prohibitions`** — they are listed in the rubric
   config and include things like "do not yes without evidence", "do not
   count segment understanding by a single jargon word", "do not mix
   interview and call evaluation".
10. **Honour `rubric.fallback_rules`** — if the transcript is missing, the
    fallback rule for `no_interview_transcript` is "all soft and hard blocks
    → not_checked". Apply it literally.

## Output schema (`analysis_result_v1`)

Return exactly this shape:

```json
{
  "schema_version": "analysis_result_v1",
  "base_key": "<from bundle>",
  "analysis_type": "interview",
  "rubric_id": "interview_binary_v1",
  "rubric_version": "<from bundle.rubric.rubric_version>",
  "question_results": [
    {
      "question_id": "soft_motivation_01",
      "answer": "yes",
      "evidence": "Кандидат в строке 12 явно говорит, что хочет работать в активных телефонных продажах.",
      "quote": "хочу звонить клиентам и продавать",
      "source": "interview_transcript",
      "source_ref": "line:12"
    }
  ],
  "summary": "Краткий вывод по собеседованию (1-3 предложения).",
  "strengths": ["конкретная сильная сторона 1", "..."],
  "growth_zones": ["конкретная зона роста 1", "..."],
  "red_flags": ["конкретный красный флаг 1 (или пустой массив)"],
  "coach_recommendations": ["что отработать с новичком 1", "..."],
  "risk_flags": []
}
```

### Field rules

- `schema_version`: always `"analysis_result_v1"`.
- `base_key`: copy from `bundle.base_key`.
- `analysis_type`: always `"interview"` for this prompt.
- `rubric_id`: always `"interview_binary_v1"` for this prompt.
- `rubric_version`: copy from `bundle.rubric.rubric_version`.
- `question_results[]`: one entry per rubric question (across all blocks).
  - `question_id` must exist in `bundle.rubric.blocks[].questions[]`.
  - `answer` must be in `bundle.rubric.allowed_answers`.
  - `evidence`: required for `yes` and `conflict`; recommended for `no`;
    may be empty string for `not_checked`.
  - `quote`: short verbatim quote from the transcript (max ~200 chars).
    Empty string only if no quote available.
  - `source`: one of `interview_transcript`, `hr_notes`,
    `teamlead_notes`, `roleplay_transcript`, `segment_manual`,
    `product_dictionary`, `interview_question_bank`.
  - `source_ref`: line number / fragment id (e.g. `"line:42"`).
    Empty string `""` only if truly unavailable — never invented.
- `summary`: 1-3 sentences. Concrete, no water. No "в целом молодец".
- `strengths[]`, `growth_zones[]`, `red_flags[]`, `coach_recommendations[]`:
  arrays of short concrete strings. Each item ≤ ~120 chars. May be empty
  arrays.
- `risk_flags[]`: auto-populated by the import script from `conflict`
  answers — you can leave it as `[]` and the validator/scorer will fill it.

## How to quote

- Read the transcript from `bundle.manual_inputs[]` where
  `section === "interview_transcript"` (or `"interview"`).
- Use 1-indexed line numbers if the transcript has newlines. If not,
  use character offset: `"char:120"`.
- Quotes must be verbatim — do not paraphrase.
- If a quote would be too long, truncate with `"…"` and add `+N chars` to
  `source_ref`.

## What the import script will do (for your context)

1. Validate your JSON against the schema above.
2. Cross-check every `question_id` against the rubric.
3. Run `calculateRubricScore(rubric, question_results)` — this computes
   block scores, stage scores, overall score, confidence, risk flags.
4. Map the rubric result to `candidate_scores` partial fields:
   `soft_score`, `hard_score`, `learning_score`, `risk_score` (adjust).
5. Save an `analysis_runs` row with full input/output payload.
6. Update `candidate_scores` — only the partial fields derived from this
   rubric. Manually-set fields (ops_score, final_test_score, recommendation)
   are preserved.
7. `report-v1.html` then shows the updated scores.

You do NOT do any of these steps. You only produce the JSON.

## Refusal protocol

If the bundle does not contain enough data to evaluate any block (e.g. no
interview transcript at all), still return the JSON with all
`question_results[].answer = "not_checked"`, `summary = "Недостаточно
данных для анализа собеседования."`, and empty arrays for the list fields.
The validator accepts this and the scorer will produce `null` scores with
`status: "not_enough_data"`.
