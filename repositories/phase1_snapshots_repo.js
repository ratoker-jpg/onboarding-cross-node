function safeParse(value) {
  try { return value ? JSON.parse(value) : null; } catch (_) { return null; }
}

function mapTestDaySnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    base_key: row.base_key,
    test_day_key: row.test_day_key,
    source: row.source || null,
    legacy_key: row.legacy_key || null,
    candidate_row: safeParse(row.candidate_row_json),
    build_row: safeParse(row.build_row_json),
    voice_bot_row: safeParse(row.voice_bot_row_json),
    raw_payload: safeParse(row.raw_payload_json),
    imported_at: row.imported_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapImmersionSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    base_key: row.base_key,
    current_day: row.current_day,
    days_completed: row.days_completed,
    blocks_completed_percent: row.blocks_completed_percent,
    materials_opened_percent: row.materials_opened_percent,
    help_requests_count: row.help_requests_count,
    delays_count: row.delays_count,
    immersion_status: row.immersion_status,
    source: row.source || null,
    legacy_key: row.legacy_key || null,
    newbie_row: safeParse(row.newbie_row_json),
    progress_rows: safeParse(row.progress_rows_json) || [],
    tracking_rows: safeParse(row.tracking_rows_json) || [],
    material_sessions: safeParse(row.material_sessions_json) || [],
    summary_row: safeParse(row.summary_row_json),
    help_requests: safeParse(row.help_requests_json) || [],
    raw_payload: safeParse(row.raw_payload_json),
    imported_at: row.imported_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapTrainingBotDialog(row) {
  if (!row) return null;
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    base_key: row.base_key,
    training_key: row.training_key,
    legacy_key: row.legacy_key,
    team_id: row.team_id,
    team_name: row.team_name,
    role_id: row.role_id,
    role_title: row.role_title,
    role_company: row.role_company,
    role_client_name: row.role_client_name,
    role_tax_system: row.role_tax_system,
    role_business_type: row.role_business_type,
    role_success_criteria: row.role_success_criteria,
    role_failure_criteria: row.role_failure_criteria,
    role_target_action: row.role_target_action,
    role_objections: row.role_objections,
    role_tone: row.role_tone,
    role_extra_profile: row.role_extra_profile,
    dialog_date: row.dialog_date,
    transcript_text: row.transcript_text,
    result_payload: safeParse(row.result_payload_json),
    role_payload: safeParse(row.role_profile_json),
    source_payload: safeParse(row.source_payload_json),
    dedup_key: row.dedup_key,
    imported_at: row.imported_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createSnapshotsRepo(db) {
  return {
    upsertTestDay(record) {
      db.prepare(`
        INSERT INTO test_day_snapshot (
          candidate_id, base_key, test_day_key, scores_json, open_answers_json, voice_result_json,
          summary, raw_payload_json, source, legacy_key, candidate_row_json, build_row_json,
          voice_bot_row_json, imported_at, created_at, updated_at
        ) VALUES (
          @candidate_id, @base_key, @test_day_key, @scores_json, @open_answers_json, @voice_result_json,
          @summary, @raw_payload_json, @source, @legacy_key, @candidate_row_json, @build_row_json,
          @voice_bot_row_json, @imported_at, @created_at, @updated_at
        )
        ON CONFLICT(candidate_id) DO UPDATE SET
          test_day_key = excluded.test_day_key,
          scores_json = excluded.scores_json,
          open_answers_json = excluded.open_answers_json,
          voice_result_json = excluded.voice_result_json,
          summary = excluded.summary,
          raw_payload_json = excluded.raw_payload_json,
          source = excluded.source,
          legacy_key = excluded.legacy_key,
          candidate_row_json = excluded.candidate_row_json,
          build_row_json = excluded.build_row_json,
          voice_bot_row_json = excluded.voice_bot_row_json,
          imported_at = excluded.imported_at,
          updated_at = excluded.updated_at
      `).run(record);
      return this.getTestDayByCandidateId(record.candidate_id);
    },
    getTestDayByCandidateId(candidateId) {
      return mapTestDaySnapshot(db.prepare('SELECT * FROM test_day_snapshot WHERE candidate_id = ?').get(candidateId));
    },
    upsertImmersion(record) {
      db.prepare(`
        INSERT INTO immersion_snapshot (
          candidate_id, base_key, current_day, days_completed, blocks_completed_percent,
          materials_opened_percent, help_requests_count, delays_count, immersion_status,
          raw_payload_json, source, legacy_key, newbie_row_json, progress_rows_json,
          tracking_rows_json, material_sessions_json, summary_row_json, help_requests_json,
          imported_at, created_at, updated_at
        ) VALUES (
          @candidate_id, @base_key, @current_day, @days_completed, @blocks_completed_percent,
          @materials_opened_percent, @help_requests_count, @delays_count, @immersion_status,
          @raw_payload_json, @source, @legacy_key, @newbie_row_json, @progress_rows_json,
          @tracking_rows_json, @material_sessions_json, @summary_row_json, @help_requests_json,
          @imported_at, @created_at, @updated_at
        )
        ON CONFLICT(candidate_id) DO UPDATE SET
          current_day = excluded.current_day,
          days_completed = excluded.days_completed,
          blocks_completed_percent = excluded.blocks_completed_percent,
          materials_opened_percent = excluded.materials_opened_percent,
          help_requests_count = excluded.help_requests_count,
          delays_count = excluded.delays_count,
          immersion_status = excluded.immersion_status,
          raw_payload_json = excluded.raw_payload_json,
          source = excluded.source,
          legacy_key = excluded.legacy_key,
          newbie_row_json = excluded.newbie_row_json,
          progress_rows_json = excluded.progress_rows_json,
          tracking_rows_json = excluded.tracking_rows_json,
          material_sessions_json = excluded.material_sessions_json,
          summary_row_json = excluded.summary_row_json,
          help_requests_json = excluded.help_requests_json,
          imported_at = excluded.imported_at,
          updated_at = excluded.updated_at
      `).run(record);
      return this.getImmersionByCandidateId(record.candidate_id);
    },
    getImmersionByCandidateId(candidateId) {
      return mapImmersionSnapshot(db.prepare('SELECT * FROM immersion_snapshot WHERE candidate_id = ?').get(candidateId));
    },
    upsertTrainingBotDialog(record) {
      const existing = db.prepare('SELECT id FROM training_bot_dialogs WHERE dedup_key = ?').get(record.dedup_key);
      if (existing) {
        db.prepare(`
          UPDATE training_bot_dialogs SET
            training_key = @training_key,
            legacy_key = @legacy_key,
            team_id = @team_id,
            team_name = @team_name,
            role_id = @role_id,
            role_client = @role_client,
            role_business = @role_business,
            role_title = @role_title,
            role_company = @role_company,
            role_client_name = @role_client_name,
            role_tax_system = @role_tax_system,
            role_business_type = @role_business_type,
            role_success_criteria = @role_success_criteria,
            role_failure_criteria = @role_failure_criteria,
            role_target_action = @role_target_action,
            role_objections = @role_objections,
            role_tone = @role_tone,
            role_extra_profile = @role_extra_profile,
            dialog_date = @dialog_date,
            result = @result,
            transcript_text = @transcript_text,
            role_profile_json = @role_profile_json,
            analysis_json = @analysis_json,
            result_payload_json = @result_payload_json,
            source_payload_json = @source_payload_json,
            imported_at = @imported_at,
            updated_at = @updated_at
          WHERE id = @id
        `).run({ ...record, id: existing.id });
        return this.getTrainingBotDialogById(existing.id);
      }
      const result = db.prepare(`
        INSERT INTO training_bot_dialogs (
          candidate_id, base_key, training_key, legacy_key, team_id, team_name,
          role_id, role_client, role_business, role_title, role_company, role_client_name,
          role_tax_system, role_business_type, role_success_criteria, role_failure_criteria,
          role_target_action, role_objections, role_tone, role_extra_profile,
          dialog_date, result, transcript_text, role_profile_json, analysis_json,
          result_payload_json, source_payload_json, dedup_key, imported_at, created_at, updated_at
        ) VALUES (
          @candidate_id, @base_key, @training_key, @legacy_key, @team_id, @team_name,
          @role_id, @role_client, @role_business, @role_title, @role_company, @role_client_name,
          @role_tax_system, @role_business_type, @role_success_criteria, @role_failure_criteria,
          @role_target_action, @role_objections, @role_tone, @role_extra_profile,
          @dialog_date, @result, @transcript_text, @role_profile_json, @analysis_json,
          @result_payload_json, @source_payload_json, @dedup_key, @imported_at, @created_at, @updated_at
        )
      `).run(record);
      return this.getTrainingBotDialogById(result.lastInsertRowid);
    },
    getTrainingBotDialogById(id) {
      return mapTrainingBotDialog(db.prepare('SELECT * FROM training_bot_dialogs WHERE id = ?').get(id));
    },
    listTrainingBotDialogsByCandidateId(candidateId) {
      return db.prepare('SELECT * FROM training_bot_dialogs WHERE candidate_id = ? ORDER BY datetime(updated_at) DESC, id DESC').all(candidateId).map(mapTrainingBotDialog);
    },
  };
}

module.exports = {
  createSnapshotsRepo,
};
