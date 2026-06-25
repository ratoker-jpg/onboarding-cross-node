function mapCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    base_key: row.base_key,
    last_name: row.last_name,
    first_name: row.first_name,
    full_name: row.full_name,
    seller_segment: row.seller_segment,
    direction: row.direction,
    mentor: row.mentor,
    recruiter: row.recruiter,
    test_day_started_at: row.test_day_started_at,
    immersion_started_at: row.immersion_started_at,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createCandidatesRepo(db) {
  const insertCandidate = db.prepare(`
    INSERT INTO candidates (
      base_key, last_name, first_name, full_name, seller_segment, direction,
      mentor, recruiter, test_day_started_at, immersion_started_at, status,
      created_at, updated_at
    ) VALUES (
      @base_key, @last_name, @first_name, @full_name, @seller_segment, @direction,
      @mentor, @recruiter, @test_day_started_at, @immersion_started_at, @status,
      @created_at, @updated_at
    )
  `);

  const listCandidatesStmt = db.prepare(`
    SELECT * FROM candidates
    ORDER BY datetime(created_at) DESC, id DESC
  `);

  const findByBaseKeyStmt = db.prepare(`
    SELECT * FROM candidates WHERE base_key = ?
  `);

  const getMaxBaseKeyStmt = db.prepare(`
    SELECT base_key FROM candidates
    WHERE base_key LIKE 'GTRAIN%'
    ORDER BY id DESC
    LIMIT 1
  `);

  return {
    insert(candidate) {
      const result = insertCandidate.run(candidate);
      return this.findById(result.lastInsertRowid);
    },
    findById(id) {
      return mapCandidate(db.prepare('SELECT * FROM candidates WHERE id = ?').get(id));
    },
    findByBaseKey(baseKey) {
      return mapCandidate(findByBaseKeyStmt.get(baseKey));
    },
    listCandidates() {
      return listCandidatesStmt.all().map(mapCandidate);
    },
    getLastBaseKey() {
      const row = getMaxBaseKeyStmt.get();
      return row ? row.base_key : null;
    },
  };
}

module.exports = {
  createCandidatesRepo,
};
