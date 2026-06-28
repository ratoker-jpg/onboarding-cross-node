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
        // REPORT-CANDIDATE-PICKER-V1: immersion_started_at is the primary
        // date shown in the picker card ("Начало погружения"). test_day_started_at
        // is also returned so the UI can fall back to it ONLY internally for
        // sorting when immersion_started_at is missing — it must never be
        // labelled as "Начало погружения" in the UI (per spec).
        immersion_started_at: candidate.immersion_started_at || null,
        test_day_started_at: candidate.test_day_started_at || null,
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

  // Phase 3E3C fixup: include candidate_files in viewer card so report can
  // detect and render real call transcripts uploaded as files.
  // For calls_start/middle/final: include full text_content (needed by report).
  // For other sections: include metadata only (text_content omitted for size).
  const CALLS_FILE_SECTIONS = new Set(['calls_start', 'calls_middle', 'calls_final']);
  const viewerFiles = repos.candidateFilesRepo.listByCandidateId(candidate.id).map(f => {
    if (CALLS_FILE_SECTIONS.has(f.section)) {
      return {
        id: f.id,
        section: f.section,
        file_type: f.file_type || null,
        original_name: f.original_name || null,
        mime_type: f.mime_type || null,
        size_bytes: f.size_bytes || null,
        text_content: f.text_content || null,
        comment: f.comment || null,
        created_at: f.created_at || null,
      };
    }
    return {
      id: f.id,
      section: f.section,
      file_type: f.file_type || null,
      original_name: f.original_name || null,
      mime_type: f.mime_type || null,
      size_bytes: f.size_bytes || null,
      text_content: null,
      text_content_preview: typeof f.text_content === 'string' && f.text_content.length > 0
        ? f.text_content.slice(0, 500)
        : null,
      comment: f.comment || null,
      created_at: f.created_at || null,
    };
  });

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
    // Phase 3E3C fixup: files for report rendering
    files: viewerFiles,
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
  // Phase 3E2 fixup: include transcript_preview (capped at 30000 chars) so
  // the report can show the dialog text under "Посмотреть диалоги".
  const rolePayload = raw.role_payload || null;
  const TRANSCRIPT_LIMIT = 30000;
  const fullTranscript = typeof raw.transcript_text === 'string' ? raw.transcript_text : '';
  const transcriptTruncated = fullTranscript.length > TRANSCRIPT_LIMIT;
  const transcriptPreview = transcriptTruncated
    ? fullTranscript.slice(0, TRANSCRIPT_LIMIT)
    : fullTranscript;
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
    // Phase 3E2 fixup: transcript preview for report visibility
    transcript_preview: transcriptPreview || null,
    transcript_truncated: transcriptTruncated,
    transcript_length: fullTranscript.length,
    // Phase 3E2: role portrait fields from the dialog row
    role_portrait: {
      role_id: raw.role_id || null,
      team_id: raw.team_id || null,
      team_name: raw.team_name || null,
      company_name: raw.role_company || (rolePayload && rolePayload.company_name) || null,
      full_name: raw.role_client_name || (rolePayload && rolePayload.full_name) || null,
      position: (rolePayload && rolePayload.position) || null,
      tax_system: raw.role_tax_system || (rolePayload && rolePayload.tax_system) || null,
      business_type: raw.role_business_type || (rolePayload && rolePayload.business_type) || null,
      previous_interactions: (rolePayload && rolePayload.previous_interactions) || null,
      client_info: (rolePayload && rolePayload.client_info) || null,
      business_experience: (rolePayload && rolePayload.business_experience) || null,
      success_criteria: raw.role_success_criteria || null,
      failure_criteria: raw.role_failure_criteria || null,
      target_action: raw.role_target_action || null,
      objections: raw.role_objections || null,
      tone: raw.role_tone || null,
      extra_profile: raw.role_extra_profile || null,
    },
    legacy_key: raw.legacy_key || null,
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
  // Fallback for old analysis_runs that don't have top-level summary/lists
  // in output_payload — try scores_patch (which has recommendation/strengths/etc).
  const scoresPatch = output.scores_patch || {};

  // Truncate evidence fields inside unit question_details
  const units = Array.isArray(rubricResult.units)
    ? rubricResult.units.map(u => ({
        ...u,
        question_details: Array.isArray(u.question_details)
          ? u.question_details.map(qd => ({
              ...qd,
              evidence: truncateForViewer(qd.evidence),
              quote: truncateForViewer(qd.quote),
              source: truncateForViewer(qd.source, 120),
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
    // Fallback to scores_patch for old runs that don't have them at top level.
    summary: (typeof output.summary === 'string' && output.summary)
      ? truncateForViewer(output.summary, 1000)
      : (scoresPatch.recommendation ? truncateForViewer(scoresPatch.recommendation, 1000) : null),
    strengths: Array.isArray(output.strengths) && output.strengths.length
      ? output.strengths
      : (Array.isArray(scoresPatch.strengths) ? scoresPatch.strengths : []),
    growth_zones: Array.isArray(output.growth_zones) && output.growth_zones.length
      ? output.growth_zones
      : (Array.isArray(scoresPatch.growth_zones) ? scoresPatch.growth_zones : []),
    coach_recommendations: Array.isArray(output.coach_recommendations) && output.coach_recommendations.length
      ? output.coach_recommendations
      : (Array.isArray(scoresPatch.coach_recommendations) ? scoresPatch.coach_recommendations : []),
    red_flags: Array.isArray(output.red_flags) && output.red_flags.length
      ? output.red_flags
      : (Array.isArray(scoresPatch.red_flags) ? scoresPatch.red_flags : []),
    // Phase 3E3E: calls-only stage dynamics + call_results
    stage_dynamics: output.stage_dynamics || null,
    call_results: Array.isArray(output.call_results) ? output.call_results : null,
    // FULL-CANDIDATE-CARD-V1 fixup: pass through block-specific extras so
    // report-v1.html can render training_agents and ops analysis runs the
    // same way it renders interview/calls. These fields are null/[] for
    // interview/calls runs (no schema change for those types).
    dialogs_reviewed: output.dialogs_reviewed != null ? output.dialogs_reviewed : null,
    note: typeof output.note === 'string' && output.note
      ? truncateForViewer(output.note, 1000)
      : null,
    ops_score: typeof output.ops_score === 'number' && Number.isFinite(output.ops_score)
      ? output.ops_score
      : null,
    discipline_score: typeof output.discipline_score === 'number' && Number.isFinite(output.discipline_score)
      ? output.discipline_score
      : null,
    notes: Array.isArray(output.notes) ? output.notes : [],
  };
}

/**
 * Build the latest_analysis block for the viewer card.
 * Returns {
 *   interview: <projection>|null,
 *   calls: <projection>|null,
 *   training_agents: <projection>|null,   // FULL-CANDIDATE-CARD-V1 fixup
 *   ops: <projection>|null,               // FULL-CANDIDATE-CARD-V1 fixup
 * }.
 *
 * For each type, picks the most recent successful codex analysis_run.
 * FULL-CANDIDATE-CARD-V1 fixup: training_agents and ops are now first-class
 * analysis types (created by import_full_candidate_card.js). They are
 * returned alongside interview/calls so report-v1.html can render them on
 * their respective tabs without special endpoints.
 */
function buildLatestAnalysis(baseKey, analysisRunsRepo) {
  const types = ['interview', 'calls', 'training_agents', 'ops'];
  const out = { interview: null, calls: null, training_agents: null, ops: null };
  for (const t of types) {
    const runs = analysisRunsRepo.listByBaseKeyType(baseKey, t);
    // Filter to codex + success, then take the most recent (repo already
    // orders by created_at DESC, id DESC).
    const latest = runs.find(r => r.source === 'codex' && r.status === 'success');
    out[t] = projectAnalysisRunForViewer(latest);
  }
  return out;
}

// ----------------------------------------------------------------------
// DATA-PURGE-V1
// ----------------------------------------------------------------------

/**
 * List tmp/ files that match a candidate's base_key. Used by purgeCandidateData
 * to count / unlink bundle and result JSON files produced by the Codex pipeline.
 *
 * Match rules (per spec):
 *   - tmp/<base_key>*         (e.g. tmp/GTRAIN02_calls_bundle.json)
 *   - tmp/*<base_key>*        (defensive: any tmp file whose name contains the key)
 *   - examples/  and public/ are NEVER touched
 *
 * Returns an array of absolute paths. Reads are best-effort: if tmp/ does not
 * exist, returns [].
 */
function listTmpFilesForBaseKey(baseKey) {
  if (!baseKey) return [];
  // tmp/ lives at the repo root (same level as package.json). __dirname is
  // services/, so the repo root is one level up.
  const repoRoot = path.resolve(__dirname, '..');
  const tmpDir = path.join(repoRoot, 'tmp');
  let entries = [];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch (_) {
    return []; // tmp/ does not exist → nothing to purge
  }
  const safeKey = String(baseKey);
  const matched = [];
  for (const name of entries) {
    // Both match rules collapse to "name contains the base_key". The two
    // patterns in the spec are equivalent for a flat tmp/ directory.
    if (name.includes(safeKey)) {
      matched.push(path.join(tmpDir, name));
    }
  }
  return matched;
}

/**
 * Allowed on-disk roots for purge unlinking. A stored_path or tmp file path
 * is only unlinked if its resolved absolute path is INSIDE one of these
 * roots. This prevents a compromised DB row (e.g. stored_path = "/etc/passwd"
 * or "../../.env") from tricking the purge into deleting files outside the
 * sanctioned directories.
 *
 * Roots:
 *   - <repoRoot>/tmp/                         — Codex bundle/result JSON files
 *   - <process.cwd()>/data/uploads/phase1/    — uploaded candidate files
 *     (created by saveCandidateFile; stored_path is relative to cwd)
 *
 * Both roots are resolved to absolute form at module load. Symlinks inside
 * are not specially handled — if an attacker can plant a symlink inside
 * these roots, they have already compromised the server. The guard here is
 * against DB-injected path traversal, not symlink attacks.
 */
const PURGE_ALLOWED_ROOTS = (() => {
  const repoRoot = path.resolve(__dirname, '..');
  const tmpRoot = path.resolve(repoRoot, 'tmp');
  const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads', 'phase1');
  return [tmpRoot, uploadsRoot];
})();

/**
 * Check whether a resolved absolute path is inside any of the allowed roots.
 * Uses path.relative() to avoid prefix-matching pitfalls (e.g. /tmp-evil
 * should NOT match root /tmp). A path is "inside" iff the relative path
 * from the root to the target does not start with '..' and is not absolute.
 */
function isPathInside(resolvedTarget, allowedRoot) {
  if (!resolvedTarget || !allowedRoot) return false;
  const rel = path.relative(allowedRoot, resolvedTarget);
  if (!rel) return false; // the root itself — don't unlink a directory
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function isPathInsideAnyRoot(resolvedTarget) {
  return PURGE_ALLOWED_ROOTS.some(root => isPathInside(resolvedTarget, root));
}

/**
 * Redact a file path for inclusion in API responses / audit log. We never
 * want to leak absolute server paths (which reveal the deploy layout) or
 * the raw DB-stored value (which might be the attacker's payload). Returns
 * a basename-only or "<redacted>" string.
 */
function redactPath(p) {
  if (!p) return '<empty>';
  try {
    const resolved = path.resolve(p);
    // If inside an allowed root, return the path relative to that root —
    // useful for debugging without leaking absolute layout.
    for (const root of PURGE_ALLOWED_ROOTS) {
      if (isPathInside(resolved, root)) {
        const rel = path.relative(root, resolved);
        return rel || path.basename(resolved);
      }
    }
    // Outside any allowed root — return only the basename so the operator
    // sees "passwd" or ".env" without the directory structure.
    return path.basename(resolved) || '<redacted>';
  } catch (_) {
    return '<redacted>';
  }
}

/**
 * Remove a list of files safely. Returns { deleted, failed, unsafe }.
 *
 * Safety:
 *   - Each path is resolved to absolute form and checked against
 *     PURGE_ALLOWED_ROOTS. Paths outside the allowed roots are NOT unlinked,
 *     NOT counted as failed, and NOT counted as deleted — they go into
 *     `unsafe` so the operator sees the DB row is suspicious. The raw path
 *     is redacted via redactPath() before being stored in the result.
 *   - ENOENT (file already gone) is silently skipped — not deleted, not
 *     failed, not unsafe.
 *   - Other unlink errors (EACCES, EISDIR, …) go into `failed` with a
 *     redacted path + the error message.
 *
 * @param {string[]} paths  — paths from DB (may be relative or absolute)
 * @returns {{deleted: number, failed: Array<{path, error}>, unsafe: Array<{path}>}}
 */
function unlinkFiles(paths) {
  const result = { deleted: 0, failed: [], unsafe: [] };
  for (const p of paths || []) {
    let resolved;
    try {
      // path.resolve() against process.cwd() turns relative stored_paths
      // (like "data/uploads/phase1/GTRAIN02/...") into absolute form.
      resolved = path.resolve(p);
    } catch (_) {
      result.unsafe.push({ path: redactPath(p) });
      continue;
    }
    if (!isPathInsideAnyRoot(resolved)) {
      // Path traversal / absolute path outside sanctioned roots — DO NOT
      // unlink, DO NOT crash. Record a redacted basename so the operator
      // can investigate the DB row.
      result.unsafe.push({ path: redactPath(p) });
      continue;
    }
    try {
      fs.unlinkSync(resolved);
      result.deleted += 1;
    } catch (err) {
      if (err && err.code === 'ENOENT') continue; // already gone — not a failure
      result.failed.push({ path: redactPath(p), error: err.message });
    }
  }
  return result;
}

/**
 * Count rows that WOULD be deleted for a candidate, without touching anything.
 * Used by dry_run mode. Reads only — safe to call any time.
 *
 * @param {object} repos  — built repos
 * @param {object} db     — raw better-sqlite3 handle (for legacy_targets_map)
 * @param {number} candidateId
 * @param {string} baseKey
 * @returns {object} counts per entity + tmp_files list
 */
function countCandidateData(repos, db, candidateId, baseKey) {
  const manualInputs = repos.manualInputsRepo.listByCandidateId(candidateId).length;
  const candidateFiles = repos.candidateFilesRepo.listByCandidateId(candidateId).length;
  const aiProfile = repos.aiProfileRepo.getByCandidateId(candidateId) ? 1 : 0;
  const sourceLinks = repos.sourceLinksRepo.listByCandidateId(candidateId).length;
  const testDay = repos.snapshotsRepo.getTestDayByCandidateId(candidateId) ? 1 : 0;
  const immersion = repos.snapshotsRepo.getImmersionByCandidateId(candidateId) ? 1 : 0;
  const trainingBotDialogs = repos.snapshotsRepo.listTrainingBotDialogsByCandidateId(candidateId).length;
  const candidateScores = repos.candidateScoresRepo.getByCandidateId(candidateId) ? 1 : 0;
  const analysisRuns = repos.analysisRunsRepo.listByBaseKey(baseKey).length;
  const importRuns = repos.importRunsRepo.listByBaseKey(baseKey).length;
  // legacy_targets_map has no repo — count directly.
  let legacyTargets = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM legacy_targets_map WHERE candidate_id = ?').get(candidateId);
    legacyTargets = row ? Number(row.c) || 0 : 0;
  } catch (_) { /* table may not exist on very old DBs — treat as 0 */ }
  const tmpFiles = listTmpFilesForBaseKey(baseKey);
  // SECURITY: never return raw absolute tmp paths from the service. The
  // dry-run response is sent to the API caller and would leak the server's
  // directory layout. We return only the count + a redacted preview (each
  // path run through redactPath() → basename-only or relative-to-allowed-root).
  // The raw paths are still available internally to purgeCandidateData()
  // via listTmpFilesForBaseKey() during the live purge — they just never
  // reach the response / audit log.
  return {
    manual_inputs: manualInputs,
    candidate_files: candidateFiles,
    ai_profile: aiProfile,
    source_links: sourceLinks,
    test_day_snapshot: testDay,
    immersion_snapshot: immersion,
    training_bot_dialogs: trainingBotDialogs,
    candidate_scores: candidateScores,
    analysis_runs: analysisRuns,
    import_runs: importRuns,
    legacy_targets_map: legacyTargets,
    tmp_files: tmpFiles.length,
    tmp_files_preview: tmpFiles.map(p => redactPath(p)),
  };
}

/**
 * Purge sensitive candidate data from the server.
 *
 * Mode "candidate_data" (the only one supported in v1):
 *   - removes manual_inputs, candidate_files, ai_profile, source_links,
 *     test_day_snapshot, immersion_snapshot, training_bot_dialogs,
 *     candidate_scores, analysis_runs, import_runs, legacy_targets_map,
 *     and tmp/<base_key>* files
 *   - KEEPS the candidates row (id, base_key, full_name, segment, direction,
 *     mentor, recruiter, dates, status) so the candidate is still listed
 *   - KEEPS candidate_keys (session_key/key_type/etc.) — keys are needed
 *     for re-imports and for the candidate's identity chain. A separate
 *     full_delete mode (described in PATCH_REPORT) would also remove keys
 *     and the candidate row itself.
 *   - Writes an audit_log row with action=candidate_data_purge. The payload
 *     contains ONLY counts + mode + dry_run — never raw call/interview text.
 *
 * Safety:
 *   - confirm_base_key MUST equal the base_key being purged. Returns 400 otherwise.
 *   - dry_run defaults to true. When true, nothing is deleted — the response
 *     contains the same would_delete counts as a live run would produce.
 *   - All DB deletes run inside a single transaction. If any delete throws,
 *     the whole transaction rolls back and the error propagates.
 *   - tmp/ file unlinking happens AFTER the DB transaction commits. A failed
 *     unlink is reported in the response but does NOT roll back the DB.
 *
 * @param {string} baseKey
 * @param {object} opts
 *   - mode: 'candidate_data' (only supported value in v1)
 *   - confirm_base_key: must equal baseKey
 *   - dry_run: boolean (default true)
 *   - admin_key: required for audit_log (hashed before storage)
 * @returns {object} { ok, dry_run, base_key, candidate, would_delete | deleted, audit_log_id? }
 * @throws {Error} with .code = 'CANDIDATE_NOT_FOUND' | 'PURGE_CONFIRM_MISMATCH' | 'PURGE_UNSUPPORTED_MODE'
 */
function purgeCandidateData(baseKey, opts) {
  const mode = String(opts && opts.mode || 'candidate_data');
  const confirmBaseKey = String(opts && opts.confirm_base_key || '');
  const dryRun = opts && opts.dry_run === false ? false : true; // default true
  const adminKey = opts && opts.admin_key || 'unknown';

  if (mode !== 'candidate_data') {
    const err = new Error(`unsupported_purge_mode:${mode}`);
    err.code = 'PURGE_UNSUPPORTED_MODE';
    throw err;
  }
  if (!confirmBaseKey || confirmBaseKey !== baseKey) {
    const err = new Error('confirm_base_key_mismatch');
    err.code = 'PURGE_CONFIRM_MISMATCH';
    throw err;
  }

  const db = ensureDb();
  const repos = buildRepos(db);
  const candidate = repos.candidatesRepo.findByBaseKey(baseKey);
  if (!candidate) {
    const err = new Error('candidate_not_found');
    err.code = 'CANDIDATE_NOT_FOUND';
    throw err;
  }

  const counts = countCandidateData(repos, db, candidate.id, baseKey);

  // Public profile (no secrets) returned in the response so the caller can
  // double-check they purged the right person.
  const candidatePublic = {
    base_key: candidate.base_key,
    full_name: candidate.full_name,
    seller_segment: candidate.seller_segment,
    direction: candidate.direction,
    mentor: candidate.mentor,
    recruiter: candidate.recruiter,
    status: candidate.status,
  };

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      mode,
      base_key: baseKey,
      candidate: candidatePublic,
      would_delete: counts,
    };
  }

  // ---- LIVE PURGE -----------------------------------------------------
  // All DB deletes run inside one transaction. better-sqlite3's transaction()
  // returns a function that runs its body and commits on normal return /
  // rolls back on throw. We capture the per-table counts inside the body so
  // the response can report exactly what was removed.
  let deleted = null;
  const tx = db.transaction(() => {
    const manualInputs = repos.manualInputsRepo.deleteByCandidateId(candidate.id);
    const filesResult = repos.candidateFilesRepo.deleteByCandidateId(candidate.id);
    const aiProfile = repos.aiProfileRepo.deleteByCandidateId(candidate.id);
    const sourceLinks = repos.sourceLinksRepo.deleteByCandidateId(candidate.id);
    const snapCounts = repos.snapshotsRepo.deleteByCandidateId(candidate.id);
    const candidateScores = repos.candidateScoresRepo.deleteByCandidateId(candidate.id);
    const analysisRuns = repos.analysisRunsRepo.deleteByBaseKey(baseKey);
    const importRuns = repos.importRunsRepo.deleteByBaseKey(baseKey);
    // legacy_targets_map — delete directly (no repo).
    let legacyTargets = 0;
    try {
      const info = db.prepare('DELETE FROM legacy_targets_map WHERE candidate_id = ?').run(candidate.id);
      legacyTargets = info.changes || 0;
    } catch (_) { /* table missing — nothing to delete */ }

    deleted = {
      manual_inputs: manualInputs,
      candidate_files: filesResult.count,
      ai_profile: aiProfile,
      source_links: sourceLinks,
      test_day_snapshot: snapCounts.test_day_snapshot,
      immersion_snapshot: snapCounts.immersion_snapshot,
      training_bot_dialogs: snapCounts.training_bot_dialogs,
      candidate_scores: candidateScores,
      analysis_runs: analysisRuns,
      import_runs: importRuns,
      legacy_targets_map: legacyTargets,
      tmp_files: 0, // filled in after the tx commits + unlinks run
    };

    // Stash the file paths collected during countCandidateData so we can
    // unlink them AFTER the transaction commits. We attach to `deleted` so
    // the post-tx code can read them — but they are stripped from the final
    // response (no absolute paths in the API contract).
    // SECURITY: these paths come from the DB (candidate_files.stored_path)
    // and from tmp/ readdir. They are NOT trusted — unlinkFiles() resolves
    // each to absolute form and refuses to unlink anything outside
    // PURGE_ALLOWED_ROOTS (see unlinkFiles docs).
    // NOTE: we re-read tmp paths via listTmpFilesForBaseKey() here instead
    // of using counts.tmp_file_paths because countCandidateData() no longer
    // returns raw paths (they would leak via the dry-run response). The
    // count is still available as counts.tmp_files.
    const liveTmpPaths = listTmpFilesForBaseKey(baseKey);
    deleted.__tmp_paths = filesResult.stored_paths.concat(liveTmpPaths);
    deleted.__stored_paths = filesResult.stored_paths;

    // Audit log INSIDE the same transaction — so a rollback also drops the
    // audit row. Payload contains ONLY counts + mode + dry_run, never raw
    // call/interview text or session_keys. tmp_files count here is the
    // number of candidate paths we INTEND to unlink; the actual deleted /
    // failed / unsafe split is added post-commit (not in the audit payload
    // to keep the row shape stable across dry_run / live).
    const auditPayload = {
      mode,
      dry_run: false,
      deleted_counts: {
        manual_inputs: deleted.manual_inputs,
        candidate_files: deleted.candidate_files,
        ai_profile: deleted.ai_profile,
        source_links: deleted.source_links,
        test_day_snapshot: deleted.test_day_snapshot,
        immersion_snapshot: deleted.immersion_snapshot,
        training_bot_dialogs: deleted.training_bot_dialogs,
        candidate_scores: deleted.candidate_scores,
        analysis_runs: deleted.analysis_runs,
        import_runs: deleted.import_runs,
        legacy_targets_map: deleted.legacy_targets_map,
        tmp_files: deleted.__tmp_paths.length,
      },
      candidate: candidatePublic,
    };
    appendAuditLog(db, adminKey, 'candidate_data_purge', 'candidate', candidate.id, baseKey, auditPayload);
  });
  tx();

  // ---- POST-COMMIT: unlink on-disk files -----------------------------
  // We do this AFTER the tx commits so a failed unlink does NOT roll back
  // the DB. unlinkFiles() applies a path-safety allowlist: only files
  // inside <repoRoot>/tmp/ or <cwd>/data/uploads/phase1/ are unlinked.
  // Anything outside is reported as `unsafe` (redacted basename) and left
  // on disk — the operator should investigate the DB row.
  const allPaths = deleted.__tmp_paths || [];
  const unlinkResult = unlinkFiles(allPaths);
  deleted.tmp_files = unlinkResult.deleted;
  deleted.tmp_files_failed = unlinkResult.failed.length;
  deleted.unsafe_paths_count = unlinkResult.unsafe.length;

  // Fetch the audit_log row id we just wrote (the most recent one for this
  // candidate + action). This is best-effort — if the lookup fails, we still
  // return ok:true with audit_log_id:null.
  let auditLogId = null;
  try {
    const row = db.prepare(
      `SELECT id FROM audit_log WHERE base_key = ? AND action = 'candidate_data_purge'
       ORDER BY datetime(created_at) DESC, id DESC LIMIT 1`
    ).get(baseKey);
    auditLogId = row ? row.id : null;
  } catch (_) { /* ignore */ }

  // Strip internal helpers from the response.
  delete deleted.__tmp_paths;
  delete deleted.__stored_paths;

  return {
    ok: true,
    dry_run: false,
    mode,
    base_key: baseKey,
    candidate: candidatePublic,
    deleted,
    audit_log_id: auditLogId,
    // SECURITY: never return raw absolute paths in the API. failed / unsafe
    // paths are redacted to basename-only (or relative-to-allowed-root) so
    // the operator can debug without leaking the server's directory layout
    // or the attacker's original payload.
    tmp_files_failed: unlinkResult.failed.length,
    tmp_files_failed_paths: unlinkResult.failed.map(f => f.path),
    unsafe_paths_count: unlinkResult.unsafe.length,
    unsafe_paths: unlinkResult.unsafe.map(u => u.path),
  };
}

// ----------------------------------------------------------------------
// STATIC-HTML-EXPORT-V1
// ----------------------------------------------------------------------

/**
 * Sanitize a candidate's full_name (or any free-form string) into a safe
 * filename component. Strips path separators, control chars, and characters
 * that are illegal in filenames on Windows / macOS / Linux. Collapses
 * whitespace into single underscores. Returns a non-empty fallback when the
 * input is empty or all-illegal.
 *
 * Examples:
 *   'Иванов Иван'            → 'Ivanov_Ivan'  (translit not applied — we keep
 *                                              Cyrillic, just trim/sanitize)
 *   'Иванов/Иван'            → 'Иванов_Иван'
 *   '../../../etc/passwd'    → 'etc_passwd'
 *   ''                       → 'candidate'
 */
function sanitizeFilenameComponent(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'candidate';
  // Replace path separators + control chars + illegal-in-filename chars.
  // Keep letters (incl. Cyrillic), digits, dashes, underscores, dots.
  const cleaned = raw
    .replace(/[\\/\x00-\x1f<>:"|?*]/g, '_') // illegal chars → underscore
    .replace(/\s+/g, '_')                    // whitespace → underscore
    .replace(/_+/g, '_')                     // collapse runs
    .replace(/^[_.\-]+|[_.\-]+$/g, '');      // trim leading/trailing seps
  return cleaned || 'candidate';
}

/**
 * Build the export filename: <Full_Name>_report_<YYYY-MM-DD>.html
 * The name uses the candidate's full_name (sanitized) + the export date.
 * No base_key, no timestamps with colons (illegal on Windows).
 */
function buildExportFilename(candidate, exportedAtIso) {
  const name = sanitizeFilenameComponent(candidate.full_name);
  const d = new Date(exportedAtIso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${name}_report_${yyyy}-${mm}-${dd}.html`;
}

/**
 * Escape a string for safe inclusion in HTML text content / attribute values.
 * Replaces & < > " ' with their entity equivalents. Used for every user-
 * controlled value that lands in the exported HTML (full_name, direction,
 * segment, mentor, recommendations, etc.).
 */
function escapeHtmlStrict(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Serialize JSON for safe embedding inside <script type="application/json">.
 *
 * The naive JSON.stringify can produce "</script>" if a string value
 * contains that literal — the browser's HTML parser would close the script
 * tag early. We escape "<" (which covers </script> and <!--) and also U+2028
 * / U+2029 (line/paragraph separators that are valid in JSON strings but
 * break JS string literals in older browsers — harmless inside a JSON
 * script tag, but escaping is cheap insurance).
 *
 * Returns a string that is safe to interpolate between
 *   <script type="application/json"> ... </script>
 */
function safeJsonForScript(json) {
  const str = JSON.stringify(json);
  return str
    .replace(/</g, '\\u003c')   // covers </script>, <!--
    .replace(/>/g, '\\u003e')   // symmetry — covers -->
    .replace(/&/g, '\\u0026')   // covers & in case of HTML entity confusion
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Strip sensitive fields from the viewer card before embedding in the
 * exported HTML. The viewer card is already a safe projection for the
 * live report (no session keys in `candidate`), but the static export
 * must be stricter: it leaves the server, gets opened in browsers outside
 * our control, and may be forwarded. So we apply an EXPLICIT safe
 * projection to every section — never embed raw nested objects.
 *
 * What gets stripped (security-critical):
 *   - candidate.base_key, candidate.id            (technical ids)
 *   - candidate.created_at/updated_at             (not user-facing)
 *   - completeness.base_key                        (technical id)
 *   - scores.id, scores.candidate_id, scores.base_key, scores.analysis_run_id
 *   - scores.created_at/updated_at                 (not user-facing)
 *   - training_bot_dialogs[].session_key, legacy_key, team_id, voice_id,
 *     external_id, dedup_key                       (technical ids)
 *   - training_bot_dialogs[].result_payload        (raw import payload)
 *   - training_bot_dialogs[].analysis_json         (raw Codex result)
 *   - training_bot_dialogs[].transcript_preview, transcript_text (full text)
 *   - training_bot_dialogs[].role_portrait.extra_profile, team_id, raw rows
 *   - files[].id, stored_path, text_content        (technical id + full text)
 *   - manual_inputs[].payload (raw)                (replaced with preview/length)
 *   - import_summary, has_legacy_ai_profile, keys, source_links (dropped wholesale)
 *
 * What stays (human-facing):
 *   - candidate: full_name, seller_segment, direction, mentor, recruiter,
 *     test_day_started_at, immersion_started_at, status
 *   - completeness: completed_count, total_count, status, items[code/title/status/source]
 *   - scores: overall_score, hard/soft/learning/discipline/call_quality/ops/
 *     final_test/risk scores, risk_level, final_status, recommendation,
 *     strengths, growth_zones, red_flags, coach_recommendations,
 *     score_breakdown (structure only, no ids)
 *   - training_bot_dialogs: dialog_date, role_id, role_client, role_business,
 *     product, result (SUCCESSFUL/FAILED) + safe summary from result_payload
 *   - files: section, file_type, original_name, size_bytes, mime_type
 *   - manual_inputs: section + safe preview (≤500 chars) + length
 *   - latest_analysis: interview/calls/training_agents/ops — each with
 *     summary, strengths, growth_zones, red_flags, coach_recommendations,
 *     rubric_result.overall_score_percent (no ids, no raw evidence)
 */
function sanitizeCardForExport(card) {
  if (!card) return null;
  return {
    candidate: sanitizeCandidateForExport(card.candidate),
    completeness: sanitizeCompletenessForExport(card.completeness),
    scores: sanitizeScoresForExport(card.scores),
    manual_inputs: (card.manual_inputs || []).map(sanitizeManualInputForExport),
    training_bot_dialogs: (card.training_bot_dialogs || []).map(sanitizeTrainingDialogForExport),
    call_stats: sanitizeCallStatsForExport(card.call_stats),
    ops_summary: sanitizeOpsSummaryForExport(card.ops_summary),
    interview_summary: sanitizeInterviewSummaryForExport(card.interview_summary),
    files: (card.files || []).map(sanitizeFileForExport),
    latest_analysis: sanitizeLatestAnalysisForExport(card.latest_analysis),
  };
}

function sanitizeCandidateForExport(c) {
  if (!c) return null;
  return {
    full_name: c.full_name || 'Без ФИО',
    seller_segment: c.seller_segment || null,
    direction: c.direction || null,
    mentor: c.mentor || null,
    recruiter: c.recruiter || null,
    test_day_started_at: c.test_day_started_at || null,
    immersion_started_at: c.immersion_started_at || null,
    immersion_finished_at: c.immersion_finished_at || c.immersion_ended_at || null,
    status: c.status || null,
  };
}

function sanitizeCompletenessForExport(comp) {
  if (!comp) return null;
  return {
    completed_count: comp.completed_count != null ? comp.completed_count : 0,
    total_count: comp.total_count != null ? comp.total_count : 0,
    status: comp.status || 'missing',
    items: Array.isArray(comp.items)
      ? comp.items.map(it => ({
          code: it.code || null,
          title: it.title || null,
          status: it.status || 'missing',
          source: it.source || null,
        }))
      : [],
  };
}

function sanitizeScoresForExport(s) {
  if (!s) return null;
  // score_breakdown may contain nested objects with scores — keep the
  // structure but strip any id/base_key/candidate_id fields that might
  // sneak in.
  const safeBreakdown = s.score_breakdown && typeof s.score_breakdown === 'object'
    ? JSON.parse(JSON.stringify(s.score_breakdown, (k, v) => {
        if (k === 'id' || k === 'candidate_id' || k === 'base_key' || k === 'analysis_run_id') return undefined;
        return v;
      }))
    : null;
  return {
    hard_score: s.hard_score ?? null,
    soft_score: s.soft_score ?? null,
    learning_score: s.learning_score ?? null,
    discipline_score: s.discipline_score ?? null,
    call_quality_score: s.call_quality_score ?? null,
    ops_score: s.ops_score ?? null,
    final_test_score: s.final_test_score ?? null,
    risk_score: s.risk_score ?? null,
    overall_score: s.overall_score ?? null,
    risk_level: s.risk_level || null,
    final_status: s.final_status || null,
    recommendation: s.recommendation || null,
    strengths: Array.isArray(s.strengths) ? s.strengths.filter(Boolean) : [],
    growth_zones: Array.isArray(s.growth_zones) ? s.growth_zones.filter(Boolean) : [],
    red_flags: Array.isArray(s.red_flags) ? s.red_flags.filter(Boolean) : [],
    coach_recommendations: Array.isArray(s.coach_recommendations) ? s.coach_recommendations.filter(Boolean) : [],
    score_breakdown: safeBreakdown,
  };
}

function sanitizeManualInputForExport(m) {
  if (!m) return null;
  // Extract a safe short preview + length. Never embed the full payload
  // (it may contain full call/interview transcripts).
  let preview = '';
  let length = 0;
  if (m.payload && typeof m.payload === 'object') {
    const p = m.payload;
    const text = p.text_content || p.transcript || p.text ||
      (typeof p === 'string' ? p : '');
    if (text) {
      length = String(text).length;
      preview = String(text).slice(0, 500);
    } else if (Array.isArray(p.calls)) {
      length = p.calls.length;
      preview = `Звонков в разделе: ${p.calls.length}`;
    } else if (p.comment) {
      length = String(p.comment).length;
      preview = String(p.comment).slice(0, 500);
    }
  }
  return {
    section: m.section || null,
    preview: preview || null,
    length,
    updated_at: m.updated_at || null,
  };
}

function sanitizeTrainingDialogForExport(d) {
  if (!d) return null;
  // Extract a safe summary from result_payload if it's an object — keep
  // only SUCCESSFUL/FAILED counts + block scores, never raw rows.
  let resultSummary = null;
  if (d.result_payload && typeof d.result_payload === 'object') {
    const rp = d.result_payload;
    resultSummary = {};
    if (rp.SUCCESSFUL != null) resultSummary.successful = rp.SUCCESSFUL;
    if (rp.FAILED != null) resultSummary.failed = rp.FAILED;
    // Block scores (BLOCK_1..BLOCK_6) are safe scalar values.
    for (const k of Object.keys(rp)) {
      if (/^BLOCK_\d+$/.test(k) && typeof rp[k] !== 'object') {
        resultSummary[k.toLowerCase()] = rp[k];
      }
    }
    if (Object.keys(resultSummary).length === 0) resultSummary = null;
  }
  return {
    dialog_date: d.dialog_date || null,
    role_id: d.role_id || null,
    role_client: d.role_client || null,
    role_business: d.role_business || null,
    product: d.product || null,
    result: d.result || null,
    result_summary: resultSummary,
  };
}

function sanitizeCallStatsForExport(cs) {
  if (!cs) return null;
  return {
    talk_time_minutes: cs.talk_time_minutes ?? null,
    calls_total: cs.calls_total ?? null,
    reached_calls: cs.reached_calls ?? null,
    calls_over_2min: cs.calls_over_2min ?? null,
    calls_over_2min_percent: cs.calls_over_2min_percent ?? null,
    calls_over_10min: cs.calls_over_10min ?? null,
    effective_minutes: cs.effective_minutes ?? null,
    days: Array.isArray(cs.days)
      ? cs.days.map(dy => ({
          day: dy.day || dy.label || null,
          calls_total: dy.calls_total ?? null,
          calls_over_2min: dy.calls_over_2min ?? null,
        }))
      : [],
  };
}

function sanitizeOpsSummaryForExport(ops) {
  if (!ops) return null;
  return {
    sections: Array.isArray(ops.sections)
      ? ops.sections.map(sec => ({
          title: sec.title || null,
          status: sec.status || 'not_checked',
          comment: sec.comment || null,
        }))
      : [],
  };
}

function sanitizeInterviewSummaryForExport(is) {
  if (!is) return null;
  return {
    has_interview: Boolean(is.has_interview),
    has_transcript: Boolean(is.has_transcript),
    length: is.length ?? null,
    updated_at: is.updated_at || null,
  };
}

function sanitizeFileForExport(f) {
  if (!f) return null;
  // NEVER embed text_content or stored_path — only safe metadata.
  return {
    section: f.section || null,
    file_type: f.file_type || null,
    original_name: f.original_name || null,
    mime_type: f.mime_type || null,
    size_bytes: f.size_bytes ?? null,
  };
}

function sanitizeLatestAnalysisForExport(la) {
  if (!la) return null;
  const sanitizeOne = (a) => {
    if (!a) return null;
    const rr = a.rubric_result || {};
    return {
      analysis_type: a.analysis_type || null,
      summary: a.summary || null,
      strengths: Array.isArray(a.strengths) ? a.strengths.filter(Boolean) : [],
      growth_zones: Array.isArray(a.growth_zones) ? a.growth_zones.filter(Boolean) : [],
      red_flags: Array.isArray(a.red_flags) ? a.red_flags.filter(Boolean) : [],
      coach_recommendations: Array.isArray(a.coach_recommendations) ? a.coach_recommendations.filter(Boolean) : [],
      rubric_result: {
        rubric_id: rr.rubric_id || null,
        rubric_version: rr.rubric_version || null,
        overall_score_percent: rr.overall_score_percent ?? null,
        overall_confidence: rr.overall_confidence || null,
        overall_status: rr.overall_status || null,
      },
    };
  };
  return {
    interview: sanitizeOne(la.interview),
    calls: sanitizeOne(la.calls),
    training_agents: sanitizeOne(la.training_agents),
    ops: sanitizeOne(la.ops),
  };
}

/**
 * Render a self-contained HTML report for a candidate.
 *
 * The HTML is a single file with inline CSS + a single <script
 * type="application/json"> block holding the sanitized card. When opened
 * via file://, a tiny inline <script> reads the JSON and renders the
 * report — NO fetch() calls, NO viewer key, NO server dependency.
 *
 * Security:
 *   - Every user-controlled string is HTML-escaped via escapeHtmlStrict().
 *   - The embedded JSON is escaped via safeJsonForScript() so </script>
 *     inside a transcript cannot break out of the script tag.
 *   - base_key / candidate.id / session keys / source_links / import_summary
 *     are stripped by sanitizeCardForExport() BEFORE embedding.
 *   - No absolute server paths anywhere in the HTML.
 *   - No ADMIN_KEY / VIEWER_KEY / X-Admin-Key / session_key literals.
 */
function renderStaticReportHtml(card, exportedAtIso) {
  const safe = sanitizeCardForExport(card);
  const c = safe.candidate;
  const escapedName = escapeHtmlStrict(c.full_name);
  const escapedDirection = escapeHtmlStrict(c.direction || '—');
  const escapedSegment = escapeHtmlStrict(c.seller_segment || '—');
  const escapedMentor = escapeHtmlStrict(c.mentor || '—');
  const escapedRecruiter = escapeHtmlStrict(c.recruiter || '—');
  const escapedStatus = escapeHtmlStrict(c.status || '—');

  // Format export timestamp in Russian locale (DD.MM.YYYY HH:MM, Moscow tz).
  const exportDate = new Date(exportedAtIso);
  const fmtDt = (d) => {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
  };
  // Use Europe/Moscow timezone for the displayed timestamp.
  let exportedAtRu;
  try {
    exportedAtRu = exportDate.toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    exportedAtRu = fmtDt(exportDate);
  }

  // Format optional date fields (immersion_started_at, etc.).
  const fmtDate = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return fmtDt(d).split(' ')[0]; // DD.MM.YYYY only
    } catch (_) { return '—'; }
  };

  // Scores summary — extract the headline numbers if present.
  const s = safe.scores || {};
  const scoreRow = (label, value, isRisk) => {
    if (value == null || value === '') {
      return `<div class="score-cell empty"><div class="sc-label">${escapeHtmlStrict(label)}</div><div class="sc-value">—</div></div>`;
    }
    const num = Number(value);
    const display = Number.isFinite(num) ? Math.round(num * 10) / 10 : escapeHtmlStrict(value);
    const cls = isRisk ? 'risk' : '';
    return `<div class="score-cell ${cls}"><div class="sc-label">${escapeHtmlStrict(label)}</div><div class="sc-value">${escapeHtmlStrict(display)}</div></div>`;
  };

  // Lists (strengths / growth_zones / red_flags / coach_recommendations).
  const renderList = (items, title, cls) => {
    const arr = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!arr.length) return '';
    return `<div class="list-box ${cls}"><h4>${escapeHtmlStrict(title)}</h4><ul>${arr.map(i => `<li>${escapeHtmlStrict(i)}</li>`).join('')}</ul></div>`;
  };

  // Manual inputs — show section + safe preview (already sanitized to ≤500
  // chars by sanitizeManualInputForExport). Never reach into raw payload.
  const manualInputsHtml = (safe.manual_inputs || []).map(m => {
    const section = escapeHtmlStrict(m.section || '');
    const preview = m.preview ? `<div class="mi-preview">${escapeHtmlStrict(m.preview)}</div>` : '';
    const lengthInfo = m.length ? `<div class="mi-length">длина: ${escapeHtmlStrict(m.length)}</div>` : '';
    return `<div class="mi-row"><div class="mi-section">${section}</div>${preview}${lengthInfo}</div>`;
  }).join('');

  // Training dialogs — show role + date + result + safe summary.
  const trainingHtml = (safe.training_bot_dialogs || []).map(d => {
    const role = escapeHtmlStrict([d.role_client, d.role_business].filter(Boolean).join(' / ') || 'Диалог');
    const date = escapeHtmlStrict(d.dialog_date || '—');
    const result = escapeHtmlStrict(d.result || '—');
    const product = escapeHtmlStrict(d.product || '');
    let summary = '';
    if (d.result_summary && typeof d.result_summary === 'object') {
      const parts = [];
      if (d.result_summary.successful != null) parts.push(`успешно: ${d.result_summary.successful}`);
      if (d.result_summary.failed != null) parts.push(`провалено: ${d.result_summary.failed}`);
      if (parts.length) summary = `<div class="td-summary">${escapeHtmlStrict(parts.join(' · '))}</div>`;
    }
    return `<div class="td-row"><div class="td-head"><b>${role}</b>${product ? ` · ${product}` : ''}</div><div class="td-meta">Дата: ${date} · Результат: ${result}</div>${summary}</div>`;
  }).join('');

  // Completeness items.
  const completenessHtml = (safe.completeness && Array.isArray(safe.completeness.items))
    ? safe.completeness.items.map(item => {
        const st = item.status === 'ready' ? '✓' : '—';
        const cls = item.status === 'ready' ? 'ready' : 'not-ready';
        return `<div class="ci-row ${cls}"><span class="ci-title">${escapeHtmlStrict(item.title || item.code)}</span><span class="ci-status">${st}</span></div>`;
      }).join('')
    : '';

  // Latest analysis summary.
  const la = safe.latest_analysis || {};
  const analysisBlock = (label, a) => {
    if (!a) return '';
    const rr = a.rubric_result || {};
    const score = rr.overall_score_percent != null ? rr.overall_score_percent : '—';
    const summary = a.summary ? escapeHtmlStrict(String(a.summary).slice(0, 500)) : '';
    const strengths = renderList(a.strengths, 'Сильные стороны', 'strengths');
    const growth = renderList(a.growth_zones, 'Зоны роста', 'growth');
    const risks = renderList(a.red_flags, 'Риски', 'red-flags');
    const coach = renderList(a.coach_recommendations, 'Рекомендации тренеру', 'coach');
    return `<div class="analysis-card">
      <h3>${escapeHtmlStrict(label)}</h3>
      <div class="analysis-meta">общий балл: <b>${escapeHtmlStrict(score)}</b></div>
      ${summary ? `<div class="analysis-summary">${summary}</div>` : ''}
      <div class="lists-grid">${strengths}${growth}${risks}${coach}</div>
    </div>`;
  };

  const embeddedJson = safeJsonForScript(safe);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Отчёт по новичку — ${escapedName}</title>
<style>
:root {
  --bg: #f6f1ff; --panel: #ffffff; --panel-soft: #faf7ff;
  --text: #1f1733; --muted: #73668f; --line: #e5d6ff;
  --accent: #7f42e1; --accent-soft: #f0e6ff;
  --ok: #23824f; --ok-soft: #d8f3e3;
  --warn: #b46b00; --warn-soft: #fff1d6;
  --danger: #d85c3a; --danger-soft: #ffe0d4;
  --radius-lg: 20px; --radius-md: 14px; --radius-sm: 10px;
  --shadow: 0 12px 36px rgba(82, 45, 145, 0.10);
}
* { box-sizing: border-box; }
body {
  margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Manrope, sans-serif;
  background: linear-gradient(180deg, #f7f2ff 0%, #ffffff 100%);
  color: var(--text); min-height: 100vh; line-height: 1.5;
}
.page { max-width: 1100px; margin: 0 auto; padding: 24px 18px 80px; }
.export-header {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg);
  padding: 18px 22px; box-shadow: var(--shadow); margin-bottom: 20px;
}
.export-header .eh-title { font-size: 20px; font-weight: 800; margin: 0 0 6px; }
.export-header .eh-sub { color: var(--muted); font-size: 13px; margin: 0; }
.export-header .eh-meta { color: var(--muted); font-size: 12px; margin-top: 8px; }
.hero {
  background: linear-gradient(135deg, #7f42e1 0%, #6934c7 100%);
  color: #fff; border-radius: var(--radius-lg); padding: 28px 28px;
  margin-bottom: 20px; box-shadow: var(--shadow);
}
.hero h1 { margin: 0 0 8px; font-size: 30px; font-weight: 800; }
.hero .hero-sub { font-size: 15px; opacity: 0.92; }
.hero .hero-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-top: 18px; }
.hero .hero-cell { background: rgba(255,255,255,0.13); border: 1px solid rgba(255,255,255,0.16); border-radius: var(--radius-sm); padding: 10px 12px; }
.hero .hero-cell .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.75; }
.hero .hero-cell .value { font-size: 15px; font-weight: 700; margin-top: 2px; }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg);
  padding: 20px 22px; box-shadow: var(--shadow); margin-bottom: 16px;
}
.card h2 { margin: 0 0 12px; font-size: 18px; font-weight: 700; }
.card h3 { margin: 0 0 8px; font-size: 15px; font-weight: 700; }
.score-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.score-cell { background: var(--panel-soft); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; }
.score-cell.empty .sc-value { color: var(--muted); }
.score-cell.risk .sc-value { color: var(--danger); }
.sc-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.sc-value { font-size: 18px; font-weight: 700; margin-top: 4px; }
.lists-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 10px; }
.list-box { background: var(--panel-soft); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 12px 14px; }
.list-box h4 { margin: 0 0 8px; font-size: 13px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.list-box ul { margin: 0; padding-left: 18px; font-size: 14px; }
.list-box.strengths h4 { color: var(--ok); }
.list-box.red-flags h4 { color: var(--danger); }
.list-box.growth h4 { color: var(--warn); }
.mi-row { padding: 10px 0; border-bottom: 1px solid var(--line); }
.mi-row:last-child { border-bottom: 0; }
.mi-section { font-weight: 700; font-size: 13px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
.mi-preview { font-size: 13px; color: var(--text); white-space: pre-wrap; word-wrap: break-word; }
.td-row { padding: 10px 0; border-bottom: 1px solid var(--line); }
.td-row:last-child { border-bottom: 0; }
.td-head { font-weight: 700; font-size: 14px; }
.td-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
.ci-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.ci-row:last-child { border-bottom: 0; }
.ci-status.ready { color: var(--ok); font-weight: 700; }
.ci-status.not-ready { color: var(--muted); }
.analysis-card { background: var(--panel-soft); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 14px 16px; margin-bottom: 12px; }
.analysis-meta { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
.analysis-summary { font-size: 14px; margin-bottom: 8px; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.tab { padding: 8px 14px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--panel); cursor: pointer; font-size: 13px; font-weight: 600; color: var(--muted); }
.tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.tab-content { display: none; }
.tab-content.active { display: block; }
.footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 30px; }
@media (max-width: 720px) {
  .hero h1 { font-size: 24px; }
  .card { padding: 16px; }
}
</style>
</head>
<body>
<div class="page">
  <div class="export-header">
    <h1 class="eh-title">Отчёт по новичку</h1>
    <p class="eh-sub">Автономный экспорт — открывается локально без сервера</p>
    <p class="eh-meta">Отчёт выгружен: ${escapeHtmlStrict(exportedAtRu)}</p>
  </div>

  <section class="hero">
    <h1>${escapedName}</h1>
    <div class="hero-sub">Направление / сегмент: ${escapedSegment} · ${escapedDirection}</div>
    <div class="hero-grid">
      <div class="hero-cell"><div class="label">Статус</div><div class="value">${escapedStatus}</div></div>
      <div class="hero-cell"><div class="label">Наставник</div><div class="value">${escapedMentor}</div></div>
      <div class="hero-cell"><div class="label">Рекрутёр</div><div class="value">${escapedRecruiter}</div></div>
      <div class="hero-cell"><div class="label">Начало погружения</div><div class="value">${escapeHtmlStrict(fmtDate(c.immersion_started_at))}</div></div>
      <div class="hero-cell"><div class="label">Дата тестового дня</div><div class="value">${escapeHtmlStrict(fmtDate(c.test_day_started_at))}</div></div>
    </div>
  </section>

  <div class="tabs">
    <button class="tab active" data-tab="overview">Обзор</button>
    <button class="tab" data-tab="scores">Оценки</button>
    <button class="tab" data-tab="inputs">Данные</button>
    <button class="tab" data-tab="training">Учебные агенты</button>
    <button class="tab" data-tab="analysis">Анализ</button>
  </div>

  <div class="tab-content active" id="tab-overview">
    <div class="card">
      <h2>Готовность данных</h2>
      ${completenessHtml || '<div class="empty">Нет данных по готовности.</div>'}
    </div>
    <div class="card">
      <h2>Краткое резюме</h2>
      <div class="score-grid">
        ${scoreRow('Общий балл', s.overall_score)}
        ${scoreRow('Качество звонков', s.call_quality_score)}
        ${scoreRow('Софт-навыки', s.soft_score)}
        ${scoreRow('Профессиональные навыки', s.hard_score)}
        ${scoreRow('Обучаемость', s.learning_score)}
        ${scoreRow('Дисциплина', s.discipline_score)}
        ${scoreRow('Операционка', s.ops_score)}
        ${scoreRow('Выпускной тест', s.final_test_score)}
        ${scoreRow('Риск', s.risk_score, true)}
      </div>
    </div>
  </div>

  <div class="tab-content" id="tab-scores">
    <div class="card">
      <h2>Итоговые оценки</h2>
      ${s.recommendation ? `<div class="list-box"><h4>Рекомендация</h4><p>${escapeHtmlStrict(s.recommendation)}</p></div>` : ''}
      <div class="lists-grid">
        ${renderList(s.strengths, 'Сильные стороны', 'strengths')}
        ${renderList(s.growth_zones, 'Зоны роста', 'growth')}
        ${renderList(s.red_flags, 'Риски', 'red-flags')}
        ${renderList(s.coach_recommendations, 'Рекомендации тренеру', 'coach')}
      </div>
    </div>
  </div>

  <div class="tab-content" id="tab-inputs">
    <div class="card">
      <h2>Введённые данные</h2>
      ${manualInputsHtml || '<div class="empty">Нет введённых данных.</div>'}
    </div>
  </div>

  <div class="tab-content" id="tab-training">
    <div class="card">
      <h2>Учебные диалоги</h2>
      ${trainingHtml || '<div class="empty">Нет учебных диалогов.</div>'}
    </div>
  </div>

  <div class="tab-content" id="tab-analysis">
    <div class="card">
      <h2>Анализ Codex</h2>
      ${analysisBlock('Собеседование', la.interview)}
      ${analysisBlock('Звонки', la.calls)}
      ${analysisBlock('Учебные агенты', la.training_agents)}
      ${analysisBlock('Операционка', la.ops)}
      ${(!la.interview && !la.calls && !la.training_agents && !la.ops) ? '<div class="empty">Анализ ещё не рассчитан.</div>' : ''}
    </div>
  </div>

  <div class="footer">
    Отчёт сформирован автоматически. Данные актуальны на момент экспорта.
  </div>
</div>

<script type="application/json" id="card-data">${embeddedJson}</script>
<script>
  // Minimal tab switching — no fetch, no external deps.
  document.querySelectorAll('.tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var target = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(tc) { tc.classList.remove('active'); });
      btn.classList.add('active');
      var el = document.getElementById('tab-' + target);
      if (el) el.classList.add('active');
    });
  });
</script>
</body>
</html>`;
}

/**
 * Export a candidate's report as a self-contained HTML file.
 *
 * Writes the file to <repoRoot>/tmp/exports/<filename>. Returns a public
 * descriptor with the filename + relative path + size. The absolute path
 * is NEVER returned (it would leak the server's directory layout).
 *
 * @param {string} baseKey
 * @param {object} opts
 *   - confirm_base_key: MUST equal baseKey (400 on mismatch)
 *   - admin_key: for audit_log (hashed)
 * @returns {{ok, base_key_redacted, file: {filename, path, size_bytes}, exported_at}}
 * @throws {Error} with .code = 'CANDIDATE_NOT_FOUND' | 'PURGE_CONFIRM_MISMATCH'
 */
function exportCandidateReportHtml(baseKey, opts) {
  const confirmBaseKey = String(opts && opts.confirm_base_key || '');
  const adminKey = opts && opts.admin_key || 'unknown';
  if (!confirmBaseKey || confirmBaseKey !== baseKey) {
    const err = new Error('confirm_base_key_mismatch');
    err.code = 'PURGE_CONFIRM_MISMATCH';
    throw err;
  }

  const card = getViewerCandidateCard(baseKey);
  if (!card || !card.candidate) {
    const err = new Error('candidate_not_found');
    err.code = 'CANDIDATE_NOT_FOUND';
    throw err;
  }

  const exportedAt = nowIso();
  const filename = buildExportFilename(card.candidate, exportedAt);
  const html = renderStaticReportHtml(card, exportedAt);

  // Write to <repoRoot>/tmp/exports/. Create the dir if missing.
  const repoRoot = path.resolve(__dirname, '..');
  const exportsDir = path.join(repoRoot, 'tmp', 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const absPath = path.join(exportsDir, filename);
  fs.writeFileSync(absPath, html, 'utf8');
  const sizeBytes = fs.statSync(absPath).size;

  // Audit log — payload contains only the filename + base_key hash, never
  // the card contents or absolute path.
  const db = ensureDb();
  appendAuditLog(db, adminKey, 'candidate_report_exported', 'candidate', null, baseKey, {
    filename,
    size_bytes: sizeBytes,
    exported_at: exportedAt,
  });

  return {
    ok: true,
    // Do NOT return base_key in the response — it's a technical id. The
    // caller already knows it (they passed it in the URL). We return a
    // redacted hint only.
    exported_at: exportedAt,
    file: {
      filename,
      // Relative path only — never leak the absolute server path.
      path: `tmp/exports/${filename}`,
      size_bytes: sizeBytes,
    },
  };
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
  purgeCandidateData,
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
  // STATIC-HTML-EXPORT-V1
  exportCandidateReportHtml,
  // Phase 3D2 constants exposed for routes
  IMPORT_REQUIRED_SOURCE,
  IMPORT_LABEL_RU,
};
