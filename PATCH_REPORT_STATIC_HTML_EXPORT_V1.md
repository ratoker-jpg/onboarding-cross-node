# PATCH REPORT — STATIC-HTML-EXPORT-V1

**Date:** 2026-06-25
**Goal:** add the ability to export a candidate's report as a self-contained HTML file that opens locally in a browser without a server, API calls, or viewer key. Requested by security so reports can be downloaded and then the candidate's data purged via DATA-PURGE-V1 without losing the report.

Non-deploy patch. No production DB touched, no live export run, nothing deployed.

## What was built

### CLI script
`scripts/export_candidate_report_html.js` — thin wrapper around the same `exportCandidateReportHtml()` service function that powers the API endpoint.

```bash
node scripts/export_candidate_report_html.js --base-key GTRAIN02 --confirm GTRAIN02
node scripts/export_candidate_report_html.js --base-key GTRAIN02 --confirm GTRAIN02 --out tmp/exports/custom.html
```

Exit codes: `0` success, `1` bad args, `2` candidate not found, `3` confirm mismatch, `5` internal error.

### Admin endpoints

**`POST /api/admin/phase1/candidates/:base_key/export-html`** — admin-only (`X-Admin-Key`).

Body:
```json
{ "confirm_base_key": "GTRAIN02" }
```

Response:
```json
{
  "ok": true,
  "exported_at": "2026-06-25T12:00:00.000Z",
  "file": {
    "filename": "Иванов_Иван_report_2026-06-25.html",
    "path": "tmp/exports/Иванов_Иван_report_2026-06-25.html",
    "size_bytes": 12345
  }
}
```

**`GET /api/admin/phase1/exports/:filename/download`** — admin-only. Streams the file with `Content-Disposition: attachment`. Path-safety: `filename` is forced through `path.basename()` and the resolved path must be inside `<repoRoot>/tmp/exports/`.

### Service function
`services/phase1_candidate_service.js` → `exportCandidateReportHtml(baseKey, opts)` + private helpers:
- `sanitizeFilenameComponent(value)` — strips path separators / control chars / illegal-in-filename chars, collapses whitespace to `_`, returns `'candidate'` fallback for empty input.
- `buildExportFilename(candidate, exportedAtIso)` — `<SanitizedName>_report_<YYYY-MM-DD>.html`.
- `escapeHtmlStrict(value)` — escapes `& < > " '` for safe HTML embedding.
- `safeJsonForScript(json)` — JSON.stringify + escapes `<`, `>`, `&`, U+2028, U+2029 so `</script>` inside a transcript cannot break out of the embedded `<script type="application/json">` block.
- `sanitizeCardForExport(card)` — strips `candidate.base_key`, `candidate.id`, `keys`, `source_links`, `import_summary`, `has_legacy_ai_profile` before embedding.
- `renderStaticReportHtml(card, exportedAtIso)` — renders the full self-contained HTML.

### Self-contained HTML

The exported HTML is a single file with:
- Inline `<style>` (purple-accent palette matching report-v1, responsive grid, ~120 lines of CSS).
- Inline `<script type="application/json" id="card-data">` holding the sanitized card (escaped via `safeJsonForScript`).
- A tiny inline `<script>` for tab switching — NO `fetch()`, NO `XMLHttpRequest`, NO external fonts, NO CDN.
- 5 tabs: Обзор / Оценки / Данные / Учебные агенты / Анализ.
- Export header: "Отчёт выгружен: ДД.ММ.ГГГГ ЧЧ:ММ" (Europe/Moscow timezone).
- Hero: "Кандидат: ФИО" + "Направление / сегмент: Грузоперевозки · S" + status / mentor / recruiter / immersion date.

## Security

- **`confirm_base_key`** MUST equal the URL `base_key` — checked before any DB access. Returns `400 confirm_base_key_mismatch` otherwise.
- **Filename sanitization** — `sanitizeFilenameComponent()` strips `/\<>:"|?*` + control chars + collapses whitespace. `'../../../etc/passwd'` → `'etc_passwd'`. No path traversal possible.
- **HTML escaping** — every user-controlled string (`full_name`, `direction`, `mentor`, `recommendation`, transcript previews, etc.) goes through `escapeHtmlStrict()`. XSS payloads like `<script>alert(1)</script>` in `full_name` are rendered as escaped text.
- **JSON embedding** — `safeJsonForScript()` escapes `<` → `\u003c` so `</script>` inside a transcript cannot close the JSON script tag early. Tested with `</script><script>alert("pwned")</script>` payload.
- **Card sanitization** — `sanitizeCardForExport()` strips `base_key`, `id`, `keys` (session keys), `source_links` (legacy_key), `import_summary` (source_code / legacy_key), `has_legacy_ai_profile` before embedding. Only human-facing fields remain.
- **No absolute server paths** — the response returns only `tmp/exports/<filename>` (relative). The HTML contains no `/home/`, no `/etc/`, no absolute repo root.
- **No secrets in HTML** — verified: no `base_key`, `session_key`, `admin_key`, `viewer_key`, `X-Admin-Key` literals in the rendered HTML.
- **No network requests** — verified: no `fetch(`, no `XMLHttpRequest` in the HTML. Opens offline via `file://`.
- **Download endpoint path-safety** — `GET /exports/:filename/download` forces `path.basename()`, rejects `..` / `/`, and verifies the resolved path is inside `tmp/exports/`.
- **Audit log** — `candidate_report_exported` row written with `filename` + `size_bytes` + `exported_at` only. No card contents, no absolute path.
- **`tmp/exports/` already in `.gitignore`** — the existing `tmp/` rule covers it.

## Files changed / new

| File | Change |
|---|---|
| `services/phase1_candidate_service.js` | New `exportCandidateReportHtml()` + helpers (`sanitizeFilenameComponent`, `buildExportFilename`, `escapeHtmlStrict`, `safeJsonForScript`, `sanitizeCardForExport`, `renderStaticReportHtml`). Exported via `module.exports`. |
| `routes/phase1_admin_routes.js` | New `POST /candidates/:base_key/export-html` + `GET /exports/:filename/download` routes. Download route uses `path.basename()` + resolved-path-inside-`tmp/exports/` guard. |
| `scripts/export_candidate_report_html.js` | **New.** CLI wrapper. `--base-key` + `--confirm` required; `--out` optional (must be inside `tmp/`). |
| `scripts/test_export_candidate_report_html.js` | **New.** 9 mock-based tests covering filename sanitization, HTML escaping, JSON embedding, card sanitization, rendered-HTML redaction, XSS payloads, `</script>` injection, path traversal. |
| `PATCH_REPORT_STATIC_HTML_EXPORT_V1.md` | **New.** This file. |

## Not changed (per spec)

- Scoring logic, master prompt, importer, purge logic, DB schema, viewer auth, candidate picker, `report-v1.html` (the live report is untouched — this PR adds a parallel export path).

## Checks run

```
node --check server.js                                    # OK
node --check routes/phase1_admin_routes.js                # OK
node --check services/phase1_candidate_service.js         # OK
node --check scripts/export_candidate_report_html.js      # OK
node --check scripts/test_export_candidate_report_html.js # OK
node scripts/test_export_candidate_report_html.js         # 9/9 PASS
node scripts/test_rubric_scoring.js                       # 24/24 (no scoring changes)
```

### Mock-based unit tests (`scripts/test_export_candidate_report_html.js`)

better-sqlite3 is not installed in this environment, so the test extracts the pure helpers via vm sandboxing. 9 tests pass:

1. **sanitizeFilenameComponent** — 11 cases: Cyrillic, path separators, traversal payloads, control chars, empty/null/undefined, whitespace collapse.
2. **buildExportFilename** — produces `<Name>_report_<YYYY-MM-DD>.html`, no colons, no slashes.
3. **escapeHtmlStrict** — 8 cases: `<script>`, quotes, apostrophes, `&`, XSS payloads, null/undefined/number.
4. **safeJsonForScript** — `</script>` inside transcript is escaped; round-trip via `JSON.parse` preserves the payload.
5. **sanitizeCardForExport** — strips `base_key`, `id`, `keys`, `source_links`, `import_summary`, `has_legacy_ai_profile`; keeps `scores`, `manual_inputs`.
6. **renderStaticReportHtml** — rendered HTML has no `base_key`, `session_key`, `admin_key`, `viewer_key`, `X-Admin-Key`, `/home/`, `/etc/`, absolute repo root, `fetch(`, `XMLHttpRequest`. Has `full_name`, `direction`, "Отчёт выгружен:".
7. **XSS in user fields** — `<script>alert("xss")</script>` in `full_name` + `"><img src=x onerror=alert(1)>` in `direction` are escaped; raw payloads absent, escaped form present.
8. **`</script>` in transcript** — JSON block contains `\u003c` (escaped `<`), not raw `</script>`. `<script>` tag count ≤ 3.
9. **filename from malicious `full_name`** — `'../../../etc/passwd'` → safe filename, no `..`, no `/`, no `\`, ends with `.html`.

## Manual smoke (for reviewer on prod-VPS)

1. **Export via CLI:**
   ```bash
   node scripts/export_candidate_report_html.js --base-key GTRAIN02 --confirm GTRAIN02
   # expected: OK: report exported, filename + path + size printed, exit 0
   ```

2. **Open the HTML locally:**
   - Open the generated file in a browser via `file://`.
   - Report renders: hero with ФИО + direction · segment, export timestamp, tabs work.
   - DevTools → Network: **zero requests** to any server.

3. **Grep for sensitive data:**
   ```bash
   FILE=tmp/exports/*_report_*.html
   grep -nE 'GTRAIN0[0-9]|base_key|session_key|admin_key|viewer_key|X-Admin-Key|/home/|/etc/passwd' $FILE
   # expected: no matches (exit 1)
   ```

4. **Grep for fetch / XMLHttpRequest:**
   ```bash
   grep -nE 'fetch\(|XMLHttpRequest|new WebSocket' $FILE
   # expected: no matches
   ```

5. **XSS sanity:** manually edit a candidate's `full_name` in the DB to `<script>alert(1)</script>`, re-export, open the HTML — the script must NOT execute (it should be visible as escaped text).

6. **`</script>` injection:** manually put `</script><script>alert('pwned')</script>` into a `manual_inputs.payload.transcript`, re-export, open — the `alert('pwned')` must NOT execute.

7. **Export via API:**
   ```bash
   curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
     -d '{"confirm_base_key":"GTRAIN02"}' \
     http://localhost:8020/api/admin/phase1/candidates/GTRAIN02/export-html
   # expected: {"ok":true,"file":{"filename":"...","path":"tmp/exports/...","size_bytes":...}}
   ```

8. **Download via API:**
   ```bash
   curl -s -H "X-Admin-Key: $ADMIN_KEY" -OJ \
     http://localhost:8020/api/admin/phase1/exports/<filename>/download
   # expected: file downloaded with the right filename
   ```

9. **Negative — confirm mismatch:**
   ```bash
   node scripts/export_candidate_report_html.js --base-key GTRAIN02 --confirm WRONG
   # expected: FAIL: --confirm (WRONG) must equal --base-key (GTRAIN02). Exit 3.
   ```

10. **Negative — candidate not found:**
    ```bash
    node scripts/export_candidate_report_html.js --base-key NOPE9999 --confirm NOPE9999
    # expected: FAIL: candidate_not_found:NOPE9999. Exit 2.
    ```

11. **Negative — download path traversal:**
    ```bash
    curl -s -H "X-Admin-Key: $ADMIN_KEY" \
      http://localhost:8020/api/admin/phase1/exports/..%2F..%2Fetc%2Fpasswd/download
    # expected: 400 invalid_filename
    ```

## Rollback

Delivered as a branch/PR; rollback = revert the merge commit or `git checkout main -- <file>` per changed file. New `scripts/export_candidate_report_html.js`, `scripts/test_export_candidate_report_html.js`, and `PATCH_REPORT_STATIC_HTML_EXPORT_V1.md` can be deleted outright. Exported HTML files in `tmp/exports/` are already gitignored.
