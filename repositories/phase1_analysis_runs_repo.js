function safeParseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function mapAnalysisRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    base_key: row.base_key,
    analysis_type: row.analysis_type,
    source: row.source,
    status: row.status,
    input_payload: safeParseJson(row.input_payload_json),
    output_payload: safeParseJson(row.output_payload_json),
    error_text: row.error_text,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

function createAnalysisRunsRepo(db) {
  const insertStmt = db.prepare(`
    INSERT INTO analysis_runs (
      candidate_id, base_key, analysis_type, source, status,
      input_payload_json, output_payload_json, error_text,
      created_at, finished_at
    ) VALUES (
      @candidate_id, @base_key, @analysis_type, @source, @status,
      @input_payload_json, @output_payload_json, @error_text,
      @created_at, @finished_at
    )
  `);

  const updateStmt = db.prepare(`
    UPDATE analysis_runs SET
      status = @status,
      output_payload_json = @output_payload_json,
      error_text = @error_text,
      finished_at = @finished_at
    WHERE id = @id
  `);

  const findByIdStmt = db.prepare('SELECT * FROM analysis_runs WHERE id = ?');
  const listByBaseKeyStmt = db.prepare(`
    SELECT * FROM analysis_runs
    WHERE base_key = ?
    ORDER BY datetime(created_at) DESC, id DESC
  `);
  const listByBaseKeyTypeStmt = db.prepare(`
    SELECT * FROM analysis_runs
    WHERE base_key = ? AND analysis_type = ?
    ORDER BY datetime(created_at) DESC, id DESC
  `);

  return {
    create(record) {
      const result = insertStmt.run(record);
      return mapAnalysisRun(findByIdStmt.get(result.lastInsertRowid));
    },
    update(patch) {
      updateStmt.run(patch);
      return mapAnalysisRun(findByIdStmt.get(patch.id));
    },
    findById(id) {
      return mapAnalysisRun(findByIdStmt.get(id));
    },
    listByBaseKey(baseKey) {
      return listByBaseKeyStmt.all(baseKey).map(mapAnalysisRun);
    },
    listByBaseKeyType(baseKey, analysisType) {
      return listByBaseKeyTypeStmt.all(baseKey, analysisType).map(mapAnalysisRun);
    },
  };
}

module.exports = {
  createAnalysisRunsRepo,
};
