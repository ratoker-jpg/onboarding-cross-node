const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPhase1Config } = require('../lib/phase1_config');
const { getPhase1Db, getPhase1DbStatus } = require('../lib/phase1_db');
const { createCandidatesRepo } = require('../repositories/phase1_candidates_repo');
const { createKeysRepo } = require('../repositories/phase1_keys_repo');
const { createManualInputsRepo } = require('../repositories/phase1_manual_inputs_repo');
const { createCandidateFilesRepo } = require('../repositories/phase1_candidate_files_repo');
const { createAiProfileRepo } = require('../repositories/phase1_ai_profile_repo');
const { createSourceLinksRepo } = require('../repositories/phase1_source_links_repo');
const { createImportRunsRepo } = require('../repositories/phase1_import_runs_repo');
const { createQuestionBanksRepo } = require('../repositories/phase1_question_banks_repo');
const { createSnapshotsRepo } = require('../repositories/phase1_snapshots_repo');
const { buildNextBaseKey, normalizeKeyInput } = require('./phase1_key_service');
const {
  buildDedupKey,
  readImmersionImport,
  readInterviewQuestionBank,
  readManualQuestionBank,
  readTrainingBotImport,
  readWebMvpImport,
  toJson,
} = require('./phase1_google_sheets_import_service');

const ALLOWED_MANUAL_SECTIONS = new Set([
  'interview_transcript',
  'interview',
  'real_calls',
  'phone_metrics',
  'operations',
  'ops_xsales',
  'ops_overdue_goals',
  'ops_statuses',
  'ops_comments',
  'calls_start',
  'calls_middle',
  'calls_final',
  'final_test',
  'trainer_comment',
]);

const ALLOWED_FILE_SECTIONS = new Set([
  'interview',
  'phone_metrics',
  'ops_xsales',
  'ops_overdue_goals',
  'ops_statuses',
  'ops_comments',
  'calls_start',
  'calls_middle',
  'calls_final',
  'final_test',
  'teachbase_report',
  'other',
]);

const COMPLETENESS_ITEMS = [
  { code: 'interview_transcript', title: 'Собеседование', type: 'manual_file', manual: ['interview', 'interview_transcript'], files: ['interview'] },
  { code: 'test_day_snapshot', title: 'Тестовый день', type: 'import', snapshot: 'test_day_snapshot' },
  { code: 'immersion_snapshot', title: 'Погружение', type: 'import', snapshot: 'immersion_snapshot' },
  { code: 'training_bot_dialogs', title: 'Бот учебки', type: 'import', list: 'training_bot_dialogs' },
  { code: 'phone_metrics', title: 'Время на трубке', type: 'manual_file', manual: ['phone_metrics'], files: ['phone_metrics'] },
  { code: 'ops_xsales', title: 'Операционка: XSales', type: 'manual_file', manual: ['ops_xsales'], files: ['ops_xsales'] },
  { code: 'ops_overdue_goals', title: 'Операционка: просрочки', type: 'manual_file', manual: ['ops_overdue_goals'], files: ['ops_overdue_goals'] },
  { code: 'ops_statuses', title: 'Операционка: статусы', type: 'manual_file', manual: ['ops_statuses'], files: ['ops_statuses'] },
  { code: 'ops_comments', title: 'Операционка: комментарии', type: 'manual_file', manual: ['ops_comments'], files: ['ops_comments'] },
  { code: 'calls_start', title: 'Звонки начала', type: 'manual_file', manual: ['calls_start'], files: ['calls_start'] },
  { code: 'calls_middle', title: 'Звонки середины', type: 'manual_file', manual: ['calls_middle'], files: ['calls_middle'] },
  { code: 'calls_final', title: 'Звонки выпуска', type: 'manual_file', manual: ['calls_final'], files: ['calls_final'] },
  { code: 'final_test', title: 'Выпускной тест', type: 'manual_file', manual: ['final_test'], files: ['final_test', 'teachbase_report'] },
];

const SOURCE_NAMES = {
  web_mvp: 'Web MVP',
  onboarding_route: 'Маршрут новичка',
  bot_training: 'Бот учебки',
  crosses_selection: 'Кроссы подбор / собесы',
  automanual: 'Автомануал',
};

function hashAdminKey(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function assertEnabled() {
  const config = getPhase1Config();
  if (!config.enabled) {
    const error = new Error('phase1_admin_disabled');
    error.code = 'PHASE1_ADMIN_DISABLED';
    throw error;
  }
  return config;
}

function ensureDb() {
  assertEnabled();
  return getPhase1Db();
}

function buildRepos(db) {
  return {
    candidatesRepo: createCandidatesRepo(db),
    keysRepo: createKeysRepo(db),
    manualInputsRepo: createManualInputsRepo(db),
    candidateFilesRepo: createCandidateFilesRepo(db),
    aiProfileRepo: createAiProfileRepo(db),
    sourceLinksRepo: createSourceLinksRepo(db),
    importRunsRepo: createImportRunsRepo(db),
    questionBanksRepo: createQuestionBanksRepo(db),
    snapshotsRepo: createSnapshotsRepo(db),
  };
}

function appendAuditLog(db, adminKey, action, entityType, entityId, baseKey, payload) {
  db.prepare(`
    INSERT INTO audit_log (
      actor_type, actor_key_hash, action, entity_type, entity_id, base_key, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'admin',
    hashAdminKey(adminKey),
    action,
    entityType,
    entityId == null ? null : String(entityId),
    baseKey || null,
    payload ? JSON.stringify(payload) : null,
    nowIso()
  );
}

function createError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function getCandidateOrThrow(repos, baseKey) {
  const candidate = repos.candidatesRepo.findByBaseKey(baseKey);
  if (!candidate) throw createError('CANDIDATE_NOT_FOUND', 'candidate_not_found');
  return candidate;
}

function insertLegacyTargets(db, candidateId, baseKey, insertedKeys) {
  const insertStmt = db.prepare(`
    INSERT INTO legacy_targets_map (
      candidate_id, candidate_key_id, base_key, session_key, legacy_target, payload_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = nowIso();
  for (const key of insertedKeys) {
    insertStmt.run(
      candidateId,
      key.id,
      baseKey,
      key.session_key,
      key.legacy_target || null,
      JSON.stringify({
        key_type: key.key_type,
        product_code: key.product_code,
        team_id: key.team_id,
        team_name: key.team_name,
      }),
      'planned',
      now,
      now
    );
  }
}

function validateSegment(config, sellerSegment) {
  if (!config.allowedSegments.includes(sellerSegment)) {
    throw createError('INVALID_SELLER_SEGMENT', 'invalid_seller_segment');
  }
}

function manualExists(manualInputs, sections) {
  return manualInputs.some(item => sections.includes(item.section));
}

function fileExists(files, sections) {
  return files.some(item => sections.includes(item.section));
}

function buildCompleteness(candidate, repos) {
  const manualInputs = repos.manualInputsRepo.listByCandidateId(candidate.id);
  const files = repos.candidateFilesRepo.listByCandidateId(candidate.id);
  const testDaySnapshot = repos.snapshotsRepo.getTestDayByCandidateId(candidate.id);
  const immersionSnapshot = repos.snapshotsRepo.getImmersionByCandidateId(candidate.id);
  const trainingBotDialogs = repos.snapshotsRepo.listTrainingBotDialogsByCandidateId(candidate.id);

  const items = COMPLETENESS_ITEMS.map(item => {
    let status = 'missing';
    let source = item.type;
    if (item.snapshot === 'test_day_snapshot') {
      status = testDaySnapshot ? 'ready' : 'not_imported';
      source = 'import:web_mvp';
    } else if (item.snapshot === 'immersion_snapshot') {
      status = immersionSnapshot ? 'ready' : 'not_imported';
      source = 'import:onboarding_route';
    } else if (item.list === 'training_bot_dialogs') {
      status = trainingBotDialogs.length ? 'ready' : 'not_imported';
      source = 'import:bot_training';
    } else {
      const hasManual = manualExists(manualInputs, item.manual || []);
      const hasFile = fileExists(files, item.files || []);
      const hasLegacyOperations = item.code.startsWith('ops_') && manualExists(manualInputs, ['operations']);
      status = hasManual || hasFile || hasLegacyOperations ? 'ready' : 'missing';
      source = [hasManual ? 'manual' : null, hasFile ? 'file' : null, hasLegacyOperations ? 'manual:operations' : null]
        .filter(Boolean)
        .join('+') || 'manual_file';
    }
    return { code: item.code, title: item.title, status, source };
  });

  const completedCount = items.filter(item => item.status === 'ready').length;
  return {
    ok: true,
    base_key: candidate.base_key,
    completed_count: completedCount,
    total_count: items.length,
    status: completedCount === items.length ? 'ready' : completedCount > 0 ? 'partial' : 'missing',
    items,
  };
}

function formatCandidateResponse(candidate, repos) {
  return {
    candidate,
    keys: repos.keysRepo.listByBaseKey(candidate.base_key),
    source_links: repos.sourceLinksRepo.listByCandidateId(candidate.id),
    manual_inputs: repos.manualInputsRepo.listByCandidateId(candidate.id),
    files: repos.candidateFilesRepo.listByCandidateId(candidate.id),
    completeness: buildCompleteness(candidate, repos),
    ai_profile: repos.aiProfileRepo.getByCandidateId(candidate.id),
    test_day_snapshot: repos.snapshotsRepo.getTestDayByCandidateId(candidate.id),
    immersion_snapshot: repos.snapshotsRepo.getImmersionByCandidateId(candidate.id),
    training_bot_dialogs: repos.snapshotsRepo.listTrainingBotDialogsByCandidateId(candidate.id),
    import_summary: repos.importRunsRepo.listByBaseKey(candidate.base_key),
  };
}

function createCandidateWithKeys(payload, adminKey) {
  const config = assertEnabled();
  validateSegment(config, String(payload.seller_segment || '').trim());
  const db = ensureDb();
  const repos = buildRepos(db);
  const tx = db.transaction(() => {
    const lastBaseKey = repos.candidatesRepo.getLastBaseKey();
    const baseKey = buildNextBaseKey(lastBaseKey, config.baseKeyPrefix);
    const now = nowIso();
    const candidate = repos.candidatesRepo.insert({
      base_key: baseKey,
      last_name: String(payload.last_name || '').trim(),
      first_name: String(payload.first_name || '').trim(),
      full_name: `${String(payload.last_name || '').trim()} ${String(payload.first_name || '').trim()}`.trim(),
      seller_segment: String(payload.seller_segment || '').trim(),
      direction: String(payload.direction || '').trim(),
      mentor: payload.mentor ? String(payload.mentor).trim() : null,
      recruiter: payload.recruiter ? String(payload.recruiter).trim() : null,
      test_day_started_at: payload.test_day_started_at ? String(payload.test_day_started_at).trim() : null,
      immersion_started_at: payload.immersion_started_at ? String(payload.immersion_started_at).trim() : null,
      status: String(payload.status || 'draft').trim() || 'draft',
      created_at: now,
      updated_at: now,
    });
    const keyRows = Array.isArray(payload.keys)
      ? payload.keys.map(keyInput => normalizeKeyInput(baseKey, candidate.id, keyInput, repos.keysRepo))
      : [];
    const insertedKeys = repos.keysRepo.insertMany(keyRows);
    insertLegacyTargets(db, candidate.id, baseKey, insertedKeys);
    appendAuditLog(db, adminKey, 'phase1_candidate_created', 'candidate', candidate.id, candidate.base_key, {
      candidate,
      keys: insertedKeys,
    });
    return { candidate, keys: insertedKeys };
  });
  return tx();
}

function addKeysToCandidate(baseKey, keys, adminKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const tx = db.transaction(() => {
    const candidate = getCandidateOrThrow(repos, baseKey);
    const keyRows = (Array.isArray(keys) ? keys : []).map(keyInput => normalizeKeyInput(baseKey, candidate.id, keyInput, repos.keysRepo));
    const insertedKeys = repos.keysRepo.insertMany(keyRows);
    insertLegacyTargets(db, candidate.id, baseKey, insertedKeys);
    appendAuditLog(db, adminKey, 'phase1_keys_created', 'candidate', candidate.id, candidate.base_key, insertedKeys);
    return insertedKeys;
  });
  return tx();
}

function saveManualInput(baseKey, section, payload, adminKey) {
  if (!ALLOWED_MANUAL_SECTIONS.has(section)) {
    throw createError('INVALID_MANUAL_INPUT_SECTION', 'invalid_manual_input_section');
  }
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const now = nowIso();
  const manualInput = repos.manualInputsRepo.upsert({
    candidate_id: candidate.id,
    base_key: baseKey,
    section,
    payload_json: JSON.stringify(payload || {}),
    created_at: now,
    updated_at: now,
  });
  appendAuditLog(db, adminKey, 'phase1_manual_input_saved', 'candidate', candidate.id, candidate.base_key, { section });
  return manualInput;
}

function safeFileName(value) {
  const raw = String(value || 'upload.bin').trim() || 'upload.bin';
  const base = raw.replace(/[\\/]/g, '_').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return base.replace(/^\.+/, '') || 'upload.bin';
}

function stripDataUrl(value) {
  const raw = String(value || '');
  const marker = 'base64,';
  const index = raw.indexOf(marker);
  return index >= 0 ? raw.slice(index + marker.length) : raw;
}

function isTextUpload(payload, originalName) {
  const mime = String(payload.mime_type || '').toLowerCase();
  return mime.startsWith('text/') || /\.txt$/i.test(originalName || '') || payload.text_content !== undefined;
}

function saveCandidateFile(baseKey, payload, adminKey) {
  const section = String(payload.section || '').trim();
  if (!ALLOWED_FILE_SECTIONS.has(section)) {
    throw createError('INVALID_FILE_SECTION', 'invalid_file_section');
  }
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const originalName = safeFileName(payload.original_name || payload.file_name || `${section}.txt`);
  const uploadDir = path.join(process.cwd(), 'data', 'uploads', 'phase1', candidate.base_key);
  fs.mkdirSync(uploadDir, { recursive: true });

  let bytes;
  let textContent = payload.text_content == null ? null : String(payload.text_content);
  if (payload.content_base64) {
    bytes = Buffer.from(stripDataUrl(payload.content_base64), 'base64');
    if (textContent == null && isTextUpload(payload, originalName)) textContent = bytes.toString('utf8');
  } else if (textContent != null) {
    bytes = Buffer.from(textContent, 'utf8');
  } else {
    throw createError('INVALID_FILE_PAYLOAD', 'file_content_required');
  }

  const now = nowIso();
  const storedName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${originalName}`;
  const storedAbsPath = path.join(uploadDir, storedName);
  fs.writeFileSync(storedAbsPath, bytes);
  const storedPath = path.join('data', 'uploads', 'phase1', candidate.base_key, storedName).replace(/\\/g, '/');

  const file = repos.candidateFilesRepo.create({
    candidate_id: candidate.id,
    base_key: candidate.base_key,
    section,
    file_type: payload.file_type ? String(payload.file_type).trim() : null,
    original_name: originalName,
    stored_path: storedPath,
    mime_type: payload.mime_type ? String(payload.mime_type).trim() : null,
    size_bytes: bytes.length,
    text_content: textContent,
    comment: payload.comment ? String(payload.comment).trim() : null,
    created_at: now,
    updated_at: now,
  });
  appendAuditLog(db, adminKey, 'phase1_candidate_file_uploaded', 'candidate', candidate.id, candidate.base_key, {
    id: file.id,
    section: file.section,
    original_name: file.original_name,
    stored_path: file.stored_path,
  });
  return file;
}

function saveAiProfile(baseKey, payload, adminKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const now = nowIso();
  const aiProfile = repos.aiProfileRepo.upsert({
    candidate_id: candidate.id,
    base_key: baseKey,
    hard_score: payload.hard_score ?? null,
    soft_score: payload.soft_score ?? null,
    learning_score: payload.learning_score ?? null,
    discipline_score: payload.discipline_score ?? null,
    call_quality_score: payload.call_quality_score ?? null,
    risk_level: payload.risk_level || null,
    final_status: payload.final_status || null,
    strengths_json: JSON.stringify(Array.isArray(payload.strengths) ? payload.strengths : []),
    growth_zones_json: JSON.stringify(Array.isArray(payload.growth_zones) ? payload.growth_zones : []),
    risks_json: JSON.stringify(Array.isArray(payload.risks) ? payload.risks : []),
    recommendations_json: JSON.stringify(Array.isArray(payload.recommendations) ? payload.recommendations : []),
    summary_text: payload.summary_text || payload.summary || null,
    raw_payload_json: JSON.stringify(payload || {}),
    created_at: now,
    updated_at: now,
  });
  appendAuditLog(db, adminKey, 'phase1_ai_profile_saved', 'candidate', candidate.id, candidate.base_key, { base_key: baseKey });
  return aiProfile;
}

function upsertSourceLink(baseKey, payload, adminKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const sourceCode = String(payload.source_code || '').trim();
  if (!sourceCode) throw createError('INVALID_SOURCE_CODE', 'invalid_source_code');
  const config = getPhase1Config();
  const sourceDefinition = config.sources[sourceCode];
  if (!sourceDefinition) throw createError('INVALID_SOURCE_CODE', 'invalid_source_code');
  const now = nowIso();
  const sourceLink = repos.sourceLinksRepo.upsert({
    candidate_id: candidate.id,
    base_key: baseKey,
    source_code: sourceCode,
    source_name: String(payload.source_name || sourceDefinition.source_name || SOURCE_NAMES[sourceCode] || sourceCode),
    legacy_key: payload.legacy_key ? String(payload.legacy_key).trim() : null,
    legacy_id: payload.legacy_id ? String(payload.legacy_id).trim() : null,
    comment: payload.comment ? String(payload.comment).trim() : null,
    created_at: now,
    updated_at: now,
  });
  appendAuditLog(db, adminKey, 'phase1_source_link_upserted', 'candidate', candidate.id, candidate.base_key, sourceLink);
  return sourceLink;
}

function listSourceLinks(baseKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  return repos.sourceLinksRepo.listByCandidateId(candidate.id);
}

function getCandidateCard(baseKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = repos.candidatesRepo.findByBaseKey(baseKey);
  if (!candidate) return null;
  return formatCandidateResponse(candidate, repos);
}

function getCompleteness(baseKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  return buildCompleteness(candidate, repos);
}

function listCandidates() {
  const db = ensureDb();
  const repos = buildRepos(db);
  return repos.candidatesRepo.listCandidates().map(candidate => ({
    ...candidate,
    keys_count: repos.keysRepo.listByCandidateId(candidate.id).length,
    source_links_count: repos.sourceLinksRepo.listByCandidateId(candidate.id).length,
  }));
}

function getDashboardMvp() {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidates = repos.candidatesRepo.listCandidates();
  const byStatus = {};
  const byRisk = {};
  const scoreTotals = {
    hard_score: 0,
    soft_score: 0,
    learning_score: 0,
    discipline_score: 0,
    call_quality_score: 0,
  };
  let scoreCount = 0;

  const cardRows = candidates.map(candidate => {
    byStatus[candidate.status] = (byStatus[candidate.status] || 0) + 1;
    const aiProfile = repos.aiProfileRepo.getByCandidateId(candidate.id);
    const riskLevel = aiProfile && aiProfile.risk_level ? aiProfile.risk_level : 'unknown';
    byRisk[riskLevel] = (byRisk[riskLevel] || 0) + 1;
    if (aiProfile) {
      scoreTotals.hard_score += Number(aiProfile.hard_score || 0);
      scoreTotals.soft_score += Number(aiProfile.soft_score || 0);
      scoreTotals.learning_score += Number(aiProfile.learning_score || 0);
      scoreTotals.discipline_score += Number(aiProfile.discipline_score || 0);
      scoreTotals.call_quality_score += Number(aiProfile.call_quality_score || 0);
      scoreCount += 1;
    }
    return {
      base_key: candidate.base_key,
      full_name: candidate.full_name,
      seller_segment: candidate.seller_segment,
      direction: candidate.direction,
      status: candidate.status,
      risk_level: riskLevel,
      created_at: candidate.created_at,
    };
  });

  return {
    ok: true,
    total_candidates: candidates.length,
    by_status: byStatus,
    by_risk: byRisk,
    avg_scores: {
      hard_score: scoreCount ? scoreTotals.hard_score / scoreCount : 0,
      soft_score: scoreCount ? scoreTotals.soft_score / scoreCount : 0,
      learning_score: scoreCount ? scoreTotals.learning_score / scoreCount : 0,
      discipline_score: scoreCount ? scoreTotals.discipline_score / scoreCount : 0,
      call_quality_score: scoreCount ? scoreTotals.call_quality_score / scoreCount : 0,
    },
    candidates: cardRows,
  };
}

function getPhase1Health() {
  const config = getPhase1Config();
  const dbStatus = getPhase1DbStatus();
  return {
    ok: dbStatus.ok,
    feature_enabled: config.enabled,
    db_path: dbStatus.dbPath,
    sqlite_dependency: dbStatus.dependency,
    sqlite_ready: dbStatus.ok,
    configured_sources: Object.values(config.sources).map(source => ({
      source_code: source.source_code,
      configured: Boolean(source.spreadsheetId),
    })),
    error: dbStatus.ok ? null : dbStatus.error,
  };
}

function createImportRun(baseKey, sourceCode, repos) {
  return repos.importRunsRepo.create({
    base_key: baseKey,
    source_code: sourceCode,
    status: 'running',
    rows_read: 0,
    rows_saved: 0,
    error_text: null,
    started_at: nowIso(),
    finished_at: null,
  });
}

function finalizeImportRun(importRunsRepo, runId, patch) {
  return importRunsRepo.update(runId, {
    status: patch.status,
    rows_read: patch.rows_read || 0,
    rows_saved: patch.rows_saved || 0,
    error_text: patch.error_text || null,
    finished_at: nowIso(),
  });
}

async function importWithRun(baseKey, sourceCode, adminKey, worker) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const run = createImportRun(baseKey, sourceCode, repos);
  try {
    const summary = await worker({ db, repos, candidate, run });
    const finalStatus = ['success', 'success_with_warnings', 'no_matching_rows'].includes(summary.status)
      ? summary.status
      : 'success';
    const finishedRun = finalizeImportRun(repos.importRunsRepo, run.id, {
      status: finalStatus,
      rows_read: summary.rows_read,
      rows_saved: summary.rows_saved,
      error_text: summary.warnings && summary.warnings.length ? summary.warnings.join('; ') : null,
    });
    appendAuditLog(db, adminKey, 'phase1_import_success', 'candidate', candidate.id, candidate.base_key, finishedRun);
    return { ok: true, ...summary, import_run: finishedRun };
  } catch (err) {
    const finishedRun = finalizeImportRun(repos.importRunsRepo, run.id, {
      status: 'failed',
      rows_read: 0,
      rows_saved: 0,
      error_text: err.message || String(err),
    });
    appendAuditLog(db, adminKey, 'phase1_import_failed', 'candidate', candidate.id, candidate.base_key, finishedRun);
    err.import_run = finishedRun;
    if (!err.source) err.source = sourceCode;
    if (!err.source_code) err.source_code = sourceCode;
    throw err;
  }
}

async function importTestDay(baseKey, adminKey) {
  return importWithRun(baseKey, 'web_mvp', adminKey, async ({ repos, candidate }) => {
    const sourceLink = repos.sourceLinksRepo.findByCandidateAndSource(candidate.id, 'web_mvp');
    if (!sourceLink || !sourceLink.legacy_key) throw createError('SOURCE_LINK_NOT_FOUND', 'source_link_not_found:web_mvp');
    const imported = await readWebMvpImport(sourceLink.legacy_key);
    const now = nowIso();
    const snapshot = repos.snapshotsRepo.upsertTestDay({
      candidate_id: candidate.id,
      base_key: candidate.base_key,
      test_day_key: sourceLink.legacy_key,
      scores_json: toJson(imported.build_row),
      open_answers_json: toJson(imported.candidate_row),
      voice_result_json: toJson(imported.voice_bot_row),
      summary: imported.build_row ? JSON.stringify(imported.build_row) : null,
      raw_payload_json: toJson({
        source: 'web_mvp',
        legacy_key: sourceLink.legacy_key,
        candidate_row: imported.candidate_row,
        build_row: imported.build_row,
        voice_bot_row: imported.voice_bot_row,
        imported_at: now,
      }),
      source: 'web_mvp',
      legacy_key: sourceLink.legacy_key,
      candidate_row_json: toJson(imported.candidate_row),
      build_row_json: toJson(imported.build_row),
      voice_bot_row_json: toJson(imported.voice_bot_row),
      imported_at: now,
      created_at: now,
      updated_at: now,
    });
    return {
      source: 'web_mvp',
      status: 'success',
      rows_read: imported.rows_read,
      rows_saved: snapshot ? 1 : 0,
      ranges_used: imported.ranges_used,
    };
  });
}

async function importImmersion(baseKey, adminKey) {
  return importWithRun(baseKey, 'onboarding_route', adminKey, async ({ repos, candidate }) => {
    const sourceLink = repos.sourceLinksRepo.findByCandidateAndSource(candidate.id, 'onboarding_route');
    if (!sourceLink || !sourceLink.legacy_key) throw createError('SOURCE_LINK_NOT_FOUND', 'source_link_not_found:onboarding_route');
    const imported = await readImmersionImport(sourceLink.legacy_key);
    const currentDay = imported.newbie_row ? Number(imported.newbie_row['текущий_день'] || imported.newbie_row.current_day || 0) : null;
    const now = nowIso();
    const snapshot = repos.snapshotsRepo.upsertImmersion({
      candidate_id: candidate.id,
      base_key: candidate.base_key,
      current_day: Number.isFinite(currentDay) ? currentDay : null,
      days_completed: imported.progress_rows.length,
      blocks_completed_percent: null,
      materials_opened_percent: null,
      help_requests_count: imported.help_requests.length,
      delays_count: null,
      immersion_status: imported.newbie_row ? String(imported.newbie_row['статус'] || imported.newbie_row.status || '') : null,
      raw_payload_json: toJson({
        source: 'onboarding_route',
        legacy_key: sourceLink.legacy_key,
        newbie_row: imported.newbie_row,
        progress_rows: imported.progress_rows,
        tracking_rows: imported.tracking_rows,
        material_sessions: imported.material_sessions,
        summary_row: imported.summary_row,
        help_requests: imported.help_requests,
        imported_at: now,
      }),
      source: 'onboarding_route',
      legacy_key: sourceLink.legacy_key,
      newbie_row_json: toJson(imported.newbie_row),
      progress_rows_json: toJson(imported.progress_rows),
      tracking_rows_json: toJson(imported.tracking_rows),
      material_sessions_json: toJson(imported.material_sessions),
      summary_row_json: toJson(imported.summary_row),
      help_requests_json: toJson(imported.help_requests),
      imported_at: now,
      created_at: now,
      updated_at: now,
    });
    return {
      source: 'onboarding_route',
      status: 'success',
      rows_read: imported.rows_read,
      rows_saved: snapshot ? 1 : 0,
      ranges_used: imported.ranges_used,
    };
  });
}

async function importTrainingBot(baseKey, adminKey) {
  return importWithRun(baseKey, 'bot_training', adminKey, async ({ db, repos, candidate }) => {
    const sourceLink = repos.sourceLinksRepo.findByCandidateAndSource(candidate.id, 'bot_training');
    if (!sourceLink || !sourceLink.legacy_key) throw createError('SOURCE_LINK_NOT_FOUND', 'source_link_not_found:bot_training');

    const imported = await readTrainingBotImport(sourceLink.legacy_key);
    db.prepare(`
      DELETE FROM training_bot_dialogs
      WHERE candidate_id = ?
        AND base_key = ?
        AND COALESCE(legacy_key, '') <> ?
    `).run(candidate.id, candidate.base_key, sourceLink.legacy_key);

    let rowsSaved = 0;
    const warnings = Array.isArray(imported.warnings) ? imported.warnings.slice() : [];

    for (const item of imported.dialogs) {
      const rolePayload = item.role_profile || item.role_row || {};
      const resultPayload = item.result_payload || item.result_row || null;
      const resultText = item.result_text || (resultPayload && (resultPayload.summary || resultPayload.total_score || resultPayload.feedback)) || null;
      const importedAt = nowIso();
      const dedupKey = buildDedupKey([
        candidate.base_key,
        sourceLink.legacy_key,
        item.external_key || sourceLink.legacy_key,
        item.role_id || '',
        item.dialog_date || '',
        item.transcript_text || resultText || '',
      ]);

      repos.snapshotsRepo.upsertTrainingBotDialog({
        candidate_id: candidate.id,
        base_key: candidate.base_key,
        training_key: sourceLink.legacy_key,
        legacy_key: item.external_key || sourceLink.legacy_key,
        team_id: item.team_id || rolePayload.team_id || rolePayload['ID команды'] || null,
        team_name: item.team_name || rolePayload.team_name || rolePayload['Команда'] || null,
        role_id: item.role_id || rolePayload.role_id || rolePayload['ID роли'] || null,
        role_client: rolePayload.client || rolePayload.client_name || rolePayload['ФИО'] || null,
        role_business: rolePayload.business || rolePayload['Род деятельности'] || null,
        role_title: item.role_text || rolePayload.title || rolePayload['Должность'] || null,
        role_company: rolePayload.company || rolePayload['Название компании'] || null,
        role_client_name: rolePayload.client_name || rolePayload.client || rolePayload['ФИО'] || null,
        role_tax_system: rolePayload.tax_system || rolePayload['СНО'] || null,
        role_business_type: rolePayload.organization_form || rolePayload.business_type || rolePayload['Форма организации'] || null,
        role_success_criteria: rolePayload.success_criteria || rolePayload['Критерий успеха'] || null,
        role_failure_criteria: rolePayload.failure_criteria || rolePayload['Критерий провала'] || null,
        role_target_action: rolePayload.target_action || rolePayload['Целевое действие'] || null,
        role_objections: rolePayload.objections || rolePayload['Возражения'] || null,
        role_tone: rolePayload.tone || rolePayload['Тон'] || null,
        role_extra_profile: JSON.stringify(rolePayload),
        dialog_date: item.dialog_date || null,
        result: resultText,
        transcript_text: item.transcript_text || null,
        role_profile_json: JSON.stringify(rolePayload),
        analysis_json: JSON.stringify({}),
        result_payload_json: JSON.stringify(resultPayload),
        source_payload_json: JSON.stringify({
          external_key: item.external_key || sourceLink.legacy_key,
          key_row: item.key_row || null,
          result_row: item.result_row || null,
          transcript_row: item.transcript_row || null,
        }),
        dedup_key: dedupKey,
        imported_at: importedAt,
        created_at: importedAt,
        updated_at: importedAt,
      });
      rowsSaved += 1;
    }

    if (!rowsSaved) {
      warnings.push(`no_matching_training_bot_rows:${sourceLink.legacy_key}`);
    }

    return {
      source: 'bot_training',
      status: rowsSaved ? (warnings.length ? 'success_with_warnings' : 'success') : 'no_matching_rows',
      warnings,
      rows_read: imported.rows_read,
      rows_saved: rowsSaved,
      ranges_used: imported.ranges_used,
      legacy_key: sourceLink.legacy_key,
    };
  });
}

async function importInterviewQuestions(baseKey, adminKey) {
  return importWithRun(baseKey, 'crosses_selection', adminKey, async ({ repos }) => {
    const imported = await readInterviewQuestionBank();
    let rowsSaved = 0;
    for (const row of imported.rows) {
      repos.questionBanksRepo.upsertInterview({
        source_sheet: row.source_sheet,
        block: row.block || null,
        question_text: row.question_text || null,
        model_instruction: row.model_instruction || null,
        risk_type: row.risk_type || null,
        version: row.version || null,
        active: 1,
        raw_payload_json: JSON.stringify(row.raw_payload || {}),
        dedup_key: buildDedupKey([
          row.source_sheet,
          row.question_text || '',
          row.block || '',
          JSON.stringify(row.raw_payload || {}),
        ]),
        imported_at: nowIso(),
        updated_at: nowIso(),
      });
      rowsSaved += 1;
    }
    return {
      source: 'crosses_selection',
      status: imported.warnings && imported.warnings.length ? 'success_with_warnings' : 'success',
      warnings: imported.warnings || [],
      rows_read: imported.rows_read,
      rows_saved: rowsSaved,
      ranges_used: imported.ranges_used,
    };
  });
}

async function importManualQuestions(baseKey, adminKey) {
  return importWithRun(baseKey, 'automanual', adminKey, async ({ repos }) => {
    const imported = await readManualQuestionBank();
    let rowsSaved = 0;
    for (const row of imported.rows) {
      repos.questionBanksRepo.upsertManual({
        source_sheet: row.source_sheet,
        block: row.block,
        question_text: row.question_text,
        model_instruction: row.model_instruction,
        risk_type: row.risk_type,
        version: row.version,
        active: 1,
        raw_payload_json: JSON.stringify(row.raw_payload || {}),
        dedup_key: buildDedupKey([row.source_sheet, row.block, row.question_text]),
        imported_at: nowIso(),
        updated_at: nowIso(),
      });
      rowsSaved += 1;
    }
    return {
      source: 'automanual',
      status: 'success',
      rows_read: imported.rows_read,
      rows_saved: rowsSaved,
      ranges_used: imported.ranges_used,
    };
  });
}

async function importAll(baseKey, adminKey) {
  return {
    ok: true,
    base_key: baseKey,
    imports: {
      test_day: await importTestDay(baseKey, adminKey),
      immersion: await importImmersion(baseKey, adminKey),
      training_bot: await importTrainingBot(baseKey, adminKey),
      interview_questions: await importInterviewQuestions(baseKey, adminKey),
      manual_questions: await importManualQuestions(baseKey, adminKey),
    },
  };
}

function getImportSummary(baseKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  getCandidateOrThrow(repos, baseKey);
  return repos.importRunsRepo.listByBaseKey(baseKey);
}

module.exports = {
  addKeysToCandidate,
  assertEnabled,
  createCandidateWithKeys,
  getCandidateCard,
  getCompleteness,
  getDashboardMvp,
  getImportSummary,
  getPhase1Health,
  importAll,
  importImmersion,
  importInterviewQuestions,
  importManualQuestions,
  importTestDay,
  importTrainingBot,
  listCandidates,
  listSourceLinks,
  saveAiProfile,
  saveCandidateFile,
  saveManualInput,
  upsertSourceLink,
};
