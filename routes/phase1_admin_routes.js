const {
  addKeysToCandidate,
  appendCallToManualInput,
  assertEnabled,
  buildImportSummary,
  checkImportSourceLink,
  createCandidateWithKeys,
  getCandidateCard,
  getCandidateIntakeView,
  getCandidateScores,
  getCandidateScoresHistory,
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
  recalculateCandidateScores,
  saveAiProfile,
  saveCandidateFile,
  saveCandidateFileWithManualInput,
  saveCandidateScores,
  saveManualInput,
  upsertSourceLink,
} = require('../services/phase1_candidate_service');

function createPhase1Routes(options) {
  const { sendJson, readBody, adminKey } = options;

  function isAuthorized(req) {
    const provided = String(req.headers['x-admin-key'] || '').trim();
    return Boolean(adminKey) && Boolean(provided) && provided === adminKey;
  }

  function readJsonBody(req) {
    return readBody(req).then(body => {
      if (!body) return {};
      return JSON.parse(body);
    });
  }

  function safeSendJson(res, status, payload) {
    if (res.writableEnded || res.headersSent) {
      console.warn(`phase1 response skipped: already sent (${status})`);
      return true;
    }
    sendJson(res, status, payload);
    return true;
  }

  function sendDisabled(res) {
    return safeSendJson(res, 404, { ok: false, error: 'phase1_admin_disabled' });
  }

  function sendError(res, status, payload) {
    return safeSendJson(res, status, { ok: false, ...payload });
  }

  function handleError(res, err) {
    if (res.writableEnded || res.headersSent) {
      console.error('phase1 error after response sent:', err && err.stack ? err.stack : err);
      return true;
    }
    const source = err && (err.source || err.source_code) ? (err.source || err.source_code) : undefined;
    const importRun = err && err.import_run ? err.import_run : undefined;
    if (err && err.code === 'SQLITE_DEPENDENCY_MISSING') return sendError(res, 503, { error: 'sqlite_dependency_missing', source, import_run: importRun });
    if (err && err.code === 'INVALID_SELLER_SEGMENT') return sendError(res, 400, { error: 'invalid_seller_segment', source });
    if (err && err.code === 'INVALID_MANUAL_INPUT_SECTION') return sendError(res, 400, { error: 'invalid_manual_input_section', source });
    if (err && err.code === 'INVALID_FILE_SECTION') return sendError(res, 400, { error: 'invalid_file_section', source });
    if (err && err.code === 'INVALID_FILE_PAYLOAD') return sendError(res, 400, { error: 'file_content_required', source });
    if (err && err.code === 'INVALID_SOURCE_CODE') return sendError(res, 400, { error: 'invalid_source_code', source });
    if (err && err.code === 'INVALID_SCORE_VALUE') return sendError(res, 400, { error: 'invalid_score_value', field: err.field });
    if (err && err.code === 'INVALID_SCORE_RANGE') return sendError(res, 400, { error: 'invalid_score_range', field: err.field });
    if (err && err.code === 'EMPTY_CALL_TRANSCRIPT') return sendError(res, 400, { error: 'empty_call_transcript' });
    if (err && err.code === 'CANDIDATE_NOT_FOUND') return sendError(res, 404, { error: 'candidate_not_found', source });
    if (err && err.code === 'SOURCE_LINK_NOT_FOUND') return sendError(res, 404, { error: err.message, source, import_run: importRun });
    if (err && err.code === 'PHASE1_SOURCE_CONFIG_MISSING') return sendError(res, 503, { error: err.message, source, import_run: importRun });
    if (err && err.code === 'PHASE1_IMPORT_READ_ERROR') return sendError(res, 400, { error: err.message, source, import_run: importRun });
    if (err && err.code === 'PHASE1_ADMIN_DISABLED') return sendDisabled(res);
    return sendError(res, 500, { error: err && err.message ? err.message : 'phase1_unknown_error', source, import_run: importRun });
  }

  async function handle(req, res, cleanUrl) {
    const isPhase1Path = cleanUrl.startsWith('/api/admin/phase1/') || cleanUrl === '/api/dashboard/phase1/mvp';
    if (!isPhase1Path) return false;

    try {
      assertEnabled();
    } catch (err) {
      return sendDisabled(res);
    }

    if (!isAuthorized(req)) {
      return safeSendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    try {
      if (cleanUrl === '/api/admin/phase1/health' && req.method === 'GET') {
        const health = getPhase1Health();
        return safeSendJson(res, health.ok ? 200 : 503, health);
      }

      if (cleanUrl === '/api/admin/phase1/candidates' && req.method === 'POST') {
        const payload = await readJsonBody(req);
        const created = createCandidateWithKeys(payload, adminKey);
        return safeSendJson(res, 200, {
          ok: true,
          candidate: {
            base_key: created.candidate.base_key,
            full_name: created.candidate.full_name,
          },
          keys: created.keys.map(key => ({
            session_key: key.session_key,
            key_type: key.key_type,
            product_code: key.product_code,
            legacy_target: key.legacy_target,
          })),
        });
      }

      if (cleanUrl === '/api/admin/phase1/candidates' && req.method === 'GET') {
        return safeSendJson(res, 200, { ok: true, candidates: listCandidates() });
      }

      const candidateMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)$/);
      if (candidateMatch && req.method === 'GET') {
        const card = getCandidateCard(candidateMatch[1]);
        if (!card) return safeSendJson(res, 404, { ok: false, error: 'candidate_not_found' });
        return safeSendJson(res, 200, { ok: true, ...card });
      }

      const completenessMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/completeness$/);
      if (completenessMatch && req.method === 'GET') {
        return safeSendJson(res, 200, getCompleteness(completenessMatch[1]));
      }

      const filesMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/files$/);
      if (filesMatch && req.method === 'POST') {
        const payload = await readJsonBody(req);
        return safeSendJson(res, 200, { ok: true, file: saveCandidateFile(filesMatch[1], payload, adminKey) });
      }

      const keysMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/keys$/);
      if (keysMatch && req.method === 'GET') {
        const card = getCandidateCard(keysMatch[1]);
        if (!card) return safeSendJson(res, 404, { ok: false, error: 'candidate_not_found' });
        return safeSendJson(res, 200, { ok: true, keys: card.keys });
      }
      if (keysMatch && req.method === 'POST') {
        const payload = await readJsonBody(req);
        const keys = addKeysToCandidate(keysMatch[1], payload.keys || [], adminKey);
        return safeSendJson(res, 200, { ok: true, keys });
      }

      const sourceLinksMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/source-links$/);
      if (sourceLinksMatch && req.method === 'GET') {
        return safeSendJson(res, 200, { ok: true, source_links: listSourceLinks(sourceLinksMatch[1]) });
      }
      if (sourceLinksMatch && req.method === 'POST') {
        const payload = await readJsonBody(req);
        return safeSendJson(res, 200, { ok: true, source_link: upsertSourceLink(sourceLinksMatch[1], payload, adminKey) });
      }

      const manualInputMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/manual-input$/);
      if (manualInputMatch && req.method === 'POST') {
        const payload = await readJsonBody(req);
        const saved = saveManualInput(manualInputMatch[1], String(payload.section || '').trim(), payload.payload || payload, adminKey);
        return safeSendJson(res, 200, { ok: true, manual_input: saved });
      }

      const aiProfileMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/ai-profile$/);
      if (aiProfileMatch && req.method === 'POST') {
        const payload = await readJsonBody(req);
        return safeSendJson(res, 200, { ok: true, ai_profile: saveAiProfile(aiProfileMatch[1], payload, adminKey) });
      }

      const importTestDayMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/import\/test-day$/);
      if (importTestDayMatch && req.method === 'POST') return safeSendJson(res, 200, await importTestDay(importTestDayMatch[1], adminKey));

      const importImmersionMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/import\/immersion$/);
      if (importImmersionMatch && req.method === 'POST') return safeSendJson(res, 200, await importImmersion(importImmersionMatch[1], adminKey));

      const importTrainingBotMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/import\/training-bot$/);
      if (importTrainingBotMatch && req.method === 'POST') return safeSendJson(res, 200, await importTrainingBot(importTrainingBotMatch[1], adminKey));

      const importInterviewMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/import\/interview-questions$/);
      if (importInterviewMatch && req.method === 'POST') return safeSendJson(res, 200, await importInterviewQuestions(importInterviewMatch[1], adminKey));

      const importManualMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/import\/manual-questions$/);
      if (importManualMatch && req.method === 'POST') return safeSendJson(res, 200, await importManualQuestions(importManualMatch[1], adminKey));

      const importAllMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/import\/all$/);
      if (importAllMatch && req.method === 'POST') return safeSendJson(res, 200, await importAll(importAllMatch[1], adminKey));

      const importSummaryMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/import\/summary$/);
      if (importSummaryMatch && req.method === 'GET') return safeSendJson(res, 200, { ok: true, import_summary: getImportSummary(importSummaryMatch[1]) });

      const scoresMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/scores$/);
      if (scoresMatch && req.method === 'GET') {
        try {
          const scores = getCandidateScores(scoresMatch[1]);
          return safeSendJson(res, 200, { ok: true, scores });
        } catch (err) {
          if (err && err.code === 'CANDIDATE_NOT_FOUND') return sendError(res, 404, { error: 'candidate_not_found' });
          throw err;
        }
      }
      if (scoresMatch && req.method === 'POST') {
        const payload = await readJsonBody(req);
        const saved = saveCandidateScores(scoresMatch[1], payload || {}, adminKey);
        return safeSendJson(res, 200, { ok: true, scores: saved });
      }

      const scoresRecalcMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/scores\/recalculate$/);
      if (scoresRecalcMatch && req.method === 'POST') {
        try {
          const updated = recalculateCandidateScores(scoresRecalcMatch[1], adminKey);
          return safeSendJson(res, 200, { ok: true, scores: updated });
        } catch (err) {
          if (err && err.code === 'SCORES_NOT_FOUND') return sendError(res, 404, { error: 'scores_not_found' });
          throw err;
        }
      }

      const scoresHistoryMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/scores\/history$/);
      if (scoresHistoryMatch && req.method === 'GET') {
        const history = getCandidateScoresHistory(scoresHistoryMatch[1]);
        return safeSendJson(res, 200, { ok: true, history });
      }

      // Phase 3D2: import source-link pre-check
      const importCheckMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/import-check\/([^/]+)$/);
      if (importCheckMatch && req.method === 'GET') {
        const check = checkImportSourceLink(importCheckMatch[1], importCheckMatch[2]);
        return safeSendJson(res, 200, { ok: true, ...check });
      }

      // Phase 3D2: append a call item to manual_inputs[calls_*].calls[]
      const callAppendMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/calls\/(calls_start|calls_middle|calls_final)$/);
      if (callAppendMatch && req.method === 'POST') {
        const payload = await readJsonBody(req);
        const result = appendCallToManualInput(callAppendMatch[1], callAppendMatch[2], payload || {}, adminKey);
        return safeSendJson(res, 200, { ok: true, ...result });
      }

      // Phase 3D2: upload file + upsert linked manual_input in one operation
      const filesWithManualMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/files-with-manual$/);
      if (filesWithManualMatch && req.method === 'POST') {
        const payload = await readJsonBody(req);
        const result = saveCandidateFileWithManualInput(filesWithManualMatch[1], payload || {}, adminKey);
        return safeSendJson(res, 200, { ok: true, ...result });
      }

      // Phase 3D2: unified intake view (manual_inputs + files grouped by section)
      const intakeViewMatch = cleanUrl.match(/^\/api\/admin\/phase1\/candidates\/([^/]+)\/intake-view$/);
      if (intakeViewMatch && req.method === 'GET') {
        const view = getCandidateIntakeView(intakeViewMatch[1]);
        return safeSendJson(res, 200, { ok: true, ...view });
      }

      if (cleanUrl === '/api/dashboard/phase1/mvp' && req.method === 'GET') {
        return safeSendJson(res, 200, getDashboardMvp());
      }

      return safeSendJson(res, 404, { ok: false, error: 'phase1_route_not_found' });
    } catch (err) {
      return handleError(res, err);
    }
  }

  return { handle };
}

module.exports = {
  createPhase1Routes,
};
