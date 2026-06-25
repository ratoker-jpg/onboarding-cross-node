function mapImportRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    base_key: row.base_key,
    source_code: row.source_code,
    status: row.status,
    rows_read: row.rows_read,
    rows_saved: row.rows_saved,
    error_text: row.error_text,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function createImportRunsRepo(db) {
  return {
    create(record) {
      const result = db.prepare(`
        INSERT INTO import_runs (
          base_key, source_code, status, rows_read, rows_saved, error_text, started_at, finished_at
        ) VALUES (
          @base_key, @source_code, @status, @rows_read, @rows_saved, @error_text, @started_at, @finished_at
        )
      `).run(record);
      return this.findById(result.lastInsertRowid);
    },
    update(id, patch) {
      db.prepare(`
        UPDATE import_runs
        SET status = @status,
            rows_read = @rows_read,
            rows_saved = @rows_saved,
            error_text = @error_text,
            finished_at = @finished_at
        WHERE id = @id
      `).run({ id, ...patch });
      return this.findById(id);
    },
    findById(id) {
      return mapImportRun(db.prepare('SELECT * FROM import_runs WHERE id = ?').get(id));
    },
    listByBaseKey(baseKey) {
      return db.prepare('SELECT * FROM import_runs WHERE base_key = ? ORDER BY id DESC').all(baseKey).map(mapImportRun);
    },
    // DATA-PURGE-V1: delete all import_runs for a candidate.
    // import_runs is keyed by base_key. Returns the number of rows deleted.
    deleteByBaseKey(baseKey) {
      const info = db.prepare('DELETE FROM import_runs WHERE base_key = ?').run(baseKey);
      return info.changes || 0;
    },
  };
}

module.exports = {
  createImportRunsRepo,
};
