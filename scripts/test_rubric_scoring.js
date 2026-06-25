/**
 * Phase 3C0 — local smoke test for rubric scoring engine.
 *
 * Run: node scripts/test_rubric_scoring.js
 *
 * No external deps. Pure assertions; exits with non-zero on failure.
 */

const path = require('path');
const assert = require('assert');
const {
  loadRubric,
  validateRubric,
  calculateBlockScore,
  calculateRubricScore,
  mapRubricResultToCandidateScores,
} = require('../services/phase1_rubric_score_service');

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ----------------------------------------------------------------------
// 0. Loading + validation
// ----------------------------------------------------------------------

test('interview_binary_v1 loads and validates', () => {
  const r = loadRubric('interview_binary_v1');
  assert.strictEqual(r.rubric_id, 'interview_binary_v1');
  assert.strictEqual(r.evaluation_unit, 'block');
  assert.ok(r.blocks.length >= 13, `expected >=13 blocks, got ${r.blocks.length}`);
  assert.deepStrictEqual(r.allowed_answers.sort(), ['conflict', 'no', 'not_checked', 'yes']);
});

test('calls_automanual_binary_v1 loads and validates', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  assert.strictEqual(r.rubric_id, 'calls_automanual_binary_v1');
  assert.strictEqual(r.evaluation_unit, 'stage');
  assert.ok(r.stages.length === 5, `expected 5 stages, got ${r.stages.length}`);
  assert.deepStrictEqual(r.allowed_answers.sort(), ['conflict', 'no', 'not_applicable', 'not_enough_data', 'yes']);
});

test('calls v1.1.0 objections stage: 4 weighted questions, no metadata, weights sum to 1.0', () => {
  // v1.1.0 removed the metadata question objections_05; the stage now has
  // 4 weighted questions and no metadata questions at all.
  const r = loadRubric('calls_automanual_binary_v1');
  const obj = r.stages.find(s => s.stage_id === 'objections');
  assert.strictEqual(obj.questions.length, 4);
  assert.ok(obj.questions.every(q => !q.metadata), 'v1.1.0 has no metadata questions in objections');
  assert.deepStrictEqual(
    obj.questions.map(q => q.question_id).sort(),
    ['objections_attempted_handle', 'objections_checked_remaining_doubts',
     'objections_compared_competitors', 'objections_used_examples']
  );
  const sum = obj.questions.reduce((s, q) => s + q.weight, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.001, `weights sum to ${sum}, expected 1.0`);
});

test('calls v1.1.0 has 16 weighted questions total, none metadata', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const all = r.stages.flatMap(s => s.questions);
  assert.strictEqual(all.length, 16, `expected 16 questions, got ${all.length}`);
  assert.ok(all.every(q => !q.metadata), 'v1.1.0 has no metadata questions');
});

test('unknown rubric id throws UNKNOWN_RUBRIC_ID', () => {
  assert.throws(() => loadRubric('does_not_exist'), err => err.code === 'UNKNOWN_RUBRIC_ID');
});

test('validateRubric rejects missing fields', () => {
  assert.throws(() => validateRubric({ rubric_id: 'x' }), err => err.code === 'RUBRIC_VALIDATION_FAILED');
});

test('validateRubric rejects block with weights not summing to 1.0', () => {
  const bad = {
    rubric_id: 'test',
    rubric_version: '1',
    evaluation_unit: 'block',
    allowed_answers: ['yes', 'no'],
    answer_groups: {
      contributes_to_numerator: ['yes'],
      contributes_to_denominator_only: ['no'],
      excluded_from_calculation: [],
      raises_risk_flag: [],
      lowers_confidence: [],
    },
    score_formula: {},
    candidate_scores_mapping: {},
    evidence_schema: { required_fields: ['evidence'] },
    blocks: [
      {
        block_id: 'b1',
        block_weight: 1.0,
        questions: [
          { question_id: 'q1', weight: 0.30 },
          { question_id: 'q2', weight: 0.30 },
        ],
      },
    ],
  };
  assert.throws(() => validateRubric(bad), err => err.code === 'RUBRIC_VALIDATION_FAILED');
});

// ----------------------------------------------------------------------
// 1. All-yes → 100%
// ----------------------------------------------------------------------

test('interview soft_motivation all-yes → 100', () => {
  const r = loadRubric('interview_binary_v1');
  const block = r.blocks.find(b => b.block_id === 'soft_motivation');
  const answers = {
    soft_motivation_01: { answer: 'yes', evidence: 'e1' },
    soft_motivation_02: { answer: 'yes', evidence: 'e2' },
    soft_motivation_03: { answer: 'yes', evidence: 'e3' },
    soft_motivation_04: { answer: 'yes', evidence: 'e4' },
  };
  const result = calculateBlockScore(block, answers);
  assert.strictEqual(result.score_percent, 100);
  assert.strictEqual(result.confidence, 'normal');
  assert.strictEqual(result.status, 'applicable');
  assert.strictEqual(result.risk_flags.length, 0);
});

test('calls contact all-yes → 100', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'contact');
  const answers = {};
  for (const q of stage.questions) {
    answers[q.question_id] = { answer: 'yes', evidence: 'e', quote: 'q', source: 'call_transcript', source_ref: '00:01' };
  }
  const result = calculateBlockScore(stage, answers);
  assert.strictEqual(result.score_percent, 100);
});

// ----------------------------------------------------------------------
// 2. Mixed yes/no → correct weighted percent
// ----------------------------------------------------------------------

test('calls contact mixed yes/no → correct weighted percent (v1.1.0: 20%)', () => {
  // v1.1.0 contact = contact_bank_tochka (0.2) + contact_call_reason (0.8).
  // bank_tochka yes (0.2), call_reason no (0.8) → yes=0.2 / applicable=1.0 = 20%.
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'contact');
  const answers = {
    contact_bank_tochka: { answer: 'yes', evidence: 'назвал Банк Точка', quote: 'q', source: 'call_transcript' },
    contact_call_reason: { answer: 'no', evidence: 'причина неясная', quote: 'q', source: 'call_transcript' },
  };
  const result = calculateBlockScore(stage, answers);
  assert.strictEqual(result.score_percent, 20);
  assert.strictEqual(result.applicable_weight, 1.0);
  assert.strictEqual(result.yes_weight, 0.2);
});

// ----------------------------------------------------------------------
// 3. not_checked excluded from denominator
// ----------------------------------------------------------------------

test('calls contact with one not_applicable — denominator shrinks, score recomputed (v1.1.0)', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'contact');
  // contact_bank_tochka (weight 0.2) → not_applicable, excluded from denominator.
  // Remaining: contact_call_reason (0.8) = yes → 0.8/0.8 = 100%.
  const answers = {
    contact_bank_tochka: { answer: 'not_applicable', evidence: '' },
    contact_call_reason: { answer: 'yes', evidence: 'сообщил причину', quote: 'q', source: 'call_transcript' },
  };
  const result = calculateBlockScore(stage, answers);
  assert.strictEqual(result.applicable_weight, 0.8);
  assert.strictEqual(result.yes_weight, 0.8);
  assert.strictEqual(result.score_percent, 100);
});

// ----------------------------------------------------------------------
// 4. not_enough_data → null/low confidence when no applicable questions
// ----------------------------------------------------------------------

test('block with all not_enough_data → score null, confidence low, status not_enough_data', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'presentation');
  const answers = {};
  for (const q of stage.questions) {
    answers[q.question_id] = { answer: 'not_enough_data', comment: 'no product dictionary' };
  }
  const result = calculateBlockScore(stage, answers);
  assert.strictEqual(result.score_percent, null);
  assert.strictEqual(result.confidence, 'low');
  assert.strictEqual(result.status, 'not_enough_data');
});

test('block with all not_checked → status not_applicable, score null', () => {
  const r = loadRubric('interview_binary_v1');
  const block = r.blocks.find(b => b.block_id === 'hard_roleplay');
  const answers = {};
  for (const q of block.questions) {
    answers[q.question_id] = { answer: 'not_checked' };
  }
  const result = calculateBlockScore(block, answers);
  assert.strictEqual(result.score_percent, null);
  assert.strictEqual(result.status, 'not_applicable');
});

// ----------------------------------------------------------------------
// 5. conflict → risk flag, no score contribution
// ----------------------------------------------------------------------

test('conflict answer raises risk_flag and is excluded from calculation', () => {
  const r = loadRubric('interview_binary_v1');
  const block = r.blocks.find(b => b.block_id === 'soft_motivation');
  // 3 yes + 1 conflict — conflict's weight 0.15 is excluded
  // applicable = 0.35+0.25+0.25 = 0.85, yes = 0.85 → 100%
  const answers = {
    soft_motivation_01: { answer: 'yes', evidence: 'e1' },
    soft_motivation_02: { answer: 'yes', evidence: 'e2' },
    soft_motivation_03: { answer: 'yes', evidence: 'e3' },
    soft_motivation_04: { answer: 'conflict', evidence: 'transcript says X, HR note says Y' },
  };
  const result = calculateBlockScore(block, answers);
  assert.strictEqual(result.score_percent, 100);
  assert.strictEqual(result.risk_flags.length, 1);
  assert.strictEqual(result.risk_flags[0].question_id, 'soft_motivation_04');
  assert.strictEqual(result.risk_flags[0].reason, 'conflict_answer');
  assert.strictEqual(result.conflict_weight, 0.15);
  assert.strictEqual(result.status, 'has_conflict');
});

// ----------------------------------------------------------------------
// 6. objections_05 does NOT affect objections score
// ----------------------------------------------------------------------

test('calls objections all-yes → 100 (v1.1.0, no metadata)', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'objections');
  const answers = {};
  for (const q of stage.questions) {
    answers[q.question_id] = { answer: 'yes', evidence: 'e', quote: 'q', source: 'call_transcript' };
  }
  const result = calculateBlockScore(stage, answers);
  assert.strictEqual(result.score_percent, 100);
  assert.strictEqual(result.applicable_weight, 1.0);
});

test('calls objections weighted mix → correct percent (v1.1.0)', () => {
  // attempted_handle yes (0.4), rest no (0.2+0.15+0.25=0.6) → 0.4/1.0 = 40%.
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'objections');
  const answers = {
    objections_attempted_handle: { answer: 'yes', evidence: 'e', quote: 'q', source: 'call_transcript' },
    objections_checked_remaining_doubts: { answer: 'no', evidence: 'e' },
    objections_used_examples: { answer: 'no', evidence: 'e' },
    objections_compared_competitors: { answer: 'no', evidence: 'e' },
  };
  const result = calculateBlockScore(stage, answers);
  assert.strictEqual(result.score_percent, 40);
  assert.strictEqual(result.yes_weight, 0.4);
  assert.strictEqual(result.applicable_weight, 1.0);
});

// ----------------------------------------------------------------------
// 7. Full rubric score — interview
// ----------------------------------------------------------------------

test('interview full rubric with all-yes → 100, mapping produces soft/hard scores', () => {
  const r = loadRubric('interview_binary_v1');
  const answers = {};
  for (const block of r.blocks) {
    for (const q of block.questions) {
      if (q.metadata) {
        answers[q.question_id] = { answer: 'yes' };
      } else {
        answers[q.question_id] = { answer: 'yes', evidence: 'evidence for ' + q.question_id };
      }
    }
  }
  const result = calculateRubricScore(r, answers);
  assert.strictEqual(result.overall_score_percent, 100);
  assert.strictEqual(result.overall_status, 'applicable');
  assert.strictEqual(result.stages.soft.score_percent, 100);
  assert.strictEqual(result.stages.hard.score_percent, 100);
  assert.strictEqual(result.stages.segment.score_percent, 100);

  const mapping = mapRubricResultToCandidateScores(result);
  assert.strictEqual(mapping.derived_fields.soft_score, 100);
  assert.strictEqual(mapping.derived_fields.hard_score, 100);
  assert.strictEqual(mapping.derived_fields.learning_score, 100);
  assert.strictEqual(mapping.derived_fields.risk_score_adjust, 0);
});

// ----------------------------------------------------------------------
// 8. Full rubric score — calls with not_applicable objections stage
// ----------------------------------------------------------------------

test('calls full rubric with objections not_applicable — overall still computed from 4 stages', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const answers = {};
  // Contact: all yes
  for (const q of r.stages.find(s => s.stage_id === 'contact').questions) {
    answers[q.question_id] = { answer: 'yes', evidence: 'e', quote: 'q', source: 'call_transcript' };
  }
  // Needs: all yes
  for (const q of r.stages.find(s => s.stage_id === 'needs').questions) {
    answers[q.question_id] = { answer: 'yes', evidence: 'e', quote: 'q', source: 'call_transcript' };
  }
  // Presentation: all yes
  for (const q of r.stages.find(s => s.stage_id === 'presentation').questions) {
    answers[q.question_id] = { answer: 'yes', evidence: 'e', quote: 'q', source: 'call_transcript' };
  }
  // Objections: not_applicable (no objections from client)
  for (const q of r.stages.find(s => s.stage_id === 'objections').questions) {
    answers[q.question_id] = { answer: 'not_applicable', evidence: '' };
  }
  // Close: all yes
  for (const q of r.stages.find(s => s.stage_id === 'close').questions) {
    answers[q.question_id] = { answer: 'yes', evidence: 'e', quote: 'q', source: 'call_transcript' };
  }
  const result = calculateRubricScore(r, answers);
  // Objections score = null (not_applicable)
  assert.strictEqual(result.stages.objections.score_percent, null);
  // Overall should still be 100 across 4 applicable stages (re-weighted)
  // contact 0.15 + needs 0.30 + presentation 0.25 + close 0.15 = 0.85 total weight
  // all 100 → 100 * 0.85 / 0.85 = 100
  assert.strictEqual(result.overall_score_percent, 100);

  const mapping = mapRubricResultToCandidateScores(result);
  assert.strictEqual(mapping.derived_fields.call_quality_score, 100);
});

// ----------------------------------------------------------------------
// 9. Evidence warnings — yes without evidence
// ----------------------------------------------------------------------

test('yes answer without evidence produces evidence_warning', () => {
  const r = loadRubric('interview_binary_v1');
  const block = r.blocks.find(b => b.block_id === 'soft_responsibility');
  const answers = {
    soft_responsibility_01: { answer: 'yes', evidence: '' }, // missing!
    soft_responsibility_02: { answer: 'yes', evidence: 'e' },
    soft_responsibility_03: { answer: 'yes', evidence: 'e' },
    soft_responsibility_04: { answer: 'yes', evidence: 'e' },
  };
  const result = calculateBlockScore(block, answers);
  assert.ok(result.evidence_warnings.length > 0);
  assert.ok(result.evidence_warnings.some(w => w.includes('requires non-empty evidence')));
});

// ----------------------------------------------------------------------
// 10. Confidence low when >50% not_checked
// ----------------------------------------------------------------------

test('confidence low when >50% of block weight is not_checked', () => {
  const r = loadRubric('interview_binary_v1');
  const block = r.blocks.find(b => b.block_id === 'soft_motivation');
  // 2 questions not_checked (0.35 + 0.25 = 0.60 > 0.50) → low confidence
  const answers = {
    soft_motivation_01: { answer: 'not_checked' },
    soft_motivation_02: { answer: 'not_checked' },
    soft_motivation_03: { answer: 'yes', evidence: 'e' },
    soft_motivation_04: { answer: 'yes', evidence: 'e' },
  };
  const result = calculateBlockScore(block, answers);
  assert.strictEqual(result.confidence, 'low');
  // applicable weight = 0.25 + 0.15 = 0.40, yes = 0.40 → 100%
  assert.strictEqual(result.score_percent, 100);
});

// ----------------------------------------------------------------------
// 11. Fixup: candidate_scores_mapping_preview receives units
// ----------------------------------------------------------------------

test('interview full rubric all-yes → mapping_preview.learning_score === 100 (not null)', () => {
  // Before fixup: calculateRubricScore() called mapRubricResultToCandidateScores
  // without `units`, so learning_score could not be computed from per-block
  // scores and was null. After fixup: units are passed through.
  const r = loadRubric('interview_binary_v1');
  const answers = {};
  for (const block of r.blocks) {
    for (const q of block.questions) {
      if (q.metadata) {
        answers[q.question_id] = { answer: 'yes' };
      } else {
        answers[q.question_id] = { answer: 'yes', evidence: 'evidence for ' + q.question_id };
      }
    }
  }
  const result = calculateRubricScore(r, answers);
  const preview = result.candidate_scores_mapping_preview;
  assert.ok(preview, 'mapping preview must be present');
  assert.strictEqual(preview.derived_fields.soft_score, 100);
  assert.strictEqual(preview.derived_fields.hard_score, 100);
  assert.strictEqual(preview.derived_fields.learning_score, 100,
    'learning_score must be 100 (not null) when units are passed through');
});

test('interview full rubric with soft_flexibility/antifragility/proactivity partial → learning_score from available components', () => {
  // If only antifragility has answers (yes), and flexibility + proactivity are
  // not_checked, learning_score should still be computable from the one
  // available component (single-component weighted avg = that component's score).
  const r = loadRubric('interview_binary_v1');
  const answers = {};
  for (const block of r.blocks) {
    for (const q of block.questions) {
      if (q.metadata) {
        answers[q.question_id] = { answer: 'yes' };
        continue;
      }
      if (block.block_id === 'soft_flexibility' || block.block_id === 'soft_proactivity') {
        answers[q.question_id] = { answer: 'not_checked' };
      } else {
        answers[q.question_id] = { answer: 'yes', evidence: 'e' };
      }
    }
  }
  const result = calculateRubricScore(r, answers);
  const preview = result.candidate_scores_mapping_preview;
  // soft_flexibility and soft_proactivity blocks → null score (all not_checked)
  // soft_antifragility → 100
  // learning_score = 100 (from antifragility alone, single-component avg)
  assert.strictEqual(preview.derived_fields.learning_score, 100);
  assert.ok(preview.notes.some(n => n.includes('partial components')),
    'notes should warn about partial components');
});

// ----------------------------------------------------------------------
// 12. Fixup: rubric-specific answer_groups honoured via calculateRubricScore
// ----------------------------------------------------------------------

test('calculateRubricScore uses rubric.answer_groups (custom "ok" treated as numerator)', () => {
  // Build a tiny synthetic rubric where the answer that contributes to the
  // numerator is "ok" (not "yes"). validateRubric() requires a full schema,
  // so we bypass it by constructing the rubric object and calling
  // calculateRubricScore() directly — the function does not re-validate.
  const syntheticRubric = {
    rubric_id: 'synthetic_test_v1',
    rubric_version: '0.0.1',
    evaluation_unit: 'block',
    allowed_answers: ['ok', 'no', 'not_checked', 'conflict'],
    answer_groups: {
      contributes_to_numerator: ['ok'],
      contributes_to_denominator_only: ['no'],
      excluded_from_calculation: ['not_checked', 'conflict'],
      raises_risk_flag: ['conflict'],
      lowers_confidence: ['not_checked'],
    },
    score_formula: { block_score: 'ok_weight / applicable_weight' },
    stage_weights: { test: 1.0 },
    blocks: [
      {
        block_id: 'test_block',
        block_name: 'Test',
        stage: 'test',
        block_weight: 1.0,
        questions: [
          { question_id: 'q1', text: 'q1', weight: 0.50 },
          { question_id: 'q2', text: 'q2', weight: 0.50 },
        ],
      },
    ],
    candidate_scores_mapping: {},
    evidence_schema: { required_fields: ['evidence'] },
  };

  // Both answers = ok → 100%
  const answersOk = {
    q1: { answer: 'ok', evidence: 'e1' },
    q2: { answer: 'ok', evidence: 'e2' },
  };
  const resultOk = calculateRubricScore(syntheticRubric, answersOk);
  assert.strictEqual(resultOk.units[0].score_percent, 100,
    'ok answers should produce 100% when ok is in contributes_to_numerator');
  assert.strictEqual(resultOk.units[0].yes_weight, 1.0,
    'yes_weight should accumulate ok weights (1.0)');

  // One ok + one no → 50%
  const answersMixed = {
    q1: { answer: 'ok', evidence: 'e1' },
    q2: { answer: 'no', evidence: 'e2' },
  };
  const resultMixed = calculateRubricScore(syntheticRubric, answersMixed);
  assert.strictEqual(resultMixed.units[0].score_percent, 50,
    'ok(0.50) + no(0.50) → 0.50/1.00 = 50%');
  assert.strictEqual(resultMixed.units[0].applicable_weight, 1.0);

  // not_checked → excluded from denominator
  const answersSkip = {
    q1: { answer: 'ok', evidence: 'e1' },
    q2: { answer: 'not_checked' },
  };
  const resultSkip = calculateRubricScore(syntheticRubric, answersSkip);
  // applicable = 0.50 (q1), ok = 0.50 → 100%
  assert.strictEqual(resultSkip.units[0].score_percent, 100);
  assert.strictEqual(resultSkip.units[0].applicable_weight, 0.50);

  // conflict → risk flag, excluded from denominator
  const answersConflict = {
    q1: { answer: 'ok', evidence: 'e1' },
    q2: { answer: 'conflict', evidence: 'sources contradict' },
  };
  const resultConflict = calculateRubricScore(syntheticRubric, answersConflict);
  assert.strictEqual(resultConflict.units[0].score_percent, 100);
  assert.strictEqual(resultConflict.units[0].risk_flags.length, 1);
  assert.strictEqual(resultConflict.units[0].risk_flags[0].question_id, 'q2');
});

test('calculateBlockScore default param still works (no answer_groups passed)', () => {
  // Existing direct callers of calculateBlockScore that don't pass a 3rd arg
  // should continue to work with ANSWER_GROUPS_DEFAULTS.
  const r = loadRubric('interview_binary_v1');
  const block = r.blocks.find(b => b.block_id === 'soft_responsibility');
  const answers = {
    soft_responsibility_01: { answer: 'yes', evidence: 'e1' },  // 0.30
    soft_responsibility_02: { answer: 'yes', evidence: 'e2' },  // 0.25
    soft_responsibility_03: { answer: 'yes', evidence: 'e3' },  // 0.25
    soft_responsibility_04: { answer: 'no', evidence: 'e4' },   // 0.20
  };
  // No 3rd argument — must use defaults.
  // applicable = 1.00, yes = 0.30+0.25+0.25 = 0.80 → 80%
  const result = calculateBlockScore(block, answers);
  assert.strictEqual(result.score_percent, 80);
});

// ----------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------

(async () => {
  await testAsync('placeholder', () => {});
  // Drop the placeholder
  results.pop();

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log('');
  console.log(`Summary: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log('FAILED TESTS:');
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log('All tests passed.');
    process.exit(0);
  }
})();
