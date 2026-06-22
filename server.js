const http = require('http');
const fs = require('fs');
const path = require('path');
const { OnboardingCore } = require('./onboarding_core');
const { createPhase1Routes } = require('./routes/phase1_admin_routes');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

const CONFIG = {
  spreadsheetId: process.env.SPREADSHEET_ID || '1cIUSFXfb3l1bc8E9ZWXs90osDVp7F1Wx511DNKQkvV4',
  clientPath: process.env.GOOGLE_OAUTH_CLIENT || path.join(process.env.HOME || '', 'web-server/secrets/google-oauth-client.json'),
  tokenPath: process.env.GOOGLE_OAUTH_TOKEN || path.join(process.env.HOME || '', 'web-server/secrets/google-oauth-token.json'),
  adminKey: process.env.ADMIN_KEY || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 60000),
  pushIntervalMs: Number(process.env.PUSH_INTERVAL_MS || 15000),
  pullOnStart: String(process.env.SHEETS_PULL_ON_START || 'true').toLowerCase() !== 'false',
  dataDir: path.join(__dirname, 'data'),
};

const PORT = Number(process.env.PORT || 8020);
const BASE_PATH = (process.env.BASE_PATH || '/onboarding_cross').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const core = new OnboardingCore(CONFIG);

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  if (res.writableEnded || res.headersSent) {
    console.warn(`send skipped: response already finished (${status})`);
    return false;
  }
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
  return true;
}
function sendJson(res, status, obj) { return send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8'); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 10_000_000) reject(new Error('Body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';
}
function serveStatic(req, res, cleanUrl) {
  let rel = cleanUrl.slice(BASE_PATH.length).replace(/^\//, '');
  if (!rel) rel = 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Файл не найден');
    if (res.writableEnded || res.headersSent) return;
    res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': file.endsWith('.html') ? 'no-store' : 'public, max-age=3600' });
    res.end(data);
  });
}

function normalizeApiAlias(cleanUrl) {
  const phase1Alias = `${BASE_PATH}/api/admin/phase1`;
  if (cleanUrl === phase1Alias || cleanUrl.startsWith(`${phase1Alias}/`)) {
    return `/api/admin/phase1${cleanUrl.slice(phase1Alias.length)}`;
  }
  const dashboardAlias = `${BASE_PATH}/api/dashboard/phase1`;
  if (cleanUrl === dashboardAlias || cleanUrl.startsWith(`${dashboardAlias}/`)) {
    return `/api/dashboard/phase1${cleanUrl.slice(dashboardAlias.length)}`;
  }
  return cleanUrl;
}

async function handleRun(req, res) {
  const body = await readBody(req);
  const payload = body ? JSON.parse(body) : {};
  const method = String(payload.method || '');
  const args = Array.isArray(payload.args) ? payload.args : [];
  if (!/^[A-Za-z0-9_]+$/.test(method)) return sendJson(res, 400, { ok: false, error: 'Некорректный method' });
  const result = await core.call(method, args);
  return sendJson(res, 200, { ok: true, result });
}

const phase1Routes = createPhase1Routes({
  adminKey: CONFIG.adminKey,
  readBody,
  sendJson,
});

const server = http.createServer(async (req, res) => {
  const cleanUrl = decodeURIComponent((req.url || '/').split('?')[0]);
  const apiUrl = normalizeApiAlias(cleanUrl);
  try {
    if (apiUrl === '/api/onboarding/health') {
      return sendJson(res, 200, {
        ok: true,
        app: 'onboarding_cross',
        mode: 'v3-cached',
        time: new Date().toISOString(),
        cachePulledAt: core.snapshot && core.snapshot.pulledAt,
        queueLength: core.readQueue().length,
      });
    }
    if (apiUrl === '/api/onboarding/sync/pull' && req.method === 'POST') {
      const snap = await core.pullSnapshot('manual_api');
      return sendJson(res, 200, { ok: true, pulledAt: snap.pulledAt });
    }
    if (apiUrl === '/api/onboarding/sync/push' && req.method === 'POST') {
      const r = await core.flushQueue();
      return sendJson(res, 200, r);
    }
    if (apiUrl === '/api/onboarding/run' && req.method === 'POST') return handleRun(req, res);
    if (await phase1Routes.handle(req, res, apiUrl)) return;
    if (cleanUrl === BASE_PATH || cleanUrl.startsWith(BASE_PATH + '/')) return serveStatic(req, res, cleanUrl);
    if (cleanUrl === '/') {
      if (res.writableEnded || res.headersSent) return;
      res.writeHead(302, { Location: BASE_PATH + '/' });
      return res.end();
    }
    return send(res, 404, 'Not found');
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    if (res.writableEnded || res.headersSent) return;
    return sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
  }
});

async function main() {
  if (process.argv.includes('--pull-once')) {
    await core.pullSnapshot('cli');
    console.log('pull done');
    return;
  }
  if (process.argv.includes('--push-once')) {
    const r = await core.flushQueue();
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  await core.init();

  setInterval(() => {
    core.ensureFresh('interval').catch(err => console.error('interval pull failed:', err.message));
  }, Math.max(15000, Number(CONFIG.cacheTtlMs || 60000)));

  setInterval(() => {
    core.flushQueue().catch(err => console.error('queue flush failed:', err.message));
  }, Math.max(5000, Number(CONFIG.pushIntervalMs || 15000)));

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`onboarding_cross v3-cached started: http://127.0.0.1:${PORT}${BASE_PATH}/`);
    console.log(`cache ttl: ${CONFIG.cacheTtlMs}ms, push interval: ${CONFIG.pushIntervalMs}ms`);
  });
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
