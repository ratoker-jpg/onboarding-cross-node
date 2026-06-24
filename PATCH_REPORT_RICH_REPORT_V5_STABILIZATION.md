# PATCH REPORT — RICH-REPORT-V5-STABILIZATION

**Date:** 2026-06-24
**Scope:** calls import semantic guard + report-v1 UI v5 + prompt/example/tests sync
**Test candidate:** GTRAIN02 (Иванов Иван, Грузоперевозки, направление S)

This is a controlled, non-deploy patch. No production DB was touched, no live
import was run, nothing was deployed to the server.

---

## 1. Changed files

| File | Why |
|---|---|
| `scripts/import_analysis_result.js` | Added a **semantic guard** for `analysis_type=calls` (question_results / call_results / stage_dynamics / score consistency / forbidden markers). Prints a `Semantic checks:` block in every run; **aborts live import** when checks fail. |
| `public/report-v1.html` | Brought the dynamic viewer to the **v5 UI** (overview "Анализ звонков по автомануалу", calls-only stage dynamics, "Всего звонков" yellow zone with management copy, "Красные флаги" → "Риски", removed subjective overview blocks, removed misleading call metrics). Live viewer API (`/api/viewer/phase1/.../card`) is preserved. |
| `prompts/codex/calls_analysis_v1.md` | `stage_dynamics`, `call_results` and `products_detected` are now **required** (were "optional"); explicit **16 question_results**; explicit "no training_bot mixing" + consistency contract; Russian-only user text. |
| `examples/analysis/calls_result_example.json` | Added `stage_dynamics`, `call_results` and `products_detected`; example is now self-consistent (call_results average = rubric overall = 87.8) so it passes the new semantic guard. |
| `scripts/test_rubric_scoring.js` | Updated the 6 tests that referenced the removed v1.0.0 schema (`contact_01..05`, metadata `objections_05`) to the **v1.1.0** rubric. Suite is now green (24/24). |
| `tmp/GTRAIN02_calls_result_FINAL_PRODUCTS.json` | Canonical valid GTRAIN02 calls result, committed so the dry-run check is reproducible. No secrets. |

---

## 2. What changed (by block)

### Calls semantic guard (`import_analysis_result.js`)
New `runCallsSemanticChecks(doc, rubric, rubricResult)` runs for calls only,
after validation + rubric scoring:
- **question_results** — must be exactly the rubric's 16 questions (no missing/extra).
- **call_results** — must exist, be non-empty, each with a score
  (`overall_percent` / `call_quality_score` / `quality_score` / `score`).
- **stage_dynamics** — must exist and contain `start` / `middle` / `final`.
- **score consistency** — `avg(call_results scores)` vs `rubric.overall_score_percent`,
  tolerance **1.0** point (same 0–100 scale).
- **forbidden markers** — `training_bot_dialogs`, `training_bot`, `bot_training`,
  `ROLE-`, `dialog:`, `result_payload`, `учебн` must not appear in
  `question_results`, `call_results`, `stage_dynamics`, `summary`, `strengths`,
  `growth_zones`, `red_flags`, `coach_recommendations`.

Output (every run):
```
Semantic checks:
- question_results: PASS/FAIL
- call_results: PASS/FAIL
- stage_dynamics: PASS/FAIL
- score consistency: PASS/FAIL
- forbidden markers: PASS/FAIL
```
Live import exits non-zero (code 4) on any FAIL; dry-run prints the verdict and
completes. The existing valid GTRAIN02 file passes all five checks.

### report-v1 UI (v5)
The dynamic report was aligned to the v5 reference HTML. Crucially, the v5
reference was a **standalone export** that embedded a hardcoded GTRAIN02 card and
overrode `requestJson`; that demo harness was **removed** so the file remains a
live viewer driven by the viewer API.
- **Overview** — top experience block, short trainer summary, "Звонки" now shows
  a general **"Анализ звонков по автомануалу"** (контакт / потребность /
  презентация / возражения / закрытие / общий вывод), key conclusion, strengths,
  growth zones, risks, coach recommendations. Removed from overview: newbie key,
  "Сводка цифр", final status / risk / data-readiness / separate team-lead next
  step, and the Начало/Середина/Выпуск dynamics.
- **Calls tab** — keeps call summary, automanual quality, **stage dynamics
  (Начало / Середина / Выпуск live only here)**, individual calls,
  `products_detected`, talk-time / total-calls / share-over-2-min metrics, and
  color scales by time and by day. Removed: redials, calls-over-10-min,
  effective-minutes, and the "% от ориентира" / "Ориентир при средней 1:17"
  technical captions.
- **"Всего звонков" card** — data-driven against an internal benchmark
  (≈214 min ⇒ ≈180 calls). For GTRAIN02 (214 min, 89 calls ⇒ ~49%) it renders the
  **yellow zone** with the management-only copy: *"Количество звонков ниже
  ожидаемого при таком объёме времени."* No technical percent shown.
- **Recommendations** — "Красные флаги" renamed to **"Риски"**; English UI strings
  translated.
- **Training agents** — kept as a separate tab, explicitly labeled as training
  dialogs (not real calls), evaluation blocks collapsed by default, dialogs and
  role portrait viewable.

### prompt / example / tests
See table above. The prompt now enforces what the UI and semantic guard expect.

---

## 3. What was NOT changed (out of scope)
- Production DB not touched.
- Live import not run; no deploy to the server.
- No report snapshots / report history.
- No `training_agent_analysis_v1`.
- No 10-tab expansion (tab set unchanged).
- No large refactor of `phase1_candidate_service.js` or report-v1.html rewrite.
- No changes to admin/viewer auth, stack, or `.env`/secrets.

---

## 4. Checks run
```
node --check server.js                         # OK
node --check onboarding_core.js                # OK
node --check sheets_client.js                  # OK
node --check scripts/import_analysis_result.js # OK
# inline JS extracted from public/report-v1.html → node --check  # OK

node scripts/test_rubric_scoring.js            # 24 passed, 0 failed

node scripts/import_analysis_result.js --file tmp/GTRAIN02_calls_result_FINAL_PRODUCTS.json --dry-run
#   Validation: PASS
#   overall_score_percent: 78.3
#   call_quality_score patch: 78.3 → 78.3
#   Semantic checks: all PASS (avg call_results 78.33 ≈ 78.3)

node scripts/import_analysis_result.js --file examples/analysis/calls_result_example.json --dry-run
#   Validation: PASS; overall 87.8; Semantic checks: all PASS
```

## 5. Rollback
This patch is delivered as a branch/PR; rollback = revert the merge commit or
`git checkout main -- <file>` for an individual file. No backup directory is
needed because git history holds the prior versions.

## 6. Risks / manual verification
- `report-v1.html` was syntax-checked (extracted inline JS passes `node --check`)
  but **not** opened in a live browser here — visual QA against GTRAIN02 should be
  done after deploy (see PR "Manual QA").
- Stage-date formatting in the hero relies on the viewer API returning date-only
  values (as in the v5 reference). If the API ever returns timestamps, dates may
  show time — worth a glance during manual QA.
- The 214/180 calls benchmark is an internal heuristic constant; if the target
  ratio changes, update `renderPhoneQualityNorms`.
