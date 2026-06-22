function safeParseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function mapAiProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    base_key: row.base_key,
    hard_score: row.hard_score,
    soft_score: row.soft_score,
    learning_score: row.learning_score,
    discipline_score: row.discipline_score,
    call_quality_score: row.call_quality_score,
    risk_level: row.risk_level,
    final_status: row.final_status,
    strengths: safeParseJson(row.strengths_json),
    growth_zones: safeParseJson(row.growth_zones_json),
    risks: safeParseJson(row.risks_json),
    recommendations: safeParseJson(row.recommendations_json),
    summary_text: row.summary_text,
    raw_payload: safeParseJson(row.raw_payload_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createAiProfileRepo(db) {
  const upsertStmt = db.prepare(`
    INSERT INTO ai_profile (
      candidate_id, base_key, hard_score, soft_score, learning_score,
      discipline_score, call_quality_score, risk_level, final_status,
      strengths_json, growth_zones_json, risks_json, recommendations_json,
      summary_text, raw_payload_json, created_at, updated_at
    ) VALUES (
      @candidate_id, @base_key, @hard_score, @soft_score, @learning_score,
      @discipline_score, @call_quality_score, @risk_level, @final_status,
      @strengths_json, @growth_zones_json, @risks_json, @recommendations_json,
      @summary_text, @raw_payload_json, @created_at, @updated_at
    )
    ON CONFLICT(candidate_id) DO UPDATE SET
      hard_score = excluded.hard_score,
      soft_score = excluded.soft_score,
      learning_score = excluded.learning_score,
      discipline_score = excluded.discipline_score,
      call_quality_score = excluded.call_quality_score,
      risk_level = excluded.risk_level,
      final_status = excluded.final_status,
      strengths_json = excluded.strengths_json,
      growth_zones_json = excluded.growth_zones_json,
      risks_json = excluded.risks_json,
      recommendations_json = excluded.recommendations_json,
      summary_text = excluded.summary_text,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = excluded.updated_at
  `);

  const getByCandidateIdStmt = db.prepare(`
    SELECT * FROM ai_profile WHERE candidate_id = ?
  `);

  return {
    upsert(record) {
      upsertStmt.run(record);
      return mapAiProfile(getByCandidateIdStmt.get(record.candidate_id));
    },
    getByCandidateId(candidateId) {
      return mapAiProfile(getByCandidateIdStmt.get(candidateId));
    },
  };
}

module.exports = {
  createAiProfileRepo,
};
