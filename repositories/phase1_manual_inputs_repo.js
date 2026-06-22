function mapManualInput(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    base_key: row.base_key,
    section: row.section,
    payload_json: row.payload_json,
    payload: safeParseJson(row.payload_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeParseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function createManualInputsRepo(db) {
  const upsertStmt = db.prepare(`
    INSERT INTO manual_inputs (
      candidate_id, base_key, section, payload_json, created_at, updated_at
    ) VALUES (
      @candidate_id, @base_key, @section, @payload_json, @created_at, @updated_at
    )
    ON CONFLICT(candidate_id, section) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  const listByCandidateIdStmt = db.prepare(`
    SELECT * FROM manual_inputs WHERE candidate_id = ? ORDER BY section ASC
  `);

  return {
    upsert(record) {
      upsertStmt.run(record);
      return mapManualInput(db.prepare('SELECT * FROM manual_inputs WHERE candidate_id = ? AND section = ?').get(record.candidate_id, record.section));
    },
    listByCandidateId(candidateId) {
      return listByCandidateIdStmt.all(candidateId).map(mapManualInput);
    },
  };
}

module.exports = {
  createManualInputsRepo,
};
