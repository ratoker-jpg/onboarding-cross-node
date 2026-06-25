#!/usr/bin/env node
/**
 * STATIC-HTML-EXPORT-V1 — unit test for exportCandidateReportHtml + helpers.
 *
 * better-sqlite3 is NOT installed in this environment, so we extract the
 * pure helpers (sanitizeFilenameComponent, escapeHtmlStrict, safeJsonForScript,
 * sanitizeCardForExport, renderStaticReportHtml) via vm sandboxing and
 * exercise them against stub data. We can't test the full exportCandidateReport
 * function (it needs a DB), but we cover the security-critical pieces:
 *
 *   - filename sanitization (path traversal, control chars, empty input)
 *   - HTML escaping (XSS payloads in full_name / direction / etc.)
 *   - safe JSON embedding (</script> inside transcript must not break out)
 *   - card sanitization (base_key / id / keys / source_links stripped)
 *   - rendered HTML does not contain base_key / session_key / server paths
 *
 * Run: node scripts/test_export_candidate_report_html.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const servicePath = path.join(repoRoot, 'services', 'phase1_candidate_service.js');
const src = fs.readFileSync(servicePath, 'utf8');

// Extract the STATIC-HTML-EXPORT-V1 block. It starts at the section comment
// and ends right before `module.exports = {`.
const blockStart = src.indexOf('// STATIC-HTML-EXPORT-V1');
if (blockStart < 0) throw new Error('STATIC-HTML-EXPORT-V1 block not found');
const blockEnd = src.indexOf('module.exports = {', blockStart);
if (blockEnd < 0) throw new Error('module.exports not found after export block');
const block = src.slice(blockStart, blockEnd);

// We need nowIso() (used by exportCandidateReportHtml, but we only test the
// pure helpers here — we stub nowIso so the block can reference it).
const sandbox = {
  module: { exports: {} },
  process: { env: { PHASE1_ADMIN_ENABLED: '1' }, cwd: () => process.cwd() },
  console,
  Date,
  crypto: require('crypto'),
  fs: require('fs'),
  path: require('path'),
  __dirname: path.join(repoRoot, 'services'),
  // stubs for functions the block references but we don't test:
  nowIso: () => '2026-06-25T12:00:00.000Z',
  getViewerCandidateCard: () => null,
  ensureDb: () => { throw new Error('DB not available in unit test'); },
  appendAuditLog: () => {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(block + '\nmodule.exports = { sanitizeFilenameComponent, escapeHtmlStrict, safeJsonForScript, sanitizeCardForExport, renderStaticReportHtml, buildExportFilename };', sandbox, {
    filename: 'export_helpers_extract.js',
  });
} catch (err) {
  console.error('Script eval failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}

const {
  sanitizeFilenameComponent,
  escapeHtmlStrict,
  safeJsonForScript,
  sanitizeCardForExport,
  renderStaticReportHtml,
  buildExportFilename,
} = sandbox.module.exports;

// ----------------------------------------------------------------------
// TEST 1: sanitizeFilenameComponent
// ----------------------------------------------------------------------
console.log('TEST 1: sanitizeFilenameComponent');
{
  const cases = [
    ['Иванов Иван', 'Иванов_Иван'],
    ['Иванов/Иван', 'Иванов_Иван'],
    ['../../../etc/passwd', 'etc_passwd'],
    ['..\\..\\windows\\system32', 'windows_system32'],
    ['file<>:"|?*.html', 'file_.html'],  // illegal chars → underscore, * before .html
    ['', 'candidate'],
    [null, 'candidate'],
    [undefined, 'candidate'],
    ['   ', 'candidate'],
    ['name with  multiple   spaces', 'name_with_multiple_spaces'],
    ['О\'Брайен', 'О\'Брайен'],  // apostrophe kept (legal in filenames)
  ];
  for (const [input, expected] of cases) {
    const got = sanitizeFilenameComponent(input);
    assert.strictEqual(got, expected, `sanitizeFilenameComponent(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
  console.log(`  ✓ ${cases.length} cases pass`);
}

// ----------------------------------------------------------------------
// TEST 2: buildExportFilename
// ----------------------------------------------------------------------
console.log('TEST 2: buildExportFilename');
{
  const candidate = { full_name: 'Иванов Иван' };
  const fn = buildExportFilename(candidate, '2026-06-25T12:00:00.000Z');
  assert.strictEqual(fn, 'Иванов_Иван_report_2026-06-25.html', `got: ${fn}`);
  // No base_key, no colons (illegal on Windows), no path separators.
  assert.ok(!fn.includes(':'), 'filename must not contain colons');
  assert.ok(!fn.includes('/'), 'filename must not contain slashes');
  assert.ok(!fn.includes('\\'), 'filename must not contain backslashes');
  console.log(`  ✓ filename: ${fn}`);
}

// ----------------------------------------------------------------------
// TEST 3: escapeHtmlStrict — XSS payloads
// ----------------------------------------------------------------------
console.log('TEST 3: escapeHtmlStrict');
{
  const cases = [
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['"quote"', '&quot;quote&quot;'],
    ["'apostrophe'", '&#39;apostrophe&#39;'],
    ['a & b', 'a &amp; b'],
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    [null, ''],
    [undefined, ''],
    [42, '42'],
  ];
  for (const [input, expected] of cases) {
    const got = escapeHtmlStrict(input);
    assert.strictEqual(got, expected, `escapeHtmlStrict(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
  console.log(`  ✓ ${cases.length} cases pass`);
}

// ----------------------------------------------------------------------
// TEST 4: safeJsonForScript — </script> must not break out
// ----------------------------------------------------------------------
console.log('TEST 4: safeJsonForScript');
{
  // A transcript containing </script> would close the script tag early
  // if naively embedded. safeJsonForScript must escape < so the browser
  // sees the literal as text, not as a tag.
  const payload = { transcript: 'call started </script><script>alert(1)</script>' };
  const encoded = safeJsonForScript(payload);
  assert.ok(!encoded.includes('</script>'), 'encoded JSON must not contain literal </script>');
  assert.ok(!encoded.includes('<script'), 'encoded JSON must not contain literal <script');
  // The encoded string must still round-trip via JSON.parse after un-escaping.
  // (The browser does this automatically when reading textContent of a JSON
  // script tag; here we simulate by reversing the \u003c escape.)
  const decoded = encoded.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&');
  const parsed = JSON.parse(decoded);
  assert.strictEqual(parsed.transcript, payload.transcript, 'round-trip must preserve the transcript');
  console.log('  ✓ </script> escaped, round-trip preserves payload');
}

// ----------------------------------------------------------------------
// TEST 5: sanitizeCardForExport — strips base_key / id / keys / source_links
// ----------------------------------------------------------------------
console.log('TEST 5: sanitizeCardForExport strips sensitive fields');
{
  const card = {
    candidate: {
      id: 42,
      base_key: 'GTRAIN02',
      full_name: 'Иванов Иван',
      seller_segment: 'S',
      direction: 'Грузоперевозки',
      mentor: 'Петрова',
      recruiter: 'Калинкина',
      status: 'in_progress',
      test_day_started_at: '2026-06-12T10:00:00Z',
      immersion_started_at: '2026-06-15T10:00:00Z',
    },
    keys: [{ session_key: 'SECRET_SESSION_KEY_123', key_type: 'main' }],
    source_links: [{ source_code: 'bot_training', legacy_key: 'SECRET_LEGACY_KEY' }],
    import_summary: [{ source_code: 'web_mvp', legacy_key: 'abc' }],
    has_legacy_ai_profile: true,
    scores: { overall_score: 78, recommendation: 'Готов к выпуску' },
    manual_inputs: [],
    training_bot_dialogs: [],
    files: [],
    latest_analysis: null,
    completeness: { items: [] },
  };
  const safe = sanitizeCardForExport(card);
  // candidate must keep human fields but NOT base_key / id.
  assert.strictEqual(safe.candidate.full_name, 'Иванов Иван');
  assert.strictEqual(safe.candidate.seller_segment, 'S');
  assert.strictEqual(safe.candidate.direction, 'Грузоперевозки');
  assert.ok(safe.candidate.base_key === undefined, 'base_key must be stripped');
  assert.ok(safe.candidate.id === undefined, 'id must be stripped');
  // No keys / source_links / import_summary / has_legacy_ai_profile.
  assert.ok(safe.keys === undefined, 'keys must be stripped');
  assert.ok(safe.source_links === undefined, 'source_links must be stripped');
  assert.ok(safe.import_summary === undefined, 'import_summary must be stripped');
  assert.ok(safe.has_legacy_ai_profile === undefined, 'has_legacy_ai_profile must be stripped');
  // Scores / manual_inputs kept.
  assert.strictEqual(safe.scores.overall_score, 78);
  console.log('  ✓ base_key / id / keys / source_links / import_summary stripped');
}

// ----------------------------------------------------------------------
// TEST 6: renderStaticReportHtml — no base_key / session_key / server paths
// ----------------------------------------------------------------------
console.log('TEST 6: renderStaticReportHtml — no sensitive data in HTML');
{
  const card = {
    candidate: {
      id: 42,
      base_key: 'GTRAIN02',
      full_name: 'Иванов Иван',
      seller_segment: 'S',
      direction: 'Грузоперевозки',
      mentor: 'Петрова',
      recruiter: 'Калинкина',
      status: 'in_progress',
      immersion_started_at: '2026-06-15T10:00:00Z',
    },
    keys: [{ session_key: 'SECRET_SESSION_KEY_123' }],
    source_links: [{ legacy_key: 'SECRET_LEGACY_KEY' }],
    import_summary: [{ legacy_key: 'abc' }],
    scores: { overall_score: 78, recommendation: 'Готов', strengths: ['Хорошо ведёт звонок'] },
    manual_inputs: [{ section: 'calls_start', payload: { transcript: 'call text here' } }],
    training_bot_dialogs: [{ role_client: 'Клиент', dialog_date: '2026-06-10', result: 'SUCCESS' }],
    files: [],
    latest_analysis: null,
    completeness: { items: [{ code: 'interview', title: 'Собеседование', status: 'ready' }] },
  };
  const html = renderStaticReportHtml(card, '2026-06-25T12:00:00.000Z');

  // Must contain expected user-facing fields.
  assert.ok(html.includes('Иванов Иван'), 'HTML must contain full_name');
  assert.ok(html.includes('Грузоперевозки'), 'HTML must contain direction');
  assert.ok(html.includes('Отчёт выгружен:'), 'HTML must contain export timestamp label');

  // Must NOT contain sensitive data.
  assert.ok(!html.includes('GTRAIN02'), 'HTML must not contain base_key');
  assert.ok(!html.includes('SECRET_SESSION_KEY_123'), 'HTML must not contain session_key');
  assert.ok(!html.includes('SECRET_LEGACY_KEY'), 'HTML must not contain legacy_key');
  assert.ok(!html.includes('base_key'), 'HTML must not contain the literal "base_key"');
  assert.ok(!html.includes('session_key'), 'HTML must not contain "session_key"');
  assert.ok(!html.includes('admin_key'), 'HTML must not contain "admin_key"');
  assert.ok(!html.includes('X-Admin-Key'), 'HTML must not contain "X-Admin-Key"');
  assert.ok(!html.includes('viewer_key'), 'HTML must not contain "viewer_key"');

  // Must NOT contain absolute server paths.
  const repoRootAbs = path.resolve(__dirname, '..');
  assert.ok(!html.includes(repoRootAbs), 'HTML must not contain absolute repo root');
  assert.ok(!html.includes('/home/'), 'HTML must not contain /home/');
  assert.ok(!html.includes('/etc/'), 'HTML must not contain /etc/');

  // Must NOT contain fetch() — the file is self-contained.
  assert.ok(!html.includes('fetch('), 'HTML must not contain fetch()');
  assert.ok(!html.includes('XMLHttpRequest'), 'HTML must not contain XMLHttpRequest');

  // Must contain the embedded JSON (escaped).
  assert.ok(html.includes('<script type="application/json" id="card-data">'), 'HTML must embed JSON in a script tag');
  // The embedded JSON must not contain raw </script>.
  const jsonBlockMatch = html.match(/<script type="application\/json" id="card-data">([\s\S]*?)<\/script>/);
  assert.ok(jsonBlockMatch, 'JSON script block must be present');
  const jsonContent = jsonBlockMatch[1];
  assert.ok(!jsonContent.includes('</script>'), 'embedded JSON must not contain literal </script>');
  console.log('  ✓ no base_key / session_key / server paths / fetch in HTML');
}

// ----------------------------------------------------------------------
// TEST 7: XSS in full_name / direction must be escaped
// ----------------------------------------------------------------------
console.log('TEST 7: XSS payloads in user fields are escaped');
{
  const card = {
    candidate: {
      base_key: 'XSS01',
      full_name: '<script>alert("xss")</script>',
      direction: '"><img src=x onerror=alert(1)>',
      seller_segment: "'; DROP TABLE candidates; --",
    },
    scores: {},
    manual_inputs: [],
    training_bot_dialogs: [],
    files: [],
    latest_analysis: null,
    completeness: { items: [] },
  };
  const html = renderStaticReportHtml(card, '2026-06-25T12:00:00.000Z');
  // The raw XSS payload must NOT appear in the HTML.
  assert.ok(!html.includes('<script>alert("xss")</script>'), 'XSS payload in full_name must be escaped');
  assert.ok(!html.includes('"><img src=x onerror=alert(1)>'), 'XSS payload in direction must be escaped');
  // The escaped version MUST appear.
  assert.ok(html.includes('&lt;script&gt;'), 'escaped full_name must be present');
  console.log('  ✓ XSS payloads escaped');
}

// ----------------------------------------------------------------------
// TEST 8: </script> inside transcript must not break the JSON block
// ----------------------------------------------------------------------
console.log('TEST 8: </script> in transcript does not break HTML');
{
  const card = {
    candidate: { base_key: 'TRAV01', full_name: 'Test', direction: 'D', seller_segment: 'S' },
    scores: {},
    manual_inputs: [{
      section: 'calls_start',
      payload: { transcript: 'caller said </script><script>alert("pwned")</script> and hung up' },
    }],
    training_bot_dialogs: [],
    files: [],
    latest_analysis: null,
    completeness: { items: [] },
  };
  const html = renderStaticReportHtml(card, '2026-06-25T12:00:00.000Z');
  // The JSON script block must contain the ESCAPED form, not the raw </script>.
  const jsonBlockMatch = html.match(/<script type="application\/json" id="card-data">([\s\S]*?)<\/script>/);
  assert.ok(jsonBlockMatch, 'JSON block must be present');
  const jsonContent = jsonBlockMatch[1];
  assert.ok(!jsonContent.includes('</script>'), 'JSON block must not contain raw </script>');
  assert.ok(jsonContent.includes('\\u003c'), 'JSON block must contain escaped < (\\u003c)');
  // The malicious <script> from the transcript must not appear as a real tag
  // outside of the JSON block. Count <script> tags: should be exactly 2
  // (the JSON block open + the tab-switching script open) + 2 closes = 4 total.
  const scriptTagCount = (html.match(/<script/g) || []).length;
  assert.ok(scriptTagCount <= 3, `unexpected <script tag count: ${scriptTagCount} (should be ≤3: JSON open + JS open + ... )`);
  console.log('  ✓ </script> in transcript safely escaped');
}

// ----------------------------------------------------------------------
// TEST 9: filename from XSS payload in full_name is safe
// ----------------------------------------------------------------------
console.log('TEST 9: filename from malicious full_name is safe');
{
  const candidate = { full_name: '../../../etc/passwd' };
  const fn = buildExportFilename(candidate, '2026-06-25T12:00:00.000Z');
  assert.ok(!fn.includes('..'), 'filename must not contain ..');
  assert.ok(!fn.includes('/'), 'filename must not contain /');
  assert.ok(!fn.includes('\\'), 'filename must not contain \\');
  assert.ok(fn.endsWith('.html'), 'filename must end with .html');
  console.log(`  ✓ safe filename: ${fn}`);
}

// ----------------------------------------------------------------------
// TEST 10: BLOCKER — nested sensitive fields must NOT leak into rendered HTML.
// This reproduces the server smoke failure where grep found base_key,
// session_key, legacy_key, result_payload.raw, role_portrait.extra_profile,
// files.id/text_content inside the embedded JSON.
// ----------------------------------------------------------------------
console.log('TEST 10: nested sensitive fields do not leak into HTML');
{
  // Build a card that mirrors the real viewer card shape with ALL the
  // sensitive nested fields that were leaking before the fix.
  const card = {
    candidate: {
      id: 42,
      base_key: 'GTRAIN02',
      full_name: 'Иванов Иван',
      seller_segment: 'S',
      direction: 'Грузоперевозки',
      status: 'in_progress',
    },
    completeness: {
      ok: true,
      base_key: 'GTRAIN02',           // LEAK in v1
      completed_count: 5,
      total_count: 10,
      status: 'partial',
      items: [{ code: 'interview', title: 'Собеседование', status: 'ready', source: 'manual' }],
    },
    scores: {
      id: 99,                          // LEAK
      candidate_id: 42,                // LEAK
      base_key: 'GTRAIN02',            // LEAK
      analysis_run_id: 7,              // LEAK
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-25T00:00:00Z',
      overall_score: 78,
      hard_score: 80,
      soft_score: 75,
      learning_score: 90,
      discipline_score: 70,
      call_quality_score: 78,
      risk_score: 30,
      risk_level: 'low',
      final_status: 'ready',
      recommendation: 'Готов',
      strengths: ['Хорошо ведёт звонок'],
      growth_zones: ['Глубже отрабатывать возражения'],
      red_flags: [],
      coach_recommendations: ['Фокус на возражениях'],
      score_breakdown: { id: 99, base_key: 'GTRAIN02', stages: { contact: 80 } },
    },
    manual_inputs: [{
      section: 'calls_start',
      payload: {
        text_content: 'Полный транскрипт звонка — не должен попадать в экспорт целиком. ' + 'x'.repeat(2000),
        comment: 'комментарий тренера',
      },
      updated_at: '2026-06-20T00:00:00Z',
    }],
    training_bot_dialogs: [{
      session_key: 'SECRET_SESSION_KEY_123',      // LEAK
      legacy_key: 'SECRET_LEGACY_KEY',             // LEAK
      dialog_date: '2026-06-10',
      role_id: 'role-42',
      role_client: 'Клиент',
      role_business: 'Бизнес',
      product: 'Зарплатный проект',
      result: 'SUCCESSFUL',
      analysis_json: { raw_codex_result: true },   // LEAK
      result_payload: {                            // LEAK (raw)
        SUCCESSFUL: 5,
        FAILED: 1,
        raw: { sensitive: 'secret rows' },
        BLOCK_1: 80,
      },
      transcript_preview: 'полный транскрипт учебного диалога',  // LEAK
      transcript_text: 'ещё более полный транскрипт',             // LEAK
      role_portrait: {
        team_id: 'team-99',                         // LEAK
        extra_profile: { raw: 'sensitive' },        // LEAK
        success_criteria: 'критерий',
      },
    }],
    files: [{
      id: 55,                                       // LEAK
      section: 'calls_start',
      file_type: 'transcript',
      original_name: 'call.txt',
      mime_type: 'text/plain',
      size_bytes: 12345,
      stored_path: 'data/uploads/phase1/GTRAIN02/file.txt',  // LEAK
      text_content: 'полный текст файла',                     // LEAK
    }],
    latest_analysis: {
      interview: {
        id: 100,                                    // LEAK (if present)
        analysis_type: 'interview',
        summary: 'Уверенное собеседование',
        strengths: ['Чёткая структура'],
        growth_zones: [],
        red_flags: [],
        coach_recommendations: [],
        rubric_result: {
          rubric_id: 'interview_binary_v1',
          rubric_version: '1.0.0',
          overall_score_percent: 85,
          units: [{ id: 200, question_details: [{ evidence: 'raw evidence' }] }],  // LEAK
        },
      },
      calls: null,
      training_agents: null,
      ops: null,
    },
    // dropped wholesale:
    keys: [{ session_key: 'SECRET' }],
    source_links: [{ legacy_key: 'SECRET' }],
    import_summary: [{ legacy_key: 'SECRET' }],
    has_legacy_ai_profile: true,
    call_stats: null,
    ops_summary: null,
    interview_summary: null,
  };

  const html = renderStaticReportHtml(card, '2026-06-25T12:00:00.000Z');

  // The grep the reviewer runs — must find NOTHING.
  const forbidden = [
    'GTRAIN02',
    'base_key',
    'session_key',
    'SECRET_SESSION_KEY_123',
    'SECRET_LEGACY_KEY',
    'legacy_key',
    'candidate_id',
    'analysis_run_id',
    'admin_key',
    'viewer_key',
    'X-Admin-Key',
    '/home/',
    '/etc/passwd',
    'fetch(',
    'XMLHttpRequest',
    'new WebSocket',
    // nested leaks from the card above:
    'raw_codex_result',
    'sensitive',
    'secret rows',
    'полный транскрипт звонка',
    'полный текст файла',
    'data/uploads/phase1',
    'stored_path',
    'text_content',
    'extra_profile',
    'team-99',
    'transcript_preview',
    'transcript_text',
    'role_portrait',
    'analysis_json',
    'result_payload',
  ];

  // The embedded JSON block is the main risk — extract it and check
  // it doesn't contain any forbidden literal.
  const jsonBlockMatch = html.match(/<script type="application\/json" id="card-data">([\s\S]*?)<\/script>/);
  assert.ok(jsonBlockMatch, 'JSON block must be present');
  const jsonContent = jsonBlockMatch[1];

  for (const needle of forbidden) {
    assert.ok(!html.includes(needle),
      `HTML must not contain "${needle}" — found in rendered output`);
    assert.ok(!jsonContent.includes(needle),
      `embedded JSON must not contain "${needle}"`);
  }

  // Positive checks: human-facing fields ARE present.
  assert.ok(html.includes('Иванов Иван'), 'HTML must contain full_name');
  assert.ok(html.includes('Грузоперевозки'), 'HTML must contain direction/segment value');
  assert.ok(html.includes('S'), 'HTML must contain segment/direction value');
  // Hero meta order: segment · direction (per spec requirement 9).
  // With seller_segment='S' and direction='Грузоперевозки', hero shows
  // "S · Грузоперевозки". The reviewer's data has segment='Грузоперевозки'
  // and direction='S', so it shows "Грузоперевозки · S" — matches.
  assert.ok(html.includes('Направление / сегмент:'), 'hero meta label present');

  // Scores are present (human-facing values).
  assert.ok(html.includes('78'), 'overall_score present');
  assert.ok(html.includes('Хорошо ведёт звонок'), 'strengths present');

  // Training dialog safe fields present, unsafe absent.
  assert.ok(html.includes('Клиент'), 'role_client present');
  assert.ok(html.includes('Зарплатный проект'), 'product present');
  assert.ok(html.includes('успешно: 5'), 'result_summary.successful present');

  // Manual input preview present (≤500 chars), full transcript absent.
  assert.ok(html.includes('calls_start'), 'manual_inputs section present');
  assert.ok(html.includes('длина:'), 'manual_inputs length present');
  // The full 2000-char transcript must NOT be in the HTML. The preview is
  // capped at 500 chars, so any run of 600+ identical chars proves the
  // full text leaked.
  assert.ok(!html.includes('x'.repeat(600)),
    'full transcript (600+ char run) must not be in HTML — preview is capped at 500');

  console.log('  ✓ ' + forbidden.length + ' forbidden literals absent from HTML + embedded JSON');
}

// ----------------------------------------------------------------------
// TEST 11: rendered HTML hero shows "Грузоперевозки · S" when data has
// seller_segment='Грузоперевозки' and direction='S' (the reviewer's case).
// ----------------------------------------------------------------------
console.log('TEST 11: hero meta order = segment · direction');
{
  const card = {
    candidate: {
      full_name: 'Test',
      seller_segment: 'Грузоперевозки',
      direction: 'S',
    },
    scores: {},
    manual_inputs: [],
    training_bot_dialogs: [],
    files: [],
    latest_analysis: null,
    completeness: { items: [] },
  };
  const html = renderStaticReportHtml(card, '2026-06-25T12:00:00.000Z');
  assert.ok(html.includes('Направление / сегмент: Грузоперевозки · S'),
    `hero must show "Грузоперевозки · S" (segment · direction), got: ${html.match(/Направление \/ сегмент:[^<]*/)?.[0]}`);
  console.log('  ✓ hero meta: Грузоперевозки · S (segment · direction)');
}

console.log('\nALL TESTS PASSED');
