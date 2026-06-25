const {
  assertEnabled,
  getViewerCandidateCard,
  getViewerCandidates,
  getViewerDashboardSummary,
  getViewerHealth,
} = require('../services/phase1_candidate_service');
const { getPhase1Config } = require('../lib/phase1_config');

function createPhase1ViewerRoutes(options) {
  const { sendJson, readBody } = options;
  // readBody referenced for API symmetry; viewer endpoints are GET-only
  void readBody;

  function safeSendJson(res, status, payload) {
    if (res.writableEnded || res.headersSent) {
      console.warn(`phase1 viewer response skipped: already sent (${status})`);
      return true;
    }
    sendJson(res, status, payload);
    return true;
  }

  function sendError(res, status, payload) {
    return safeSendJson(res, status, { ok: false, ...payload });
  }

  function isAuthorized(req) {
    const config = getPhase1Config();
    if (!config.viewerEnabled) return { ok: false, reason: 'viewer_disabled' };
    const provided = String(req.headers['x-viewer-key'] || '').trim();
    if (!provided) return { ok: false, reason: 'unauthorized' };
    if (provided !== config.viewerKey) return { ok: false, reason: 'unauthorized' };
    return { ok: true };
  }

  async function handle(req, res, cleanUrl) {
    const isViewerPath = cleanUrl.startsWith('/api/viewer/phase1/');
    if (!isViewerPath) return false;

    try {
      assertEnabled();
    } catch (err) {
      return sendError(res, 503, { error: 'phase1_admin_disabled' });
    }

    const auth = isAuthorized(req);
    if (!auth.ok) {
      if (auth.reason === 'viewer_disabled') return sendError(res, 503, { error: 'viewer_disabled' });
      return sendError(res, 401, { error: 'unauthorized' });
    }

    try {
      if (cleanUrl === '/api/viewer/phase1/health' && req.method === 'GET') {
        return safeSendJson(res, 200, getViewerHealth());
      }

      if (cleanUrl === '/api/viewer/phase1/summary' && req.method === 'GET') {
        return safeSendJson(res, 200, getViewerDashboardSummary());
      }

      if (cleanUrl === '/api/viewer/phase1/candidates' && req.method === 'GET') {
        const url = new URL(req.url || '', 'http://localhost');
        const params = url.searchParams;
        const filters = {
          segment: params.get('segment') || '',
          status: params.get('status') || '',
          risk_level: params.get('risk_level') || '',
        };
        const candidates = getViewerCandidates(filters);
        return safeSendJson(res, 200, { ok: true, candidates });
      }

      const cardMatch = cleanUrl.match(/^\/api\/viewer\/phase1\/candidates\/([^/]+)\/card$/);
      if (cardMatch && req.method === 'GET') {
        const card = getViewerCandidateCard(cardMatch[1]);
        if (!card) return sendError(res, 404, { error: 'candidate_not_found' });
        return safeSendJson(res, 200, { ok: true, ...card });
      }

      const scoresMatch = cleanUrl.match(/^\/api\/viewer\/phase1\/candidates\/([^/]+)\/scores$/);
      if (scoresMatch && req.method === 'GET') {
        const card = getViewerCandidateCard(scoresMatch[1]);
        if (!card) return sendError(res, 404, { error: 'candidate_not_found' });
        return safeSendJson(res, 200, { ok: true, scores: card.scores });
      }

      return sendError(res, 404, { error: 'viewer_route_not_found' });
    } catch (err) {
      if (err && err.code === 'CANDIDATE_NOT_FOUND') return sendError(res, 404, { error: 'candidate_not_found' });
      return sendError(res, 500, { error: err && err.message ? err.message : 'viewer_unknown_error' });
    }
  }

  return { handle };
}

module.exports = {
  createPhase1ViewerRoutes,
};
