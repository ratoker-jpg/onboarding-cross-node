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
  };
}

module.exports = {
  createImportRunsRepo,
};
