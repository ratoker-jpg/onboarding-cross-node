#!/usr/bin/env node
/**
 * Phase 3E0 — Export candidate analysis bundle for Codex.
 *
 * Reads candidate data from SQLite and writes a JSON bundle that Codex
 * (or any LLM agent) consumes together with a prompt template to produce
 * an analysis_result_v1 JSON. The result is then imported via
 * scripts/import_analysis_result.js.
 *
 * Usage:
 *   node scripts/export_candidate_analysis_bundle.js \
 *     --base-key GTRAIN01 \
 *     --type interview \
 *     --out tmp/GTRAIN01_interview_bundle.json
 *
 * Safety:
 *   - Never exports ADMIN_KEY / VIEWER_KEY / env secrets.
 *   - Long transcripts are capped (preview + length metadata) EXCEPT for the
 *     transcript of the requested analysis_type, which is exported in full
 *     with explicit source_ref markers so Codex can quote line numbers.
 *   - Files / screenshots are exported as metadata (path, mime, size) only —
 *     binary content is never embedded.
 *   - All sections outside the analysis_type's needs are omitted or capped.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { SheetsClient } = require('../sheets_client');

// We need DB access without booting the full HTTP server.
// loadDotEnv is the same minimal parser used by server.js.
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

// Force admin feature on for the script — we read DB directly.
if (!process.env.PHASE1_ADMIN_ENABLED) process.env.PHASE1_ADMIN_ENABLED = '1';

const { getPhase1Db } = require('../lib/phase1_db');
const { getPhase1Config } = require('../lib/phase1_config');
const { loadRubric } = require('../services/phase1_rubric_score_service');

const {
  createCandidatesRepo,
} = require('../repositories/phase1_candidates_repo');
const { createManualInputsRepo } = require('../repositories/phase1_manual_inputs_repo');
const { createCandidateFilesRepo } = require('../repositories/phase1_candidate_files_repo');
const { createSourceLinksRepo } = require('../repositories/phase1_source_links_repo');
const { createCandidateScoresRepo } = require('../repositories/phase1_candidate_scores_repo');
const { createSnapshotsRepo } = require('../repositories/phase1_snapshots_repo');

// ----------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------

function parseArgs(argv) {
  const out = { baseKey: null, type: null, out: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--base-key') out.baseKey = argv[++i];
    else if (a === '--type') out.type = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a.startsWith('--base-key=')) out.baseKey = a.slice('--base-key='.length);
    else if (a.startsWith('--type=')) out.type = a.slice('--type='.length);
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/export_candidate_analysis_bundle.js --base-key <KEY> --type <interview|calls> --out <path>

Options:
  --base-key  Candidate base_key (e.g. GTRAIN01)
  --type      Analysis type: "interview" or "calls"
  --out       Output JSON file path
  --help      Show this help

Examples:
  node scripts/export_candidate_analysis_bundle.js --base-key GTRAIN01 --type interview --out tmp/GTRAIN01_interview_bundle.json
  node scripts/export_candidate_analysis_bundle.js --base-key GTRAIN01 --type calls --out tmp/GTRAIN01_calls_bundle.json
`);
}

// ----------------------------------------------------------------------
// Safety: payload projection
// ----------------------------------------------------------------------

const ANALYSIS_TYPE_TO_RUBRIC = {
  interview: 'interview_binary_v1',
  calls: 'calls_automanual_binary_v1',
};

// Secret-leakage patterns. Mirrors services/phase1_analysis_result_validator.js
// FORBIDDEN_SECRET_PATTERNS so the same checks run on export (before the
// bundle leaves the server) AND on import (before the result reaches the DB).
const FORBIDDEN_SECRET_PATTERNS = [
  /ADMIN_KEY\s*[:=]/i,
  /VIEWER_KEY\s*[:=]/i,
  /ghp_[A-Za-z0-9]{20,}/i,
  /github_pat_[A-Za-z0-9_]{20,}/i,
  /AA[A-Za-z0-9_-]{30,}/i,
  /x-access-token:/i,
];

/**
 * Scan a stringified JSON for forbidden secret patterns. Throws if any match.
 * Export uses this BEFORE fs.writeFileSync so a leaked secret never leaves
 * the server in the bundle file.
 *
 * @param {string} docStr - JSON.stringify(bundle) output
 * @param {string} context - human-readable label for error messages
 * @throws {Error} if a forbidden pattern is found
 */
function assertNoForbiddenSecrets(docStr, context) {
  for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
    const match = docStr.match(pattern);
    if (match) {
      const err = new Error(`forbidden_secret_in_bundle:${context}:pattern ${match[0]}`);
      err.code = 'FORBIDDEN_SECRET_IN_BUNDLE';
      err.pattern = match[0];
      err.context = context;
      throw err;
    }
  }
}

// Sections needed in full for each analysis type.
// For interview: we want the full transcript text.
// For calls: we want full transcripts of calls_start / calls_middle / calls_final.
const FULL_TEXT_SECTIONS_BY_TYPE = {
  interview: new Set(['interview', 'interview_transcript']),
  calls: new Set(['calls_start', 'calls_middle', 'calls_final', 'phone_metrics']),
};

// Cap for sections not in FULL_TEXT_SECTIONS_BY_TYPE.
const BUNDLE_PREVIEW_LIMIT = 2000;

function safeStringifyOnce(obj) {
  try { return JSON.stringify(obj); } catch (_) { return '[unserializable]'; }
}

function truncateForBundle(value, allowFull) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (allowFull || value.length <= BUNDLE_PREVIEW_LIMIT) return value;
    return { preview: value.slice(0, BUNDLE_PREVIEW_LIMIT), truncated: true, length: value.length };
  }
  if (typeof value === 'object') {
    const clone = Array.isArray(value) ? [...value] : { ...value };
    for (const key of Object.keys(clone)) {
      if (typeof clone[key] === 'string') {
        if (!(allowFull) && clone[key].length > BUNDLE_PREVIEW_LIMIT) {
          const full = clone[key];
          clone[key] = { preview: full.slice(0, BUNDLE_PREVIEW_LIMIT), truncated: true, length: full.length };
        }
      } else if (typeof clone[key] === 'object' && clone[key] !== null) {
        clone[key] = truncateForBundle(clone[key], allowFull);
      }
    }
    return clone;
  }
  return value;
}

function projectManualInputForBundle(raw, analysisType) {
  if (!raw) return null;
  const allowFull = FULL_TEXT_SECTIONS_BY_TYPE[analysisType].has(raw.section);
  const payload = truncateForBundle(raw.payload, allowFull);
  return {
    section: raw.section,
    payload,
    updated_at: raw.updated_at || null,
    // Mark whether the payload text is full or truncated, so Codex knows
    // whether it has the complete source for evidence quoting.
    full_text_included: allowFull,
  };
}

function projectTrainingDialogForBundle(raw, analysisType) {
  if (!raw) return null;
  // For calls analysis: include full transcript_text so Codex can quote it.
  // For interview analysis: only metadata (transcript not needed).
  const includeTranscript = analysisType === 'calls';
  const out = {
    session_key: raw.training_key || null,
    dialog_date: raw.dialog_date || null,
    role_id: raw.role_id || null,
    role_title: raw.role_title || null,
    role_client: raw.role_client || raw.role_client_name || null,
    role_business: raw.role_business || raw.role_company || null,
    role_tax_system: raw.role_tax_system || null,
    role_business_type: raw.role_business_type || null,
    role_success_criteria: raw.role_success_criteria || null,
    role_failure_criteria: raw.role_failure_criteria || null,
    role_target_action: raw.role_target_action || null,
    role_objections: raw.role_objections || null,
    role_tone: raw.role_tone || null,
    result: raw.result || null,
    result_payload: raw.result_payload || null,
    source_ref: raw.dedup_key ? `dialog:${raw.dedup_key}` : `dialog:id:${raw.id}`,
  };
  if (includeTranscript) {
    // Cap individual dialog transcript at 20K chars to keep bundle manageable.
    const cap = 20000;
    const text = raw.transcript_text || '';
    if (text.length > cap) {
      out.transcript_text = {
        preview: text.slice(0, cap),
        truncated: true,
        length: text.length,
      };
    } else {
      out.transcript_text = text;
    }
    out.transcript_full_text_included = text.length <= cap;
  } else {
    out.transcript_text_omitted = true;
  }
  return out;
}

function projectFileForBundle(raw) {
  if (!raw) return null;
  // Files are exported as metadata only — no binary content.
  return {
    section: raw.section,
    file_type: raw.file_type || null,
    original_name: raw.original_name || null,
    stored_path: raw.stored_path || null,
    mime_type: raw.mime_type || null,
    size_bytes: raw.size_bytes || null,
    comment: raw.comment || null,
    // text_content is included only if it's a text file and within cap
    text_content_preview: typeof raw.text_content === 'string' && raw.text_content.length > 0
      ? raw.text_content.slice(0, 500)
      : null,
    source_ref: raw.stored_path ? `file:${raw.stored_path}` : `file:id:${raw.id}`,
  };
}

// ----------------------------------------------------------------------
// Bundle assembly
// ----------------------------------------------------------------------

function buildCallStatsBundle(manualInputs) {
  // Mirror services/phase1_candidate_service.js buildCallStats() logic
  // but kept local to avoid pulling the whole service (which asserts admin).
  const phoneMetrics = manualInputs.find(m => m && m.section === 'phone_metrics');
  if (!phoneMetrics || !phoneMetrics.payload) {
    return {
      talk_time_minutes: null, calls_total: null, reached_calls: null,
      calls_over_2min: null, calls_over_2min_percent: null,
      calls_over_10min: null, effective_minutes: null, days: [],
    };
  }
  const p = phoneMetrics.payload;
  const days = Array.isArray(p.days) ? p.days : [];
  if (!days.length) {
    return {
      talk_time_minutes: null, calls_total: null, reached_calls: null,
      calls_over_2min: null, calls_over_2min_percent: null,
      calls_over_10min: null, effective_minutes: null, days: [],
    };
  }
  let talkTime = 0, callsTotal = 0, callsOver2min = 0, callsOver10min = 0, effectiveMinutes = 0;
  for (const d of days) {
    const minutes = Number(d.minutes) || 0;
    const callsCount = Number(d.calls_count) || 0;
    const pct = Number(d.calls_over_2min_percent);
    talkTime += minutes;
    callsTotal += callsCount;
    effectiveMinutes += minutes;
    if (typeof d.calls_over_2min === 'number') callsOver2min += d.calls_over_2min;
    else if (callsCount > 0 && Number.isFinite(pct)) callsOver2min += Math.round((callsCount * pct) / 100);
    if (typeof d.calls_over_10min === 'number') callsOver10min += d.calls_over_10min;
  }
  return {
    talk_time_minutes: talkTime || null,
    calls_total: callsTotal || null,
    reached_calls: callsTotal || null,
    calls_over_2min: callsOver2min || null,
    calls_over_2min_percent: callsTotal ? Math.round((callsOver2min / callsTotal) * 1000) / 10 : null,
    calls_over_10min: callsOver10min || null,
    effective_minutes: effectiveMinutes || null,
    days: days.map((d, idx) => ({
      day: d.day != null ? d.day : idx + 1,
      minutes: Number(d.minutes) || 0,
      calls_count: Number(d.calls_count) || 0,
      calls_over_2min_percent: Number.isFinite(Number(d.calls_over_2min_percent)) ? Number(d.calls_over_2min_percent) : null,
    })),
  };
}

/**
 * Phase 3E3E: Split a transcript file into individual call segments.
 * Heuristic: look for timestamp patterns like 00:00–00:05 at the start of
 * a new "call block" after previous content. If the split is uncertain,
 * return the whole transcript as one segment.
 *
 * Returns array of { transcript, call_index }.
 */
function splitTranscriptIntoCalls(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  // Try to find "call boundary" markers: a timestamp near 00:00–00:05
  // appearing AFTER substantial content (i.e., a previous call has ended).
  const lines = trimmed.split(/\r?\n/);
  const segments = [];
  let current = [];

  const tsRe = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

  function parseTimestampSeconds(value) {
    const parts = String(value || '').trim().split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1]; // mm:ss
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // hh:mm:ss
    return null;
  }

  for (const line of lines) {
    const ln = line.trim();
    const m = ln.match(tsRe);
    if (m) {
      const totalSec = parseTimestampSeconds(ln);

      // Possible new call start: timestamp is small (0-5 sec) AND we have content
      if (totalSec != null && totalSec <= 5 && current.length > 0) {
        const currentText = current.join('\n').trim();
        if (currentText.length >= 300) {
          segments.push(currentText);
          current = [];
        }
      }
    }
    current.push(line);
  }
  // Last segment
  if (current.length > 0) {
    const currentText = current.join('\n').trim();
    if (currentText.length >= 50) segments.push(currentText);
  }

  // If no splits or only one segment, return as-is
  if (segments.length <= 1) {
    return [{ transcript: trimmed, call_index: 1 }];
  }

  return segments.map((t, i) => ({ transcript: t, call_index: i + 1 }));
}

/**
 * Phase 3E3C fixup: Build a normalized list of real calls from BOTH
 * manual_inputs and candidate_files. Deduplicates by transcript hash
 * within the same stage. Phase 3E3E: segments transcript files into
 * individual calls.
 *
 * Each entry: { stage, stage_label, call_index, source_type, source_ref,
 *               file_id, original_name, transcript, coach_comment }
 */
function buildRealCallsForBundle(manualInputsRaw, filesRaw) {
  const STAGES = [
    { section: 'calls_start', stage: 'start',  label: 'Начало'  },
    { section: 'calls_middle', stage: 'middle', label: 'Середина' },
    { section: 'calls_final', stage: 'final',  label: 'Выпуск'  },
  ];
  const MIN_TRANSCRIPT_LEN = 50;
  const allCalls = [];

  for (const { section, stage, label } of STAGES) {
    const seenHashes = new Set();
    let callCounter = 0;

    // Source A: manual_inputs
    const mi = manualInputsRaw.find(m => m.section === section);
    if (mi && mi.payload) {
      const callsArr = Array.isArray(mi.payload.calls) ? mi.payload.calls : [];
      for (const c of callsArr) {
        const transcript = String(c.transcript || '').trim();
        if (transcript.length < MIN_TRANSCRIPT_LEN) continue;
        // Phase 3E3E: try splitting
        const segments = splitTranscriptIntoCalls(transcript);
        for (const seg of segments) {
          if (seg.transcript.length < MIN_TRANSCRIPT_LEN) continue;
          const hash = simpleHash(seg.transcript);
          if (seenHashes.has(hash)) continue;
          seenHashes.add(hash);
          callCounter++;
          allCalls.push({
            stage, stage_label: label, call_index: callCounter,
            source_type: 'manual_input',
            source_ref: `manual_inputs.${section}#call_${callCounter}`,
            file_id: null, original_name: null,
            transcript: seg.transcript,
            coach_comment: c.coach_comment || null,
          });
        }
      }
      // Legacy single-call shape
      if (!callsArr.length && mi.payload.transcript) {
        const transcript = String(mi.payload.transcript).trim();
        if (transcript.length >= MIN_TRANSCRIPT_LEN) {
          const segments = splitTranscriptIntoCalls(transcript);
          for (const seg of segments) {
            if (seg.transcript.length < MIN_TRANSCRIPT_LEN) continue;
            const hash = simpleHash(seg.transcript);
            if (seenHashes.has(hash)) continue;
            seenHashes.add(hash);
            callCounter++;
            allCalls.push({
              stage, stage_label: label, call_index: callCounter,
              source_type: 'manual_input',
              source_ref: `manual_inputs.${section}#call_${callCounter}`,
              file_id: null, original_name: null,
              transcript: seg.transcript,
              coach_comment: mi.payload.coach_comment || null,
            });
          }
        }
      }
    }

    // Source B: candidate_files — Phase 3E3E: split into individual calls
    const cf = filesRaw.filter(f => f.section === section);
    for (const f of cf) {
      const transcript = String(f.text_content || '').trim();
      if (transcript.length < MIN_TRANSCRIPT_LEN) continue;
      const segments = splitTranscriptIntoCalls(transcript);
      for (const seg of segments) {
        if (seg.transcript.length < MIN_TRANSCRIPT_LEN) continue;
        const hash = simpleHash(seg.transcript);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
        callCounter++;
        allCalls.push({
          stage, stage_label: label, call_index: callCounter,
          source_type: 'candidate_file',
          source_ref: `candidate_files.${section}:${f.id}#call_${seg.call_index}`,
          file_id: f.id, original_name: f.original_name || null,
          transcript: seg.transcript,
          coach_comment: f.comment || null,
        });
      }
    }
  }

  return allCalls;
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
 return String(h);
}

// ============================================================
// Phase 3E3E: Product dictionary from Google Sheets
// ============================================================

const PRODUCTS_SHEET_ID = '1grwKJPJ3VH6OE0Ky5v3J4FZVADHm7tJrFPwoppkdakI';
const PRODUCTS_SHEET_NAME = 'Лист1';

function normalizeStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

function isExcludedStatus(status) {
  const ns = normalizeStatus(status);
  if (ns === 'не продается' || ns === 'не продают') return true;
  return false;
}

function isExcludedDescription(description) {
  const d = String(description || '').toLowerCase().replace(/ё/g, 'е');
  return d.includes('кроссы не продают данный продукт') || d.includes('не брать в анализ');
}

function slugifyProduct(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'unnamed';
}

function parseAliases(aliasStr) {
  if (!aliasStr) return [];
  return String(aliasStr)
    .split(/[,;\n\r]+|\s+-\s+/)
    .map(s => s.trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Load product dictionary from Google Sheets.
 * Returns array of product objects or empty array on error.
 * Each product: { product_id, product_name, is_chp, segments, product_type,
 *                 description, aliases, status, selling_circle, source_ref }
 */
async function loadProductDictionary() {
  const config = {
    spreadsheetId: PRODUCTS_SHEET_ID,
    clientPath: process.env.GOOGLE_OAUTH_CLIENT || path.join(process.env.HOME || '', 'web-server/secrets/google-oauth-client.json'),
    tokenPath: process.env.GOOGLE_OAUTH_TOKEN || path.join(process.env.HOME || '', 'web-server/secrets/google-oauth-token.json'),
  };
  try {
    const client = new SheetsClient(config);
    const sheets = await client.batchGet([PRODUCTS_SHEET_NAME]);
    const rows = sheets[PRODUCTS_SHEET_NAME] || [];
    if (!rows.length) {
      console.warn('Product dictionary: no rows in sheet');
      return [];
    }
    // First row is header
    const header = rows[0];
    const products = [];
    const seenSlugs = new Set();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[0]) continue;
      const productName = String(row[0] || '').trim();
      if (!productName) continue;
      const description = String(row[4] || '').trim();
      const status = String(row[6] || '').trim();
      // Exclude non-selling
      if (isExcludedStatus(status)) continue;
      if (isExcludedDescription(description)) continue;
      // Generate stable product_id
      let slug = slugifyProduct(productName);
      if (seenSlugs.has(slug)) {
        slug = `${slug}_${i}`;
      }
      seenSlugs.add(slug);
      products.push({
        product_id: slug,
        product_name: productName,
        is_chp: String(row[1] || '').trim() === 'Да' || String(row[1] || '').trim().toLowerCase() === 'yes',
        segments: String(row[2] || '').trim() || null,
        product_type: String(row[3] || '').trim() || null,
        description: description || null,
        aliases: parseAliases(row[5]),
        status: status || null,
        selling_circle: String(row[7] || '').trim() || null,
        source_ref: `products_sheet:row_${i + 1}`,
      });
    }
    return products;
  } catch (err) {
    console.warn(`Product dictionary: failed to load from Google Sheets: ${err.message}`);
    return [];
  }
}

async function exportBundle(baseKey, analysisType) {
  if (!ANALYSIS_TYPE_TO_RUBRIC[analysisType]) {
    throw new Error(`invalid_analysis_type:${analysisType}`);
  }
  const db = getPhase1Db();
  const candidatesRepo = createCandidatesRepo(db);
  const manualInputsRepo = createManualInputsRepo(db);
  const candidateFilesRepo = createCandidateFilesRepo(db);
  const sourceLinksRepo = createSourceLinksRepo(db);
  const candidateScoresRepo = createCandidateScoresRepo(db);
  const snapshotsRepo = createSnapshotsRepo(db);

  const candidate = candidatesRepo.findByBaseKey(baseKey);
  if (!candidate) {
    throw new Error(`candidate_not_found:${baseKey}`);
  }

  // Raw manual inputs
  const manualInputsRaw = manualInputsRepo.listByCandidateId(candidate.id);
  const manualInputs = manualInputsRaw
    .map(m => projectManualInputForBundle(m, analysisType))
    .filter(Boolean);

  // Training dialogs — ONLY included for interview bundles.
  // Phase 3E3C: calls analysis must NEVER use training bot dialogs.
  // Training agents are a separate entity for training_agent_analysis_v1.
  const trainingDialogsRaw = analysisType === 'calls'
    ? []
    : snapshotsRepo.listTrainingBotDialogsByCandidateId(candidate.id);
  const trainingBotDialogs = trainingDialogsRaw
    .map(d => projectTrainingDialogForBundle(d, analysisType))
    .filter(Boolean);

  // Phase 3E3C: for calls analysis, verify that real calls exist.
  // Real calls come from TWO sources:
  //   A) manual_inputs.calls_start/middle/final (payload.calls[] or payload.transcript)
  //   B) candidate_files where section = calls_start/middle/final (text_content as transcript)
  // If neither source has real calls, abort with a clear error — do NOT fall
  // back to training bot dialogs.
  if (analysisType === 'calls') {
    const callsSections = ['calls_start', 'calls_middle', 'calls_final'];
    // Move filesRaw load before the check so we can inspect candidate_files too
    const filesRawEarly = candidateFilesRepo.listByCandidateId(candidate.id);
    let totalCalls = 0;
    for (const sec of callsSections) {
      // Source A: manual_inputs
      const mi = manualInputsRaw.find(m => m.section === sec);
      if (mi && mi.payload) {
        if (Array.isArray(mi.payload.calls)) {
          totalCalls += mi.payload.calls.filter(c => c && String(c.transcript || '').trim().length > 50).length;
        } else if (mi.payload.transcript && String(mi.payload.transcript).trim().length > 50) {
          totalCalls += 1; // legacy single-call shape
        }
      }
      // Source B: candidate_files
      const cf = filesRawEarly.filter(f => f.section === sec);
      totalCalls += cf.filter(f => f && String(f.text_content || '').trim().length > 50).length;
    }
    if (totalCalls === 0) {
      throw new Error('No real calls found for calls analysis. Upload calls_start/calls_middle/calls_final first.');
    }
  }

  // Files as metadata only
  const filesRaw = candidateFilesRepo.listByCandidateId(candidate.id);
  const files = filesRaw.map(projectFileForBundle).filter(Boolean);

  // Phase 3E3C fixup: for calls bundles, build a normalized real_calls array
  // from BOTH manual_inputs AND candidate_files. This gives Codex a clear
  // list of transcripts to analyse, with stable source_refs.
  let realCallsForBundle = null;
  if (analysisType === 'calls') {
    realCallsForBundle = buildRealCallsForBundle(manualInputsRaw, filesRaw);
  }

  // Candidate scores (current)
  const scores = candidateScoresRepo.getByCandidateId(candidate.id);

  // Source links
  const sourceLinks = sourceLinksRepo.listByCandidateId(candidate.id);

  // Call stats (only relevant for calls; null for interview)
  const callStats = analysisType === 'calls' ? buildCallStatsBundle(manualInputsRaw) : null;

  // Interview summary (only relevant for interview)
  let interviewSummary = null;
  if (analysisType === 'interview') {
    const transcript = manualInputsRaw.find(m => m.section === 'interview_transcript');
    const interview = manualInputsRaw.find(m => m.section === 'interview');
    let text = '';
    let updatedAt = null;
    if (transcript && transcript.payload) {
      const p = transcript.payload;
      text = typeof p === 'string' ? p : (p.text_content || p.transcript || p.text || '');
      updatedAt = transcript.updated_at || null;
    }
    if (!text && interview && interview.payload) {
      const p = interview.payload;
      text = typeof p === 'string' ? p : (p.text_content || p.transcript || p.text || '');
      updatedAt = updatedAt || interview.updated_at || null;
    }
    interviewSummary = {
      has_interview: Boolean(interview),
      has_transcript: Boolean(transcript),
      full_text_included: true,
      length: text.length,
      updated_at: updatedAt,
      // Note: the full text itself is in manual_inputs[interview_transcript].payload
      // (not duplicated here) so Codex reads it from there with a stable source_ref.
    };
  }

  // Rubric
  const rubricId = ANALYSIS_TYPE_TO_RUBRIC[analysisType];
  const rubric = loadRubric(rubricId);

  // Source refs collected for traceability
  // Phase 3E3C micro-fixup: for calls bundles, filter out any source refs
  // related to training bot / bot_training / ROLE- / result_payload.
  const FORBIDDEN_CALLS_REF_MARKERS = ['training_bot', 'bot_training', 'ROLE-', 'result_payload'];
  function isForbiddenCallRef(refStr) {
    const lower = String(refStr).toLowerCase();
    return FORBIDDEN_CALLS_REF_MARKERS.some(m => lower.includes(m.toLowerCase()));
  }

  const sourceRefs = [];
  if (interviewSummary) sourceRefs.push('manual_inputs.section=interview_transcript');
  if (callStats) sourceRefs.push('manual_inputs.section=phone_metrics');
  if (trainingBotDialogs.length && analysisType !== 'calls') sourceRefs.push('training_bot_dialogs[]');
  if (realCallsForBundle) {
    for (const rc of realCallsForBundle) {
      if (rc.source_ref) sourceRefs.push(rc.source_ref);
    }
  }
  for (const f of files) {
    if (f.source_ref) {
      if (analysisType === 'calls' && isForbiddenCallRef(f.source_ref)) continue;
      sourceRefs.push(f.source_ref);
    }
  }
  // Filter source_links for calls bundles — exclude bot_training
  const filteredSourceLinks = analysisType === 'calls'
    ? sourceLinks.filter(sl => sl.source_code !== 'bot_training')
    : sourceLinks;
  for (const sl of filteredSourceLinks) {
    sourceRefs.push(`source_link:${sl.source_code}:${sl.legacy_key || sl.legacy_id || ''}`);
  }

  // Compose safe candidate public profile (no internal id, no secrets)
  const candidatePublic = {
    base_key: candidate.base_key,
    full_name: candidate.full_name,
    seller_segment: candidate.seller_segment,
    direction: candidate.direction,
    mentor: candidate.mentor,
    recruiter: candidate.recruiter,
    test_day_started_at: candidate.test_day_started_at,
    immersion_started_at: candidate.immersion_started_at,
    status: candidate.status,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };

  return {
    schema_version: 'analysis_bundle_v1',
    base_key: baseKey,
    analysis_type: analysisType,
    exported_at: new Date().toISOString(),
    candidate: candidatePublic,
    completeness: null, // populated below
    scores: scores,
    manual_inputs: manualInputs,
    real_calls: realCallsForBundle,
    product_dictionary: analysisType === 'calls' ? (await loadProductDictionary()) : null,
    call_stats: callStats,
    ops_summary: null,
    interview_summary: interviewSummary,
    files: files,
    source_links: filteredSourceLinks.map(sl => ({
      source_code: sl.source_code,
      source_name: sl.source_name,
      legacy_key: sl.legacy_key,
      legacy_id: sl.legacy_id,
      comment: sl.comment,
    })),
    rubric: {
      rubric_id: rubric.rubric_id,
      rubric_version: rubric.rubric_version,
      evaluation_unit: rubric.evaluation_unit,
      allowed_answers: rubric.allowed_answers,
      answer_groups: rubric.answer_groups,
      stage_weights: rubric.stage_weights,
      blocks: rubric.blocks,
      stages: rubric.stages,
      candidate_scores_mapping: rubric.candidate_scores_mapping,
      evidence_schema: rubric.evidence_schema,
      source_dependencies: rubric.source_dependencies,
      fallback_rules: rubric.fallback_rules,
      interpretation_percent_zones: rubric.interpretation_percent_zones,
      model_prohibitions: rubric.model_prohibitions,
    },
    source_refs: sourceRefs,
  };
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.baseKey || !args.type || !args.out) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  try {
    const bundle = await exportBundle(args.baseKey, args.type);
    // Secret-leak guard: scan BEFORE writing the file. If a forbidden pattern
    // is found (e.g. an env var accidentally ended up in a manual_input
    // payload), the bundle must not leave the server.
    const bundleStr = JSON.stringify(bundle, null, 2);
    assertNoForbiddenSecrets(bundleStr, `export_bundle:${args.baseKey}:${args.type}`);
    const outDir = path.dirname(path.resolve(args.out));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(args.out, bundleStr, 'utf8');
    const size = fs.statSync(args.out).size;
    console.log(`OK bundle exported:`);
    console.log(`  base_key: ${args.baseKey}`);
    console.log(`  analysis_type: ${args.type}`);
    console.log(`  rubric: ${bundle.rubric.rubric_id} v${bundle.rubric.rubric_version}`);
    console.log(`  manual_inputs: ${bundle.manual_inputs.length}`);
    if (args.type === 'calls') {
      console.log(`  training_bot_dialogs: omitted for calls`);
    } else {
      console.log(`  training_bot_dialogs: ${bundle.training_bot_dialogs ? bundle.training_bot_dialogs.length : 0}`);
    }
    if (bundle.real_calls) {
      const byStage = {};
      let totalDupes = 0;
      for (const c of bundle.real_calls) {
        byStage[c.stage] = (byStage[c.stage] || 0) + 1;
        if (c.duplicate_skipped) totalDupes++;
      }
      console.log(`  real_calls: ${bundle.real_calls.length} (${Object.entries(byStage).map(([k,v]) => `${k}=${v}`).join(', ')})`);
      if (totalDupes) console.log(`  duplicate transcripts skipped: ${totalDupes}`);
    }
    console.log(`  files (metadata only): ${bundle.files.length}`);
    if (bundle.product_dictionary !== null) {
      console.log(`  product_dictionary: ${bundle.product_dictionary.length}`);
    }
    console.log(`  source_refs: ${bundle.source_refs.length}`);
    console.log(`  out: ${args.out} (${size} bytes)`);
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    if (process.env.PHASE3E0_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
