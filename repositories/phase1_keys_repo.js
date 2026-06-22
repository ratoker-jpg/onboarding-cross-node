function mapKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    base_key: row.base_key,
    session_key: row.session_key,
    key_type: row.key_type,
    product_code: row.product_code,
    team_id: row.team_id,
    team_name: row.team_name,
    legacy_target: row.legacy_target,
    limit_value: row.limit_value,
    final_limit: row.final_limit,
    final_equals_limit: Boolean(row.final_equals_limit),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createKeysRepo(db) {
  const insertKeyStmt = db.prepare(`
    INSERT INTO candidate_keys (
      candidate_id, base_key, session_key, key_type, product_code,
      team_id, team_name, legacy_target, limit_value, final_limit,
      final_equals_limit, status, created_at, updated_at
    ) VALUES (
      @candidate_id, @base_key, @session_key, @key_type, @product_code,
      @team_id, @team_name, @legacy_target, @limit_value, @final_limit,
      @final_equals_limit, @status, @created_at, @updated_at
    )
  `);

  const listByCandidateIdStmt = db.prepare(`
    SELECT * FROM candidate_keys WHERE candidate_id = ? ORDER BY id ASC
  `);

  const listByBaseKeyStmt = db.prepare(`
    SELECT * FROM candidate_keys WHERE base_key = ? ORDER BY id ASC
  `);

  const countByKeyTypeStmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM candidate_keys
    WHERE base_key = ? AND key_type = ? AND COALESCE(product_code, '') = COALESCE(?, '')
  `);

  return {
    insertMany(rows) {
      const inserted = [];
      for (const row of rows) {
        const result = insertKeyStmt.run(row);
        inserted.push(this.findById(result.lastInsertRowid));
      }
      return inserted;
    },
    findById(id) {
      return mapKey(db.prepare('SELECT * FROM candidate_keys WHERE id = ?').get(id));
    },
    listByCandidateId(candidateId) {
      return listByCandidateIdStmt.all(candidateId).map(mapKey);
    },
    listByBaseKey(baseKey) {
      return listByBaseKeyStmt.all(baseKey).map(mapKey);
    },
    countByType(baseKey, keyType, productCode) {
      return Number(countByKeyTypeStmt.get(baseKey, keyType, productCode).total || 0);
    },
  };
}

module.exports = {
  createKeysRepo,
};
