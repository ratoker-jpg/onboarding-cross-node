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
const { createCandidateScoresRepo } = require('../repositories/phase1_candidate_scores_repo');
const { createAnalysisRunsRepo } = require('../repositories/phase1_analysis_runs_repo');
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
    candidateScoresRepo: createCandidateScoresRepo(db),
    analysisRunsRepo: createAnalysisRunsRepo(db),
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

// ============================================================
// Phase 3B-min: manual candidate scores + read-only viewer
// ============================================================

const SCORE_FIELDS = [
  'hard_score',
  'soft_score',
  'learning_score',
  'discipline_score',
  'call_quality_score',
  'ops_score',
  'final_test_score',
  'risk_score',
];

const SCORE_WEIGHTS = {
  hard_score: 0.25,
  soft_score: 0.15,
  learning_score: 0.15,
  discipline_score: 0.15,
  call_quality_score: 0.20,
  final_test_score: 0.10,
};

const STATUS_RANK = {
  insufficient_data: 0,
  not_recommended: 1,
  needs_practice: 2,
  ready_with_control: 3,
  ready: 4,
};

const STATUS_LABEL_RU = {
  ready: 'готов к выпуску',
  ready_with_control: 'готов с контролем',
  needs_practice: 'нужна доработка',
  not_recommended: 'не рекомендован',
  insufficient_data: 'недостаточно данных',
};

const RISK_LEVEL_LABEL_RU = {
  low: 'низкий',
  medium: 'средний',
  high: 'высокий',
  critical: 'критичный',
};

function normalizeScoreInput(payload) {
  const out = {};
  for (const field of SCORE_FIELDS) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      out[field] = null;
      continue;
    }
    const num = Number(payload[field]);
    if (!Number.isFinite(num)) {
      const error = new Error(`invalid_score:${field}`);
      error.code = 'INVALID_SCORE_VALUE';
      error.field = field;
      throw error;
    }
    if (num < 0 || num > 100) {
      const error = new Error(`score_out_of_range:${field}`);
      error.code = 'INVALID_SCORE_RANGE';
      error.field = field;
      throw error;
    }
    out[field] = num;
  }
  return out;
}

function riskLevelFromScore(riskScore) {
  if (riskScore == null) return null;
  if (riskScore <= 25) return 'low';
  if (riskScore <= 55) return 'medium';
  if (riskScore <= 75) return 'high';
  return 'critical';
}

function computeOverallScore(scores) {
  let total = 0;
  let weightSum = 0;
  for (const [field, weight] of Object.entries(SCORE_WEIGHTS)) {
    const value = scores[field];
    if (value != null) {
      total += value * weight;
      weightSum += weight;
    }
  }
  if (weightSum === 0) return null;
  return Math.round(total / weightSum);
}

function detectHasCallsData(candidate, repos) {
  const completeness = buildCompleteness(candidate, repos);
  const callsItems = (completeness.items || []).filter(item =>
    item.code === 'calls_start' || item.code === 'calls_middle' || item.code === 'calls_final'
  );
  return callsItems.some(item => item.status === 'ready');
}

// Когда тренер оставил статус пустым — сервер выводит его сам по scores.
// Возвращает базовый статус ДО применения ограничителей.
function inferBaseFinalStatus(scores, overallScore, riskLevel, hasCallsData) {
  if (scores.hard_score == null || scores.soft_score == null) return 'insufficient_data';
  if (scores.hard_score < 50) return 'needs_practice';
  if (scores.soft_score < 50) return 'needs_practice';
  if (overallScore == null) return 'insufficient_data';
  if (overallScore >= 76 && riskLevel === 'low' && hasCallsData) return 'ready';
  if (overallScore >= 61) return 'ready_with_control';
  return 'needs_practice';
}

function applyStatusLimiters(proposedStatus, scores, hasCallsData) {
  // not_recommended — тренерский вето. Сервер его не понижает, только повышает,
  // если есть явные критичные ошибки.
  let status = proposedStatus || 'insufficient_data';
  const rank = STATUS_RANK[status] != null ? STATUS_RANK[status] : 0;

  // Ограничители из 11_EVALUATION_RUBRICS_BY_STAGE_V1.md §12
  // Порядок: от самых жёстких (needs_practice) к мягким (ready_with_control)
  if (scores.hard_score == null || scores.soft_score == null) {
    return 'insufficient_data';
  }
  // Если тренер явно сказал not_recommended — оставляем как есть,
  // сервер не "улучшает" вето тренера.
  if (status === 'not_recommended') return status;

  if (scores.hard_score != null && scores.hard_score < 50) {
    if (rank > STATUS_RANK.needs_practice) return 'needs_practice';
  }
  if (scores.discipline_score != null && scores.discipline_score < 50) {
    if (rank > STATUS_RANK.ready_with_control) return 'ready_with_control';
  }
  if (scores.risk_score != null && scores.risk_score >= 76) {
    if (rank > STATUS_RANK.ready_with_control) return 'ready_with_control';
  }
  if (!hasCallsData) {
    if (rank > STATUS_RANK.ready_with_control) return 'ready_with_control';
  }
  return status;
}

function buildScoreBreakdown(scores, riskLevel, finalStatus, overallScore) {
  const breakdown = {};
  for (const field of SCORE_FIELDS) {
    const value = scores[field];
    let level = null;
    if (value != null) {
      if (field === 'risk_score') {
        level = riskLevelFromScore(value);
      } else if (value <= 20) level = 'critical_fail';
      else if (value <= 40) level = 'weak';
      else if (value <= 60) level = 'basic_unstable';
      else if (value <= 75) level = 'working_minimum';
      else if (value <= 89) level = 'strong';
      else level = 'excellent';
    }
    breakdown[field] = { value, level };
  }
  breakdown.overall_score = { value: overallScore };
  breakdown.risk_level = { value: riskLevel };
  breakdown.final_status = { value: finalStatus };
  return breakdown;
}

function normalizeStringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value).split(/\r?\n/).map(v => v.trim()).filter(Boolean);
}

function saveCandidateScores(baseKey, payload, adminKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const scores = normalizeScoreInput(payload || {});
  const now = nowIso();

  // overall_score считаем на сервере, не доверяем клиенту
  const overallScore = computeOverallScore(scores);
  const riskLevel = riskLevelFromScore(scores.risk_score);
  const hasCallsData = detectHasCallsData(candidate, repos);

  // final_status: если тренер явно выбрал статус — берём его (с ограничителями).
  // Если пусто — сервер выводит статус сам по scores.
  const requestedStatus = String(payload.final_status || '').trim() || null;
  const baseStatus = requestedStatus || inferBaseFinalStatus(scores, overallScore, riskLevel, hasCallsData);
  const finalStatus = applyStatusLimiters(baseStatus, scores, hasCallsData);

  const recommendation = payload.recommendation ? String(payload.recommendation).trim() : null;
  const strengths = normalizeStringList(payload.strengths);
  const growthZones = normalizeStringList(payload.growth_zones);
  const redFlags = normalizeStringList(payload.red_flags);
  const coachRecommendations = normalizeStringList(payload.coach_recommendations);

  const inputPayload = {
    requested_scores: scores,
    requested_final_status: requestedStatus,
    recommendation,
    strengths,
    growth_zones: growthZones,
    red_flags: redFlags,
    coach_recommendations: coachRecommendations,
  };

  const analysisRun = repos.analysisRunsRepo.create({
    candidate_id: candidate.id,
    base_key: baseKey,
    analysis_type: 'overall',
    source: 'manual',
    status: 'running',
    input_payload_json: JSON.stringify(inputPayload),
    output_payload_json: null,
    error_text: null,
    created_at: now,
    finished_at: null,
  });

  const outputPayload = {
    scores,
    overall_score: overallScore,
    risk_level: riskLevel,
    final_status: finalStatus,
    has_calls_data: hasCallsData,
    recommendation,
    strengths,
    growth_zones: growthZones,
    red_flags: redFlags,
    coach_recommendations: coachRecommendations,
  };

  const breakdown = buildScoreBreakdown(scores, riskLevel, finalStatus, overallScore);

  const saved = repos.candidateScoresRepo.upsert({
    candidate_id: candidate.id,
    base_key: baseKey,
    hard_score: scores.hard_score,
    soft_score: scores.soft_score,
    learning_score: scores.learning_score,
    discipline_score: scores.discipline_score,
    call_quality_score: scores.call_quality_score,
    ops_score: scores.ops_score,
    final_test_score: scores.final_test_score,
    risk_score: scores.risk_score,
    overall_score: overallScore,
    risk_level: riskLevel,
    final_status: finalStatus,
    recommendation,
    source: 'manual',
    analysis_run_id: analysisRun.id,
    score_breakdown_json: JSON.stringify(breakdown),
    strengths_json: JSON.stringify(strengths),
    growth_zones_json: JSON.stringify(growthZones),
    red_flags_json: JSON.stringify(redFlags),
    coach_recommendations_json: JSON.stringify(coachRecommendations),
    has_calls_data: hasCallsData ? 1 : 0,
    created_at: now,
    updated_at: now,
  });

  repos.analysisRunsRepo.update({
    id: analysisRun.id,
    status: 'success',
    output_payload_json: JSON.stringify(outputPayload),
    error_text: null,
    finished_at: now,
  });

  appendAuditLog(db, adminKey, 'phase1_candidate_scores_saved', 'candidate', candidate.id, baseKey, {
    overall_score: overallScore,
    final_status: finalStatus,
    risk_level: riskLevel,
  });

  return saved;
}

function getCandidateScores(baseKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  return repos.candidateScoresRepo.getByCandidateId(candidate.id);
}

function recalculateCandidateScores(baseKey, adminKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const existing = repos.candidateScoresRepo.getByCandidateId(candidate.id);
  if (!existing) {
    const error = new Error('scores_not_found');
    error.code = 'SCORES_NOT_FOUND';
    throw error;
  }
  const now = nowIso();
  const scores = {};
  for (const field of SCORE_FIELDS) scores[field] = existing[field];

  const overallScore = computeOverallScore(scores);
  const riskLevel = riskLevelFromScore(scores.risk_score);
  const hasCallsData = detectHasCallsData(candidate, repos);

  // existing.final_status мог быть сохранён как inferred (когда тренер оставил пусто).
  // На recalc мы не знаем, что было тренерское вето, а что inferred — поэтому если
  // existing.final_status !== 'not_recommended', пересчитываем inferred заново.
  let baseStatus;
  if (existing.final_status === 'not_recommended') {
    baseStatus = 'not_recommended';
  } else {
    baseStatus = inferBaseFinalStatus(scores, overallScore, riskLevel, hasCallsData);
  }
  const finalStatus = applyStatusLimiters(baseStatus, scores, hasCallsData);

  const breakdown = buildScoreBreakdown(scores, riskLevel, finalStatus, overallScore);

  const analysisRun = repos.analysisRunsRepo.create({
    candidate_id: candidate.id,
    base_key: baseKey,
    analysis_type: 'overall',
    source: 'mixed',
    status: 'success',
    input_payload_json: JSON.stringify({ recalculate: true, from_scores_id: existing.id }),
    output_payload_json: JSON.stringify({
      overall_score: overallScore,
      risk_level: riskLevel,
      final_status: finalStatus,
      has_calls_data: hasCallsData,
    }),
    error_text: null,
    created_at: now,
    finished_at: now,
  });

  const updated = repos.candidateScoresRepo.upsert({
    candidate_id: candidate.id,
    base_key: baseKey,
    hard_score: existing.hard_score,
    soft_score: existing.soft_score,
    learning_score: existing.learning_score,
    discipline_score: existing.discipline_score,
    call_quality_score: existing.call_quality_score,
    ops_score: existing.ops_score,
    final_test_score: existing.final_test_score,
    risk_score: existing.risk_score,
    overall_score: overallScore,
    risk_level: riskLevel,
    final_status: finalStatus,
    recommendation: existing.recommendation,
    source: existing.source,
    analysis_run_id: analysisRun.id,
    score_breakdown_json: JSON.stringify(breakdown),
    strengths_json: JSON.stringify(existing.strengths || []),
    growth_zones_json: JSON.stringify(existing.growth_zones || []),
    red_flags_json: JSON.stringify(existing.red_flags || []),
    coach_recommendations_json: JSON.stringify(existing.coach_recommendations || []),
    has_calls_data: hasCallsData ? 1 : 0,
    created_at: existing.created_at,
    updated_at: now,
  });

  appendAuditLog(db, adminKey, 'phase1_candidate_scores_recalculated', 'candidate', candidate.id, baseKey, {
    overall_score: overallScore,
    final_status: finalStatus,
    risk_level: riskLevel,
  });

  return updated;
}

function getCandidateScoresHistory(baseKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  return repos.analysisRunsRepo.listByBaseKeyType(baseKey, 'overall');
}

function getViewerDashboardSummary() {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidates = repos.candidatesRepo.listCandidates();
  const byStatus = {};
  const byRisk = {};
  const scoreFields = [
    'hard_score',
    'soft_score',
    'learning_score',
    'discipline_score',
    'call_quality_score',
    'ops_score',
    'final_test_score',
    'risk_score',
    'overall_score',
  ];
  const scoreTotals = {};
  const scoreCounts = {};
  for (const field of scoreFields) {
    scoreTotals[field] = 0;
    scoreCounts[field] = 0;
  }
  let candidatesWithScores = 0;

  for (const candidate of candidates) {
    const scores = repos.candidateScoresRepo.getByCandidateId(candidate.id);
    // Summary по статусу берётся из candidate_scores.final_status (а не из candidate.status),
    // чтобы отражать итоговую аналитику, а не черновой статус кандидата.
    const status = scores && scores.final_status ? scores.final_status : (candidate.status || 'unknown');
    byStatus[status] = (byStatus[status] || 0) + 1;
    const riskLevel = scores && scores.risk_level ? scores.risk_level : 'unknown';
    byRisk[riskLevel] = (byRisk[riskLevel] || 0) + 1;
    if (scores) {
      candidatesWithScores += 1;
      for (const field of scoreFields) {
        const value = scores[field];
        if (value != null && Number.isFinite(Number(value))) {
          scoreTotals[field] += Number(value);
          scoreCounts[field] += 1;
        }
      }
    }
  }

  const avgScores = {};
  for (const field of scoreFields) {
    avgScores[field] = scoreCounts[field]
      ? Math.round((scoreTotals[field] / scoreCounts[field]) * 10) / 10
      : null;
  }

  return {
    ok: true,
    total_candidates: candidates.length,
    candidates_with_scores: candidatesWithScores,
    by_status: byStatus,
    by_risk: byRisk,
    avg_scores: avgScores,
  };
}

function getViewerCandidates(filters = {}) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidates = repos.candidatesRepo.listCandidates();
  const segment = String(filters.segment || '').trim();
  const status = String(filters.status || '').trim();
  const riskLevel = String(filters.risk_level || '').trim();

  return candidates
    .map(candidate => {
      const scores = repos.candidateScoresRepo.getByCandidateId(candidate.id);
      const completeness = buildCompleteness(candidate, repos);
      return {
        base_key: candidate.base_key,
        full_name: candidate.full_name,
        seller_segment: candidate.seller_segment,
        direction: candidate.direction,
        status: candidate.status,
        created_at: candidate.created_at,
        updated_at: candidate.updated_at,
        scores: scores || null,
        completeness_summary: {
          completed_count: completeness.completed_count,
          total_count: completeness.total_count,
          status: completeness.status,
        },
      };
    })
    .filter(row => {
      if (segment && row.seller_segment !== segment) return false;
      if (status && (row.scores ? row.scores.final_status : row.status) !== status) return false;
      if (riskLevel && (!row.scores || row.scores.risk_level !== riskLevel)) return false;
      return true;
    });
}

function getViewerCandidateCard(baseKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = repos.candidatesRepo.findByBaseKey(baseKey);
  if (!candidate) return null;
  const completeness = buildCompleteness(candidate, repos);
  const scores = repos.candidateScoresRepo.getByCandidateId(candidate.id);
  const importSummary = repos.importRunsRepo.listByBaseKey(baseKey);
  const manualInputsRaw = repos.manualInputsRepo.listByCandidateId(candidate.id);
  const trainingDialogsRaw = repos.snapshotsRepo.listTrainingBotDialogsByCandidateId(candidate.id);

  // Safe projection of manual inputs for viewer.
  // mapManualInputForViewer returns null for sections outside the whitelist,
  // so we filter those out — otherwise report-v1.html's
  // `manualInputs.find(m => m.section === ...)` could hit a null entry.
  const viewerManualInputs = manualInputsRaw
    .map(mapManualInputForViewer)
    .filter(Boolean);

  // Normalized blocks derived from manual inputs.
  // buildInterviewSummary takes RAW manual inputs (not viewer-projected) so it
  // can read full transcript text before truncation kicks in.
  const callStats = buildCallStats(viewerManualInputs);
  const opsSummary = buildOpsSummary(viewerManualInputs);
  const interviewSummary = buildInterviewSummary(manualInputsRaw);

  // Safe projection of training bot dialogs for viewer.
  // mapTrainingDialogForViewer currently never returns null, but filter(Boolean)
  // keeps the contract robust against future changes.
  const viewerTrainingDialogs = trainingDialogsRaw
    .map(mapTrainingDialogForViewer)
    .filter(Boolean);

  // Phase 3E1: latest Codex analysis runs (interview + calls) for rich report
  const latestAnalysis = buildLatestAnalysis(baseKey, repos.analysisRunsRepo);

  return {
    candidate,
    completeness,
    scores,
    import_summary: importSummary,
    has_legacy_ai_profile: Boolean(repos.aiProfileRepo.getByCandidateId(candidate.id)),
    // Phase 3D1: rich report feeds
    manual_inputs: viewerManualInputs,
    training_bot_dialogs: viewerTrainingDialogs,
    call_stats: callStats,
    ops_summary: opsSummary,
    interview_summary: interviewSummary,
    // Phase 3E1: latest Codex analysis visibility
    latest_analysis: latestAnalysis,
  };
}

function getViewerHealth() {
  const config = getPhase1Config();
  return {
    ok: config.viewerEnabled,
    viewer_enabled: config.viewerEnabled,
    admin_enabled: config.enabled,
  };
}

// ============================================================
// Phase 3D1: viewer card normalizers (private)
// ============================================================

// Sections safe to expose to viewer. Anything outside this set stays in DB.
const VIEWER_MANUAL_SECTIONS = new Set([
  'interview',
  'interview_transcript',
  'phone_metrics',
  'calls_start',
  'calls_middle',
  'calls_final',
  'operations',
  'ops_xsales',
  'ops_overdue_goals',
  'ops_statuses',
  'ops_comments',
  'final_test',
]);

// Cap payload size for viewer to avoid shipping huge transcripts over the wire.
// Larger payloads are truncated to a preview + length metadata.
const VIEWER_PAYLOAD_PREVIEW_LIMIT = 2000;
const VIEWER_INTERVIEW_PREVIEW_LIMIT = 800;

function truncatePayloadForViewer(payload) {
  // Returns { payload, truncated, length } where `payload` is the safe value
  // to ship. Strings longer than the limit are replaced with a preview object.
  if (payload == null) {
    return { payload: null, truncated: false, length: 0 };
  }
  if (typeof payload === 'string') {
    if (payload.length <= VIEWER_PAYLOAD_PREVIEW_LIMIT) {
      return { payload, truncated: false, length: payload.length };
    }
    return {
      payload: {
        preview: payload.slice(0, VIEWER_PAYLOAD_PREVIEW_LIMIT),
        truncated: true,
        length: payload.length,
      },
      truncated: true,
      length: payload.length,
    };
  }
  if (typeof payload === 'object') {
    // For objects we ship as-is, but flag large string fields inside
    // (e.g. transcript text_content) by truncating them in-place on a clone.
    const clone = Array.isArray(payload) ? [...payload] : { ...payload };
    for (const key of Object.keys(clone)) {
      if (typeof clone[key] === 'string' && clone[key].length > VIEWER_PAYLOAD_PREVIEW_LIMIT) {
        const full = clone[key];
        clone[key] = {
          preview: full.slice(0, VIEWER_PAYLOAD_PREVIEW_LIMIT),
          truncated: true,
          length: full.length,
        };
      }
    }
    return { payload: clone, truncated: false, length: JSON.stringify(clone).length };
  }
  return { payload, truncated: false, length: 0 };
}

function mapManualInputForViewer(raw) {
  if (!raw) return null;
  if (!VIEWER_MANUAL_SECTIONS.has(raw.section)) return null;
  const { payload: safePayload } = truncatePayloadForViewer(raw.payload);
  return {
    section: raw.section,
    payload: safePayload,
    updated_at: raw.updated_at || null,
  };
}

function mapTrainingDialogForViewer(raw) {
  if (!raw) return null;
  // Pick only the minimal, non-secret fields needed by report-v1.html.
  // transcript_text is intentionally omitted — too large and not needed for
  // the report card. analysis_json + result_payload are included so the
  // report can render imported bot-training results without falling back to
  // the misleading "аналитика появится в Phase 3C" placeholder.
  return {
    session_key: raw.training_key || null,
    dialog_date: raw.dialog_date || null,
    role_id: raw.role_id || null,
    role_client: raw.role_client || raw.role_client_name || null,
    role_business: raw.role_business || raw.role_company || null,
    product: raw.role_title || null,
    result: raw.result || null,
    analysis_json: raw.analysis_json || null,
    result_payload: raw.result_payload || null,
  };
}

function buildCallStats(manualInputs) {
  const out = {
    talk_time_minutes: null,
    calls_total: null,
    reached_calls: null,
    calls_over_2min: null,
    calls_over_2min_percent: null,
    calls_over_10min: null,
    effective_minutes: null,
    days: [],
  };
  const phoneMetrics = manualInputs.find(m => m && m.section === 'phone_metrics');
  if (!phoneMetrics || !phoneMetrics.payload) return out;
  const p = phoneMetrics.payload;
  const days = Array.isArray(p.days) ? p.days : [];
  if (!days.length) return out;

  let talkTime = 0;
  let callsTotal = 0;
  let reachedCalls = 0;
  let callsOver2min = 0;
  let callsOver10min = 0;
  let effectiveMinutes = 0;

  for (const d of days) {
    const minutes = Number(d.minutes) || 0;
    const callsCount = Number(d.calls_count) || 0;
    const pct = Number(d.calls_over_2min_percent);
    talkTime += minutes;
    callsTotal += callsCount;
    reachedCalls += callsCount; // no separate field; assume calls_count == reached
    effectiveMinutes += minutes; // no separate field; use minutes as proxy

    // Prefer explicit calls_over_2min count field when present; otherwise
    // estimate from calls_count * percent / 100.
    if (typeof d.calls_over_2min === 'number') {
      callsOver2min += d.calls_over_2min;
    } else if (callsCount > 0 && Number.isFinite(pct)) {
      callsOver2min += Math.round((callsCount * pct) / 100);
    }

    if (typeof d.calls_over_10min === 'number') {
      callsOver10min += d.calls_over_10min;
    }
  }

  out.talk_time_minutes = talkTime || null;
  out.calls_total = callsTotal || null;
  out.reached_calls = reachedCalls || null;
  out.calls_over_2min = callsOver2min || null;
  // Weighted percent: total over-2min calls / total calls.
  // This is NOT the average of daily percentages — that would give 50% for
  // a day with 10 calls @ 100% plus a day with 90 calls @ 0%, when the real
  // total is 10/100 = 10%.
  out.calls_over_2min_percent = callsTotal
    ? Math.round((callsOver2min / callsTotal) * 1000) / 10
    : null;
  out.calls_over_10min = callsOver10min || null;
  out.effective_minutes = effectiveMinutes || null;
  out.days = days.map((d, idx) => ({
    day: d.day != null ? d.day : idx + 1,
    minutes: Number(d.minutes) || 0,
    calls_count: Number(d.calls_count) || 0,
    calls_over_2min_percent: Number.isFinite(Number(d.calls_over_2min_percent))
      ? Number(d.calls_over_2min_percent)
      : null,
  }));
  return out;
}

const OPS_SECTION_META = {
  ops_xsales: { code: 'ops_xsales', title: 'XSALES' },
  ops_overdue_goals: { code: 'ops_overdue_goals', title: 'Просрочки клиентских целей' },
  ops_statuses: { code: 'ops_statuses', title: 'Статусы' },
  ops_comments: { code: 'ops_comments', title: 'Комментарии' },
  phone_metrics: { code: 'phone_metrics', title: 'Время на трубке' },
};

function buildOpsSummary(manualInputs) {
  const sections = [];
  for (const [code, meta] of Object.entries(OPS_SECTION_META)) {
    const m = manualInputs.find(x => x && x.section === code);
    const payload = m && m.payload ? m.payload : null;
    const status = payload && payload.status
      ? payload.status
      : (m ? 'not_checked' : 'not_checked');
    const comment = payload && payload.comment ? String(payload.comment) : '';
    sections.push({
      code: meta.code,
      title: meta.title,
      status,
      comment,
      updated_at: m && m.updated_at ? m.updated_at : null,
    });
  }
  return { sections };
}

function buildInterviewSummary(manualInputs) {
  // NOTE: this function expects RAW manual inputs (from repo), not
  // viewer-projected ones. The viewer projection truncates long strings to
  // { preview, truncated, length } objects, which would make `length`
  // incorrect here. Callers must pass `manualInputsRaw`.
  const interviewManual = manualInputs.find(m => m && m.section === 'interview');
  const transcriptManual = manualInputs.find(m => m && m.section === 'interview_transcript');

  const out = {
    has_interview: Boolean(interviewManual),
    has_transcript: Boolean(transcriptManual),
    preview: '',
    length: 0,
    updated_at: null,
  };

  // Extract full text from raw payload. Defensive: if payload is already a
  // truncated preview object (string field replaced with { preview, length }),
  // fall back to its `preview` field so we still return something useful.
  const extractText = (manual) => {
    if (!manual || !manual.payload) return '';
    const p = manual.payload;
    if (typeof p === 'string') return p;
    if (typeof p === 'object') {
      // Direct string fields
      for (const key of ['text_content', 'transcript', 'text', 'comment']) {
        if (typeof p[key] === 'string') return p[key];
        // Maybe already truncated by viewer projection
        if (p[key] && typeof p[key] === 'object' && typeof p[key].preview === 'string') {
          return p[key].preview;
        }
      }
    }
    return '';
  };

  // Prefer transcript section text; fallback to interview section text_content.
  let text = '';
  let updatedAt = null;
  if (transcriptManual) {
    text = extractText(transcriptManual);
    updatedAt = transcriptManual.updated_at || null;
  }
  if (!text && interviewManual) {
    text = extractText(interviewManual);
    updatedAt = updatedAt || interviewManual.updated_at || null;
  }

  if (text) {
    const full = String(text);
    out.length = full.length;
    out.preview = full.length > VIEWER_INTERVIEW_PREVIEW_LIMIT
      ? full.slice(0, VIEWER_INTERVIEW_PREVIEW_LIMIT)
      : full;
    out.updated_at = updatedAt;
  }
  // Raw transcript text is NEVER included in `out` — only `preview` (capped)
  // and `length` (full). Caller must not leak raw text via this summary.
  return out;
}

// ============================================================
// Phase 3D2: admin intake UX/data fix
// ============================================================

// Map admin "import" button → required source_code (for pre-check diagnostics)
const IMPORT_REQUIRED_SOURCE = {
  'test-day': 'web_mvp',
  'immersion': 'onboarding_route',
  'training-bot': 'bot_training',
  'interview-questions': 'crosses_selection',
  'manual-questions': 'automanual',
  'all': null, // 'all' checks each sub-import; treated separately
};

const IMPORT_LABEL_RU = {
  'test-day': 'Импорт тестового дня',
  'immersion': 'Импорт погружения',
  'training-bot': 'Импорт бота учебки',
  'interview-questions': 'Вопросы собеседования',
  'manual-questions': 'Вопросы автомануала',
  'all': 'Импортировать всё',
};

/**
 * Pre-check: does the candidate have the source link required for this import?
 * Returns { ok, has_link, source_code, required_legacy_key_hint, message }.
 * Does NOT throw — caller (admin UI) uses this to render a friendly hint
 * before the user clicks import.
 *
 * For importType='all', checks the three real candidate-level sources:
 * web_mvp, onboarding_route, bot_training. Returns ok=false with a `missing`
 * array if any are absent. interview-questions / manual-questions are NOT
 * checked inside 'all' because importAll does not require them.
 */
function checkImportSourceLink(baseKey, importType) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);

  if (importType === 'all') {
    const subChecks = ['test-day', 'immersion', 'training-bot'].map(t => {
      const requiredSource = IMPORT_REQUIRED_SOURCE[t];
      return { import_type: t, source_code: requiredSource };
    });
    const links = repos.sourceLinksRepo.listByCandidateId(candidate.id);
    const missing = [];
    const foundLinks = [];
    for (const sc of subChecks) {
      const link = links.find(l => l.source_code === sc.source_code);
      if (!link) {
        missing.push({
          import_type: sc.import_type,
          source_code: sc.source_code,
          message: `Нет связи ${sc.source_code} для этого новичка.`,
          required_legacy_key_hint: `Сначала сохраните source link: ${sc.source_code} → legacy key (старый ключ кандидата).`,
        });
      } else {
        foundLinks.push({
          import_type: sc.import_type,
          source_code: sc.source_code,
          legacy_key: link.legacy_key || null,
        });
      }
    }
    if (missing.length > 0) {
      return {
        ok: false,
        import_type: 'all',
        has_link: false,
        missing,
        message: `Не хватает связей для импорта: ${missing.map(m => m.source_code).join(', ')}`,
      };
    }
    return {
      ok: true,
      import_type: 'all',
      has_link: true,
      links: foundLinks,
      message: 'Все необходимые связи найдены (web_mvp, onboarding_route, bot_training).',
    };
  }

  const requiredSource = IMPORT_REQUIRED_SOURCE[importType];
  if (!requiredSource) {
    return {
      ok: true,
      import_type: importType,
      has_link: true,
      source_code: null,
      message: 'Этот импорт не требует явной source link.',
    };
  }
  const links = repos.sourceLinksRepo.listByCandidateId(candidate.id);
  const link = links.find(l => l.source_code === requiredSource);
  if (!link) {
    return {
      ok: false,
      import_type: importType,
      has_link: false,
      source_code: requiredSource,
      required_legacy_key_hint: `Сначала сохраните source link: ${requiredSource} → legacy key (старый ключ кандидата).`,
      message: `Нет связи ${requiredSource} для этого новичка.`,
    };
  }
  return {
    ok: true,
    import_type: importType,
    has_link: true,
    source_code: requiredSource,
    legacy_key: link.legacy_key || null,
    message: `Связь ${requiredSource} найдена (legacy_key: ${link.legacy_key || '—'}).`,
  };
}

/**
 * Build a human-readable summary from an import result.
 * The import service returns { ok, status, source, rows_read, rows_saved, warnings, ... }.
 * We turn that into a short Russian line + keep the raw payload for details.
 */
function buildImportSummary(importType, result) {
  const label = IMPORT_LABEL_RU[importType] || importType;
  const status = result && result.status ? result.status : 'unknown';
  const rowsRead = result && typeof result.rows_read === 'number' ? result.rows_read : 0;
  const rowsSaved = result && typeof result.rows_saved === 'number' ? result.rows_saved : 0;
  const source = result && result.source ? result.source : '';
  const warnings = result && Array.isArray(result.warnings) ? result.warnings : [];

  let headline;
  if (status === 'no_matching_rows' || (status === 'success' && rowsRead === 0)) {
    headline = `${label}: данных не найдено`;
  } else if (status === 'success') {
    headline = `${label}: готово (прочитано ${rowsRead}, сохранено ${rowsSaved})`;
  } else if (status === 'success_with_warnings') {
    headline = `${label}: готово с предупреждениями (прочитано ${rowsRead}, сохранено ${rowsSaved})`;
  } else if (status === 'failed') {
    headline = `${label}: ошибка`;
  } else {
    headline = `${label}: ${status}`;
  }

  const lines = [headline];
  if (source) lines.push(`Источник: ${source}`);
  if (warnings.length) lines.push(`Предупреждения: ${warnings.length === 1 ? warnings[0] : warnings.join('; ')}`);
  return {
    headline,
    lines,
    raw: result,
  };
}

/**
 * Append a single call item to manual_inputs[section].calls[].
 * section is calls_start | calls_middle | calls_final.
 * If the existing payload is in the legacy single-call shape (has `transcript`
 * at top level), it is migrated to the new `calls[]` shape first, then the
 * new item is appended.
 *
 * The call item must be a plain object with at least `transcript` (string).
 * Optional: call_date, product, coach_comment, source, file_id, created_at.
 */
function appendCallToManualInput(baseKey, section, callItem, adminKey) {
  if (!['calls_start', 'calls_middle', 'calls_final'].includes(section)) {
    throw createError('INVALID_MANUAL_INPUT_SECTION', 'invalid_manual_input_section');
  }
  // Guard: do not append a call with empty transcript
  if (!String(callItem.transcript || '').trim()) {
    throw createError('EMPTY_CALL_TRANSCRIPT', 'empty_call_transcript');
  }
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const now = nowIso();

  // Read existing manual_input for this section (if any)
  const existing = repos.manualInputsRepo.listByCandidateId(candidate.id)
    .find(m => m.section === section);
  let calls = [];
  if (existing && existing.payload) {
    const p = existing.payload;
    if (Array.isArray(p.calls)) {
      calls = [...p.calls];
    } else if (p.transcript || p.call_date || p.product || p.coach_comment) {
      // Legacy single-call shape → migrate
      calls = [{
        call_date: p.call_date || null,
        product: p.product || null,
        transcript: p.transcript || '',
        coach_comment: p.coach_comment || '',
        source: 'paste',
        file_id: null,
        created_at: existing.updated_at || existing.created_at || now,
      }];
    }
  }

  // Build new item with sane defaults
  const newItem = {
    call_date: callItem.call_date || null,
    product: callItem.product || null,
    transcript: callItem.transcript || '',
    coach_comment: callItem.coach_comment || '',
    source: callItem.source || 'paste',
    file_id: callItem.file_id || null,
    created_at: callItem.created_at || now,
  };
  calls.push(newItem);

  const payload = { calls, comment: existing && existing.payload && existing.payload.comment ? existing.payload.comment : '' };
  const upserted = repos.manualInputsRepo.upsert({
    candidate_id: candidate.id,
    base_key: baseKey,
    section,
    payload_json: JSON.stringify(payload),
    created_at: existing ? existing.created_at : now,
    updated_at: now,
  });
  appendAuditLog(db, adminKey, 'phase1_call_appended', 'candidate', candidate.id, baseKey, { section, call_index: calls.length - 1 });
  return { manual_input: upserted, calls_count: calls.length, calls };
}

/**
 * Upload a file AND upsert a linked manual_input in one operation.
 * Used for:
 *   - interview TXT upload → file in candidate_files (section=interview) +
 *     text_content in manual_inputs (section=interview_transcript).
 *   - calls TXT upload → file in candidate_files (section=calls_*) +
 *     append transcript to manual_inputs (section=calls_*) calls[].
 *
 * payload.manual_section specifies which manual_input section to upsert.
 * payload.manual_mode = 'replace_text' | 'append_call' | 'none'.
 * payload.call_metadata = { call_date, product, coach_comment } for append_call mode.
 */
function saveCandidateFileWithManualInput(baseKey, payload, adminKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const section = String(payload.section || '').trim();
  if (!ALLOWED_FILE_SECTIONS.has(section)) {
    throw createError('INVALID_FILE_SECTION', 'invalid_file_section');
  }
  const manualSection = String(payload.manual_section || '').trim();
  const manualMode = String(payload.manual_mode || 'none').trim();
  if (manualMode !== 'none' && !ALLOWED_MANUAL_SECTIONS.has(manualSection)) {
    throw createError('INVALID_MANUAL_INPUT_SECTION', 'invalid_manual_input_section');
  }
  if (manualMode === 'append_call' && !['calls_start', 'calls_middle', 'calls_final'].includes(manualSection)) {
    throw createError('INVALID_MANUAL_INPUT_SECTION', 'append_call requires calls_start/middle/final');
  }

  // 1. Save the file (reuses saveCandidateFile logic but inline so we keep
  //    the file_id for the manual_input link).
  const file = saveCandidateFile(baseKey, payload, adminKey);

  // 2. Read text_content from the saved file
  const textContent = file.text_content || '';

  // 3. Upsert manual_input according to mode
  let manualInput = null;
  let callsCount = null;
  if (manualMode === 'replace_text' && manualSection) {
    // interview_transcript: replace text_content, preserve other fields.
    // Allow empty text_content here — the file itself is evidence, and the
    // user may upload a binary file (image, audio) without extractable text.
    const existingManual = repos.manualInputsRepo.listByCandidateId(candidate.id)
      .find(m => m.section === manualSection);
    const existingPayload = existingManual && existingManual.payload ? existingManual.payload : {};
    const newPayload = {
      ...existingPayload,
      text_content: textContent,
      source: 'txt_upload',
      file_id: file.id,
      comment: payload.comment != null ? payload.comment : (existingPayload.comment || ''),
    };
    const now = nowIso();
    manualInput = repos.manualInputsRepo.upsert({
      candidate_id: candidate.id,
      base_key: baseKey,
      section: manualSection,
      payload_json: JSON.stringify(newPayload),
      created_at: existingManual ? existingManual.created_at : now,
      updated_at: now,
    });
    appendAuditLog(db, adminKey, 'phase1_manual_input_saved', 'candidate', candidate.id, baseKey, { section: manualSection, source: 'txt_upload' });
  } else if (manualMode === 'append_call' && manualSection) {
    // Guard: do not append a call with empty transcript (no extractable text)
    if (!textContent.trim()) {
      // File is still saved (above), but no call is appended.
      return {
        file,
        manual_input: null,
        manual_section: null,
        calls_count: null,
        warning: 'Файл сохранён, но текст пустой — звонок не добавлен. Для бинарных файлов используйте обычный файловый upload без append_call.',
      };
    }
    const callItem = {
      call_date: payload.call_date || null,
      product: payload.call_product || null,
      transcript: textContent,
      coach_comment: payload.call_coach_comment || '',
      source: 'txt_upload',
      file_id: file.id,
    };
    const result = appendCallToManualInput(baseKey, manualSection, callItem, adminKey);
    manualInput = result.manual_input;
    callsCount = result.calls_count;
  }

  return {
    file,
    manual_input: manualInput,
    manual_section: manualMode !== 'none' ? manualSection : null,
    calls_count: callsCount,
  };
}

/**
 * Get a unified view of manual_inputs + files for a candidate, grouped by section.
 * Used by admin card to render a clear "what's saved" picture instead of two
 * disconnected raw JSON blocks.
 */
function getCandidateIntakeView(baseKey) {
  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = getCandidateOrThrow(repos, baseKey);
  const manualInputs = repos.manualInputsRepo.listByCandidateId(candidate.id);
  const files = repos.candidateFilesRepo.listByCandidateId(candidate.id);

  // Group by section
  const sections = {};
  const ensure = (section) => {
    if (!sections[section]) {
      sections[section] = { section, manual: null, files: [] };
    }
    return sections[section];
  };

  for (const m of manualInputs) {
    const s = ensure(m.section);
    const p = m.payload || {};
    s.manual = {
      section: m.section,
      updated_at: m.updated_at,
      has_transcript: Boolean(p.text_content || p.transcript || (Array.isArray(p.calls) && p.calls.some(c => c.transcript))),
      has_calls: Array.isArray(p.calls) ? p.calls.length : 0,
      has_status: Boolean(p.status),
      comment: p.comment || '',
      payload_size: JSON.stringify(p).length,
    };
  }
  for (const f of files) {
    const s = ensure(f.section);
    s.files.push({
      id: f.id,
      section: f.section,
      original_name: f.original_name,
      mime_type: f.mime_type,
      size_bytes: f.size_bytes,
      has_text_content: Boolean(f.text_content),
      comment: f.comment || '',
      created_at: f.created_at,
    });
  }

  return {
    base_key: baseKey,
    sections: Object.values(sections).sort((a, b) => a.section.localeCompare(b.section)),
    total_manual_inputs: manualInputs.length,
    total_files: files.length,
  };
}

// ============================================================
// Phase 3E1: latest Codex analysis visibility for rich report
// ============================================================

// Cap for any single evidence/quote/source_ref string shipped to viewer.
// Long transcripts / quotes are truncated to keep the card payload small and
// prevent dumping large raw text into the browser.
const VIEWER_EVIDENCE_LIMIT = 500;

function truncateForViewer(value, limit = VIEWER_EVIDENCE_LIMIT) {
  if (value == null) return null;
  const s = String(value);
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `… (+${s.length - limit} симв.)`;
}

/**
 * Safe projection of one analysis_run's output_payload for the viewer card.
 * Returns null if the run is missing, failed, or has no usable output.
 *
 * Shape:
 *   {
 *     id, analysis_type, source, status, created_at, finished_at,
 *     rubric_result: {
 *       rubric_id, rubric_version,
 *       overall_score_percent, overall_confidence, overall_status,
 *       risk_flags: [...], metadata: {...}, units: [...]
 *     },
 *     summary, strengths, growth_zones, coach_recommendations, red_flags
 *   }
 *
 * Safety:
 *   - input_payload is NEVER included (contains question_results with quotes).
 *   - output_payload.rubric_result is included but evidence/quote/source_ref
 *     in each unit's question_details are truncated to VIEWER_EVIDENCE_LIMIT.
 *   - raw bundle is never included.
 *   - unknown top-level keys from Codex are filtered.
 */
function projectAnalysisRunForViewer(run) {
  if (!run) return null;
  if (run.status !== 'success') return null;
  const output = run.output_payload || {};
  const rubricResult = output.rubric_result || {};

  // Truncate evidence fields inside unit question_details
  const units = Array.isArray(rubricResult.units)
    ? rubricResult.units.map(u => ({
        ...u,
        question_details: Array.isArray(u.question_details)
          ? u.question_details.map(qd => ({
              ...qd,
              evidence: truncateForViewer(qd.evidence),
              quote: truncateForViewer(qd.quote),
              source_ref: truncateForViewer(qd.source_ref, 120),
            }))
          : [],
      }))
    : [];

  return {
    id: run.id,
    analysis_type: run.analysis_type,
    source: run.source,
    status: run.status,
    created_at: run.created_at,
    finished_at: run.finished_at,
    rubric_result: {
      rubric_id: rubricResult.rubric_id || null,
      rubric_version: rubricResult.rubric_version || null,
      overall_score_percent: rubricResult.overall_score_percent ?? null,
      overall_confidence: rubricResult.overall_confidence || null,
      overall_status: rubricResult.overall_status || null,
      risk_flags: Array.isArray(rubricResult.risk_flags) ? rubricResult.risk_flags : [],
      metadata: rubricResult.metadata && typeof rubricResult.metadata === 'object' ? rubricResult.metadata : {},
      units,
    },
    // Summary + list fields come from the import script's output_payload
    // (saved alongside rubric_result). They are top-level in output_payload.
    summary: typeof output.summary === 'string' ? truncateForViewer(output.summary, 1000) : null,
    strengths: Array.isArray(output.strengths) ? output.strengths : [],
    growth_zones: Array.isArray(output.growth_zones) ? output.growth_zones : [],
    coach_recommendations: Array.isArray(output.coach_recommendations) ? output.coach_recommendations : [],
    red_flags: Array.isArray(output.red_flags) ? output.red_flags : [],
  };
}

/**
 * Build the latest_analysis block for the viewer card.
 * Returns { interview: <projection>|null, calls: <projection>|null }.
 *
 * For each type, picks the most recent successful codex analysis_run.
 */
function buildLatestAnalysis(baseKey, analysisRunsRepo) {
  const types = ['interview', 'calls'];
  const out = { interview: null, calls: null };
  for (const t of types) {
    const runs = analysisRunsRepo.listByBaseKeyType(baseKey, t);
    // Filter to codex + success, then take the most recent (repo already
    // orders by created_at DESC, id DESC).
    const latest = runs.find(r => r.source === 'codex' && r.status === 'success');
    out[t] = projectAnalysisRunForViewer(latest);
  }
  return out;
}

module.exports = {
  addKeysToCandidate,
  appendCallToManualInput,
  assertEnabled,
  buildImportSummary,
  checkImportSourceLink,
  createCandidateWithKeys,
  getCandidateCard,
  getCandidateIntakeView,
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
  saveCandidateFileWithManualInput,
  saveCandidateScores,
  getCandidateScores,
  recalculateCandidateScores,
  getCandidateScoresHistory,
  getViewerDashboardSummary,
  getViewerCandidates,
  getViewerCandidateCard,
  getViewerHealth,
  saveManualInput,
  upsertSourceLink,
  // Phase 3D2 constants exposed for routes
  IMPORT_REQUIRED_SOURCE,
  IMPORT_LABEL_RU,
};
