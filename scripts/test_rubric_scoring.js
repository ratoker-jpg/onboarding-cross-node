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

test('objections_05 is marked as metadata in calls rubric', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const obj = r.stages.find(s => s.stage_id === 'objections');
  const q5 = obj.questions.find(q => q.question_id === 'objections_05');
  assert.strictEqual(q5.metadata, true);
  assert.strictEqual(q5.weight, 0);
  assert.strictEqual(q5.metadata_field, 'relevance_objection_present');
  // Sum of non-metadata weights must equal 1.00
  const nonMetaWeight = obj.questions.filter(q => !q.metadata).reduce((s, q) => s + q.weight, 0);
  assert.ok(Math.abs(nonMetaWeight - 1.0) < 0.001, `non-metadata weights sum to ${nonMetaWeight}, expected 1.0`);
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

test('calls contact mixed yes/no → correct weighted percent (50%)', () => {
  // From doc 15 §1 example: yes=0.10+0.15+0.25=0.50; no=0.15+0.35=0.50
  // score = 0.50 / 1.00 = 50%
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'contact');
  const answers = {
    contact_01: { answer: 'no', evidence: 'no comfort check', quote: 'q', source: 'call_transcript' },
    contact_02: { answer: 'yes', evidence: 'поздоровался', quote: 'q', source: 'call_transcript' },
    contact_03: { answer: 'yes', evidence: 'представился', quote: 'q', source: 'call_transcript' },
    contact_04: { answer: 'yes', evidence: 'назвал Банк Точка', quote: 'q', source: 'call_transcript' },
    contact_05: { answer: 'no', evidence: 'причина неясная', quote: 'q', source: 'call_transcript' },
  };
  const result = calculateBlockScore(stage, answers);
  assert.strictEqual(result.score_percent, 50);
  assert.strictEqual(result.applicable_weight, 1.0);
  assert.strictEqual(result.yes_weight, 0.5);
});

// ----------------------------------------------------------------------
// 3. not_checked excluded from denominator
// ----------------------------------------------------------------------

test('calls contact with one not_applicable — denominator shrinks, score recomputed', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'contact');
  // contact_01 (weight 0.15) → not_applicable
  // remaining weights: 0.10, 0.15, 0.25, 0.35 = 0.85
  // yes on 0.10 + 0.15 + 0.25 = 0.50 → 0.50/0.85 = 58.8%
  const answers = {
    contact_01: { answer: 'not_applicable', evidence: '' },
    contact_02: { answer: 'yes', evidence: 'e' },
    contact_03: { answer: 'yes', evidence: 'e' },
    contact_04: { answer: 'yes', evidence: 'e' },
    contact_05: { answer: 'no', evidence: 'no reason' },
  };
  const result = calculateBlockScore(stage, answers);
  assert.strictEqual(result.applicable_weight, 0.85);
  assert.strictEqual(result.yes_weight, 0.50);
  assert.ok(Math.abs(result.score_percent - 58.8) < 0.1, `expected ~58.8, got ${result.score_percent}`);
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

test('objections_05 answer does not change objections score (metadata only)', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'objections');

  // All non-metadata answers = yes. objections_05 = no.
  const answers1 = {};
  for (const q of stage.questions) {
    if (q.metadata) {
      answers1[q.question_id] = { answer: 'no' };
    } else {
      answers1[q.question_id] = { answer: 'yes', evidence: 'e' };
    }
  }
  const result1 = calculateBlockScore(stage, answers1);
  assert.strictEqual(result1.score_percent, 100);
  assert.strictEqual(result1.metadata.relevance_objection_present, 'no');

  // Same non-metadata answers = yes. objections_05 = yes.
  const answers2 = { ...answers1, objections_05: { answer: 'yes' } };
  const result2 = calculateBlockScore(stage, answers2);
  assert.strictEqual(result2.score_percent, 100, 'score must not change when objections_05 flips no→yes');
  assert.strictEqual(result2.metadata.relevance_objection_present, 'yes');
  assert.deepStrictEqual(result1.applicable_weight, result2.applicable_weight);
});

test('objections_05 with not_enough_data still produces metadata but no score impact', () => {
  const r = loadRubric('calls_automanual_binary_v1');
  const stage = r.stages.find(s => s.stage_id === 'objections');
  const answers = {};
  for (const q of stage.questions) {
    if (q.metadata) {
      answers[q.question_id] = { answer: 'not_enough_data' };
    } else {
      answers[q.question_id] = { answer: 'no', evidence: 'e' };
    }
  }
  const result = calculateBlockScore(stage, answers);
  // All non-metadata = no → score 0% (not null, because applicable_weight = 1.0)
  assert.strictEqual(result.score_percent, 0);
  assert.strictEqual(result.metadata.relevance_objection_present, 'not_enough_data');
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
    if (q.metadata) {
      answers[q.question_id] = { answer: 'no' };  // relevance_objection_present = no
    } else {
      answers[q.question_id] = { answer: 'not_applicable', evidence: '' };
    }
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
  assert.strictEqual(result.metadata.relevance_objection_present, 'no');

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
