function mapSourceLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    base_key: row.base_key,
    source_code: row.source_code,
    source_name: row.source_name,
    legacy_key: row.legacy_key,
    legacy_id: row.legacy_id,
    comment: row.comment,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createSourceLinksRepo(db) {
  const upsertStmt = db.prepare(`
    INSERT INTO candidate_source_links (
      candidate_id, base_key, source_code, source_name, legacy_key, legacy_id, comment, created_at, updated_at
    ) VALUES (
      @candidate_id, @base_key, @source_code, @source_name, @legacy_key, @legacy_id, @comment, @created_at, @updated_at
    )
    ON CONFLICT(candidate_id, source_code) DO UPDATE SET
      source_name = excluded.source_name,
      legacy_key = excluded.legacy_key,
      legacy_id = excluded.legacy_id,
      comment = excluded.comment,
      updated_at = excluded.updated_at
  `);

  return {
    upsert(record) {
      upsertStmt.run(record);
      return mapSourceLink(db.prepare('SELECT * FROM candidate_source_links WHERE candidate_id = ? AND source_code = ?').get(record.candidate_id, record.source_code));
    },
    listByCandidateId(candidateId) {
      return db.prepare('SELECT * FROM candidate_source_links WHERE candidate_id = ? ORDER BY source_code ASC').all(candidateId).map(mapSourceLink);
    },
    findByCandidateAndSource(candidateId, sourceCode) {
      return mapSourceLink(db.prepare('SELECT * FROM candidate_source_links WHERE candidate_id = ? AND source_code = ?').get(candidateId, sourceCode));
    },
    // DATA-PURGE-V1: delete all source_links for a candidate.
    deleteByCandidateId(candidateId) {
      const info = db.prepare('DELETE FROM candidate_source_links WHERE candidate_id = ?').run(candidateId);
      return info.changes || 0;
    },
  };
}

module.exports = {
  createSourceLinksRepo,
};
