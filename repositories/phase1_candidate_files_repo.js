function mapCandidateFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    base_key: row.base_key,
    section: row.section,
    file_type: row.file_type,
    original_name: row.original_name,
    stored_path: row.stored_path,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    text_content: row.text_content,
    comment: row.comment,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createCandidateFilesRepo(db) {
  const insertStmt = db.prepare(`
    INSERT INTO candidate_files (
      candidate_id, base_key, section, file_type, original_name, stored_path,
      mime_type, size_bytes, text_content, comment, created_at, updated_at
    ) VALUES (
      @candidate_id, @base_key, @section, @file_type, @original_name, @stored_path,
      @mime_type, @size_bytes, @text_content, @comment, @created_at, @updated_at
    )
  `);

  const listByCandidateIdStmt = db.prepare(`
    SELECT * FROM candidate_files
    WHERE candidate_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
  `);

  const listBySectionStmt = db.prepare(`
    SELECT * FROM candidate_files
    WHERE candidate_id = ? AND section = ?
    ORDER BY datetime(created_at) DESC, id DESC
  `);

  return {
    create(record) {
      const result = insertStmt.run(record);
      return mapCandidateFile(db.prepare('SELECT * FROM candidate_files WHERE id = ?').get(result.lastInsertRowid));
    },
    listByCandidateId(candidateId) {
      return listByCandidateIdStmt.all(candidateId).map(mapCandidateFile);
    },
    listBySection(candidateId, section) {
      return listBySectionStmt.all(candidateId, section).map(mapCandidateFile);
    },
    // DATA-PURGE-V1: delete all candidate_files rows for a candidate.
    // Returns { count, stored_paths } — stored_paths lets the caller
    // unlink the underlying files on disk AFTER the DB commit.
    deleteByCandidateId(candidateId) {
      const rows = listByCandidateIdStmt.all(candidateId);
      const storedPaths = rows.map(r => r.stored_path).filter(Boolean);
      const info = db.prepare('DELETE FROM candidate_files WHERE candidate_id = ?').run(candidateId);
      return { count: info.changes || 0, stored_paths: storedPaths };
    },
  };
}

module.exports = {
  createCandidateFilesRepo,
};
