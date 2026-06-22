function safeParse(value) {
  try { return value ? JSON.parse(value) : null; } catch (_) { return null; }
}

function mapQuestionBankRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    source_sheet: row.source_sheet,
    block: row.block,
    question_text: row.question_text,
    model_instruction: row.model_instruction,
    risk_type: row.risk_type,
    version: row.version,
    active: Boolean(row.active),
    raw_payload: safeParse(row.raw_payload_json),
    dedup_key: row.dedup_key,
    imported_at: row.imported_at,
    updated_at: row.updated_at,
  };
}

function createQuestionBanksRepo(db) {
  function upsert(tableName, record) {
    db.prepare(`
      INSERT INTO ${tableName} (
        source_sheet, block, question_text, model_instruction, risk_type,
        version, active, raw_payload_json, dedup_key, imported_at, updated_at
      ) VALUES (
        @source_sheet, @block, @question_text, @model_instruction, @risk_type,
        @version, @active, @raw_payload_json, @dedup_key, @imported_at, @updated_at
      )
      ON CONFLICT(dedup_key) DO UPDATE SET
        source_sheet = excluded.source_sheet,
        block = excluded.block,
        question_text = excluded.question_text,
        model_instruction = excluded.model_instruction,
        risk_type = excluded.risk_type,
        version = excluded.version,
        active = excluded.active,
        raw_payload_json = excluded.raw_payload_json,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at
    `).run(record);
  }

  function list(tableName) {
    return db.prepare(`SELECT * FROM ${tableName} ORDER BY source_sheet ASC, id ASC`).all().map(mapQuestionBankRow);
  }

  return {
    upsertInterview(record) { upsert('interview_question_bank', record); },
    upsertManual(record) { upsert('manual_question_bank', record); },
    listInterview() { return list('interview_question_bank'); },
    listManual() { return list('manual_question_bank'); },
  };
}

module.exports = {
  createQuestionBanksRepo,
};
