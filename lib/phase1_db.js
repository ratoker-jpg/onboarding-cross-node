const fs = require('fs');
const path = require('path');
const { getPhase1Config } = require('./phase1_config');

let cachedDb = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_key TEXT NOT NULL UNIQUE,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  seller_segment TEXT NOT NULL,
  direction TEXT NOT NULL,
  mentor TEXT,
  recruiter TEXT,
  test_day_started_at TEXT,
  immersion_started_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  base_key TEXT NOT NULL,
  session_key TEXT NOT NULL UNIQUE,
  key_type TEXT NOT NULL,
  product_code TEXT,
  team_id TEXT,
  team_name TEXT,
  legacy_target TEXT,
  limit_value INTEGER,
  final_limit INTEGER,
  final_equals_limit INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_candidate_keys_candidate_id ON candidate_keys(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_keys_base_key ON candidate_keys(base_key);

CREATE TABLE IF NOT EXISTS manual_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  base_key TEXT NOT NULL,
  section TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(candidate_id, section),
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS candidate_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  base_key TEXT NOT NULL,
  section TEXT NOT NULL,
  file_type TEXT,
  original_name TEXT,
  stored_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  text_content TEXT,
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_candidate_files_candidate_id ON candidate_files(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_files_base_key ON candidate_files(base_key);
CREATE INDEX IF NOT EXISTS idx_candidate_files_section ON candidate_files(candidate_id, section);

CREATE TABLE IF NOT EXISTS interview_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL UNIQUE,
  base_key TEXT NOT NULL,
  interview_date TEXT,
  interview_transcript TEXT,
  sales_motivation_score REAL,
  antifragility_score REAL,
  rotation_risk TEXT,
  cold_sales_readiness TEXT,
  summary TEXT,
  raw_ai_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_day_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL UNIQUE,
  base_key TEXT NOT NULL,
  test_day_key TEXT,
  scores_json TEXT,
  open_answers_json TEXT,
  voice_result_json TEXT,
  summary TEXT,
  raw_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS immersion_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL UNIQUE,
  base_key TEXT NOT NULL,
  current_day INTEGER,
  days_completed INTEGER,
  blocks_completed_percent REAL,
  materials_opened_percent REAL,
  help_requests_count INTEGER,
  delays_count INTEGER,
  immersion_status TEXT,
  raw_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_bot_dialogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  base_key TEXT NOT NULL,
  training_key TEXT,
  team_id TEXT,
  team_name TEXT,
  role_id TEXT,
  role_client TEXT,
  role_business TEXT,
  dialog_date TEXT,
  result TEXT,
  transcript_text TEXT,
  role_profile_json TEXT,
  analysis_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_training_bot_dialogs_candidate_id ON training_bot_dialogs(candidate_id);

CREATE TABLE IF NOT EXISTS real_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  base_key TEXT NOT NULL,
  period TEXT,
  call_no INTEGER,
  call_date TEXT,
  product TEXT,
  transcript TEXT,
  manual_scores_json TEXT,
  ai_analysis_json TEXT,
  coach_comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_real_calls_candidate_id ON real_calls(candidate_id);

CREATE TABLE IF NOT EXISTS ops_and_final_test (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL UNIQUE,
  base_key TEXT NOT NULL,
  day_3_talk_time REAL,
  day_4_talk_time REAL,
  day_5_talk_time REAL,
  calls_over_2min_percent REAL,
  goals_filled_quality REAL,
  statuses_quality REAL,
  overdue_goals INTEGER,
  final_test_score REAL,
  final_test_percent REAL,
  weak_topics_json TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL UNIQUE,
  base_key TEXT NOT NULL,
  hard_score REAL,
  soft_score REAL,
  learning_score REAL,
  discipline_score REAL,
  call_quality_score REAL,
  risk_level TEXT,
  final_status TEXT,
  strengths_json TEXT,
  growth_zones_json TEXT,
  risks_json TEXT,
  recommendations_json TEXT,
  summary_text TEXT,
  raw_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS legacy_targets_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  candidate_key_id INTEGER,
  base_key TEXT NOT NULL,
  session_key TEXT,
  legacy_target TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
  FOREIGN KEY (candidate_key_id) REFERENCES candidate_keys(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_legacy_targets_map_candidate_id ON legacy_targets_map(candidate_id);

CREATE TABLE IF NOT EXISTS candidate_source_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  base_key TEXT NOT NULL,
  source_code TEXT NOT NULL,
  source_name TEXT,
  legacy_key TEXT,
  legacy_id TEXT,
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(candidate_id, source_code),
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_candidate_source_links_base_key ON candidate_source_links(base_key);

CREATE TABLE IF NOT EXISTS interview_question_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_sheet TEXT NOT NULL,
  block TEXT,
  question_text TEXT,
  model_instruction TEXT,
  risk_type TEXT,
  version TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  raw_payload_json TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manual_question_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_sheet TEXT NOT NULL,
  block TEXT,
  question_text TEXT,
  model_instruction TEXT,
  risk_type TEXT,
  version TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  raw_payload_json TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_key TEXT NOT NULL,
  source_code TEXT NOT NULL,
  status TEXT NOT NULL,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_saved INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_runs_base_key ON import_runs(base_key);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_key_hash TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  base_key TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_base_key ON audit_log(base_key);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  base_key TEXT NOT NULL,
  analysis_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'success',
  input_payload_json TEXT,
  output_payload_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_base_key ON analysis_runs(base_key);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_type ON analysis_runs(analysis_type);

CREATE TABLE IF NOT EXISTS candidate_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL UNIQUE,
  base_key TEXT NOT NULL,
  hard_score REAL,
  soft_score REAL,
  learning_score REAL,
  discipline_score REAL,
  call_quality_score REAL,
  ops_score REAL,
  final_test_score REAL,
  risk_score REAL,
  overall_score REAL,
  risk_level TEXT,
  final_status TEXT,
  recommendation TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  analysis_run_id INTEGER,
  score_breakdown_json TEXT,
  strengths_json TEXT,
  growth_zones_json TEXT,
  red_flags_json TEXT,
  coach_recommendations_json TEXT,
  has_calls_data INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
  FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_candidate_scores_base_key ON candidate_scores(base_key);
CREATE INDEX IF NOT EXISTS idx_candidate_scores_status ON candidate_scores(final_status);
CREATE INDEX IF NOT EXISTS idx_candidate_scores_risk ON candidate_scores(risk_level);
`;

const COLUMN_MIGRATIONS = {
  test_day_snapshot: {
    source: "TEXT",
    legacy_key: "TEXT",
    candidate_row_json: "TEXT",
    build_row_json: "TEXT",
    voice_bot_row_json: "TEXT",
    imported_at: "TEXT",
  },
  immersion_snapshot: {
    source: "TEXT",
    legacy_key: "TEXT",
    newbie_row_json: "TEXT",
    progress_rows_json: "TEXT",
    tracking_rows_json: "TEXT",
    material_sessions_json: "TEXT",
    summary_row_json: "TEXT",
    help_requests_json: "TEXT",
    imported_at: "TEXT",
  },
  training_bot_dialogs: {
    legacy_key: "TEXT",
    role_title: "TEXT",
    role_company: "TEXT",
    role_client_name: "TEXT",
    role_tax_system: "TEXT",
    role_business_type: "TEXT",
    role_success_criteria: "TEXT",
    role_failure_criteria: "TEXT",
    role_target_action: "TEXT",
    role_objections: "TEXT",
    role_tone: "TEXT",
    role_extra_profile: "TEXT",
    result_payload_json: "TEXT",
    source_payload_json: "TEXT",
    dedup_key: "TEXT",
    imported_at: "TEXT",
  },
};

function createSqliteDependencyError(cause) {
  const error = new Error('sqlite_dependency_missing');
  error.code = 'SQLITE_DEPENDENCY_MISSING';
  if (cause) error.cause = cause;
  return error;
}

function requireSqlite() {
  try {
    return require('better-sqlite3');
  } catch (err) {
    throw createSqliteDependencyError(err);
  }
}

function hasColumn(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some(row => row.name === columnName);
}

function ensureColumn(db, tableName, columnName, columnSql) {
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
  }
}

function runColumnMigrations(db) {
  for (const [tableName, columns] of Object.entries(COLUMN_MIGRATIONS)) {
    for (const [columnName, columnSql] of Object.entries(columns)) {
      ensureColumn(db, tableName, columnName, columnSql);
    }
  }
}

function ensurePhase1Schema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  runColumnMigrations(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_training_bot_dialogs_base_key ON training_bot_dialogs(base_key);
    CREATE INDEX IF NOT EXISTS idx_training_bot_dialogs_dedup_key ON training_bot_dialogs(dedup_key);
  `);
  return db;
}

function openPhase1Db() {
  const BetterSqlite3 = requireSqlite();
  const config = getPhase1Config();
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  return ensurePhase1Schema(new BetterSqlite3(config.dbPath));
}

function getPhase1Db() {
  if (!cachedDb) cachedDb = openPhase1Db();
  return cachedDb;
}

function getPhase1DbStatus() {
  const config = getPhase1Config();
  try {
    requireSqlite();
    return {
      ok: true,
      dbPath: config.dbPath,
      dependency: 'better-sqlite3',
    };
  } catch (err) {
    return {
      ok: false,
      dbPath: config.dbPath,
      dependency: 'better-sqlite3',
      error: err.message,
      code: err.code || 'UNKNOWN',
    };
  }
}

module.exports = {
  SCHEMA_SQL,
  createSqliteDependencyError,
  ensurePhase1Schema,
  getPhase1Db,
  getPhase1DbStatus,
  openPhase1Db,
};
