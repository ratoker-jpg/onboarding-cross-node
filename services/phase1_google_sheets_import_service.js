const crypto = require('crypto');
const { SheetsClient } = require('../sheets_client');
const { getPhase1Config } = require('../lib/phase1_config');

function createSourceConfigError(message, sourceCode) {
  const error = new Error(message);
  error.code = 'PHASE1_SOURCE_CONFIG_MISSING';
  error.source_code = sourceCode;
  error.source = sourceCode;
  return error;
}

function createImportReadError(message, sourceCode) {
  const error = new Error(message);
  error.code = 'PHASE1_IMPORT_READ_ERROR';
  error.source_code = sourceCode;
  error.source = sourceCode;
  return error;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeCell(value) {
  return normalizeText(value).toLowerCase();
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName || '').replace(/'/g, "''")}'`;
}

function makeA1Range(sheetName, range = 'A:Z') {
  return `${quoteSheetName(sheetName)}!${range}`;
}

function rowsToObjects(values = []) {
  const headers = (values[0] || []).map(cell => normalizeText(cell));
  const rows = values.slice(1).filter(row => row.some(cell => normalizeText(cell)));
  const objects = rows.map((row, index) => {
    const obj = { __rowIndex: index + 2 };
    headers.forEach((header, headerIndex) => {
      if (header) obj[header] = row[headerIndex] === undefined ? '' : row[headerIndex];
    });
    return obj;
  });
  return { headers, rows, objects };
}

function findHeader(headers, patterns) {
  const lowered = headers.map(header => ({ original: header, lowered: normalizeCell(header) }));
  for (const pattern of patterns) {
    const hit = lowered.find(entry => entry.lowered === normalizeCell(pattern));
    if (hit) return hit.original;
  }
  for (const pattern of patterns) {
    const hit = lowered.find(entry => entry.lowered.includes(normalizeCell(pattern)));
    if (hit) return hit.original;
  }
  return null;
}

function findRowsByLegacyKey(table, legacyKey, preferredHeaders) {
  const header = findHeader(table.headers, preferredHeaders);
  if (!header) return [];
  const normalizedKey = normalizeCell(legacyKey);
  return table.objects.filter(row => normalizeCell(row[header]) === normalizedKey);
}

function getFirstNonEmpty(row, patterns) {
  if (!row) return '';
  const keys = Object.keys(row);
  const header = findHeader(keys, patterns);
  return header ? normalizeText(row[header]) : '';
}

function toJson(value) {
  return JSON.stringify(value == null ? null : value);
}

function buildDedupKey(parts) {
  return crypto.createHash('sha256').update(parts.map(part => String(part || '')).join('|')).digest('hex');
}

function buildMapByField(rows, patterns, multi = false) {
  const map = new Map();
  for (const row of rows || []) {
    const key = normalizeCell(getFirstNonEmpty(row, patterns));
    if (!key) continue;
    if (multi) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
      continue;
    }
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

function buildSheetsClient(sourceCode) {
  const config = getPhase1Config();
  const source = config.sources[sourceCode];
  if (!source || !source.spreadsheetId) {
    throw createSourceConfigError('missing_source_spreadsheet_id', sourceCode);
  }
  return {
    source,
    client: new SheetsClient({
      spreadsheetId: source.spreadsheetId,
      clientPath: config.googleClientPath,
      tokenPath: config.googleTokenPath,
    }),
  };
}

async function getSpreadsheetSheetTitles(client) {
  if (Array.isArray(client.__phase1SheetTitles)) return client.__phase1SheetTitles;
  const response = await client.request('?fields=sheets.properties.title', { method: 'GET' });
  const titles = (response.sheets || [])
    .map(sheet => String(sheet && sheet.properties ? sheet.properties.title || '' : ''))
    .filter(Boolean);
  client.__phase1SheetTitles = titles;
  return titles;
}

function resolveSheetTitleFromMetadata(expectedName, titles) {
  if (!Array.isArray(titles) || !titles.length) return null;
  const exact = titles.find(title => title === expectedName);
  if (exact) return exact;
  const expectedTrimmed = String(expectedName || '').trim();
  return titles.find(title => String(title || '').trim() === expectedTrimmed) || null;
}

async function tryReadRange(client, a1Range) {
  const encoded = encodeURIComponent(a1Range);
  return client.request(`/values/${encoded}?valueRenderOption=FORMATTED_VALUE`, { method: 'GET' });
}

async function probeSheetTitle(client, expectedName, sourceCode, range = 'A:Z') {
  const candidates = Array.from(new Set([
    String(expectedName || ''),
    `${String(expectedName || '')} `,
  ].filter(Boolean)));
  for (const candidate of candidates) {
    try {
      const response = await tryReadRange(client, makeA1Range(candidate, range));
      return {
        actualName: candidate,
        values: response.values || [],
      };
    } catch (err) {
      if (err && err.status === 400) continue;
      const wrapped = createImportReadError(err && err.message ? err.message : 'google_sheets_read_failed', sourceCode);
      wrapped.cause = err;
      throw wrapped;
    }
  }
  return null;
}

async function resolveSheetRequests(client, sheetNames, sourceCode, range = 'A:Z') {
  let titles = [];
  try {
    titles = await getSpreadsheetSheetTitles(client);
  } catch (_) {
    titles = [];
  }

  const requests = [];
  for (const expectedName of sheetNames) {
    const actualName = resolveSheetTitleFromMetadata(expectedName, titles);
    if (actualName) {
      requests.push({ expectedName, actualName, a1: makeA1Range(actualName, range) });
      continue;
    }

    const probed = await probeSheetTitle(client, expectedName, sourceCode, range);
    if (probed) {
      requests.push({
        expectedName,
        actualName: probed.actualName,
        a1: makeA1Range(probed.actualName, range),
        values: probed.values,
      });
      continue;
    }

    throw createImportReadError(`sheet_not_found:${expectedName}`, sourceCode);
  }

  return requests;
}

function extractSheetNameFromRange(rangeText) {
  const raw = String(rangeText || '');
  const quotedMatch = raw.match(/^'((?:[^']|'')+)'!/);
  if (quotedMatch) return quotedMatch[1].replace(/''/g, "'");
  return raw.split('!')[0];
}

async function readSheetTables(client, sheetNames, sourceCode, range = 'A:Z') {
  const requests = await resolveSheetRequests(client, sheetNames, sourceCode, range);
  const out = {};
  const rangesUsed = [];
  const resolvedSheetNames = {};
  const pending = [];

  for (const item of requests) {
    resolvedSheetNames[item.expectedName] = item.actualName;
    rangesUsed.push(item.a1);
    if (item.values) {
      out[item.expectedName] = item.values;
    } else {
      pending.push(item);
    }
  }

  if (pending.length) {
    const params = new URLSearchParams();
    for (const item of pending) params.append('ranges', item.a1);
    params.set('valueRenderOption', 'FORMATTED_VALUE');
    let response;
    try {
      response = await client.request(`/values:batchGet?${params.toString()}`, { method: 'GET' });
    } catch (err) {
      const wrapped = createImportReadError(err && err.message ? err.message : 'google_sheets_read_failed', sourceCode);
      wrapped.cause = err;
      throw wrapped;
    }
    const byActualName = new Map(pending.map(item => [item.actualName, item.expectedName]));
    for (const item of response.valueRanges || []) {
      const actualName = extractSheetNameFromRange(item.range);
      const expectedName = byActualName.get(actualName) || actualName;
      out[expectedName] = item.values || [];
    }
  }

  for (const item of requests) {
    if (!out[item.expectedName]) out[item.expectedName] = [];
  }

  return {
    tables: out,
    ranges_used: rangesUsed,
    resolved_sheet_names: resolvedSheetNames,
  };
}

function getRecognizedQuestionColumns(headers, mode) {
  if (mode === 'interview') {
    return {
      block: findHeader(headers, ['блок', 'block', 'тип', 'раздел']),
      question_text: findHeader(headers, ['вопрос', 'question', 'текст вопроса', 'финальная формулировка вопроса']),
      model_instruction: findHeader(headers, ['инструкция', 'model instruction', 'комментарий', 'инструкция для модели']),
      risk_type: findHeader(headers, ['риск', 'risk', 'тип риска']),
      version: findHeader(headers, ['версия', 'version']),
    };
  }
  return {
    block: findHeader(headers, ['сегмент', 'block', 'раздел', 'блок']),
    question_text: findHeader(headers, ['финальная формулировка вопроса_20.04.2026', 'финальная формулировка_24.04.2026', 'финальная формулировка вопроса', 'финальная формулировка']),
    model_instruction: findHeader(headers, ['инструкция для модели / комментарий_20.04.2026', 'инструкция для модели / комментарий_24.04.2026', 'инструкция для модели / комментарий', 'инструкция']),
    risk_type: findHeader(headers, ['риск', 'risk']),
    version: null,
  };
}

function hasRecognizedQuestionColumns(recognizedColumns) {
  return Boolean(
    recognizedColumns.block ||
    recognizedColumns.question_text ||
    recognizedColumns.model_instruction ||
    recognizedColumns.risk_type ||
    recognizedColumns.version
  );
}

function buildQuestionField(row, header) {
  return header ? normalizeText(row[header]) : '';
}

function assertQuestionRows(rows, sourceCode, context) {
  const meaningful = rows.some(row => normalizeText(row.question_text) || normalizeText(row.model_instruction));
  if (!meaningful) {
    throw createImportReadError(`${context}_columns_not_found`, sourceCode);
  }
}

async function readWebMvpImport(legacyKey) {
  const { source, client } = buildSheetsClient('web_mvp');
  const sheetNames = ['Кандидаты', 'Сборка', 'Голосовой бот выгрузка'];
  const { tables: sheets, ranges_used } = await readSheetTables(client, sheetNames, source.source_code);
  const candidatesTable = rowsToObjects(sheets['Кандидаты']);
  const buildTable = rowsToObjects(sheets['Сборка']);
  const voiceTable = rowsToObjects(sheets['Голосовой бот выгрузка']);
  const candidateRows = findRowsByLegacyKey(candidatesTable, legacyKey, ['key', 'ключ']);
  const buildRows = findRowsByLegacyKey(buildTable, legacyKey, ['key', 'ключ']);
  const voiceRows = findRowsByLegacyKey(voiceTable, legacyKey, ['key', 'ключ']);
  return {
    source_code: source.source_code,
    source_name: source.source_name,
    legacy_key: legacyKey,
    candidate_row: candidateRows[0] || null,
    build_row: buildRows[0] || null,
    voice_bot_row: voiceRows[0] || null,
    rows_read: candidatesTable.objects.length + buildTable.objects.length + voiceTable.objects.length,
    ranges_used,
  };
}

async function readImmersionImport(legacyKey) {
  const { source, client } = buildSheetsClient('onboarding_route');
  const sheetNames = ['Новички', 'Прогресс', 'Отслеживание_прохождения', 'Сессии_материалов', 'Сводка_новичков', 'Помощь', 'Админ_действия'];
  const { tables: sheets, ranges_used } = await readSheetTables(client, sheetNames, source.source_code);
  const newbieTable = rowsToObjects(sheets['Новички']);
  const progressTable = rowsToObjects(sheets['Прогресс']);
  const trackingTable = rowsToObjects(sheets['Отслеживание_прохождения']);
  const sessionsTable = rowsToObjects(sheets['Сессии_материалов']);
  const summaryTable = rowsToObjects(sheets['Сводка_новичков']);
  const helpTable = rowsToObjects(sheets['Помощь']);
  const newbieRow = findRowsByLegacyKey(newbieTable, legacyKey, ['key', 'ключ'])[0] || null;
  const progressRows = findRowsByLegacyKey(progressTable, legacyKey, ['key', 'ключ']);
  const trackingRows = findRowsByLegacyKey(trackingTable, legacyKey, ['key', 'ключ']);
  const materialSessions = findRowsByLegacyKey(sessionsTable, legacyKey, ['key', 'ключ']);
  const summaryRow = findRowsByLegacyKey(summaryTable, legacyKey, ['key', 'ключ'])[0] || null;
  const helpRequests = findRowsByLegacyKey(helpTable, legacyKey, ['key', 'ключ']);
  return {
    source_code: source.source_code,
    source_name: source.source_name,
    legacy_key: legacyKey,
    newbie_row: newbieRow,
    progress_rows: progressRows,
    tracking_rows: trackingRows,
    material_sessions: materialSessions,
    summary_row: summaryRow,
    help_requests: helpRequests,
    rows_read: sheetNames.reduce((sum, name) => sum + rowsToObjects(sheets[name]).objects.length, 0),
    ranges_used,
  };
}

function parseRoleId(roleText) {
  const raw = normalizeText(roleText);
  if (!raw) return '';
  return raw.split('|')[0].trim();
}

function buildTrainingBotRoleProfile(roleRow, keyRow) {
  const teamId = getFirstNonEmpty(keyRow, ['id команды', 'team id']) || getFirstNonEmpty(roleRow, ['id команды', 'team id']);
  const teamName = getFirstNonEmpty(keyRow, ['команда', 'team name']);
  const clientName = getFirstNonEmpty(roleRow, ['фио', 'клиент', 'имя клиента']);
  return {
    role_id: getFirstNonEmpty(roleRow, ['id роли', 'role_id', 'роль id', 'id']) || null,
    team_id: teamId || null,
    team_name: teamName || null,
    company: getFirstNonEmpty(roleRow, ['название компании', 'компания']) || null,
    client: clientName || null,
    client_name: clientName || null,
    title: getFirstNonEmpty(roleRow, ['должность', 'роль']) || null,
    tax_system: getFirstNonEmpty(roleRow, ['сно', 'налоговый режим']) || null,
    previous_interactions: getFirstNonEmpty(roleRow, ['взаимодействия, которые были с клиентом ранее']) || null,
    client_context: getFirstNonEmpty(roleRow, ['информация о клиенте']) || null,
    business: getFirstNonEmpty(roleRow, ['род деятельности', 'бизнес']) || null,
    business_experience: getFirstNonEmpty(roleRow, ['опыт ведения бизнеса']) || null,
    organization_form: getFirstNonEmpty(roleRow, ['форма организации']) || null,
    success_criteria: getFirstNonEmpty(roleRow, ['критерий успеха']) || null,
    failure_criteria: getFirstNonEmpty(roleRow, ['критерий провала']) || null,
    target_action: getFirstNonEmpty(roleRow, ['целевое действие']) || null,
    objections: getFirstNonEmpty(roleRow, ['возражения']) || null,
    tone: getFirstNonEmpty(roleRow, ['тон']) || null,
    extra_client_info: getFirstNonEmpty(roleRow, ['дополнительная информация о клиенте']) || null,
    voice_id: getFirstNonEmpty(roleRow, ['id голоса']) || null,
    knowledge_base: getFirstNonEmpty(roleRow, ['база знаний']) || null,
    edge_tts_voice: getFirstNonEmpty(roleRow, ['голоса для edge‑tts', 'голоса для edge-tts']) || null,
    raw: roleRow || null,
  };
}

function buildTrainingBotResultPayload(resultRow) {
  if (!resultRow) return null;
  return {
    result_time: getFirstNonEmpty(resultRow, ['время', 'дата']) || null,
    external_id: getFirstNonEmpty(resultRow, ['id', 'ключ', 'key']) || null,
    team_id: getFirstNonEmpty(resultRow, ['id команды', 'team id']) || null,
    successful: getFirstNonEmpty(resultRow, ['успешно']) || null,
    failed: getFirstNonEmpty(resultRow, ['провалено']) || null,
    block_1: getFirstNonEmpty(resultRow, ['блок 1']) || null,
    block_2: getFirstNonEmpty(resultRow, ['блок 2']) || null,
    block_3: getFirstNonEmpty(resultRow, ['блок 3']) || null,
    block_4: getFirstNonEmpty(resultRow, ['блок 4']) || null,
    block_5: getFirstNonEmpty(resultRow, ['блок 5']) || null,
    block_6: getFirstNonEmpty(resultRow, ['блок 6']) || null,
    comment_1: getFirstNonEmpty(resultRow, ['комментарий 1']) || null,
    comment_2: getFirstNonEmpty(resultRow, ['комментарий 2']) || null,
    comment_3: getFirstNonEmpty(resultRow, ['комментарий 3']) || null,
    comment_4: getFirstNonEmpty(resultRow, ['комментарий 4']) || null,
    comment_5: getFirstNonEmpty(resultRow, ['комментарий 5']) || null,
    comment_6: getFirstNonEmpty(resultRow, ['комментарий 6']) || null,
    total_score: getFirstNonEmpty(resultRow, ['итог']) || null,
    summary: getFirstNonEmpty(resultRow, ['вывод']) || null,
    feedback: getFirstNonEmpty(resultRow, ['обратная связь']) || null,
    service_comment: getFirstNonEmpty(resultRow, ['комментарий по сервису']) || null,
    raw: resultRow,
  };
}

function matchesTrainingBotKeyRow(row, matcher) {
  if (!row || !matcher) return false;
  const rowId = normalizeCell(getFirstNonEmpty(row, ['id', 'ключ', 'key']));
  const rowTeamId = normalizeCell(getFirstNonEmpty(row, ['id команды', 'team id']));
  const rowTeamName = normalizeCell(getFirstNonEmpty(row, ['команда', 'team name']));
  const rowPrompt = normalizeCell(getFirstNonEmpty(row, ['уникальный промт', 'prompt']));
  return Boolean(
    (matcher.legacy_key && rowId === normalizeCell(matcher.legacy_key)) ||
    (matcher.team_id && rowTeamId === normalizeCell(matcher.team_id)) ||
    (matcher.team_name && rowTeamName === normalizeCell(matcher.team_name)) ||
    (matcher.session_key && rowPrompt && rowPrompt === normalizeCell(matcher.session_key))
  );
}

function buildTrainingBotMatchLabel(matcher) {
  return matcher.session_key || matcher.team_id || matcher.team_name || matcher.legacy_key || 'unknown_training_key';
}

async function readTrainingBotImport(input = {}) {
  const request = typeof input === 'string' ? { legacy_key: input } : (input || {});
  const legacyKey = normalizeText(request.legacy_key);
  const trainingKeys = Array.isArray(request.training_keys) ? request.training_keys : [];
  const { source, client } = buildSheetsClient('bot_training');
  const sheetNames = ['Ключи', 'Роли', 'Результаты', 'Траскрибация'];
  const { tables: sheets, ranges_used } = await readSheetTables(client, sheetNames, source.source_code);
  const keysTable = rowsToObjects(sheets['Ключи']);
  const rolesTable = rowsToObjects(sheets['Роли']);
  const resultsTable = rowsToObjects(sheets['Результаты']);
  const transcriptsTable = rowsToObjects(sheets['Траскрибация']);

  const roleById = buildMapByField(rolesTable.objects, ['id роли', 'role_id', 'роль id', 'id']);
  const keyRowByExternalId = buildMapByField(keysTable.objects, ['id', 'ключ', 'key']);
  const resultByExternalId = buildMapByField(resultsTable.objects, ['id', 'ключ', 'key']);
  const transcriptRowsByExternalId = buildMapByField(transcriptsTable.objects, ['ключ', 'key', 'id'], true);

  const dialogs = [];
  const warnings = [];
  const matched_training_keys = [];
  const seenDialogs = new Set();
  const matchers = trainingKeys.length
    ? trainingKeys.map(key => ({
        session_key: normalizeText(key.session_key),
        team_id: normalizeText(key.team_id),
        team_name: normalizeText(key.team_name),
        legacy_key: normalizeText(key.legacy_key),
      }))
    : (legacyKey ? [{ legacy_key: legacyKey }] : []);

  for (const matcher of matchers) {
    const matchedKeyRows = keysTable.objects.filter(row => matchesTrainingBotKeyRow(row, matcher));
    const externalIds = Array.from(new Set(
      matchedKeyRows
        .map(row => getFirstNonEmpty(row, ['id', 'ключ', 'key']))
        .concat(matcher.legacy_key ? [matcher.legacy_key] : [])
        .map(value => normalizeText(value))
        .filter(Boolean)
    ));

    if (!externalIds.length) {
      warnings.push(`no_keys_match:${buildTrainingBotMatchLabel(matcher)}`);
      continue;
    }

    matched_training_keys.push({
      training_key: matcher.session_key || null,
      team_id: matcher.team_id || null,
      team_name: matcher.team_name || null,
      matched_external_ids: externalIds,
    });

    for (const externalId of externalIds) {
      const normalizedExternalId = normalizeCell(externalId);
      const keyRow = keyRowByExternalId.get(normalizedExternalId) || null;
      const resultRow = resultByExternalId.get(normalizedExternalId) || null;
      const transcriptRows = transcriptRowsByExternalId.get(normalizedExternalId) || [];
      const baseRoleRow = keyRow
        ? rolesTable.objects.find(item => normalizeCell(getFirstNonEmpty(item, ['id команды', 'team id'])) === normalizeCell(getFirstNonEmpty(keyRow, ['id команды', 'team id']))) || null
        : null;
      const rowsToMaterialize = transcriptRows.length ? transcriptRows : (resultRow ? [null] : []);

      if (!rowsToMaterialize.length) continue;

      for (const transcriptRow of rowsToMaterialize) {
        const roleText = transcriptRow ? getFirstNonEmpty(transcriptRow, ['роль']) : '';
        const roleId = parseRoleId(roleText);
        const roleRow = roleId
          ? (roleById.get(normalizeCell(roleId)) || baseRoleRow)
          : baseRoleRow;
        const dialogDate = transcriptRow
          ? getFirstNonEmpty(transcriptRow, ['дата', 'created_at', 'timestamp'])
          : getFirstNonEmpty(resultRow, ['время', 'дата']);
        const transcriptText = transcriptRow
          ? getFirstNonEmpty(transcriptRow, ['транскрибация', 'текст', 'dialog', 'диалог'])
          : '';
        const localDedupKey = buildDedupKey([
          matcher.session_key || legacyKey || externalId,
          externalId,
          roleId || roleText,
          dialogDate,
          transcriptText || 'result_only',
        ]);
        if (seenDialogs.has(localDedupKey)) continue;
        seenDialogs.add(localDedupKey);

        const roleProfile = buildTrainingBotRoleProfile(roleRow, keyRow);
        const resultPayload = buildTrainingBotResultPayload(resultRow);
        dialogs.push({
          training_key: matcher.session_key || legacyKey || null,
          external_key: externalId,
          role_id: roleId || roleProfile.role_id || null,
          role_text: roleText || roleProfile.title || null,
          role_row: roleRow,
          role_profile: roleProfile,
          key_row: keyRow,
          result_row: resultRow,
          result_payload: resultPayload,
          result_text: resultPayload ? (resultPayload.summary || resultPayload.total_score || resultPayload.feedback || null) : null,
          transcript_row: transcriptRow,
          dialog_date: dialogDate || null,
          transcript_text: transcriptText || null,
          team_id: roleProfile.team_id || null,
          team_name: roleProfile.team_name || null,
          match_reason: keyRow ? 'team_lookup' : 'legacy_key_fallback',
        });
      }
    }
  }

  return {
    source_code: source.source_code,
    source_name: source.source_name,
    legacy_key: legacyKey,
    dialogs,
    matched_training_keys,
    warnings,
    rows_read: keysTable.objects.length + rolesTable.objects.length + resultsTable.objects.length + transcriptsTable.objects.length,
    ranges_used,
  };
}

async function readInterviewQuestionBank() {
  const { source, client } = buildSheetsClient('crosses_selection');
  const sheetNames = ['Вопросы на мотивацию', 'Вопросы на мотивацию 2.0', 'Вопросы на антихрупкость', 'Собесы'];
  const { tables: sheets, ranges_used, resolved_sheet_names } = await readSheetTables(client, sheetNames, source.source_code);
  const rows = [];
  const warnings = [];

  for (const sheetName of sheetNames) {
    const table = rowsToObjects(sheets[sheetName]);
    const actualSheetName = resolved_sheet_names[sheetName] || sheetName;
    const recognized = getRecognizedQuestionColumns(table.headers, 'interview');
    if (table.objects.length > 0 && !hasRecognizedQuestionColumns(recognized)) {
      warnings.push(`columns_not_recognized: ${actualSheetName}`);
    }
    for (const row of table.objects) {
      rows.push({
        source_code: source.source_code,
        source_name: source.source_name,
        source_sheet: actualSheetName,
        block: buildQuestionField(row, recognized.block),
        question_text: buildQuestionField(row, recognized.question_text),
        model_instruction: buildQuestionField(row, recognized.model_instruction),
        risk_type: buildQuestionField(row, recognized.risk_type),
        version: buildQuestionField(row, recognized.version),
        raw_payload: row,
      });
    }
  }

  if (!rows.length) {
    throw createImportReadError('interview_questions_no_rows_read', source.source_code);
  }

  return {
    source_code: source.source_code,
    source_name: source.source_name,
    rows,
    rows_read: rows.length,
    ranges_used,
    warnings,
  };
}

async function readManualQuestionBank() {
  const { source, client } = buildSheetsClient('automanual');
  const sheetNames = ['Базовый мануал', 'Сегментный мануал'];
  const { tables: sheets, ranges_used, resolved_sheet_names } = await readSheetTables(client, sheetNames, source.source_code);
  const rows = [];
  for (const sheetName of sheetNames) {
    const table = rowsToObjects(sheets[sheetName]);
    for (const row of table.objects) {
      rows.push({
        source_code: source.source_code,
        source_name: source.source_name,
        source_sheet: resolved_sheet_names[sheetName] || sheetName,
        block: getFirstNonEmpty(row, ['сегмент', 'block', 'раздел', 'блок']),
        question_text: getFirstNonEmpty(row, ['финальная формулировка вопроса_20.04.2026', 'финальная формулировка_24.04.2026', 'финальная формулировка вопроса', 'финальная формулировка']),
        model_instruction: getFirstNonEmpty(row, ['инструкция для модели / комментарий_20.04.2026', 'инструкция для модели / комментарий_24.04.2026', 'инструкция для модели / комментарий', 'инструкция']),
        risk_type: getFirstNonEmpty(row, ['риск', 'risk']),
        version: resolved_sheet_names[sheetName] || sheetName,
        raw_payload: row,
      });
    }
  }
  assertQuestionRows(rows, source.source_code, 'manual_questions');
  return {
    source_code: source.source_code,
    source_name: source.source_name,
    rows,
    rows_read: rows.length,
    ranges_used,
  };
}

module.exports = {
  buildDedupKey,
  makeA1Range,
  quoteSheetName,
  readImmersionImport,
  readInterviewQuestionBank,
  readManualQuestionBank,
  readTrainingBotImport,
  readWebMvpImport,
  toJson,
};
