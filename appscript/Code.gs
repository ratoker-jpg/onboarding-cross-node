/**
 * Погружение новичка в Точку — MVP WebApp
 * Таблица-источник: Маршрут новичка — кросс-продавец v1
 *
 * Как запускать:
 * 1) Создай отдельный Apps Script-проект.
 * 2) Вставь этот файл как Code.gs.
 * 3) Вставь Index.html отдельным HTML-файлом с именем Index.
 * 4) Запусти setupTelegramConfigExample_ один раз, если хочешь положить примерные значения.
 * 5) Разверни как Web App1.
 */

const SPREADSHEET_ID = '1cIUSFXfb3l1bc8E9ZWXs90osDVp7F1Wx511DNKQkvV4';
const TZ = 'Europe/Moscow';

const SHEET_NAMES = {
  NEWBIES: 'Новички',
  DAYS: 'Дни',
  BLOCKS: 'Блоки_дня',
  MATERIALS: 'Материалы',
  PROGRESS: 'Прогресс',
  SETTINGS: 'Настройки',
  SCREENS: 'Экраны_WebApp',
  HELP: 'Помощь',
  NOTIFICATIONS_LOG: 'Лог_отбивок',
  TRACKING: 'Отслеживание_прохождения',
  DAY_GOALS: 'Цели_дня',
  VISUALS: 'Визуалы',
};

const REQUIRED_DIRECTION = 'кросс-продавец';
const UNLOCK_HOUR_MSK = 7;

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function doGet() {
  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Погружение в Точку')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

/**
 * Демонстрационная функция.
 * В финале сюда нужно вставить настоящий token/chat_id и запустить один раз вручную.
 * Не храни рабочий token в Google Sheet.
 */
function setupTelegramConfigExample_() {
  PropertiesService.getScriptProperties().setProperties({
    TELEGRAM_BOT_TOKEN: 'PASTE_TELEGRAM_BOT_TOKEN_HERE',
    TELEGRAM_CHAT_ID: 'PASTE_TELEGRAM_CHAT_ID_HERE',
  }, true);
}

/**
 * Проверка ключа и загрузка состояния маршрута.
 */
function loginByKey(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    if (!key) return fail_('Введи ключ.');

    ensureRuntimeSheets_();

    const found = findNewbieByKey_(key);
    if (!found) return fail_('Ключ не найден. Проверь, что ввёл его без лишних пробелов.');

    const newbie = found.newbie;
    if (String(newbie['направление'] || '').trim().toLowerCase() !== REQUIRED_DIRECTION) {
      return fail_('Для этого ключа пока не подключён маршрут кросс-продавца.');
    }

    if (!String(newbie['маршрут_начат'] || '').trim()) {
      updateNewbieFields_(found.rowIndex, {
        'маршрут_начат': nowMskString_(),
      });
    }

    const state = buildStateForKey_(key, { showWeekPlan: true });
    logTracking_({
      key,
      name: newbie['ФИО'],
      segment: newbie['сегмент'],
      dayId: 'day_' + Number(newbie['текущий_день'] || 1),
      event: 'login',
      status: 'ok',
      currentBlockId: state.tracking && state.tracking.activeBlockId,
      raw: { showWeekPlan: true }
    });
    return ok_(state);
  } catch (err) {
    return fail_('Ошибка входа: ' + err.message);
  }
}

function getCurrentState(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    if (!key) return fail_('Не передан ключ.');
    return ok_(buildStateForKey_(key, { showWeekPlan: false }));
  } catch (err) {
    return fail_('Ошибка загрузки состояния: ' + err.message);
  }
}

/**
 * Новичок посмотрел план недели и нажал “Перейти к текущему дню”.
 */
function markWeekPlanSeen(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    const found = requireNewbie_(key);
    updateNewbieFields_(found.rowIndex, {
      'план_недели_показан': nowMskString_(),
    });
    const state = buildStateForKey_(key, { showWeekPlan: false });
    logTracking_({
      key,
      name: found.newbie['ФИО'],
      segment: found.newbie['сегмент'],
      dayId: 'day_' + Number(found.newbie['текущий_день'] || 1),
      event: 'week_plan_seen',
      status: 'ok',
      currentBlockId: state.tracking && state.tracking.activeBlockId
    });
    return ok_(state);
  } catch (err) {
    return fail_('Ошибка: ' + err.message);
  }
}

/**
 * Кнопка “Начать текущий день”.
 */
function startCurrentDay(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    const found = requireNewbie_(key);
    const stateBefore = buildStateForKey_(key, { showWeekPlan: false });

    if (stateBefore.routeStatus === 'locked') return ok_(stateBefore);
    if (stateBefore.routeStatus === 'finished') return ok_(stateBefore);

    updateNewbieFields_(found.rowIndex, {
      'статус_текущего_дня': 'in_progress',
    });

    const state = buildStateForKey_(key, { showWeekPlan: false });
    state.view = 'day';
    logTracking_({
      key,
      name: found.newbie['ФИО'],
      segment: found.newbie['сегмент'],
      dayId: 'day_' + Number(found.newbie['текущий_день'] || 1),
      event: 'day_started',
      status: 'in_progress',
      currentBlockId: state.tracking && state.tracking.activeBlockId
    });
    return ok_(state);
  } catch (err) {
    return fail_('Ошибка старта дня: ' + err.message);
  }
}

/**
 * Завершение конкретного блока.
 * payload: { key, day_id, block_id, status, comment }
 */
function completeBlock(payload) {
  try {
    payload = payload || {};
    const key = normalizeKey_(payload.key);
    const blockId = String(payload.block_id || payload.blockId || '').trim();
    const dayId = String(payload.day_id || payload.dayId || '').trim();

    if (!key) return fail_('Не передан ключ.');
    if (!blockId) return fail_('Не передан block_id.');

    const found = requireNewbie_(key);
    const newbie = found.newbie;
    const finalDayId = dayId || ('day_' + Number(newbie['текущий_день'] || 1));

    upsertProgress_(key, newbie['ФИО'], finalDayId, blockId, 'done', String(payload.comment || ''));

    const state = buildStateForKey_(key, { showWeekPlan: false });
    logTracking_({
      key,
      name: newbie['ФИО'],
      segment: newbie['сегмент'],
      dayId: finalDayId,
      blockId,
      event: 'block_completed',
      status: 'done',
      currentBlockId: state.tracking && state.tracking.activeBlockId,
      comment: String(payload.comment || ''),
      raw: payload
    });

    // Ключевая отбивка: день 3, Avaya + памятка ИИЗ пройдены.
    if (finalDayId === 'day_3') {
      maybeSendReadyToCallsNotification_(key);
    }

    return ok_(state);
  } catch (err) {
    return fail_('Ошибка завершения блока: ' + err.message);
  }
}

/**
 * Завершение текущего дня.
 */
function completeDay(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    const found = requireNewbie_(key);
    const newbie = found.newbie;
    const currentDay = Number(newbie['текущий_день'] || 1);
    const now = new Date();

    const update = {
      'статус_текущего_дня': 'completed',
      'день_завершён_мск': now,
      'последняя_отбивка_мск': now,
    };

    if (currentDay >= 5) {
      update['статус'] = 'done';
      update['следующий_день_доступен_мск'] = '';
    } else {
      update['следующий_день_доступен_мск'] = nextWorkdayAt7Msk_(now);
    }

    updateNewbieFields_(found.rowIndex, update);

    upsertProgress_(key, newbie['ФИО'], 'day_' + currentDay, 'day_' + currentDay + '_completed', 'done', 'День завершён');

    logTracking_({
      key,
      name: newbie['ФИО'],
      segment: newbie['сегмент'],
      dayId: 'day_' + currentDay,
      blockId: 'day_' + currentDay + '_completed',
      event: 'day_completed',
      status: 'done',
      currentBlockId: '',
      comment: currentDay >= 5 ? 'Первая неделя завершена' : 'День завершён'
    });

    sendNotificationOnce_({
      eventId: 'day_completed_day_' + currentDay,
      key,
      name: newbie['ФИО'],
      dayId: 'day_' + currentDay,
      blockId: 'day_complete',
      text: [
        '✅ Новичок завершил день',
        '',
        'ФИО: ' + safeText_(newbie['ФИО']),
        'Ключ: ' + safeText_(key),
        'День: ' + currentDay,
        currentDay >= 5 ? 'Статус: первая неделя завершена' : 'Следующий день: ' + formatMsk_(update['следующий_день_доступен_мск']),
      ].join('\n'),
    });

    const state = buildStateForKey_(key, { showWeekPlan: false });
    state.view = currentDay >= 5 ? 'finished' : 'locked';
    return ok_(state);
  } catch (err) {
    return fail_('Ошибка завершения дня: ' + err.message);
  }
}

/**
 * Вопрос через плавающий знак “?”.
 * payload: { key, day_id, block_id, question, source }
 */
function submitHelpRequest(payload) {
  try {
    payload = payload || {};
    const key = normalizeKey_(payload.key);
    const found = requireNewbie_(key);
    const newbie = found.newbie;
    const dayId = String(payload.day_id || payload.dayId || ('day_' + Number(newbie['текущий_день'] || 1)));
    const blockId = String(payload.block_id || payload.blockId || '');
    const question = String(payload.question || '').trim();

    if (!question) return fail_('Напиши вопрос.');

    ensureRuntimeSheets_();

    const sh = sheet_(SHEET_NAMES.HELP);
    sh.appendRow([
      nowMskString_(),
      key,
      newbie['ФИО'] || '',
      dayId,
      blockId,
      'question',
      question,
      'new',
      payload.source || 'webapp',
      JSON.stringify(payload),
    ]);

    logTracking_({
      key,
      name: newbie['ФИО'],
      segment: newbie['сегмент'],
      dayId,
      blockId,
      event: 'question_sent',
      status: 'new',
      comment: question,
      raw: payload
    });

    sendNotificationOnce_({
      eventId: 'question_' + Utilities.getUuid(),
      key,
      name: newbie['ФИО'],
      dayId,
      blockId,
      allowDuplicate: true,
      text: [
        '❓ Вопрос от новичка',
        '',
        'ФИО: ' + safeText_(newbie['ФИО']),
        'Ключ: ' + safeText_(key),
        'День: ' + safeText_(dayId),
        blockId ? 'Блок: ' + safeText_(blockId) : '',
        '',
        safeText_(question),
      ].filter(Boolean).join('\n'),
    });

    return ok_({ message: 'Вопрос отправлен.' });
  } catch (err) {
    return fail_('Ошибка отправки вопроса: ' + err.message);
  }
}

/* ==============================
   Сборка состояния для фронта
================================= */

function buildStateForKey_(key, options) {
  options = options || {};
  const found = requireNewbie_(key);
  let newbie = found.newbie;

  const resolved = resolveDayLockAndAdvance_(found.rowIndex, newbie);
  newbie = resolved.newbie;

  const currentDayNumber = Number(newbie['текущий_день'] || 1);
  const currentDayId = 'day_' + currentDayNumber;

  const routeStatus = getRouteStatus_(newbie);
  const days = getDays_();
  const day = days.find(d => String(d.day_id) === currentDayId) || null;
  const blocks = getBlocksForDay_(currentDayId);
  const materials = getMaterialsByBlock_();
  const screens = getScreensByBlock_();
  const visualsByTarget = getVisualsByTarget_();
  const progress = getProgressForKey_(key);
  const goals = getDayGoals_();

  const blocksWithData = blocks.map(block => {
    const material = materials[String(block.block_id)] || null;
    const screen = screens[String(block.block_id)] || null;
    const done = Boolean(progress[String(block.block_id)]);
    return {
      block_id: String(block.block_id || ''),
      day_id: String(block.day_id || ''),
      order: Number(block['порядок'] || 0),
      type: String(block['тип'] || ''),
      title: String(block['название'] || ''),
      description: String(block['описание'] || ''),
      expected: String(block['ожидаемый_результат'] || ''),
      material_id: String(block['material_id'] || ''),
      required: isYes_(block['обязательно']),
      autoComplete: isYes_(block['авто_завершение']),
      comment: String(block['комментарий_для_новичка'] || ''),
      done,
      material: material ? normalizeMaterial_(material) : null,
      screen: screen ? normalizeScreen_(screen) : null,
      visual: visualsByTarget[String(block.block_id || '').trim()] || null,
    };
  });

  const requiredBlocks = blocksWithData.filter(b => b.required);
  const doneRequired = requiredBlocks.filter(b => b.done).length;
  const totalRequired = requiredBlocks.length;
  const percent = totalRequired ? Math.round(doneRequired / totalRequired * 100) : 100;
  const activeBlock = requiredBlocks.find(b => !b.done) || null;
  const activeRequiredIndex = activeBlock ? requiredBlocks.findIndex(b => b.block_id === activeBlock.block_id) + 1 : totalRequired;
  const optionalBlocks = blocksWithData.filter(b => !b.required);

  return {
    key,
    newbie: {
      key,
      name: String(newbie['ФИО'] || ''),
      segment: String(newbie['сегмент'] || ''),
      direction: String(newbie['направление'] || ''),
      status: String(newbie['статус'] || ''),
      currentDay: currentDayNumber,
      currentDayStatus: String(newbie['статус_текущего_дня'] || ''),
      nextAvailableAt: formatMaybeMsk_(newbie['следующий_день_доступен_мск']),
      nextAvailableRaw: dateToIso_(newbie['следующий_день_доступен_мск']),
    },
    routeStatus,
    showWeekPlan: Boolean(options.showWeekPlan),
    day: day ? normalizeDay_(day) : null,
    blocks: blocksWithData,
    requiredBlocks,
    optionalBlocks,
    activeBlockId: activeBlock ? activeBlock.block_id : '',
    activeBlock,
    tracking: {
      mode: 'step_by_step',
      activeBlockId: activeBlock ? activeBlock.block_id : '',
      activeStep: activeRequiredIndex,
      totalSteps: totalRequired,
      doneSteps: doneRequired,
      percent,
      allRequiredDone: totalRequired ? doneRequired >= totalRequired : true,
    },
    weekPlan: days.map(normalizeDay_),
    goals,
    screens: getGlobalScreens_(),
    visuals: {
      login: visualsByTarget.login_screen || null,
      weekPlan: visualsByTarget.screen_week_plan || null,
      locked: visualsByTarget.screen_day_locked || null,
      finished: visualsByTarget.screen_finished || null,
      help: visualsByTarget.help_widget || null,
    },
    help: {
      technical: 'https://connect.tochka.com/tochka/channels/itquestions',
      study: 'https://connect.tochka.com/tochka/channels/pomogaem-uchebke',
    },
    nowMsk: nowMskString_(),
  };
}

function getRouteStatus_(newbie) {
  const currentDay = Number(newbie['текущий_день'] || 1);
  const status = String(newbie['статус_текущего_дня'] || '').trim();
  const next = asDate_(newbie['следующий_день_доступен_мск']);

  if (currentDay >= 5 && status === 'completed') return 'finished';

  if (status === 'completed' && next && new Date().getTime() < next.getTime()) {
    return 'locked';
  }

  if (status === 'available') return 'available';
  if (status === 'in_progress') return 'in_progress';
  if (!status) return 'available';

  return status;
}

/**
 * Если день завершён, а время открытия следующего уже наступило:
 * current_day + 1, status = available.
 */
function resolveDayLockAndAdvance_(rowIndex, newbie) {
  const currentDay = Number(newbie['текущий_день'] || 1);
  const status = String(newbie['статус_текущего_дня'] || '').trim();
  const next = asDate_(newbie['следующий_день_доступен_мск']);

  if (status === 'completed' && currentDay < 5 && next && new Date().getTime() >= next.getTime()) {
    updateNewbieFields_(rowIndex, {
      'текущий_день': currentDay + 1,
      'статус_текущего_дня': 'available',
      'день_завершён_мск': '',
      'следующий_день_доступен_мск': '',
    });
    return requireNewbie_(newbie['key']);
  }

  return { rowIndex, newbie };
}

function maybeSendReadyToCallsNotification_(key) {
  const requiredBlocks = ['d3_avaya_test', 'd3_iiz_process', 'd3_third_parties'];
  const progress = getProgressForKey_(key);
  const ready = requiredBlocks.every(id => progress[id]);
  if (!ready) return;

  const found = requireNewbie_(key);
  const newbie = found.newbie;

  sendNotificationOnce_({
    eventId: 'd3_ready_to_calls',
    key,
    name: newbie['ФИО'],
    dayId: 'day_3',
    blockId: 'd3_ready_to_calls',
    text: [
      '📞 Новичок готов к звонкам',
      '',
      'ФИО: ' + safeText_(newbie['ФИО']),
      'Ключ: ' + safeText_(key),
      'Сегмент: ' + safeText_(newbie['сегмент']),
      '',
      'Avaya проверена, памятка по ИИЗ пройдена, работа с третьими лицами изучена. Можно ставить/проводить встречу и выходить в первые звонки.',
    ].join('\n'),
  });
}

/* ==============================
   Чтение таблицы
================================= */

function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Не найден лист: ' + name);
  return sh;
}

function getTable_(sheetName) {
  const sh = sheet_(sheetName);
  const values = sh.getDataRange().getValues();
  if (!values.length) return { sh, headers: [], rows: [], headerMap: {} };

  const headers = values[0].map(v => String(v || '').trim());
  const headerMap = {};
  headers.forEach((h, i) => {
    if (h) headerMap[h] = i;
  });

  const rows = values.slice(1).filter(row => row.some(cell => String(cell || '').trim() !== ''));
  return { sh, headers, rows, headerMap };
}

function objectFromRow_(headers, row) {
  const obj = {};
  headers.forEach((h, i) => {
    if (h) obj[h] = row[i];
  });
  return obj;
}

function findNewbieByKey_(key) {
  const t = getTable_(SHEET_NAMES.NEWBIES);
  const keyCol = t.headerMap['key'];
  if (keyCol === undefined) throw new Error('В листе Новички нет колонки key.');

  const values = t.sh.getDataRange().getValues();
  const headers = values[0].map(v => String(v || '').trim());

  for (let r = 1; r < values.length; r++) {
    const rowKey = normalizeKey_(values[r][keyCol]);
    if (rowKey === key) {
      return {
        rowIndex: r + 1,
        newbie: objectFromRow_(headers, values[r]),
      };
    }
  }
  return null;
}

function requireNewbie_(key) {
  const found = findNewbieByKey_(key);
  if (!found) throw new Error('Ключ не найден.');
  return found;
}

function updateNewbieFields_(rowIndex, patch) {
  const sh = sheet_(SHEET_NAMES.NEWBIES);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(v => String(v || '').trim());
  const updates = [];

  Object.keys(patch).forEach(name => {
    let col = headers.indexOf(name) + 1;
    if (col <= 0) {
      col = sh.getLastColumn() + 1;
      sh.getRange(1, col).setValue(name);
      headers.push(name);
    }
    updates.push({ col, value: patch[name] });
  });

  updates.forEach(u => sh.getRange(rowIndex, u.col).setValue(u.value));
}

function getDays_() {
  const t = getTable_(SHEET_NAMES.DAYS);
  return t.rows.map(row => objectFromRow_(t.headers, row))
    .filter(d => String(d.day_id || '').trim())
    .sort((a, b) => Number(a['день'] || 0) - Number(b['день'] || 0));
}

function getBlocksForDay_(dayId) {
  const t = getTable_(SHEET_NAMES.BLOCKS);
  return t.rows.map(row => objectFromRow_(t.headers, row))
    .filter(b => String(b.day_id || '') === dayId)
    .sort((a, b) => Number(a['порядок'] || 0) - Number(b['порядок'] || 0));
}

function getMaterialsByBlock_() {
  const t = getTable_(SHEET_NAMES.MATERIALS);
  const map = {};
  t.rows.map(row => objectFromRow_(t.headers, row)).forEach(m => {
    const blockId = String(m.block_id || '').trim();
    if (blockId) map[blockId] = m;
  });
  return map;
}

function getScreensByBlock_() {
  const t = getTable_(SHEET_NAMES.SCREENS);
  const map = {};
  t.rows.map(row => objectFromRow_(t.headers, row)).forEach(s => {
    const blockId = String(s.block_id || '').trim();
    if (blockId) map[blockId] = s;
  });
  return map;
}

function getGlobalScreens_() {
  const t = getTable_(SHEET_NAMES.SCREENS);
  const map = {};
  t.rows.map(row => objectFromRow_(t.headers, row)).forEach(s => {
    const id = String(s.screen_id || '').trim();
    if (id) map[id] = normalizeScreen_(s);
  });
  return map;
}

function getProgressForKey_(key) {
  const t = getTable_(SHEET_NAMES.PROGRESS);
  const map = {};
  t.rows.map(row => objectFromRow_(t.headers, row)).forEach(p => {
    if (normalizeKey_(p.key) === key && String(p['статус'] || '') === 'done') {
      map[String(p.block_id || '').trim()] = p;
    }
  });
  return map;
}

function getDayGoals_() {
  const sh = ss_().getSheetByName(SHEET_NAMES.DAY_GOALS);
  if (!sh) return {};
  const t = getTable_(SHEET_NAMES.DAY_GOALS);
  const map = {};
  t.rows.map(row => objectFromRow_(t.headers, row)).forEach(g => {
    if (g.day_id) {
      map[String(g.day_id)] = {
        min: Number(g.min_call_minutes || 0),
        target: Number(g.target_call_minutes || 0),
        text: String(g['цель_звонков'] || ''),
        show: isYes_(g['показывать_новичку']),
      };
    }
  });
  return map;
}

/* ==============================
   Запись прогресса
================================= */

function upsertProgress_(key, name, dayId, blockId, status, comment) {
  const sh = sheet_(SHEET_NAMES.PROGRESS);
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(v => String(v || '').trim());
  const map = {};
  headers.forEach((h, i) => map[h] = i);

  const keyCol = map.key;
  const blockCol = map.block_id;
  const now = nowMskString_();

  for (let r = 1; r < values.length; r++) {
    if (normalizeKey_(values[r][keyCol]) === key && String(values[r][blockCol] || '').trim() === blockId) {
      setRowValuesByHeader_(sh, r + 1, {
        'ФИО': name || '',
        'day_id': dayId,
        'статус': status,
        'дата_завершения': now,
        'комментарий_новичка': comment || '',
        'обновлено': now,
      });
      return;
    }
  }

  const rowObj = {
    'key': key,
    'ФИО': name || '',
    'day_id': dayId,
    'block_id': blockId,
    'статус': status,
    'дата_старта': now,
    'дата_завершения': now,
    'комментарий_новичка': comment || '',
    'обновлено': now,
  };
  appendObjectRow_(sh, rowObj);
}

function setRowValuesByHeader_(sh, rowIndex, patch) {
  let headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(v => String(v || '').trim());
  Object.keys(patch).forEach(name => {
    let col = headers.indexOf(name) + 1;
    if (col <= 0) {
      col = sh.getLastColumn() + 1;
      sh.getRange(1, col).setValue(name);
      headers.push(name);
    }
    sh.getRange(rowIndex, col).setValue(patch[name]);
  });
}

function appendObjectRow_(sh, obj) {
  let headers = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(v => String(v || '').trim());
  if (!headers.length || !headers[0]) {
    headers = Object.keys(obj);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  Object.keys(obj).forEach(name => {
    if (headers.indexOf(name) < 0) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(name);
      headers.push(name);
    }
  });

  const row = headers.map(h => obj[h] !== undefined ? obj[h] : '');
  sh.appendRow(row);
}


/* ==============================
   Отслеживание прохождения
================================= */

function logTracking_(payload) {
  try {
    payload = payload || {};
    ensureRuntimeSheets_();

    const key = normalizeKey_(payload.key);
    const dayId = String(payload.dayId || payload.day_id || '');
    const blockId = String(payload.blockId || payload.block_id || '');
    const blocks = dayId ? getBlocksForDay_(dayId) : [];
    const progress = key ? getProgressForKey_(key) : {};
    const requiredBlocks = blocks.filter(b => isYes_(b['обязательно']));
    const doneRequired = requiredBlocks.filter(b => progress[String(b.block_id || '').trim()]).length;
    const totalRequired = requiredBlocks.length;
    const percent = totalRequired ? Math.round(doneRequired / totalRequired * 100) : 0;
    const activeBlock = requiredBlocks.map(b => String(b.block_id || '').trim()).find(id => !progress[id]) || '';
    const block = blocks.find(b => String(b.block_id || '').trim() === blockId) || null;

    const sh = sheet_(SHEET_NAMES.TRACKING);
    sh.appendRow([
      nowMskString_(),
      key,
      payload.name || '',
      payload.segment || '',
      dayId,
      dayId ? String(dayId).replace('day_', '') : '',
      blockId,
      block ? Number(block['порядок'] || '') : '',
      payload.event || '',
      payload.status || '',
      percent,
      doneRequired,
      totalRequired,
      payload.currentBlockId || activeBlock || '',
      payload.comment || '',
      JSON.stringify(payload.raw || payload),
    ]);
  } catch (err) {
    // Не ломаем пользовательский сценарий из-за логирования.
    console.error('logTracking_ failed: ' + err.message);
  }
}

/* ==============================
   Telegram и логи
================================= */

function sendNotificationOnce_(payload) {
  payload = payload || {};
  ensureRuntimeSheets_();

  if (!payload.allowDuplicate && notificationAlreadyLogged_(payload.eventId, payload.key, payload.dayId, payload.blockId)) {
    return;
  }

  let status = 'not_sent';
  let message = '';

  try {
    message = sendTelegram_(payload.text || '');
    status = 'sent';
  } catch (err) {
    status = 'error: ' + err.message;
  }

  const sh = sheet_(SHEET_NAMES.NOTIFICATIONS_LOG);
  sh.appendRow([
    nowMskString_(),
    payload.eventId || '',
    payload.key || '',
    payload.name || '',
    payload.dayId || '',
    payload.blockId || '',
    status,
    message,
    JSON.stringify(payload),
  ]);
}

function notificationAlreadyLogged_(eventId, key, dayId, blockId) {
  const sh = sheet_(SHEET_NAMES.NOTIFICATIONS_LOG);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return false;

  for (let r = 1; r < values.length; r++) {
    if (
      String(values[r][1] || '') === String(eventId || '') &&
      normalizeKey_(values[r][2]) === normalizeKey_(key) &&
      String(values[r][4] || '') === String(dayId || '') &&
      String(values[r][5] || '') === String(blockId || '')
    ) {
      return true;
    }
  }
  return false;
}

function sendTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');

  if (!token || !chatId || token === 'PASTE_TELEGRAM_BOT_TOKEN_HERE') {
    return 'Telegram config is empty. Message was logged only.';
  }

  const url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true,
    }),
    muteHttpExceptions: true,
  });

  return res.getContentText();
}

/* ==============================
   Runtime sheets
================================= */

function ensureRuntimeSheets_() {
  const ss = ss_();

  if (!ss.getSheetByName(SHEET_NAMES.HELP)) {
    const sh = ss.insertSheet(SHEET_NAMES.HELP);
    sh.appendRow(['timestamp_msk', 'key', 'ФИО', 'day_id', 'block_id', 'тип', 'текст', 'статус', 'source', 'raw_payload']);
  }

  if (!ss.getSheetByName(SHEET_NAMES.NOTIFICATIONS_LOG)) {
    const sh = ss.insertSheet(SHEET_NAMES.NOTIFICATIONS_LOG);
    sh.appendRow(['timestamp_msk', 'event_id', 'key', 'ФИО', 'day_id', 'block_id', 'status', 'message', 'raw_payload']);
  }

  if (!ss.getSheetByName(SHEET_NAMES.TRACKING)) {
    const sh = ss.insertSheet(SHEET_NAMES.TRACKING);
    sh.appendRow(['timestamp_msk', 'key', 'ФИО', 'сегмент', 'day_id', 'день', 'block_id', 'шаг', 'событие', 'статус', 'процент_дня', 'завершено_блоков', 'всего_блоков', 'current_block_id', 'комментарий', 'raw_payload']);
  }
}


/* ==============================
   Визуалы
================================= */

function getVisualsByTarget_() {
  const sh = ss_().getSheetByName(SHEET_NAMES.VISUALS);
  if (!sh) return {};

  const t = getTable_(SHEET_NAMES.VISUALS);
  const map = {};

  t.rows.map(row => objectFromRow_(t.headers, row)).forEach(v => {
    const fileName = String(v['имя_файла'] || '').trim();
    const targetRaw = String(v['block_id/screen_id'] || '').trim();
    if (!fileName || !targetRaw) return;

    const visual = normalizeVisual_(v);
    targetRaw.split('/').map(x => x.trim()).filter(Boolean).forEach(target => {
      map[target] = visual;
    });
  });

  return map;
}

function normalizeVisual_(v) {
  return {
    visual_id: String(v.visual_id || ''),
    place: String(v['экран/место'] || ''),
    day_id: String(v.day_id || ''),
    target: String(v['block_id/screen_id'] || ''),
    priority: String(v['приоритет'] || ''),
    file: String(v['имя_файла'] || ''),
    format: String(v['формат'] || ''),
    size: String(v['размер_ориентир'] || ''),
    description: String(v['что_на_картинке'] || ''),
    purpose: String(v['зачем_нужна'] || ''),
    status: String(v['статус'] || ''),
    comment: String(v['комментарий'] || ''),
  };
}

/* ==============================
   Нормализация данных
================================= */

function normalizeDay_(d) {
  return {
    day_id: String(d.day_id || ''),
    number: Number(d['день'] || 0),
    title: String(d['название'] || ''),
    goal: String(d['цель_дня'] || ''),
    description: String(d['короткое_описание'] || ''),
    checkpoint: String(d['чекпоинт_дня'] || ''),
  };
}

function normalizeMaterial_(m) {
  return {
    material_id: String(m.material_id || ''),
    title: String(m['название'] || ''),
    type: String(m['тип'] || ''),
    url: String(m['ссылка'] || ''),
    required: isYes_(m['обязательность']),
    duration: String(m['длительность_мин'] || ''),
    after: String(m['что_сделать_после'] || ''),
    comment: String(m['комментарий'] || ''),
    isLink: /^https?:\/\//i.test(String(m['ссылка'] || '')),
  };
}

function normalizeScreen_(s) {
  return {
    screen_id: String(s.screen_id || ''),
    day_id: String(s.day_id || ''),
    block_id: String(s.block_id || ''),
    type: String(s['тип_экрана'] || ''),
    title: String(s['заголовок'] || ''),
    subtitle: String(s['подзаголовок'] || ''),
    text: String(s['основной_текст'] || ''),
    button: String(s['кнопка'] || ''),
    action: String(s['ссылка/действие'] || ''),
    comment: String(s['комментарий'] || ''),
  };
}

function normalizeKey_(v) {
  return String(v || '').trim().toUpperCase();
}

function isYes_(v) {
  const s = String(v || '').trim().toLowerCase();
  return ['yes', 'да', 'true', '1', 'required'].indexOf(s) >= 0;
}

/* ==============================
   Даты
================================= */

function nextWorkdayAt7Msk_(date) {
  let d = mskDateOnly_(date);
  d = new Date(d.getTime() + 24 * 60 * 60 * 1000);

  while (isWeekendMsk_(d)) {
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }

  const ymd = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  return new Date(ymd + 'T' + String(UNLOCK_HOUR_MSK).padStart(2, '0') + ':00:00+03:00');
}

function mskDateOnly_(date) {
  const ymd = Utilities.formatDate(date || new Date(), TZ, 'yyyy-MM-dd');
  return new Date(ymd + 'T00:00:00+03:00');
}

function isWeekendMsk_(date) {
  const day = Number(Utilities.formatDate(date, TZ, 'u')); // 1 = Monday, 7 = Sunday
  return day === 6 || day === 7;
}

function nowMskString_() {
  return Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm:ss');
}

function formatMsk_(date) {
  return Utilities.formatDate(asDate_(date), TZ, 'dd.MM.yyyy HH:mm');
}

function formatMaybeMsk_(value) {
  const d = asDate_(value);
  return d ? Utilities.formatDate(d, TZ, 'dd.MM.yyyy HH:mm') : '';
}

function asDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function dateToIso_(value) {
  const d = asDate_(value);
  return d ? d.toISOString() : '';
}

/* ==============================
   Ответы
================================= */

function ok_(data) {
  return { ok: true, data: data || {} };
}

function fail_(message) {
  return { ok: false, error: message || 'Ошибка.' };
}

function safeText_(v) {
  return String(v === undefined || v === null ? '' : v);
}
/* ==============================
   V4: админка, тайминги, ручное управление
================================= */

SHEET_NAMES.ADMIN_ACTIONS = 'Админ_действия';
SHEET_NAMES.MATERIAL_SESSIONS = 'Сессии_материалов';
SHEET_NAMES.SUMMARY = 'Сводка_новичков';

const MATERIAL_OPEN_LOCK_SECONDS = 30;

function setupAdminConfigExample_() {
  PropertiesService.getScriptProperties().setProperties({
    ADMIN_KEY: 'PASTE_ADMIN_KEY_HERE',
    TELEGRAM_BOT_TOKEN: 'PASTE_TELEGRAM_BOT_TOKEN_HERE',
    TELEGRAM_CHAT_ID: 'PASTE_TELEGRAM_CHAT_ID_HERE',
  }, true);
}

function loginByKey(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    if (!key) return fail_('Введи ключ.');
    ensureRuntimeSheets_();

    if (isAdminKey_(key)) {
      logAdminAction_({ adminKey: key, action: 'admin_login', comment: 'Админ вошёл в панель' });
      return ok_({ mode: 'admin', admin: true, dashboard: getAdminDashboardData_(key), adminKeyHint: 'ok' });
    }

    const found = findNewbieByKey_(key);
    if (!found) return fail_('Ключ не найден. Проверь, что ввёл его без лишних пробелов.');

    const newbie = found.newbie;
    if (String(newbie['направление'] || '').trim().toLowerCase() !== REQUIRED_DIRECTION) {
      return fail_('Для этого ключа пока не подключён маршрут кросс-продавца.');
    }

    if (!String(newbie['маршрут_начат'] || '').trim()) {
      updateNewbieFields_(found.rowIndex, { 'маршрут_начат': nowMskString_() });
    }

    const state = buildStateForKey_(key, { showWeekPlan: true });
    logTracking_({
      key,
      name: newbie['ФИО'],
      segment: newbie['сегмент'],
      dayId: 'day_' + Number(newbie['текущий_день'] || 1),
      event: 'login',
      status: 'ok',
      currentBlockId: state.tracking && state.tracking.activeBlockId,
      raw: { showWeekPlan: true }
    });
    return ok_(state);
  } catch (err) {
    return fail_('Ошибка входа: ' + err.message);
  }
}

function getAdminDashboard(adminKey) {
  try {
    requireAdmin_(adminKey);
    return ok_({ mode: 'admin', admin: true, dashboard: getAdminDashboardData_(adminKey) });
  } catch (err) {
    return fail_('Ошибка админки: ' + err.message);
  }
}

function createNewbieKey(payload) {
  try {
    payload = payload || {};
    requireAdmin_(payload.adminKey);
    ensureRuntimeSheets_();

    const name = String(payload.name || payload.fio || '').trim();
    const segment = String(payload.segment || '').trim();
    const direction = String(payload.direction || REQUIRED_DIRECTION).trim() || REQUIRED_DIRECTION;

    if (!name) return fail_('Укажи ФИО новичка.');
    if (!segment) return fail_('Укажи сегмент.');

    const key = generateUniqueNewbieKey_();
    const today = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy');
    const sh = sheet_(SHEET_NAMES.NEWBIES);

    appendObjectRow_(sh, {
      'key': key,
      'ФИО': name,
      'сегмент': segment,
      'направление': direction,
      'старт': today,
      'текущий_день': 1,
      'статус': 'active',
      'наставник': '',
      'telegram': '',
      'email': '',
      'ссылка_на_результат_тестового_дня': '',
      'комментарий': '',
      'статус_текущего_дня': 'available',
      'день_завершён_мск': '',
      'следующий_день_доступен_мск': '',
      'последняя_отбивка_мск': '',
      'маршрут_начат': '',
      'план_недели_показан': '',
    });

    logAdminAction_({
      adminKey: payload.adminKey,
      key,
      name,
      action: 'create_newbie_key',
      newValue: key,
      comment: 'Создан ключ новичка',
      raw: payload
    });

    return ok_({ key, name, segment, direction, dashboard: getAdminDashboardData_(payload.adminKey) });
  } catch (err) {
    return fail_('Ошибка создания ключа: ' + err.message);
  }
}

function getNewbieAdminState(adminKey, newbieKey) {
  try {
    requireAdmin_(adminKey);
    const key = normalizeKey_(newbieKey);
    const found = requireNewbie_(key);
    const state = buildStateForKey_(key, { showWeekPlan: false });
    return ok_({
      mode: 'admin_newbie',
      newbie: state.newbie,
      state,
      progress: getProgressRowsForKey_(key),
      sessions: getMaterialSessionRowsForKey_(key),
      help: getHelpRowsForKey_(key),
      tracking: getTrackingRowsForKey_(key, 80),
    });
  } catch (err) {
    return fail_('Ошибка карточки новичка: ' + err.message);
  }
}

function forceOpenNextDay(adminKey, newbieKey) {
  try {
    requireAdmin_(adminKey);
    const key = normalizeKey_(newbieKey);
    const found = requireNewbie_(key);
    const newbie = found.newbie;
    const currentDay = Number(newbie['текущий_день'] || 1);
    const nextDay = Math.min(currentDay + 1, 5);

    updateNewbieFields_(found.rowIndex, {
      'текущий_день': nextDay,
      'статус_текущего_дня': 'available',
      'день_завершён_мск': '',
      'следующий_день_доступен_мск': '',
      'последняя_отбивка_мск': nowMskString_(),
    });

    logAdminAction_({
      adminKey,
      key,
      name: newbie['ФИО'],
      dayId: 'day_' + nextDay,
      action: 'force_open_next_day',
      oldValue: String(currentDay),
      newValue: String(nextDay),
      comment: 'Следующий день открыт вручную'
    });

    return getNewbieAdminState(adminKey, key);
  } catch (err) {
    return fail_('Ошибка ручного открытия дня: ' + err.message);
  }
}

function forceOpenDay(adminKey, newbieKey, dayNumber) {
  try {
    requireAdmin_(adminKey);
    const key = normalizeKey_(newbieKey);
    const found = requireNewbie_(key);
    const newbie = found.newbie;
    const day = Math.max(1, Math.min(5, Number(dayNumber || 1)));

    updateNewbieFields_(found.rowIndex, {
      'текущий_день': day,
      'статус_текущего_дня': 'available',
      'день_завершён_мск': '',
      'следующий_день_доступен_мск': '',
      'последняя_отбивка_мск': nowMskString_(),
    });

    logAdminAction_({
      adminKey,
      key,
      name: newbie['ФИО'],
      dayId: 'day_' + day,
      action: 'force_open_day',
      oldValue: String(newbie['текущий_день'] || ''),
      newValue: String(day),
      comment: 'Конкретный день открыт вручную'
    });

    return getNewbieAdminState(adminKey, key);
  } catch (err) {
    return fail_('Ошибка открытия выбранного дня: ' + err.message);
  }
}

function getPreviewState(adminKey, dayNumber, blockId) {
  try {
    requireAdmin_(adminKey);
    const day = Math.max(1, Math.min(5, Number(dayNumber || 1)));
    const state = buildPreviewState_(day, String(blockId || ''));
    logAdminAction_({ adminKey, dayId: 'day_' + day, blockId: blockId || '', action: 'preview_day', comment: 'Открыт preview-режим' });
    return ok_({ mode: 'admin_preview', state });
  } catch (err) {
    return fail_('Ошибка preview: ' + err.message);
  }
}

function recordMaterialOpened(payload) {
  try {
    payload = payload || {};
    const key = normalizeKey_(payload.key);
    const blockId = String(payload.block_id || payload.blockId || '').trim();
    const dayId = String(payload.day_id || payload.dayId || '').trim();
    if (!key) return fail_('Не передан ключ.');
    if (!blockId) return fail_('Не передан block_id.');

    const found = requireNewbie_(key);
    const newbie = found.newbie;
    const material = getMaterialForBlock_(blockId) || {};
    const sessionId = Utilities.getUuid();
    const now = new Date();
    const sh = sheet_(SHEET_NAMES.MATERIAL_SESSIONS);

    sh.appendRow([
      sessionId,
      key,
      newbie['ФИО'] || '',
      dayId || ('day_' + Number(newbie['текущий_день'] || 1)),
      blockId,
      String(material.material_id || ''),
      String(material['название'] || ''),
      String(material['ссылка'] || payload.url || ''),
      nowMskString_(),
      now.toISOString(),
      '',
      '',
      '',
      '',
      'opened'
    ]);

    logTracking_({
      key,
      name: newbie['ФИО'],
      segment: newbie['сегмент'],
      dayId: dayId || ('day_' + Number(newbie['текущий_день'] || 1)),
      blockId,
      event: 'material_opened',
      status: 'opened',
      comment: String(material['название'] || ''),
      raw: payload
    });

    return ok_({ sessionId, openedAt: nowMskString_(), lockSeconds: MATERIAL_OPEN_LOCK_SECONDS });
  } catch (err) {
    return fail_('Ошибка фиксации открытия материала: ' + err.message);
  }
}

function completeBlock(payload) {
  try {
    payload = payload || {};
    const key = normalizeKey_(payload.key);
    const blockId = String(payload.block_id || payload.blockId || '').trim();
    const dayId = String(payload.day_id || payload.dayId || '').trim();

    if (!key) return fail_('Не передан ключ.');
    if (!blockId) return fail_('Не передан block_id.');

    const found = requireNewbie_(key);
    const newbie = found.newbie;
    const finalDayId = dayId || ('day_' + Number(newbie['текущий_день'] || 1));
    const sessionData = completeLatestMaterialSession_(key, blockId);

    upsertProgress_(key, newbie['ФИО'], finalDayId, blockId, 'done', String(payload.comment || ''));
    updateProgressTimingFields_(key, blockId, sessionData);

    const state = buildStateForKey_(key, { showWeekPlan: false });
    logTracking_({
      key,
      name: newbie['ФИО'],
      segment: newbie['сегмент'],
      dayId: finalDayId,
      blockId,
      event: 'block_completed',
      status: 'done',
      currentBlockId: state.tracking && state.tracking.activeBlockId,
      comment: sessionData && sessionData.durationMin ? ('Длительность: ' + sessionData.durationMin + ' мин') : String(payload.comment || ''),
      raw: Object.assign({}, payload, { session: sessionData || null })
    });

    if (finalDayId === 'day_3') maybeSendReadyToCallsNotification_(key);
    return ok_(state);
  } catch (err) {
    return fail_('Ошибка завершения блока: ' + err.message);
  }
}

function buildStateForKey_(key, options) {
  options = options || {};
  const found = requireNewbie_(key);
  let newbie = found.newbie;

  const resolved = resolveDayLockAndAdvance_(found.rowIndex, newbie);
  newbie = resolved.newbie;

  const currentDayNumber = Number(newbie['текущий_день'] || 1);
  const currentDayId = 'day_' + currentDayNumber;

  const routeStatus = getRouteStatus_(newbie);
  const days = getDays_();
  const day = days.find(d => String(d.day_id) === currentDayId) || null;
  const blocks = getBlocksForDay_(currentDayId);
  const materials = getMaterialsByBlock_();
  const screens = getScreensByBlock_();
  const visualsByTarget = getVisualsByTarget_();
  const progress = getProgressForKey_(key);
  const goals = getDayGoals_();
  const sessionMap = getOpenSessionMapForKey_(key);

  const blocksWithData = blocks.map(block => {
    const blockId = String(block.block_id || '').trim();
    const material = materials[blockId] || null;
    const screen = screens[blockId] || null;
    const progressRow = progress[blockId] || null;
    const done = Boolean(progressRow);
    return {
      block_id: blockId,
      day_id: String(block.day_id || ''),
      order: Number(block['порядок'] || 0),
      type: String(block['тип'] || ''),
      title: String(block['название'] || ''),
      description: String(block['описание'] || ''),
      expected: String(block['ожидаемый_результат'] || ''),
      material_id: String(block['material_id'] || ''),
      required: isYes_(block['обязательно']),
      autoComplete: isYes_(block['авто_завершение']),
      comment: String(block['комментарий_для_новичка'] || ''),
      done,
      progress: progressRow,
      material: material ? normalizeMaterial_(material) : null,
      screen: screen ? normalizeScreen_(screen) : null,
      visual: visualsByTarget[blockId] || null,
      openSession: sessionMap[blockId] || null,
    };
  });

  const requiredBlocks = blocksWithData.filter(b => b.required);
  const doneRequired = requiredBlocks.filter(b => b.done).length;
  const totalRequired = requiredBlocks.length;
  const percent = totalRequired ? Math.round(doneRequired / totalRequired * 100) : 100;
  const activeBlock = requiredBlocks.find(b => !b.done) || null;
  const activeRequiredIndex = activeBlock ? requiredBlocks.findIndex(b => b.block_id === activeBlock.block_id) + 1 : totalRequired;
  const optionalBlocks = blocksWithData.filter(b => !b.required);

  return {
    key,
    mode: 'student',
    newbie: {
      key,
      name: String(newbie['ФИО'] || ''),
      segment: String(newbie['сегмент'] || ''),
      direction: String(newbie['направление'] || ''),
      status: String(newbie['статус'] || ''),
      currentDay: currentDayNumber,
      currentDayStatus: String(newbie['статус_текущего_дня'] || ''),
      nextAvailableAt: formatMaybeMsk_(newbie['следующий_день_доступен_мск']),
      nextAvailableRaw: dateToIso_(newbie['следующий_день_доступен_мск']),
    },
    routeStatus,
    showWeekPlan: Boolean(options.showWeekPlan),
    day: day ? normalizeDay_(day) : null,
    blocks: blocksWithData,
    requiredBlocks,
    optionalBlocks,
    activeBlockId: activeBlock ? activeBlock.block_id : '',
    activeBlock,
    tracking: {
      mode: 'step_by_step',
      activeBlockId: activeBlock ? activeBlock.block_id : '',
      activeStep: activeRequiredIndex,
      totalSteps: totalRequired,
      doneSteps: doneRequired,
      percent,
      allRequiredDone: totalRequired ? doneRequired >= totalRequired : true,
    },
    weekPlan: days.map(normalizeDay_),
    goals,
    screens: getGlobalScreens_(),
    visuals: {
      login: visualsByTarget.login_screen || null,
      weekPlan: visualsByTarget.screen_week_plan || null,
      locked: visualsByTarget.screen_day_locked || null,
      finished: visualsByTarget.screen_finished || null,
      help: visualsByTarget.help_widget || null,
    },
    help: {
      technical: 'https://connect.tochka.com/tochka/channels/itquestions',
      study: 'https://connect.tochka.com/tochka/channels/pomogaem-uchebke',
    },
    materialLockSeconds: MATERIAL_OPEN_LOCK_SECONDS,
    nowMsk: nowMskString_(),
  };
}

function ensureRuntimeSheets_() {
  const ss = ss_();
  ensureSheetWithHeader_(ss, SHEET_NAMES.HELP, ['timestamp_msk', 'key', 'ФИО', 'day_id', 'block_id', 'тип', 'текст', 'статус', 'source', 'raw_payload']);
  ensureSheetWithHeader_(ss, SHEET_NAMES.NOTIFICATIONS_LOG, ['timestamp_msk', 'event_id', 'key', 'ФИО', 'day_id', 'block_id', 'status', 'message', 'raw_payload']);
  ensureSheetWithHeader_(ss, SHEET_NAMES.TRACKING, ['timestamp_msk', 'key', 'ФИО', 'сегмент', 'day_id', 'день', 'block_id', 'шаг', 'событие', 'статус', 'процент_дня', 'завершено_блоков', 'всего_блоков', 'current_block_id', 'комментарий', 'raw_payload']);
  ensureSheetWithHeader_(ss, SHEET_NAMES.ADMIN_ACTIONS, ['timestamp_msk', 'admin_action', 'admin_key_hash', 'key', 'ФИО', 'day_id', 'block_id', 'action', 'old_value', 'new_value', 'comment', 'raw_payload']);
  ensureSheetWithHeader_(ss, SHEET_NAMES.MATERIAL_SESSIONS, ['session_id', 'key', 'ФИО', 'day_id', 'block_id', 'material_id', 'material_title', 'material_url', 'opened_at_msk', 'opened_at_iso', 'completed_at_msk', 'completed_at_iso', 'duration_sec', 'duration_min', 'status']);
  ensureSheetWithHeader_(ss, SHEET_NAMES.SUMMARY, ['generated_at_msk', 'key', 'ФИО', 'сегмент', 'направление', 'текущий_день', 'статус', 'статус_текущего_дня', 'процент_текущего_дня', 'пройдено_блоков', 'всего_блоков', 'вопросов', 'последняя_активность', 'зона']);
}

function ensureSheetWithHeader_(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0 || !String(sh.getRange(1, 1).getValue() || '').trim()) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  }
  return sh;
}

function isAdminKey_(rawKey) {
  const key = normalizeKey_(rawKey);
  const propKey = normalizeKey_(PropertiesService.getScriptProperties().getProperty('ADMIN_KEY'));
  return Boolean(key && propKey && key === propKey);
}

function requireAdmin_(rawKey) {
  if (!isAdminKey_(rawKey)) throw new Error('Нет доступа к админке. Проверь админский ключ.');
  return true;
}

function hashAdminKey_(rawKey) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(rawKey || ''));
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('').slice(0, 16);
}

function logAdminAction_(payload) {
  try {
    payload = payload || {};
    ensureRuntimeSheets_();
    sheet_(SHEET_NAMES.ADMIN_ACTIONS).appendRow([
      nowMskString_(),
      payload.action || payload.adminAction || '',
      hashAdminKey_(payload.adminKey || ''),
      normalizeKey_(payload.key || ''),
      payload.name || '',
      payload.dayId || '',
      payload.blockId || '',
      payload.action || '',
      payload.oldValue || '',
      payload.newValue || '',
      payload.comment || '',
      JSON.stringify(payload.raw || payload),
    ]);
  } catch (err) {
    console.error('logAdminAction_ failed: ' + err.message);
  }
}

function generateUniqueNewbieKey_() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 30; attempt++) {
    let key = 'CR-';
    for (let i = 0; i < 8; i++) key += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    if (!findNewbieByKey_(key)) return key;
  }
  throw new Error('Не получилось сгенерировать уникальный ключ. Попробуй ещё раз.');
}

function getAdminDashboardData_(adminKey) {
  requireAdmin_(adminKey);
  ensureRuntimeSheets_();
  const summary = buildNewbieSummaries_();
  writeSummarySheet_(summary);
  return {
    generatedAt: nowMskString_(),
    students: summary,
    stats: {
      total: summary.length,
      active: summary.filter(s => s.status !== 'done').length,
      green: summary.filter(s => s.zone === 'green').length,
      yellow: summary.filter(s => s.zone === 'yellow').length,
      red: summary.filter(s => s.zone === 'red').length,
    }
  };
}

function buildNewbieSummaries_() {
  const t = getTable_(SHEET_NAMES.NEWBIES);
  const newbies = t.rows.map(row => objectFromRow_(t.headers, row)).filter(n => normalizeKey_(n.key));
  const helpCounts = getHelpCounts_();
  const lastActivity = getLastActivityMap_();
  const studyStats = getStudyStatsMap_();

  return newbies.map(n => {
    const key = normalizeKey_(n.key);
    const currentDay = Number(n['текущий_день'] || 1);
    const dayId = 'day_' + currentDay;
    const blocks = getBlocksForDay_(dayId).filter(b => isYes_(b['обязательно']));
    const progress = getProgressForKey_(key);
    const done = blocks.filter(b => progress[String(b.block_id || '').trim()]).length;
    const total = blocks.length;
    const percent = total ? Math.round(done / total * 100) : 0;
    const status = String(n['статус'] || 'active');
    const currentDayStatus = String(n['статус_текущего_дня'] || '');
    const activity = lastActivity[key] || '';
    const questions = helpCounts[key] || 0;
    const zone = getSummaryZone_(status, currentDayStatus, percent, questions, activity);
    const activeBlock = blocks.map(b => String(b.block_id || '').trim()).find(id => !progress[id]) || '';
    const study = studyStats[key] || { minutes: 0, sessions: 0, completed: 0 };

    return {
      key,
      name: String(n['ФИО'] || ''),
      segment: String(n['сегмент'] || ''),
      direction: String(n['направление'] || ''),
      currentDay,
      status,
      currentDayStatus,
      percent,
      doneBlocks: done,
      totalBlocks: total,
      activeBlock,
      questions,
      lastActivity: activity,
      studyMinutes: study.minutes,
      materialSessions: study.sessions,
      zone,
    };
  });
}

function getSummaryZone_(status, currentDayStatus, percent, questions, lastActivity) {
  if (status === 'done') return 'green';
  if (!lastActivity) return 'yellow';
  if (questions >= 5) return 'yellow';
  if (currentDayStatus === 'completed' || currentDayStatus === 'locked') return 'green';
  if (percent >= 70) return 'green';
  return 'yellow';
}

function writeSummarySheet_(summary) {
  const sh = sheet_(SHEET_NAMES.SUMMARY);
  const header = ['generated_at_msk', 'key', 'ФИО', 'сегмент', 'направление', 'текущий_день', 'статус', 'статус_текущего_дня', 'процент_текущего_дня', 'пройдено_блоков', 'всего_блоков', 'вопросов', 'последняя_активность', 'зона'];
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (!summary.length) return;
  const now = nowMskString_();
  const rows = summary.map(s => [now, s.key, s.name, s.segment, s.direction, s.currentDay, s.status, s.currentDayStatus, s.percent, s.doneBlocks, s.totalBlocks, s.questions, s.lastActivity, s.zone]);
  sh.getRange(2, 1, rows.length, header.length).setValues(rows);
}

function getHelpCounts_() {
  const sh = ss_().getSheetByName(SHEET_NAMES.HELP);
  const counts = {};
  if (!sh) return counts;
  const t = getTable_(SHEET_NAMES.HELP);
  t.rows.map(row => objectFromRow_(t.headers, row)).forEach(h => {
    const key = normalizeKey_(h.key);
    if (key) counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function getLastActivityMap_() {
  const sh = ss_().getSheetByName(SHEET_NAMES.TRACKING);
  const map = {};
  if (!sh) return map;
  const t = getTable_(SHEET_NAMES.TRACKING);
  t.rows.map(row => objectFromRow_(t.headers, row)).forEach(r => {
    const key = normalizeKey_(r.key);
    if (key) map[key] = String(r.timestamp_msk || '');
  });
  return map;
}

function getProgressRowsForKey_(key) {
  const t = getTable_(SHEET_NAMES.PROGRESS);
  return t.rows.map(row => objectFromRow_(t.headers, row)).filter(r => normalizeKey_(r.key) === normalizeKey_(key));
}

/**
 * Сводка по времени на материалах для всех новичков.
 * Читает лист material_sessions один раз и суммирует duration_min по ключу.
 * Возвращает { [key]: { minutes, sessions, completed } }. Схему не меняет.
 */
function getStudyStatsMap_() {
  const map = {};
  const sh = ss_().getSheetByName(SHEET_NAMES.MATERIAL_SESSIONS);
  if (!sh) return map;
  const t = getTable_(SHEET_NAMES.MATERIAL_SESSIONS);
  t.rows.map(row => objectFromRow_(t.headers, row)).forEach(r => {
    const key = normalizeKey_(r.key);
    if (!key) return;
    if (!map[key]) map[key] = { minutes: 0, sessions: 0, completed: 0 };
    map[key].sessions += 1;
    const min = Number(r.duration_min || 0);
    if (!isNaN(min) && min > 0) map[key].minutes += min;
    if (String(r.status || '') === 'completed') map[key].completed += 1;
  });
  Object.keys(map).forEach(k => { map[k].minutes = Math.round(map[k].minutes * 10) / 10; });
  return map;
}

function getMaterialSessionRowsForKey_(key) {
  const sh = ss_().getSheetByName(SHEET_NAMES.MATERIAL_SESSIONS);
  if (!sh) return [];
  const t = getTable_(SHEET_NAMES.MATERIAL_SESSIONS);
  return t.rows.map(row => objectFromRow_(t.headers, row)).filter(r => normalizeKey_(r.key) === normalizeKey_(key));
}

function getHelpRowsForKey_(key) {
  const sh = ss_().getSheetByName(SHEET_NAMES.HELP);
  if (!sh) return [];
  const t = getTable_(SHEET_NAMES.HELP);
  return t.rows.map(row => objectFromRow_(t.headers, row)).filter(r => normalizeKey_(r.key) === normalizeKey_(key));
}

function getTrackingRowsForKey_(key, limit) {
  const sh = ss_().getSheetByName(SHEET_NAMES.TRACKING);
  if (!sh) return [];
  const t = getTable_(SHEET_NAMES.TRACKING);
  const rows = t.rows.map(row => objectFromRow_(t.headers, row)).filter(r => normalizeKey_(r.key) === normalizeKey_(key));
  return rows.slice(Math.max(0, rows.length - (limit || 50))).reverse();
}

function getMaterialForBlock_(blockId) {
  const t = getTable_(SHEET_NAMES.MATERIALS);
  const rows = t.rows.map(row => objectFromRow_(t.headers, row));
  return rows.find(m => String(m.block_id || '').trim() === String(blockId || '').trim()) || null;
}

function getOpenSessionMapForKey_(key) {
  const rows = getMaterialSessionRowsForKey_(key);
  const map = {};
  rows.forEach(r => {
    if (String(r.status || '') === 'opened') map[String(r.block_id || '')] = r;
  });
  return map;
}

function completeLatestMaterialSession_(key, blockId) {
  const sh = sheet_(SHEET_NAMES.MATERIAL_SESSIONS);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0].map(v => String(v || '').trim());
  const h = {};
  headers.forEach((name, i) => h[name] = i);

  for (let r = values.length - 1; r >= 1; r--) {
    if (normalizeKey_(values[r][h.key]) === normalizeKey_(key) && String(values[r][h.block_id] || '').trim() === String(blockId || '').trim() && String(values[r][h.status] || '') === 'opened') {
      const now = new Date();
      const openedIso = String(values[r][h.opened_at_iso] || '');
      const opened = openedIso ? new Date(openedIso) : null;
      const durationSec = opened && !isNaN(opened.getTime()) ? Math.max(0, Math.round((now.getTime() - opened.getTime()) / 1000)) : '';
      const durationMin = durationSec === '' ? '' : Math.round(durationSec / 60 * 10) / 10;
      const rowIndex = r + 1;
      setRowValuesByHeader_(sh, rowIndex, {
        'completed_at_msk': nowMskString_(),
        'completed_at_iso': now.toISOString(),
        'duration_sec': durationSec,
        'duration_min': durationMin,
        'status': 'completed',
      });
      return { openedAtIso: openedIso, completedAtIso: now.toISOString(), durationSec, durationMin };
    }
  }
  return null;
}

function updateProgressTimingFields_(key, blockId, sessionData) {
  if (!sessionData) return;
  const sh = sheet_(SHEET_NAMES.PROGRESS);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return;
  const headers = values[0].map(v => String(v || '').trim());
  const keyCol = headers.indexOf('key');
  const blockCol = headers.indexOf('block_id');
  for (let r = 1; r < values.length; r++) {
    if (normalizeKey_(values[r][keyCol]) === normalizeKey_(key) && String(values[r][blockCol] || '').trim() === String(blockId || '').trim()) {
      setRowValuesByHeader_(sh, r + 1, {
        'material_opened_at_iso': sessionData.openedAtIso || '',
        'material_completed_at_iso': sessionData.completedAtIso || '',
        'duration_sec': sessionData.durationSec,
        'duration_min': sessionData.durationMin,
      });
      return;
    }
  }
}

function buildPreviewState_(dayNumber, selectedBlockId) {
  const dayId = 'day_' + Number(dayNumber || 1);
  const days = getDays_();
  const day = days.find(d => String(d.day_id) === dayId) || null;
  const blocks = getBlocksForDay_(dayId);
  const materials = getMaterialsByBlock_();
  const screens = getScreensByBlock_();
  const visualsByTarget = getVisualsByTarget_();
  const goals = getDayGoals_();

  let selectedIndex = 0;
  if (selectedBlockId) {
    const idx = blocks.findIndex(b => String(b.block_id || '').trim() === selectedBlockId);
    if (idx >= 0) selectedIndex = idx;
  }

  const blocksWithData = blocks.map((block, index) => {
    const blockId = String(block.block_id || '').trim();
    const material = materials[blockId] || null;
    const screen = screens[blockId] || null;
    const done = index < selectedIndex;
    return {
      block_id: blockId,
      day_id: String(block.day_id || ''),
      order: Number(block['порядок'] || 0),
      type: String(block['тип'] || ''),
      title: String(block['название'] || ''),
      description: String(block['описание'] || ''),
      expected: String(block['ожидаемый_результат'] || ''),
      material_id: String(block['material_id'] || ''),
      required: isYes_(block['обязательно']),
      autoComplete: isYes_(block['авто_завершение']),
      comment: String(block['комментарий_для_новичка'] || ''),
      done,
      material: material ? normalizeMaterial_(material) : null,
      screen: screen ? normalizeScreen_(screen) : null,
      visual: visualsByTarget[blockId] || null,
      preview: true,
    };
  });

  const requiredBlocks = blocksWithData.filter(b => b.required);
  const activeBlock = selectedBlockId ? blocksWithData.find(b => b.block_id === selectedBlockId) : requiredBlocks.find(b => !b.done) || requiredBlocks[0] || null;
  const doneRequired = requiredBlocks.filter(b => b.done).length;
  const totalRequired = requiredBlocks.length;

  return {
    key: 'ADMIN_PREVIEW',
    mode: 'preview',
    preview: true,
    newbie: { key: 'ADMIN_PREVIEW', name: 'Админ preview', segment: 'preview', direction: REQUIRED_DIRECTION, status: 'preview', currentDay: Number(dayNumber), currentDayStatus: 'preview' },
    routeStatus: 'preview',
    showWeekPlan: false,
    day: day ? normalizeDay_(day) : null,
    blocks: blocksWithData,
    requiredBlocks,
    optionalBlocks: blocksWithData.filter(b => !b.required),
    activeBlockId: activeBlock ? activeBlock.block_id : '',
    activeBlock,
    tracking: { mode: 'preview', activeBlockId: activeBlock ? activeBlock.block_id : '', activeStep: Math.max(1, requiredBlocks.findIndex(b => activeBlock && b.block_id === activeBlock.block_id) + 1), totalSteps: totalRequired, doneSteps: doneRequired, percent: totalRequired ? Math.round(doneRequired / totalRequired * 100) : 0, allRequiredDone: false },
    weekPlan: days.map(normalizeDay_),
    goals,
    screens: getGlobalScreens_(),
    visuals: { weekPlan: visualsByTarget.screen_week_plan || null, locked: visualsByTarget.screen_day_locked || null, finished: visualsByTarget.screen_finished || null, help: visualsByTarget.help_widget || null },
    help: { technical: 'https://connect.tochka.com/tochka/channels/itquestions', study: 'https://connect.tochka.com/tochka/channels/pomogaem-uchebke' },
    materialLockSeconds: 0,
    nowMsk: nowMskString_(),
  };
}


/* ==============================
   V4.1 fix: admin card fallback
   Переопределяет функцию выше, чтобы карточка новичка открывалась даже если часть данных сломалась.
================================= */

function getNewbieAdminState(adminKey, newbieKey) {
  try {
    requireAdmin_(adminKey);
    ensureRuntimeSheets_();

    const key = normalizeKey_(newbieKey);
    const found = requireNewbie_(key);
    let state = null;
    let warning = '';

    try {
      state = buildStateForKey_(key, { showWeekPlan: false });
    } catch (stateErr) {
      warning = 'Часть данных маршрута не загрузилась: ' + stateErr.message;
      state = buildAdminFallbackState_(key, found.newbie, warning);
    }

    return ok_({
      mode: 'admin_newbie',
      newbie: state.newbie,
      state,
      warning,
      progress: safeRowsForKey_('progress', key),
      sessions: safeRowsForKey_('sessions', key),
      help: safeRowsForKey_('help', key),
      tracking: safeRowsForKey_('tracking', key),
    });
  } catch (err) {
    return fail_('Ошибка карточки новичка: ' + err.message);
  }
}

function safeRowsForKey_(type, key) {
  try {
    if (type === 'progress') return getProgressRowsForKey_(key);
    if (type === 'sessions') return getMaterialSessionRowsForKey_(key);
    if (type === 'help') return getHelpRowsForKey_(key);
    if (type === 'tracking') return getTrackingRowsForKey_(key, 80);
  } catch (err) {
    return [{ error: err.message }];
  }
  return [];
}

function buildAdminFallbackState_(key, newbie, warning) {
  const currentDayNumber = Math.max(1, Math.min(5, Number(newbie['текущий_день'] || 1)));
  const currentDayId = 'day_' + currentDayNumber;
  const days = getDays_();
  const day = days.find(d => String(d.day_id) === currentDayId) || null;
  const blocksRaw = getBlocksForDay_(currentDayId);
  const progress = getProgressForKey_(key);
  const blocks = blocksRaw.map(block => {
    const blockId = String(block.block_id || '').trim();
    return {
      block_id: blockId,
      day_id: String(block.day_id || currentDayId),
      order: Number(block['порядок'] || 0),
      type: String(block['тип'] || ''),
      title: String(block['название'] || blockId),
      description: String(block['описание'] || ''),
      expected: String(block['ожидаемый_результат'] || ''),
      material_id: String(block['material_id'] || ''),
      required: isYes_(block['обязательно']),
      autoComplete: isYes_(block['авто_завершение']),
      comment: String(block['комментарий_для_новичка'] || ''),
      done: Boolean(progress[blockId]),
      material: null,
      screen: null,
      visual: null,
      openSession: null,
    };
  });

  const requiredBlocks = blocks.filter(b => b.required);
  const doneRequired = requiredBlocks.filter(b => b.done).length;
  const totalRequired = requiredBlocks.length;
  const activeBlock = requiredBlocks.find(b => !b.done) || null;

  return {
    key,
    mode: 'student',
    adminWarning: warning || '',
    newbie: {
      key,
      name: String(newbie['ФИО'] || ''),
      segment: String(newbie['сегмент'] || ''),
      direction: String(newbie['направление'] || ''),
      status: String(newbie['статус'] || ''),
      currentDay: currentDayNumber,
      currentDayStatus: String(newbie['статус_текущего_дня'] || ''),
      nextAvailableAt: formatMaybeMsk_(newbie['следующий_день_доступен_мск']),
      nextAvailableRaw: dateToIso_(newbie['следующий_день_доступен_мск']),
    },
    routeStatus: getRouteStatus_(newbie),
    showWeekPlan: false,
    day: day ? normalizeDay_(day) : null,
    blocks,
    requiredBlocks,
    optionalBlocks: blocks.filter(b => !b.required),
    activeBlockId: activeBlock ? activeBlock.block_id : '',
    activeBlock,
    tracking: {
      mode: 'fallback',
      activeBlockId: activeBlock ? activeBlock.block_id : '',
      activeStep: activeBlock ? requiredBlocks.findIndex(b => b.block_id === activeBlock.block_id) + 1 : totalRequired,
      totalSteps: totalRequired,
      doneSteps: doneRequired,
      percent: totalRequired ? Math.round(doneRequired / totalRequired * 100) : 0,
      allRequiredDone: totalRequired ? doneRequired >= totalRequired : true,
    },
    weekPlan: days.map(normalizeDay_),
    goals: {},
    screens: {},
    visuals: {},
    help: {
      technical: 'https://connect.tochka.com/tochka/channels/itquestions',
      study: 'https://connect.tochka.com/tochka/channels/pomogaem-uchebke',
    },
    materialLockSeconds: MATERIAL_OPEN_LOCK_SECONDS,
    nowMsk: nowMskString_(),
  };
}



/* ==============================
   V4.2 fix: стабильный вход и безопасные админ-методы
   Не трогает старые функции, а даёт фронту отдельные точки входа.
================================= */

function loginRouteV42(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    if (!key) return fail_('Введи ключ.');

    ensureRuntimeSheets_();

    if (isAdminKey_(key)) {
      logAdminAction_({ adminKey: key, action: 'admin_login_v42', comment: 'Админ вошёл в панель v4.2' });
      return ok_({
        mode: 'admin',
        admin: true,
        adminKeyHint: 'ok',
        dashboard: getAdminDashboardDataSafeV42_(key)
      });
    }

    const found = findNewbieByKey_(key);
    if (!found) {
      return fail_('Ключ «' + key + '» не найден в листе «Новички». Проверь ключ или создай новый в админке.');
    }

    const newbie = found.newbie;
    if (!isAllowedStudentDirectionV42_(newbie['направление'])) {
      return fail_('Для этого ключа указано направление «' + safeText_(newbie['направление']) + '». Сейчас маршрут подключён только для кросс-продавца.');
    }

    if (!String(newbie['маршрут_начат'] || '').trim()) {
      updateNewbieFields_(found.rowIndex, { 'маршрут_начат': nowMskString_() });
    }

    const state = buildStudentStateSafeV42_(key, { showWeekPlan: true });

    logTracking_({
      key,
      name: newbie['ФИО'],
      segment: newbie['сегмент'],
      dayId: 'day_' + Number(newbie['текущий_день'] || 1),
      event: 'login_v42',
      status: 'ok',
      currentBlockId: state.tracking && state.tracking.activeBlockId,
      raw: { showWeekPlan: true }
    });

    return ok_({ mode: 'student', state: state });
  } catch (err) {
    return fail_('Ошибка входа v4.2: ' + (err && err.message ? err.message : String(err)));
  }
}

function getSafeStudentStateV42(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    if (!key) return fail_('Не передан ключ.');
    requireNewbie_(key);
    return ok_({ mode: 'student', state: buildStudentStateSafeV42_(key, { showWeekPlan: false }) });
  } catch (err) {
    return fail_('Ошибка загрузки состояния v4.2: ' + (err && err.message ? err.message : String(err)));
  }
}

function getAdminDashboardV42(adminKey) {
  try {
    requireAdmin_(adminKey);
    return ok_({
      mode: 'admin',
      admin: true,
      dashboard: getAdminDashboardDataSafeV42_(adminKey)
    });
  } catch (err) {
    return fail_('Ошибка админки v4.2: ' + (err && err.message ? err.message : String(err)));
  }
}

function getNewbieAdminStateV42(adminKey, newbieKey) {
  try {
    requireAdmin_(adminKey);
    ensureRuntimeSheets_();

    const key = normalizeKey_(newbieKey);
    const found = requireNewbie_(key);
    let state;
    let warning = '';

    try {
      state = buildStudentStateSafeV42_(key, { showWeekPlan: false });
    } catch (stateErr) {
      warning = 'Часть данных маршрута не загрузилась: ' + (stateErr && stateErr.message ? stateErr.message : String(stateErr));
      state = buildAdminFallbackState_(key, found.newbie, warning);
    }

    return ok_({
      mode: 'admin_newbie',
      newbie: state.newbie,
      state: state,
      warning: warning || state.adminWarning || '',
      progress: safeRowsForKey_('progress', key),
      sessions: safeRowsForKey_('sessions', key),
      help: safeRowsForKey_('help', key),
      tracking: safeRowsForKey_('tracking', key),
    });
  } catch (err) {
    return fail_('Ошибка карточки новичка v4.2: ' + (err && err.message ? err.message : String(err)));
  }
}

function forceOpenNextDayV42(adminKey, newbieKey) {
  try {
    requireAdmin_(adminKey);
    const key = normalizeKey_(newbieKey);
    const found = requireNewbie_(key);
    const newbie = found.newbie;
    const currentDay = Number(newbie['текущий_день'] || 1);
    const nextDay = Math.min(currentDay + 1, 5);

    updateNewbieFields_(found.rowIndex, {
      'текущий_день': nextDay,
      'статус_текущего_дня': 'available',
      'день_завершён_мск': '',
      'следующий_день_доступен_мск': '',
      'последняя_отбивка_мск': nowMskString_(),
    });

    logAdminAction_({
      adminKey,
      key,
      name: newbie['ФИО'],
      dayId: 'day_' + nextDay,
      action: 'force_open_next_day_v42',
      oldValue: String(currentDay),
      newValue: String(nextDay),
      comment: 'Следующий день открыт вручную'
    });

    return getNewbieAdminStateV42(adminKey, key);
  } catch (err) {
    return fail_('Ошибка ручного открытия дня v4.2: ' + (err && err.message ? err.message : String(err)));
  }
}

function forceOpenDayV42(adminKey, newbieKey, dayNumber) {
  try {
    requireAdmin_(adminKey);
    const key = normalizeKey_(newbieKey);
    const found = requireNewbie_(key);
    const newbie = found.newbie;
    const day = Math.max(1, Math.min(5, Number(dayNumber || 1)));

    updateNewbieFields_(found.rowIndex, {
      'текущий_день': day,
      'статус_текущего_дня': 'available',
      'день_завершён_мск': '',
      'следующий_день_доступен_мск': '',
      'последняя_отбивка_мск': nowMskString_(),
    });

    logAdminAction_({
      adminKey,
      key,
      name: newbie['ФИО'],
      dayId: 'day_' + day,
      action: 'force_open_day_v42',
      oldValue: String(newbie['текущий_день'] || ''),
      newValue: String(day),
      comment: 'Конкретный день открыт вручную'
    });

    return getNewbieAdminStateV42(adminKey, key);
  } catch (err) {
    return fail_('Ошибка открытия выбранного дня v4.2: ' + (err && err.message ? err.message : String(err)));
  }
}

function buildStudentStateSafeV42_(key, options) {
  options = options || {};
  const found = requireNewbie_(key);
  try {
    const state = buildStateForKey_(key, options);
    state.mode = 'student';
    state.authVersion = 'v4.2';
    state.materialLockSeconds = MATERIAL_OPEN_LOCK_SECONDS;
    return state;
  } catch (err) {
    const warning = 'Маршрут открыт в безопасном режиме: ' + (err && err.message ? err.message : String(err));
    const fallback = buildAdminFallbackState_(key, found.newbie, warning);
    fallback.showWeekPlan = Boolean(options.showWeekPlan);
    fallback.mode = 'student';
    fallback.authVersion = 'v4.2-fallback';
    fallback.adminWarning = warning;
    return fallback;
  }
}

function getAdminDashboardDataSafeV42_(adminKey) {
  try {
    const dashboard = getAdminDashboardData_(adminKey);
    dashboard.warning = '';
    return dashboard;
  } catch (err) {
    const students = buildNewbieSummariesSafeV42_();
    return {
      generatedAt: nowMskString_(),
      warning: 'Дашборд открыт в безопасном режиме: ' + (err && err.message ? err.message : String(err)),
      students: students,
      stats: {
        total: students.length,
        active: students.filter(s => s.status !== 'done').length,
        green: students.filter(s => s.zone === 'green').length,
        yellow: students.filter(s => s.zone === 'yellow').length,
        red: students.filter(s => s.zone === 'red').length,
      }
    };
  }
}

function buildNewbieSummariesSafeV42_() {
  try {
    const t = getTable_(SHEET_NAMES.NEWBIES);
    const newbies = t.rows.map(row => objectFromRow_(t.headers, row)).filter(n => normalizeKey_(n.key));
    let studyStats = {};
    try { studyStats = getStudyStatsMap_(); } catch (e) { studyStats = {}; }
    return newbies.map(n => {
      const key = normalizeKey_(n.key);
      const currentDay = Number(n['текущий_день'] || 1);
      let percent = 0, done = 0, total = 0, activeBlock = '';
      const study = studyStats[key] || { minutes: 0, sessions: 0, completed: 0 };
      try {
        const blocks = getBlocksForDay_('day_' + currentDay).filter(b => isYes_(b['обязательно']));
        const progress = getProgressForKey_(key);
        total = blocks.length;
        done = blocks.filter(b => progress[String(b.block_id || '').trim()]).length;
        percent = total ? Math.round(done / total * 100) : 0;
        activeBlock = blocks.map(b => String(b.block_id || '').trim()).find(id => !progress[id]) || '';
      } catch (innerErr) {}
      return {
        key: key,
        name: String(n['ФИО'] || ''),
        segment: String(n['сегмент'] || ''),
        direction: String(n['направление'] || ''),
        currentDay: currentDay,
        status: String(n['статус'] || 'active'),
        currentDayStatus: String(n['статус_текущего_дня'] || ''),
        percent: percent,
        doneBlocks: done,
        totalBlocks: total,
        activeBlock: activeBlock,
        questions: 0,
        lastActivity: '',
        studyMinutes: study.minutes,
        materialSessions: study.sessions,
        zone: percent >= 70 ? 'green' : 'yellow',
      };
    });
  } catch (err) {
    return [];
  }
}

function isAllowedStudentDirectionV42_(direction) {
  const value = String(direction || '').trim().toLowerCase();
  if (!value) return true;
  return value === REQUIRED_DIRECTION || value.indexOf('кросс-продав') >= 0 || value.indexOf('cross') >= 0;
}


/* ==============================
   V4.3 fix: admin только через Script Properties + JSON-ответы
   Причина: старый fallback-ключ удалён, чтобы не конфликтовать с ключами новичков.
================================= */

function jsonResponseV43_(payload) {
  return JSON.stringify(makeJsonSafeV43_(payload));
}

function makeJsonSafeV43_(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? '' : Utilities.formatDate(value, TZ, 'dd.MM.yyyy HH:mm:ss');
  }
  if (Array.isArray(value)) return value.map(makeJsonSafeV43_);
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(function(k) {
      out[k] = makeJsonSafeV43_(value[k]);
    });
    return out;
  }
  return value;
}

function okJsonV43_(data) {
  return jsonResponseV43_({ ok: true, data: data || {} });
}

function failJsonV43_(message) {
  return jsonResponseV43_({ ok: false, error: message || 'Ошибка.' });
}

function getAdminKeyStatusV43_() {
  const propKey = String(PropertiesService.getScriptProperties().getProperty('ADMIN_KEY') || '').trim();
  return {
    configured: Boolean(propKey),
    message: propKey ? 'ADMIN_KEY задан в Script Properties.' : 'ADMIN_KEY не задан в Script Properties.'
  };
}

function buildLoginRouteV43Data_(rawKey) {
  const key = normalizeKey_(rawKey);
  if (!key) throw new Error('Р’РІРµРґРё РєР»СЋС‡.');

  ensureRuntimeSheets_();

  if (isAdminKey_(key)) {
    logAdminAction_({
      adminKey: key,
      action: 'admin_login_v43',
      comment: 'РђРґРјРёРЅ РІРѕС€С‘Р» РІ РїР°РЅРµР»СЊ v4.3 С‡РµСЂРµР· Script Properties'
    });
    return {
      mode: 'admin',
      admin: true,
      authVersion: 'v4.3',
      adminKeyStatus: getAdminKeyStatusV43_(),
      dashboard: getAdminDashboardDataSafeV42_(key)
    };
  }

  const found = findNewbieByKey_(key);
  if (!found) throw new Error('РљР»СЋС‡ В«' + key + 'В» РЅРµ РЅР°Р№РґРµРЅ РІ Р»РёСЃС‚Рµ В«РќРѕРІРёС‡РєРёВ».');

  const newbie = found.newbie;
  if (!isAllowedStudentDirectionV42_(newbie['РЅР°РїСЂР°РІР»РµРЅРёРµ'])) {
    throw new Error('Р”Р»СЏ СЌС‚РѕРіРѕ РєР»СЋС‡Р° СѓРєР°Р·Р°РЅРѕ РЅР°РїСЂР°РІР»РµРЅРёРµ В«' + safeText_(newbie['РЅР°РїСЂР°РІР»РµРЅРёРµ']) + 'В». РЎРµР№С‡Р°СЃ РјР°СЂС€СЂСѓС‚ РїРѕРґРєР»СЋС‡С‘РЅ С‚РѕР»СЊРєРѕ РґР»СЏ РєСЂРѕСЃСЃ-РїСЂРѕРґР°РІС†Р°.');
  }

  if (!String(newbie['РјР°СЂС€СЂСѓС‚_РЅР°С‡Р°С‚'] || '').trim()) {
    updateNewbieFields_(found.rowIndex, { 'РјР°СЂС€СЂСѓС‚_РЅР°С‡Р°С‚': nowMskString_() });
  }

  const state = buildStudentStateSafeV42_(key, { showWeekPlan: true });
  state.authVersion = 'v4.3';

  logTracking_({
    key,
    name: newbie['Р¤РРћ'],
    segment: newbie['СЃРµРіРјРµРЅС‚'],
    dayId: 'day_' + Number(newbie['С‚РµРєСѓС‰РёР№_РґРµРЅСЊ'] || 1),
    event: 'login_v43',
    status: 'ok',
    currentBlockId: state.tracking && state.tracking.activeBlockId,
    raw: { showWeekPlan: true }
  });

  return { mode: 'student', state: state };
}

function loginRouteV43(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    if (!key) return failJsonV43_('Введи ключ.');

    ensureRuntimeSheets_();

    return okJsonV43_(buildLoginRouteV43Data_(rawKey));
    const adminStatus = getAdminKeyStatusV43_();

    if (isAdminKey_(key)) {
      logAdminAction_({ adminKey: key, action: 'admin_login_v43', comment: 'Админ вошёл в панель v4.3 через Script Properties' });
      return okJsonV43_({
        mode: 'admin',
        admin: true,
        authVersion: 'v4.3',
        adminKeyStatus: adminStatus,
        dashboard: getAdminDashboardDataSafeV42_(key)
      });
    }

    // Старый тестовый fallback явно запрещаем, чтобы не было скрытой логики.
    if (false && key === 'DISABLED-LEGACY-ADMIN-KEY') {
      return failJsonV43_('Старый тестовый админ-ключ отключён. Задай настоящий ADMIN_KEY в Script Properties и входи по нему.');
    }

    const found = findNewbieByKey_(key);
    if (!found) {
      const hint = adminStatus.configured
        ? ''
        : ' Если это должен быть админский вход — сначала задай ADMIN_KEY в Script Properties.';
      return failJsonV43_('Ключ «' + key + '» не найден в листе «Новички».' + hint);
    }

    const newbie = found.newbie;
    if (!isAllowedStudentDirectionV42_(newbie['направление'])) {
      return failJsonV43_('Для этого ключа указано направление «' + safeText_(newbie['направление']) + '». Сейчас маршрут подключён только для кросс-продавца.');
    }

    if (!String(newbie['маршрут_начат'] || '').trim()) {
      updateNewbieFields_(found.rowIndex, { 'маршрут_начат': nowMskString_() });
    }

    const state = buildStudentStateSafeV42_(key, { showWeekPlan: true });
    state.authVersion = 'v4.3';

    logTracking_({
      key,
      name: newbie['ФИО'],
      segment: newbie['сегмент'],
      dayId: 'day_' + Number(newbie['текущий_день'] || 1),
      event: 'login_v43',
      status: 'ok',
      currentBlockId: state.tracking && state.tracking.activeBlockId,
      raw: { showWeekPlan: true }
    });

    return okJsonV43_({ mode: 'student', state: state });
  } catch (err) {
    return failJsonV43_('Ошибка входа v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function getAdminDashboardV43(adminKey) {
  try {
    requireAdmin_(adminKey);
    return okJsonV43_({
      mode: 'admin',
      admin: true,
      authVersion: 'v4.3',
      adminKeyStatus: getAdminKeyStatusV43_(),
      dashboard: getAdminDashboardDataSafeV42_(adminKey)
    });
  } catch (err) {
    return failJsonV43_('Ошибка админки v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function createNewbieKeyV43(payload) {
  try {
    const res = createNewbieKey(payload);
    return jsonResponseV43_(res);
  } catch (err) {
    return failJsonV43_('Ошибка создания ключа v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function getNewbieAdminStateV43(adminKey, newbieKey) {
  try {
    const res = getNewbieAdminState(adminKey, newbieKey);
    return jsonResponseV43_(res);
  } catch (err) {
    return failJsonV43_('Ошибка карточки новичка v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function forceOpenNextDayV43(adminKey, newbieKey) {
  try {
    const res = forceOpenNextDay(adminKey, newbieKey);
    return jsonResponseV43_(res);
  } catch (err) {
    return failJsonV43_('Ошибка ручного открытия дня v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function forceOpenDayV43(adminKey, newbieKey, dayNumber) {
  try {
    const res = forceOpenDay(adminKey, newbieKey, dayNumber);
    return jsonResponseV43_(res);
  } catch (err) {
    return failJsonV43_('Ошибка открытия выбранного дня v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function getSafeStudentStateV43(rawKey) {
  try {
    const key = normalizeKey_(rawKey);
    if (!key) return failJsonV43_('Не передан ключ.');
    requireNewbie_(key);
    return okJsonV43_({ mode: 'student', state: buildStudentStateSafeV42_(key, { showWeekPlan: false }) });
  } catch (err) {
    return failJsonV43_('Ошибка загрузки состояния v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}
function getCurrentStateV43(rawKey) {
  try {
    const res = getCurrentState(rawKey);
    return jsonResponseV43_(res && res.ok ? { ok: true, data: { mode: 'student', state: res.data } } : res);
  } catch (err) {
    return failJsonV43_('РћС€РёР±РєР° Р·Р°РіСЂСѓР·РєРё СЃРѕСЃС‚РѕСЏРЅРёСЏ v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function markWeekPlanSeenV43(rawKey) {
  try {
    const res = markWeekPlanSeen(rawKey);
    if (!res || !res.ok) return jsonResponseV43_(res);
    return okJsonV43_({ mode: 'student', state: buildStudentStateSafeV42_(normalizeKey_(rawKey), { showWeekPlan: false }) });
  } catch (err) {
    return failJsonV43_('РћС€РёР±РєР° РїРµСЂРµС…РѕРґР° РёР· РїР»Р°РЅР° РЅРµРґРµР»Рё v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function startCurrentDayV43(rawKey) {
  try {
    const res = startCurrentDay(rawKey);
    return jsonResponseV43_(res && res.ok ? { ok: true, data: { mode: 'student', state: res.data } } : res);
  } catch (err) {
    return failJsonV43_('РћС€РёР±РєР° СЃС‚Р°СЂС‚Р° РґРЅСЏ v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function recordMaterialOpenedV43(payload) {
  try {
    const res = recordMaterialOpened(payload);
    return jsonResponseV43_(res);
  } catch (err) {
    return failJsonV43_('РћС€РёР±РєР° С„РёРєСЃР°С†РёРё РѕС‚РєСЂС‹С‚РёСЏ РјР°С‚РµСЂРёР°Р»Р° v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function completeBlockV43(payload) {
  try {
    const res = completeBlock(payload);
    return jsonResponseV43_(res && res.ok ? { ok: true, data: { mode: 'student', state: res.data } } : res);
  } catch (err) {
    return failJsonV43_('РћС€РёР±РєР° Р·Р°РІРµСЂС€РµРЅРёСЏ С€Р°РіР° v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function completeDayV43(rawKey) {
  try {
    const res = completeDay(rawKey);
    return jsonResponseV43_(res && res.ok ? { ok: true, data: { mode: 'student', state: res.data } } : res);
  } catch (err) {
    return failJsonV43_('РћС€РёР±РєР° Р·Р°РІРµСЂС€РµРЅРёСЏ РґРЅСЏ v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}

function submitHelpRequestV43(payload) {
  try {
    const res = submitHelpRequest(payload);
    return jsonResponseV43_(res);
  } catch (err) {
    return failJsonV43_('РћС€РёР±РєР° РѕС‚РїСЂР°РІРєРё РІРѕРїСЂРѕСЃР° v4.3: ' + (err && err.message ? err.message : String(err)));
  }
}
