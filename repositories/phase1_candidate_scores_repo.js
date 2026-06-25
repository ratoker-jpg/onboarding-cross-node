function safeParseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function mapCandidateScores(row) {
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
    ops_score: row.ops_score,
    final_test_score: row.final_test_score,
    risk_score: row.risk_score,
    overall_score: row.overall_score,
    risk_level: row.risk_level,
    final_status: row.final_status,
    recommendation: row.recommendation,
    source: row.source,
    analysis_run_id: row.analysis_run_id,
    score_breakdown: safeParseJson(row.score_breakdown_json),
    strengths: safeParseJson(row.strengths_json),
    growth_zones: safeParseJson(row.growth_zones_json),
    red_flags: safeParseJson(row.red_flags_json),
    coach_recommendations: safeParseJson(row.coach_recommendations_json),
    has_calls_data: Boolean(row.has_calls_data),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createCandidateScoresRepo(db) {
  const upsertStmt = db.prepare(`
    INSERT INTO candidate_scores (
      candidate_id, base_key,
      hard_score, soft_score, learning_score, discipline_score,
      call_quality_score, ops_score, final_test_score, risk_score, overall_score,
      risk_level, final_status, recommendation,
      source, analysis_run_id,
      score_breakdown_json, strengths_json, growth_zones_json, red_flags_json, coach_recommendations_json,
      has_calls_data, created_at, updated_at
    ) VALUES (
      @candidate_id, @base_key,
      @hard_score, @soft_score, @learning_score, @discipline_score,
      @call_quality_score, @ops_score, @final_test_score, @risk_score, @overall_score,
      @risk_level, @final_status, @recommendation,
      @source, @analysis_run_id,
      @score_breakdown_json, @strengths_json, @growth_zones_json, @red_flags_json, @coach_recommendations_json,
      @has_calls_data, @created_at, @updated_at
    )
    ON CONFLICT(candidate_id) DO UPDATE SET
      hard_score = excluded.hard_score,
      soft_score = excluded.soft_score,
      learning_score = excluded.learning_score,
      discipline_score = excluded.discipline_score,
      call_quality_score = excluded.call_quality_score,
      ops_score = excluded.ops_score,
      final_test_score = excluded.final_test_score,
      risk_score = excluded.risk_score,
      overall_score = excluded.overall_score,
      risk_level = excluded.risk_level,
      final_status = excluded.final_status,
      recommendation = excluded.recommendation,
      source = excluded.source,
      analysis_run_id = excluded.analysis_run_id,
      score_breakdown_json = excluded.score_breakdown_json,
      strengths_json = excluded.strengths_json,
      growth_zones_json = excluded.growth_zones_json,
      red_flags_json = excluded.red_flags_json,
      coach_recommendations_json = excluded.coach_recommendations_json,
      has_calls_data = excluded.has_calls_data,
      updated_at = excluded.updated_at
  `);

  const getByCandidateIdStmt = db.prepare('SELECT * FROM candidate_scores WHERE candidate_id = ?');
  const getByBaseKeyStmt = db.prepare('SELECT * FROM candidate_scores WHERE base_key = ?');
  const listAllStmt = db.prepare(`
    SELECT * FROM candidate_scores
    ORDER BY datetime(updated_at) DESC, id DESC
  `);

  return {
    upsert(record) {
      upsertStmt.run(record);
      return mapCandidateScores(getByCandidateIdStmt.get(record.candidate_id));
    },
    getByCandidateId(candidateId) {
      return mapCandidateScores(getByCandidateIdStmt.get(candidateId));
    },
    getByBaseKey(baseKey) {
      return mapCandidateScores(getByBaseKeyStmt.get(baseKey));
    },
    listAll() {
      return listAllStmt.all().map(mapCandidateScores);
    },
    // DATA-PURGE-V1: delete the candidate_scores row for a candidate.
    // Returns 1 if deleted, 0 if there was no row.
    deleteByCandidateId(candidateId) {
      const info = db.prepare('DELETE FROM candidate_scores WHERE candidate_id = ?').run(candidateId);
      return info.changes || 0;
    },
  };
}

module.exports = {
  createCandidateScoresRepo,
};
