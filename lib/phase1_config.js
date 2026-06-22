const path = require('path');

const DEFAULT_SEGMENTS = [
  'Грузоперевозки',
  'Стройка',
  'Селлеры',
  'Микс',
  'Розница',
  'ВЭД',
];

const SOURCE_DEFINITIONS = {
  web_mvp: {
    source_code: 'web_mvp',
    source_name: 'Web MVP',
    envKey: 'PHASE1_WEB_MVP_SPREADSHEET_ID',
    spreadsheetId: '',
  },
  onboarding_route: {
    source_code: 'onboarding_route',
    source_name: 'Маршрут новичка',
    envKey: 'PHASE1_ROUTE_SPREADSHEET_ID',
    spreadsheetId: '',
  },
  bot_training: {
    source_code: 'bot_training',
    source_name: 'Бот учебки',
    envKey: 'PHASE1_BOT_TRAINING_SPREADSHEET_ID',
    spreadsheetId: '',
  },
  crosses_selection: {
    source_code: 'crosses_selection',
    source_name: 'Кроссы подбор / собесы',
    envKey: 'PHASE1_CROSSES_SELECTION_SPREADSHEET_ID',
    spreadsheetId: '',
  },
  automanual: {
    source_code: 'automanual',
    source_name: 'Автомануал',
    envKey: 'PHASE1_AUTOMANUAL_SPREADSHEET_ID',
    spreadsheetId: '',
  },
};

function isEnabled(value) {
  return String(value || '').trim() === '1';
}

function resolveDbPath(rawPath) {
  const configured = String(rawPath || './data/db/onboarding_phase1.sqlite').trim();
  if (!configured) {
    return path.join(__dirname, '..', 'data', 'db', 'onboarding_phase1.sqlite');
  }
  if (path.isAbsolute(configured)) return configured;
  return path.join(__dirname, '..', configured);
}

function getSourceDefinitions() {
  const out = {};
  for (const [code, def] of Object.entries(SOURCE_DEFINITIONS)) {
    out[code] = {
      ...def,
      spreadsheetId: String(process.env[def.envKey] || '').trim(),
    };
  }
  return out;
}

function getPhase1Config() {
  return {
    enabled: isEnabled(process.env.PHASE1_ADMIN_ENABLED),
    dbPath: resolveDbPath(process.env.PHASE1_DB_PATH),
    adminKey: String(process.env.ADMIN_KEY || ''),
    baseKeyPrefix: 'GTRAIN',
    allowedSegments: DEFAULT_SEGMENTS.slice(),
    googleClientPath: process.env.GOOGLE_OAUTH_CLIENT || path.join(process.env.HOME || '', 'web-server/secrets/google-oauth-client.json'),
    googleTokenPath: process.env.GOOGLE_OAUTH_TOKEN || path.join(process.env.HOME || '', 'web-server/secrets/google-oauth-token.json'),
    sources: getSourceDefinitions(),
  };
}

module.exports = {
  DEFAULT_SEGMENTS,
  SOURCE_DEFINITIONS,
  getPhase1Config,
};
