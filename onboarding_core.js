const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SheetsClient } = require('./sheets_client');

const SHEETS = {
  README: 'README',
  NEWBIES: 'Новички',
  DAYS: 'Дни',
  BLOCKS: 'Блоки_дня',
  MATERIALS: 'Материалы',
  PROGRESS: 'Прогресс',
  RESULTS: 'Результаты',
  DASHBOARD: 'Дашборд',
  SETTINGS: 'Настройки',
  REFS: 'Справочники',
  SCREENS: 'Экраны_WebApp',
  LOGIC: 'Логика_WebApp',
  NOTIFICATIONS: 'Отбивки',
  DAY_GOALS: 'Цели_дня',
  HELP: 'Помощь',
  NOTIFICATIONS_LOG: 'Лог_отбивок',
  TRACKING: 'Отслеживание_прохождения',
  VISUALS: 'Визуалы',
  ADMIN_ACTIONS: 'Админ_действия',
  MATERIAL_SESSIONS: 'Сессии_материалов',
  SUMMARY: 'Сводка_новичков',
};

const READ_SHEETS = [
  SHEETS.NEWBIES,
  SHEETS.DAYS,
  SHEETS.BLOCKS,
  SHEETS.MATERIALS,
  SHEETS.PROGRESS,
  SHEETS.SCREENS,
  SHEETS.DAY_GOALS,
  SHEETS.VISUALS,
  SHEETS.HELP,
  SHEETS.TRACKING,
  SHEETS.MATERIAL_SESSIONS,
];

const RUNTIME_HEADERS = {
  [SHEETS.HELP]: ['timestamp_msk', 'key', 'ФИО', 'day_id', 'block_id', 'тип', 'текст', 'статус', 'source', 'raw_payload'],
  [SHEETS.PROGRESS]: ['key', 'ФИО', 'day_id', 'block_id', 'статус', 'дата_старта', 'дата_завершения', 'комментарий_новичка', 'обновлено'],
  [SHEETS.TRACKING]: ['timestamp_msk', 'key', 'ФИО', 'сегмент', 'day_id', 'день', 'block_id', 'шаг', 'событие', 'статус', 'процент_дня', 'завершено_блоков', 'всего_блоков', 'current_block_id', 'комментарий', 'raw_payload'],
  [SHEETS.ADMIN_ACTIONS]: ['timestamp_msk', 'admin_action', 'admin_key_hash', 'key', 'ФИО', 'day_id', 'block_id', 'action', 'old_value', 'new_value', 'comment', 'raw_payload'],
  [SHEETS.MATERIAL_SESSIONS]: ['session_id', 'key', 'ФИО', 'day_id', 'block_id', 'material_id', 'material_title', 'material_url', 'opened_at_msk', 'opened_at_iso', 'completed_at_msk', 'completed_at_iso', 'duration_sec', 'duration_min', 'status'],
};

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function normalizeKey(v) { return String(v || '').trim().toUpperCase(); }
function isYes(v) { return ['yes', 'да', 'true', '1', 'required'].includes(String(v || '').trim().toLowerCase()); }
function safe(v) { return String(v === undefined || v === null ? '' : v); }
function number(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function formatMsk(date) { return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(date).replace(',', ''); }
function nowMskString() { return formatMsk(new Date()); }
function nowIso() { return new Date().toISOString(); }
function getMskParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short'
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday,
  };
}
function dateFromMskParts(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, second));
}
function parseStoredMskDate(value) {
  const text = safe(value).trim();
  if (!text) return null;
  const iso = Date.parse(text);
  if (Number.isFinite(iso)) return new Date(iso);
  const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const [, dd, mm, yyyy, hh = '00', min = '00', ss = '00'] = match;
  return dateFromMskParts(Number(yyyy), Number(mm), Number(dd), Number(hh), Number(min), Number(ss));
}
function isWeekendMsk(date) {
  const weekday = getMskParts(date).weekday;
  return weekday === 'Sat' || weekday === 'Sun';
}
function buildNextWorkdayUnlockMsk(date = new Date()) {
  const parts = getMskParts(date);
  let candidate = dateFromMskParts(parts.year, parts.month, parts.day);
  do {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  } while (isWeekendMsk(candidate));
  const next = getMskParts(candidate);
  return dateFromMskParts(next.year, next.month, next.day, 7, 0, 0);
}
function hash16(v) { return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 16); }
function ok(data) { return JSON.stringify({ ok: true, data: data || {} }); }
function fail(message) { return JSON.stringify({ ok: false, error: message || 'Ошибка.' }); }

function colToA1(col) {
  let s = ''; let n = Number(col);
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function rowsToTable(values = []) {
  const headers = (values[0] || []).map(v => String(v || '').trim());
  const rows = values.slice(1).filter(row => row.some(cell => String(cell || '').trim() !== ''));
  const headerMap = {};
  headers.forEach((h, i) => { if (h) headerMap[h] = i; });
  const objects = rows.map((row, idx) => {
    const obj = { __rowIndex: idx + 2 };
    headers.forEach((h, i) => { if (h) obj[h] = row[i] === undefined ? '' : row[i]; });
    return obj;
  });
  return { headers, rows, objects, headerMap };
}

function getValue(obj, names, fallback = '') {
  for (const name of names) {
    if (obj && obj[name] !== undefined && obj[name] !== '') return obj[name];
  }
  return fallback;
}

function normalizeDay(d) {
  return {
    day_id: safe(d.day_id),
    number: number(d['день']),
    title: safe(d['название']),
    goal: safe(d['цель_дня']),
    description: safe(d['короткое_описание']),
    checkpoint: safe(d['чекпоинт_дня']),
  };
}

function normalizeMaterial(m) {
  const url = safe(m['ссылка']);
  return {
    material_id: safe(m.material_id),
    title: safe(m['название']),
    type: safe(m['тип']),
    url,
    required: isYes(m['обязательность']),
    duration: safe(m['длительность_мин']),
    after: safe(m['что_сделать_после']),
    comment: safe(m['комментарий']),
    buttonText: safe(getValue(m, ['кнопка', 'button_text'], '')),
    isLink: /^https?:\/\//i.test(url),
  };
}

function normalizeScreen(s) {
  return {
    screen_id: safe(s.screen_id),
    day_id: safe(s.day_id),
    block_id: safe(s.block_id),
    type: safe(s['тип_экрана']),
    title: safe(s['заголовок']),
    subtitle: safe(s['подзаголовок']),
    text: safe(s['основной_текст']),
    button: safe(s['кнопка']),
    action: safe(s['ссылка/действие']),
    comment: safe(s['комментарий']),
  };
}

function normalizeVisual(v) {
  return {
    visual_id: safe(v.visual_id),
    place: safe(v['экран/место']),
    day_id: safe(v.day_id),
    target: safe(v['block_id/screen_id']),
    priority: safe(v['приоритет']),
    file: safe(v['имя_файла']),
    format: safe(v['формат']),
    size: safe(v['размер_ориентир']),
    description: safe(v['что_на_картинке']),
    purpose: safe(v['зачем_нужна']),
    status: safe(v['статус']),
    comment: safe(v['комментарий']),
  };
}

class OnboardingCore {
  constructor(config) {
    this.config = config;
    this.dataDir = config.dataDir;
    this.cachePath = path.join(this.dataDir, 'cache', 'onboarding_snapshot.json');
    this.queuePath = path.join(this.dataDir, 'queue', 'sheets_queue.jsonl');
    this.failedQueuePath = path.join(this.dataDir, 'queue', 'sheets_queue_failed.jsonl');
    this.sheets = new SheetsClient(config);
    this.snapshot = readJson(this.cachePath, null);
    this.lastPullAt = this.snapshot ? Number(this.snapshot.pulledAtMs || 0) : 0;
    this.pushing = false;
  }

  async init() {
    ensureDir(path.dirname(this.cachePath));
    ensureDir(path.dirname(this.queuePath));
    if (!this.snapshot || this.config.pullOnStart) await this.pullSnapshot('startup');
  }

  table(name) {
    const values = this.snapshot && this.snapshot.sheets ? (this.snapshot.sheets[name] || []) : [];
    return rowsToTable(values);
  }

  async ensureFresh(reason = 'request') {
    const ttl = Number(this.config.cacheTtlMs || 60000);
    if (!this.snapshot || Date.now() - this.lastPullAt > ttl) {
      try { await this.pullSnapshot(reason); } catch (err) { console.error('pullSnapshot failed:', err.message); }
    }
  }

  async pullSnapshot(reason = 'manual') {
    const sheets = await this.sheets.batchGet(READ_SHEETS);
    this.snapshot = { pulledAt: new Date().toISOString(), pulledAtMs: Date.now(), reason, sheets };
    this.lastPullAt = this.snapshot.pulledAtMs;
    writeJson(this.cachePath, this.snapshot);
    console.log(`snapshot pulled: ${Object.keys(sheets).length} sheets, reason=${reason}`);
    return this.snapshot;
  }

  enqueue(op) {
    const item = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...op };
    appendJsonl(this.queuePath, item);
    return item;
  }

  readQueue() {
    if (!fs.existsSync(this.queuePath)) return [];
    return fs.readFileSync(this.queuePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }

  writeQueue(items) {
    if (!items.length) { try { fs.unlinkSync(this.queuePath); } catch (_) {} return; }
    fs.writeFileSync(this.queuePath, items.map(x => JSON.stringify(x)).join('\n') + '\n');
  }

  async flushQueue() {
    if (this.pushing) return { ok: true, skipped: 'already_pushing' };
    this.pushing = true;
    try {
      const items = this.readQueue();
      if (!items.length) return { ok: true, pushed: 0 };
      const remain = [];
      let pushed = 0;
      for (const item of items) {
        try {
          if (item.type === 'append') {
            await this.sheets.appendRows(item.sheet, [item.row]);
          } else if (item.type === 'update') {
            await this.sheets.updateValues(item.sheet, item.a1, item.values);
          } else {
            throw new Error(`Unknown queue item type: ${item.type}`);
          }
          pushed++;
        } catch (err) {
          item.lastError = err.message;
          item.retryAt = new Date(Date.now() + 60_000).toISOString();
          remain.push(item);
          console.error('queue push failed:', item.type, item.sheet, err.message);
          // If Google starts throttling, stop this flush and keep remaining items.
          if (err.status === 429 || err.status >= 500) {
            const rest = items.slice(items.indexOf(item) + 1);
            remain.push(...rest);
            break;
          }
        }
      }
      this.writeQueue(remain);
      return { ok: true, pushed, remain: remain.length };
    } finally {
      this.pushing = false;
    }
  }

  sheetHeaders(sheetName) {
    const t = this.table(sheetName);
    return t.headers.length ? t.headers : (RUNTIME_HEADERS[sheetName] || []);
  }

  objectToRow(sheetName, obj) {
    const headers = this.sheetHeaders(sheetName);
    return headers.map(h => obj[h] === undefined ? '' : obj[h]);
  }

  addLocalObject(sheetName, obj) {
    if (!this.snapshot) this.snapshot = { pulledAt: new Date().toISOString(), pulledAtMs: Date.now(), sheets: {} };
    if (!this.snapshot.sheets[sheetName] || !this.snapshot.sheets[sheetName].length) {
      this.snapshot.sheets[sheetName] = [this.sheetHeaders(sheetName)];
    }
    const row = this.objectToRow(sheetName, obj);
    this.snapshot.sheets[sheetName].push(row);
    writeJson(this.cachePath, this.snapshot);
    return row;
  }

  updateLocalRow(sheetName, rowIndex, patch) {
    const values = this.snapshot.sheets[sheetName] || [];
    const headers = values[0] || [];
    while (values.length < rowIndex) values.push([]);
    const row = values[rowIndex - 1] || [];
    for (const [key, value] of Object.entries(patch)) {
      let idx = headers.indexOf(key);
      if (idx < 0) {
        headers.push(key); idx = headers.length - 1;
      }
      row[idx] = value;
    }
    values[0] = headers;
    values[rowIndex - 1] = row;
    this.snapshot.sheets[sheetName] = values;
    writeJson(this.cachePath, this.snapshot);
    return row;
  }

  findNewbie(key) {
    const t = this.table(SHEETS.NEWBIES);
    const found = t.objects.find(n => normalizeKey(n.key) === normalizeKey(key));
    return found ? { rowIndex: found.__rowIndex, newbie: found } : null;
  }

  isAdminKey(key) {
    return Boolean(normalizeKey(key) && normalizeKey(key) === normalizeKey(this.config.adminKey));
  }

  isAllowedDirection(direction) {
    const value = String(direction || '').trim().toLowerCase();
    return value === 'кросс-продавец' || value.includes('кросс-продав') || value.includes('cross');
  }

  getDays() {
    return this.table(SHEETS.DAYS).objects.filter(d => safe(d.day_id)).sort((a, b) => number(a['день']) - number(b['день']));
  }

  normalizeSegment(segment) {
    return safe(segment).trim().toLowerCase();
  }

  normalizeRouteVariant(routeVariant) {
    return safe(routeVariant).trim().toLowerCase() === 'seller' ? 'seller' : 'default';
  }

  getRouteVariantForSegment(segment) {
    return this.normalizeSegment(segment).includes('селлер') ? 'seller' : 'default';
  }

  getBlockRouteVariant(block) {
    const raw = safe(getValue(block, ['route_variant', 'segment_filter', 'audience'], '')).trim().toLowerCase();
    if (!raw) return '';
    if (raw.includes('seller') || raw.includes('селлер')) return 'seller';
    if (raw.includes('default') || raw.includes('обыч') || raw.includes('regular')) return 'default';
    return '';
  }

  isBlockVisibleForRoute(block, routeVariant = 'default') {
    const marker = this.getBlockRouteVariant(block);
    if (!marker) return true;
    if (marker === 'seller') return routeVariant === 'seller';
    if (marker === 'default') return routeVariant !== 'seller';
    return true;
  }

  getBlocksForDay(dayId, routeVariant = 'default') {
    const normalizedRoute = this.normalizeRouteVariant(routeVariant);
    return this.table(SHEETS.BLOCKS).objects
      .filter(b => safe(b.day_id) === dayId)
      .filter(b => this.isBlockVisibleForRoute(b, normalizedRoute))
      .sort((a, b) => number(a['порядок']) - number(b['порядок']));
  }

  mapBy(sheetName, keyName) {
    const map = {};
    this.table(sheetName).objects.forEach(obj => {
      const key = safe(obj[keyName]).trim();
      if (key) map[key] = obj;
    });
    return map;
  }

  getMaterialsByBlock() {
    const map = {};
    this.table(SHEETS.MATERIALS).objects.forEach(m => { const k = safe(m.block_id).trim(); if (k) map[k] = m; });
    return map;
  }

  getScreensByBlock() {
    const map = {};
    this.table(SHEETS.SCREENS).objects.forEach(s => { const k = safe(s.block_id).trim(); if (k) map[k] = s; });
    return map;
  }

  getGlobalScreens() {
    const map = {};
    this.table(SHEETS.SCREENS).objects.forEach(s => { const k = safe(s.screen_id).trim(); if (k) map[k] = normalizeScreen(s); });
    return map;
  }

  getVisualsByTarget() {
    const map = {};
    this.table(SHEETS.VISUALS).objects.forEach(v => {
      const fileName = safe(v['имя_файла']).trim();
      const targets = safe(v['block_id/screen_id']).trim();
      if (!fileName || !targets) return;
      const visual = normalizeVisual(v);
      targets.split('/').map(x => x.trim()).filter(Boolean).forEach(target => { map[target] = visual; });
    });
    return map;
  }

  getDayGoals() {
    const map = {};
    this.table(SHEETS.DAY_GOALS).objects.forEach(g => {
      if (!g.day_id) return;
      map[safe(g.day_id)] = {
        min: number(g.min_call_minutes),
        target: number(g.target_call_minutes),
        text: safe(g['цель_звонков']),
        show: isYes(g['показывать_новичку']),
      };
    });
    return map;
  }

  getProgressForKey(key) {
    const map = {};
    this.table(SHEETS.PROGRESS).objects.forEach(p => {
      if (normalizeKey(p.key) === normalizeKey(key) && safe(p['статус']) === 'done') {
        map[safe(p.block_id).trim()] = p;
      }
    });
    return map;
  }

  getOpenSessionsForKey(key) {
    const map = {};
    this.table(SHEETS.MATERIAL_SESSIONS).objects.forEach(s => {
      if (normalizeKey(s.key) === normalizeKey(key) && safe(s.status) === 'open') {
        map[safe(s.block_id)] = s;
      }
    });
    return map;
  }

  findLatestOpenMaterialSession(key, blockId) {
    const sessions = this.table(SHEETS.MATERIAL_SESSIONS).objects
      .filter(s => normalizeKey(s.key) === normalizeKey(key) && safe(s.block_id).trim() === safe(blockId).trim() && safe(s.status).trim() === 'open')
      .sort((a, b) => number(a.__rowIndex) - number(b.__rowIndex));
    return sessions.length ? sessions[sessions.length - 1] : null;
  }

  closeLatestOpenMaterialSession(key, blockId) {
    const session = this.findLatestOpenMaterialSession(key, blockId);
    if (!session) {
      console.log(`material session missing on completeBlock: key=${normalizeKey(key)} block=${safe(blockId)}`);
      return null;
    }
    const completedAt = new Date();
    const openedAt = parseStoredMskDate(session.opened_at_iso) || parseStoredMskDate(session.opened_at_msk);
    const durationSec = openedAt ? Math.max(0, Math.round((completedAt.getTime() - openedAt.getTime()) / 1000)) : '';
    const patch = {
      completed_at_msk: formatMsk(completedAt),
      completed_at_iso: completedAt.toISOString(),
      duration_sec: durationSec === '' ? '' : String(durationSec),
      duration_min: durationSec === '' ? '' : (durationSec / 60).toFixed(1),
      status: 'completed',
    };
    this.updateLocalRow(SHEETS.MATERIAL_SESSIONS, session.__rowIndex, patch);
    const values = this.snapshot.sheets[SHEETS.MATERIAL_SESSIONS];
    const headers = values[0] || this.sheetHeaders(SHEETS.MATERIAL_SESSIONS);
    const row = values[session.__rowIndex - 1];
    this.enqueue({ type: 'update', sheet: SHEETS.MATERIAL_SESSIONS, a1: `A${session.__rowIndex}:${colToA1(headers.length)}${session.__rowIndex}`, values: [row] });
    return { ...session, ...patch };
  }

  maybeUnlockNextDay(found) {
    const newbie = found && found.newbie ? found.newbie : null;
    if (!newbie) return found;
    const currentDay = number(newbie['текущий_день'], 1) || 1;
    const status = safe(newbie['статус_текущего_дня']).trim();
    if (currentDay >= 5 || status !== 'completed') return found;
    const unlockAt = parseStoredMskDate(newbie['следующий_день_доступен_мск']);
    if (!unlockAt) return found;
    if (Date.now() < unlockAt.getTime()) {
      console.log(`next day still locked: key=${normalizeKey(newbie.key)} unlock_at=${formatMsk(unlockAt)}`);
      return found;
    }
    const nextDay = Math.min(currentDay + 1, 5);
    this.updateNewbie(found.rowIndex, {
      'текущий_день': nextDay,
      'статус_текущего_дня': 'available',
      'день_завершён_мск': '',
      'следующий_день_доступен_мск': '',
    });
    console.log(`next day unlocked by calendar: key=${normalizeKey(newbie.key)} day=${nextDay}`);
    return this.findNewbie(newbie.key) || found;
  }

  getRouteStatus(newbie) {
    const currentDay = number(newbie['текущий_день'], 1);
    const status = safe(newbie['статус_текущего_дня']).trim();
    if (currentDay >= 5 && status === 'completed') return 'finished';
    if (status === 'completed') return 'locked';
    if (status === 'available') return 'available';
    if (status === 'in_progress') return 'in_progress';
    return status || 'available';
  }

  buildStudentState(key, options = {}) {
    const initialFound = this.findNewbie(key);
    if (!initialFound) throw new Error(`Ключ «${normalizeKey(key)}» не найден в листе «Новички».`);
    const found = this.maybeUnlockNextDay(initialFound);
    const newbie = found.newbie;
    const actualDayNumber = number(newbie['текущий_день'], 1) || 1;
    const preview = Boolean(options.preview);
    const dayNumber = Math.max(1, Math.min(5, number(options.dayNumber, actualDayNumber) || actualDayNumber));
    const currentDayId = `day_${dayNumber}`;
    const routeVariant = this.normalizeRouteVariant(options.routeVariant || this.getRouteVariantForSegment(newbie['сегмент']));
    const days = this.getDays();
    const day = days.find(d => safe(d.day_id) === currentDayId) || null;
    const materials = this.getMaterialsByBlock();
    const screens = this.getScreensByBlock();
    const visuals = this.getVisualsByTarget();
    const progress = preview ? {} : this.getProgressForKey(key);
    const sessions = preview ? {} : this.getOpenSessionsForKey(key);

    const blocksWithData = this.getBlocksForDay(currentDayId, routeVariant).map(block => {
      const blockId = safe(block.block_id).trim();
      const progressRow = progress[blockId] || null;
      return {
        block_id: blockId,
        day_id: safe(block.day_id),
        order: number(block['порядок']),
        type: safe(block['тип']),
        title: safe(block['название']),
        description: safe(block['описание']),
        expected: safe(block['ожидаемый_результат']),
        material_id: safe(block.material_id),
        required: isYes(block['обязательно']),
        autoComplete: isYes(block['авто_завершение']),
        comment: safe(block['комментарий_для_новичка']),
        done: Boolean(progressRow),
        progress: progressRow,
        material: materials[blockId] ? normalizeMaterial(materials[blockId]) : null,
        screen: screens[blockId] ? normalizeScreen(screens[blockId]) : null,
        visual: visuals[blockId] || null,
        openSession: sessions[blockId] || null,
      };
    });

    const requiredBlocks = blocksWithData.filter(b => b.required);
    const doneRequired = requiredBlocks.filter(b => b.done).length;
    const totalRequired = requiredBlocks.length;
    const percent = totalRequired ? Math.round(doneRequired / totalRequired * 100) : 100;
    const activeBlock = requiredBlocks.find(b => !b.done) || requiredBlocks[0] || blocksWithData[0] || null;
    const activeRequiredIndex = activeBlock ? Math.max(1, requiredBlocks.findIndex(b => b.block_id === activeBlock.block_id) + 1) : totalRequired;

    return {
      key: normalizeKey(key),
      mode: 'student',
      authVersion: 'v3-cached',
      preview,
      newbie: {
        key: normalizeKey(key),
        name: preview ? 'Preview' : safe(newbie['ФИО']),
        surname: safe(newbie['Фамилия']),
        firstName: safe(newbie['Имя']),
        segment: routeVariant === 'seller' ? 'Селлеры' : safe(newbie['сегмент']),
        direction: safe(newbie['направление']),
        status: safe(newbie['статус']),
        currentDay: dayNumber,
        actualCurrentDay: actualDayNumber,
        currentDayStatus: preview ? 'preview' : safe(newbie['статус_текущего_дня']),
        nextAvailableAt: safe(newbie['следующий_день_доступен_мск']),
        nextAvailableRaw: safe(newbie['следующий_день_доступен_мск']),
        routeVariant,
      },
      routeVariant,
      routeStatus: preview ? 'preview' : this.getRouteStatus(newbie),
      showWeekPlan: Boolean(options.showWeekPlan),
      day: day ? normalizeDay(day) : null,
      blocks: blocksWithData,
      requiredBlocks,
      optionalBlocks: blocksWithData.filter(b => !b.required),
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
      weekPlan: days.map(normalizeDay),
      goals: this.getDayGoals(),
      screens: this.getGlobalScreens(),
      visuals: {
        login: visuals.login_screen || null,
        weekPlan: visuals.screen_week_plan || null,
        locked: visuals.screen_day_locked || null,
        finished: visuals.screen_finished || null,
        help: visuals.help_widget || null,
      },
      help: {
        technical: 'https://connect.tochka.com/tochka/channels/itquestions',
        study: 'https://connect.tochka.com/tochka/channels/pomogaem-uchebke',
      },
      materialLockSeconds: 30,
      nowMsk: nowMskString(),
    };
  }

  updateNewbie(rowIndex, patch) {
    const headers = this.sheetHeaders(SHEETS.NEWBIES);
    this.updateLocalRow(SHEETS.NEWBIES, rowIndex, patch);
    const values = this.snapshot.sheets[SHEETS.NEWBIES];
    const row = values[rowIndex - 1];
    const startCol = 1;
    const endCol = headers.length;
    this.enqueue({ type: 'update', sheet: SHEETS.NEWBIES, a1: `${colToA1(startCol)}${rowIndex}:${colToA1(endCol)}${rowIndex}`, values: [row] });
  }

  logTracking(payload) {
    const obj = {
      timestamp_msk: nowMskString(),
      key: normalizeKey(payload.key),
      'ФИО': safe(payload.name),
      'сегмент': safe(payload.segment),
      day_id: safe(payload.dayId),
      'день': safe(payload.dayNumber),
      block_id: safe(payload.blockId),
      'шаг': safe(payload.step),
      'событие': safe(payload.event),
      'статус': safe(payload.status),
      'процент_дня': safe(payload.percent),
      'завершено_блоков': safe(payload.doneBlocks),
      'всего_блоков': safe(payload.totalBlocks),
      current_block_id: safe(payload.currentBlockId),
      'комментарий': safe(payload.comment),
      raw_payload: JSON.stringify(payload.raw || payload),
    };
    const row = this.addLocalObject(SHEETS.TRACKING, obj);
    this.enqueue({ type: 'append', sheet: SHEETS.TRACKING, row });
  }

  upsertProgress(key, dayId, blockId, status, comment) {
    const found = this.findNewbie(key);
    if (!found) throw new Error('Ключ не найден.');
    const name = safe(found.newbie['ФИО']);
    const t = this.table(SHEETS.PROGRESS);
    const now = nowMskString();
    const existing = t.objects.find(p => normalizeKey(p.key) === normalizeKey(key) && safe(p.block_id).trim() === blockId);
    const obj = {
      key: normalizeKey(key),
      'ФИО': name,
      day_id: dayId,
      block_id: blockId,
      'статус': status,
      'дата_старта': existing ? safe(existing['дата_старта']) || now : now,
      'дата_завершения': now,
      'комментарий_новичка': comment || '',
      'обновлено': now,
    };
    if (existing) {
      this.updateLocalRow(SHEETS.PROGRESS, existing.__rowIndex, obj);
      const values = this.snapshot.sheets[SHEETS.PROGRESS];
      const headers = values[0] || this.sheetHeaders(SHEETS.PROGRESS);
      const row = values[existing.__rowIndex - 1];
      this.enqueue({ type: 'update', sheet: SHEETS.PROGRESS, a1: `A${existing.__rowIndex}:${colToA1(headers.length)}${existing.__rowIndex}`, values: [row] });
    } else {
      const row = this.addLocalObject(SHEETS.PROGRESS, obj);
      this.enqueue({ type: 'append', sheet: SHEETS.PROGRESS, row });
    }
  }

  maybeTelegram(text) {
    const token = this.config.telegramBotToken;
    const chatId = this.config.telegramChatId;
    if (!token || !chatId) return;
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).catch(err => console.error('telegram failed:', err.message));
  }

  async call(method, args = []) {
    await this.ensureFresh(method);
    try {
      if (method === 'loginRouteV43') return this.loginRoute(args[0]);
      if (method === 'getSafeStudentStateV43' || method === 'getCurrentStateV43') return this.getState(args[0], false);
      if (method === 'markWeekPlanSeenV43') return this.getState(args[0], false);
      if (method === 'startCurrentDayV43') return this.startCurrentDay(args[0]);
      if (method === 'recordMaterialOpenedV43') return this.recordMaterialOpened(args[0]);
      if (method === 'completeBlockV43') return this.completeBlock(args[0]);
      if (method === 'completeDayV43') return this.completeDay(args[0]);
      if (method === 'submitHelpRequestV43') return this.submitHelp(args[0]);
      if (method === 'getAdminDashboardV43') return this.getAdminDashboard(args[0]);
      if (method === 'createNewbieKeyV43') return this.createNewbieKey(args[0]);
      if (method === 'getNewbieAdminStateV43') return this.getNewbieAdminState(args[0], args[1]);
      if (method === 'forceOpenNextDayV43') return this.forceOpenNextDay(args[0], args[1]);
      if (method === 'forceOpenDayV43') return this.forceOpenDay(args[0], args[1], args[2]);
      if (method === 'getPreviewState') return this.getPreviewState(args[0], args[1], args[2], args[3]);
      return fail(`Метод ${method} пока не реализован в v3-cached.`);
    } catch (err) {
      return fail((err && err.message) ? err.message : String(err));
    }
  }

  loginRoute(rawKey) {
    const key = normalizeKey(rawKey);
    if (!key) return fail('Введи ключ.');
    if (this.isAdminKey(key)) {
      return ok({ mode: 'admin', admin: true, authVersion: 'v3-cached', dashboard: this.buildAdminDashboard() });
    }
    const found = this.findNewbie(key);
    if (!found) return fail(`Ключ «${key}» не найден в листе «Новички».`);
    if (!this.isAllowedDirection(found.newbie['направление'])) {
      return fail(`Для этого ключа указано направление «${safe(found.newbie['направление'])}». Сейчас маршрут подключён только для кросс-продавца.`);
    }
    if (!safe(found.newbie['маршрут_начат']).trim()) {
      this.updateNewbie(found.rowIndex, { 'маршрут_начат': nowMskString() });
    }
    const state = this.buildStudentState(key, { showWeekPlan: true });
    this.logTracking({ key, name: found.newbie['ФИО'], segment: found.newbie['сегмент'], dayId: `day_${state.newbie.currentDay}`, event: 'login_v3_cached', status: 'ok', currentBlockId: state.tracking.activeBlockId, raw: { showWeekPlan: true } });
    return ok({ mode: 'student', state });
  }

  getState(rawKey, showWeekPlan = false) {
    const key = normalizeKey(rawKey);
    if (!key) return fail('Не передан ключ.');
    return ok({ mode: 'student', state: this.buildStudentState(key, { showWeekPlan }) });
  }

  startCurrentDay(rawKey) {
    const key = normalizeKey(rawKey);
    const found = this.findNewbie(key);
    if (!found) return fail('Ключ не найден.');
    this.updateNewbie(found.rowIndex, { 'статус_текущего_дня': 'in_progress' });
    return this.getState(key, false);
  }

  recordMaterialOpened(payload = {}) {
    const key = normalizeKey(payload.key);
    const found = this.findNewbie(key);
    if (!found) return fail('Ключ не найден.');
    const unlockedFound = this.maybeUnlockNextDay(found);
    const state = this.buildStudentState(key, { showWeekPlan: false });
    const block = (state.blocks || []).find(b => b.block_id === safe(payload.block_id));
    const material = block && block.material ? block.material : {};
    const obj = {
      session_id: crypto.randomUUID(),
      key,
      'ФИО': safe(unlockedFound.newbie['ФИО']),
      day_id: safe(payload.day_id),
      block_id: safe(payload.block_id),
      material_id: safe(material.material_id),
      material_title: safe(material.title),
      material_url: safe(payload.url || material.url),
      opened_at_msk: nowMskString(),
      opened_at_iso: nowIso(),
      completed_at_msk: '',
      completed_at_iso: '',
      duration_sec: '',
      duration_min: '',
      status: 'open',
    };
    const row = this.addLocalObject(SHEETS.MATERIAL_SESSIONS, obj);
    this.enqueue({ type: 'append', sheet: SHEETS.MATERIAL_SESSIONS, row });
    return ok({ recorded: true });
  }

  completeBlock(payload = {}) {
    const key = normalizeKey(payload.key);
    const found = this.findNewbie(key);
    if (!found) return fail('Ключ не найден.');
    const unlockedFound = this.maybeUnlockNextDay(found);
    const blockId = safe(payload.block_id).trim();
    const dayId = safe(payload.day_id).trim() || `day_${number(unlockedFound.newbie['текущий_день'], 1)}`;
    if (!blockId) return fail('Не передан block_id.');
    this.upsertProgress(key, dayId, blockId, 'done', safe(payload.comment));
    this.closeLatestOpenMaterialSession(key, blockId);
    const state = this.buildStudentState(key, { showWeekPlan: false });
    this.logTracking({ key, name: unlockedFound.newbie['ФИО'], segment: unlockedFound.newbie['сегмент'], dayId, blockId, event: 'complete_block_v3_cached', status: 'done', percent: state.tracking.percent, doneBlocks: state.tracking.doneSteps, totalBlocks: state.tracking.totalSteps, currentBlockId: state.tracking.activeBlockId });
    return ok({ mode: 'student', state });
  }

  completeDay(rawKey) {
    const key = normalizeKey(rawKey);
    const found = this.findNewbie(key);
    if (!found) return fail('Ключ не найден.');
    const currentDay = number(found.newbie['текущий_день'], 1) || 1;
    const completedAt = new Date();
    const patch = { 'статус_текущего_дня': 'completed', 'день_завершён_мск': formatMsk(completedAt) };
    if (currentDay < 5) {
      const unlockAt = buildNextWorkdayUnlockMsk(completedAt);
      patch['следующий_день_доступен_мск'] = formatMsk(unlockAt);
      console.log(`next day scheduled: key=${key} current_day=${currentDay} unlock_at=${formatMsk(unlockAt)}`);
    }
    this.updateNewbie(found.rowIndex, patch);
    return ok({ mode: 'student', state: this.buildStudentState(key, { showWeekPlan: false }) });
  }

  submitHelp(payload = {}) {
    const key = normalizeKey(payload.key);
    const found = this.findNewbie(key);
    const obj = {
      timestamp_msk: nowMskString(),
      key,
      'ФИО': found ? safe(found.newbie['ФИО']) : '',
      day_id: safe(payload.day_id),
      block_id: safe(payload.block_id),
      'тип': 'question',
      'текст': safe(payload.question || payload.text),
      'статус': 'new',
      source: safe(payload.source),
      raw_payload: JSON.stringify(payload),
    };
    const row = this.addLocalObject(SHEETS.HELP, obj);
    this.enqueue({ type: 'append', sheet: SHEETS.HELP, row });
    this.maybeTelegram(`❓ Вопрос от новичка\nФИО: ${obj['ФИО']}\nКлюч: ${key}\nДень: ${obj.day_id}\nБлок: ${obj.block_id}\n\n${obj['текст']}`);
    return ok({ sent: true });
  }

  parseDurationMinutes(value) {
    const text = safe(value).trim().replace(',', '.');
    if (!text) return 0;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  getSessionDurationMinutes(session) {
    if (!session) return 0;

    const status = safe(session.status).trim().toLowerCase();
    const isCompleted = status === 'completed' || status === 'done';
    if (!isCompleted) return 0;

    const direct = this.parseDurationMinutes(session.duration_min);
    if (direct !== null && Number.isFinite(direct) && direct >= 0) return direct;

    const seconds = Number(safe(session.duration_sec).trim().replace(',', '.'));
    if (Number.isFinite(seconds) && seconds >= 0) return seconds / 60;

    return 0;
  }

  getKnownSegments() {
    return this.table(SHEETS.REFS).objects
      .filter(row => this.normalizeSegment(row['категория']) === 'сегмент')
      .map(row => safe(row['значение']).trim())
      .filter(Boolean);
  }

  getRowsForKey(sheetName, key) {
    return this.table(sheetName).objects.filter(row => normalizeKey(row.key) === normalizeKey(key));
  }

  getLastActivityForKey(key) {
    const stamps = [];
    const newbie = this.findNewbie(key);
    if (newbie) {
      ['последняя_отбивка_мск', 'день_завершён_мск', 'следующий_день_доступен_мск', 'маршрут_начат'].forEach(field => {
        const value = safe(newbie.newbie[field]).trim();
        if (value) stamps.push(value);
      });
    }
    this.getRowsForKey(SHEETS.TRACKING, key).forEach(row => { if (safe(row.timestamp_msk).trim()) stamps.push(safe(row.timestamp_msk).trim()); });
    this.getRowsForKey(SHEETS.HELP, key).forEach(row => { if (safe(row.timestamp_msk).trim()) stamps.push(safe(row.timestamp_msk).trim()); });
    this.getRowsForKey(SHEETS.MATERIAL_SESSIONS, key).forEach(row => {
      if (safe(row.completed_at_msk).trim()) stamps.push(safe(row.completed_at_msk).trim());
      else if (safe(row.opened_at_msk).trim()) stamps.push(safe(row.opened_at_msk).trim());
    });
    const sorted = stamps.sort((a, b) => String(b).localeCompare(String(a), 'ru'));
    return sorted[0] || '';
  }

  buildDayHistory(key) {
    const found = this.findNewbie(key);
    if (!found) return [];
    const newbie = found.newbie;
    const routeVariant = this.getRouteVariantForSegment(newbie['сегмент']);
    const days = this.getDays();
    const progressRows = this.getRowsForKey(SHEETS.PROGRESS, key);
    const sessionRows = this.getRowsForKey(SHEETS.MATERIAL_SESSIONS, key);
    const helpRows = this.getRowsForKey(SHEETS.HELP, key);
    const trackingRows = this.getRowsForKey(SHEETS.TRACKING, key);
    const currentDayNumber = number(newbie['текущий_день'], 1) || 1;

    return days.map(dayRow => {
      const dayInfo = normalizeDay(dayRow);
      const dayNumber = number(dayInfo.number);
      const dayId = safe(dayInfo.day_id);
      const visibleBlocks = this.getBlocksForDay(dayId, routeVariant).map(block => ({
        block_id: safe(block.block_id),
        title: safe(block['название']),
        required: isYes(block['обязательно']),
      }));
      const requiredBlocks = visibleBlocks.filter(block => block.required);
      const dayProgress = progressRows.filter(row => safe(row.day_id) === dayId);
      const daySessions = sessionRows.filter(row => safe(row.day_id) === dayId);
      const dayHelp = helpRows.filter(row => safe(row.day_id) === dayId);
      const dayTracking = trackingRows.filter(row => safe(row.day_id) === dayId).sort((a, b) => String(b.timestamp_msk).localeCompare(String(a.timestamp_msk), 'ru'));
      const completedIds = new Set(dayProgress.filter(row => safe(row['статус']) === 'done').map(row => safe(row.block_id)));
      const completedRequired = requiredBlocks.filter(block => completedIds.has(block.block_id));
      const pendingRequired = requiredBlocks.filter(block => !completedIds.has(block.block_id));
      const hasDayComplete = completedIds.has(`day_${dayNumber}_completed`) || dayTracking.some(row => safe(row['событие']).includes('day_completed'));
      let status = 'not_opened';
      if (hasDayComplete || (requiredBlocks.length && completedRequired.length >= requiredBlocks.length && dayNumber < currentDayNumber)) {
        status = 'completed';
      } else if (dayNumber < currentDayNumber) {
        status = 'in_progress';
      } else if (dayNumber === currentDayNumber) {
        status = safe(newbie['статус_текущего_дня']) || 'available';
      }
      const sessionsDetailed = daySessions.map(session => ({
        block_id: safe(session.block_id),
        title: safe(session.material_title || session.block_id),
        opened_at_msk: safe(session.opened_at_msk),
        completed_at_msk: safe(session.completed_at_msk),
        duration_min: Math.round(this.getSessionDurationMinutes(session) * 10) / 10,
        status: safe(session.status || (safe(session.completed_at_msk) ? 'completed' : 'open')),
      }));
      const totalMinutes = Math.round(sessionsDetailed.reduce((sum, session) => sum + Number(session.duration_min || 0), 0) * 10) / 10;
      return {
        dayNumber,
        dayId,
        title: dayInfo.title,
        status,
        requiredTotal: requiredBlocks.length,
        requiredDone: completedRequired.length,
        completedTitles: completedRequired.map(block => block.title),
        pendingTitles: pendingRequired.map(block => block.title),
        sessions: sessionsDetailed,
        sessionCount: sessionsDetailed.length,
        completedSessionCount: sessionsDetailed.filter(session => session.status === 'completed').length,
        totalMinutes,
        help: dayHelp.map(row => ({ timestamp_msk: safe(row.timestamp_msk), text: safe(row['текст']), block_id: safe(row.block_id) })),
        helpCount: dayHelp.length,
        recentEvents: dayTracking.slice(0, 12).map(row => ({ timestamp_msk: safe(row.timestamp_msk), event: safe(row['событие']), block_id: safe(row.block_id), comment: safe(row['комментарий']) })),
      };
    });
  }

  buildAdminDashboard() {
    const students = this.table(SHEETS.NEWBIES).objects.filter(n => normalizeKey(n.key)).map(n => {
      const key = normalizeKey(n.key);
      const state = (() => { try { return this.buildStudentState(key, { showWeekPlan: false }); } catch (_) { return null; } })();
      const percent = state ? state.tracking.percent : 0;
      const studyMinutes = Math.round(this.getRowsForKey(SHEETS.MATERIAL_SESSIONS, key).reduce((sum, session) => sum + this.getSessionDurationMinutes(session), 0) * 10) / 10;
      const questions = this.getRowsForKey(SHEETS.HELP, key).length;
      let zone = 'red';
      if (percent >= 70) zone = 'green';
      else if (percent >= 30) zone = 'yellow';
      return {
        key,
        name: safe(n['ФИО']),
        surname: safe(n['Фамилия']),
        firstName: safe(n['Имя']),
        segment: safe(n['сегмент']),
        direction: safe(n['направление']),
        routeVariant: this.getRouteVariantForSegment(n['сегмент']),
        currentDay: number(n['текущий_день'], 1),
        status: safe(n['статус'] || 'active'),
        currentDayStatus: safe(n['статус_текущего_дня']),
        percent,
        doneBlocks: state ? state.tracking.doneSteps : 0,
        totalBlocks: state ? state.tracking.totalSteps : 0,
        activeBlock: state ? state.tracking.activeBlockId : '',
        questions,
        lastActivity: this.getLastActivityForKey(key),
        studyMinutes,
        materialSessions: this.getRowsForKey(SHEETS.MATERIAL_SESSIONS, key).length,
        zone,
      };
    });
    return {
      generatedAt: nowMskString(),
      warning: '',
      students,
      stats: {
        total: students.length,
        active: students.filter(s => s.status !== 'done').length,
        green: students.filter(s => s.zone === 'green').length,
        yellow: students.filter(s => s.zone === 'yellow').length,
        red: students.filter(s => s.zone === 'red').length,
      }
    };
  }

  getAdminDashboard(adminKey) {
    if (!this.isAdminKey(adminKey)) return fail('Нет доступа к админке. Проверь админский ключ.');
    return ok({ mode: 'admin', admin: true, authVersion: 'v3-cached', dashboard: this.buildAdminDashboard() });
  }

  createNewbieKey(payload = {}) {
    if (!this.isAdminKey(payload.adminKey)) return fail('Нет доступа к админке.');
    const knownSegments = this.getKnownSegments();
    const surname = safe(payload.surname).trim();
    const firstName = safe(payload.firstName).trim();
    const fallbackName = safe(payload.name).trim();
    const fullName = [surname, firstName].filter(Boolean).join(' ').trim() || fallbackName;
    const segment = safe(payload.segment).trim();
    if (!fullName) return fail('Укажи фамилию и имя новичка.');
    if (!segment) return fail('Выбери сегмент.');
    if (knownSegments.length && !knownSegments.includes(segment)) {
      return fail('Сегмент вне справочника. Выбери одно из фиксированных значений.');
    }
    const key = 'CR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const obj = {
      key,
      'ФИО': fullName,
      'Фамилия': surname,
      'Имя': firstName,
      'сегмент': segment,
      'направление': safe(payload.direction || 'кросс-продавец'),
      'старт': nowMskString(),
      'статус': 'active',
      'текущий_день': 1,
      'статус_текущего_дня': 'available',
      'день_завершён_мск': '',
      'следующий_день_доступен_мск': '',
      'маршрут_начат': '',
      'план_недели_показан': '',
      'создано_мск': nowMskString(),
    };
    const row = this.addLocalObject(SHEETS.NEWBIES, obj);
    this.enqueue({ type: 'append', sheet: SHEETS.NEWBIES, row });
    return ok({ key, dashboard: this.buildAdminDashboard() });
  }

  getNewbieAdminState(adminKey, newbieKey) {
    if (!this.isAdminKey(adminKey)) return fail('Нет доступа к админке.');
    const key = normalizeKey(newbieKey);
    const found = this.findNewbie(key);
    if (!found) return fail('Ключ не найден.');
    const state = this.buildStudentState(key, { showWeekPlan: false });
    const dayHistory = this.buildDayHistory(key);
    const sessions = this.getRowsForKey(SHEETS.MATERIAL_SESSIONS, key).map(session => ({
      ...session,
      duration_min: Math.round(this.getSessionDurationMinutes(session) * 10) / 10,
      status: safe(session.status || (safe(session.completed_at_msk) ? 'completed' : 'open')),
    }));
    const tracking = this.getRowsForKey(SHEETS.TRACKING, key).sort((a, b) => String(b.timestamp_msk).localeCompare(String(a.timestamp_msk), 'ru'));
    const help = this.getRowsForKey(SHEETS.HELP, key).sort((a, b) => String(b.timestamp_msk).localeCompare(String(a.timestamp_msk), 'ru'));
    const progress = this.getRowsForKey(SHEETS.PROGRESS, key);
    return ok({
      key,
      newbie: {
        key,
        name: safe(found.newbie['ФИО']),
        surname: safe(found.newbie['Фамилия']),
        firstName: safe(found.newbie['Имя']),
        segment: safe(found.newbie['сегмент']),
        direction: safe(found.newbie['направление']),
        currentDay: number(found.newbie['текущий_день'], 1) || 1,
        currentDayStatus: safe(found.newbie['статус_текущего_дня']),
        routeVariant: this.getRouteVariantForSegment(found.newbie['сегмент']),
      },
      state,
      dashboard: this.buildAdminDashboard(),
      progress,
      sessions,
      help,
      tracking,
      dayHistory,
    });
  }

  forceOpenNextDay(adminKey, newbieKey) {
    if (!this.isAdminKey(adminKey)) return fail('Нет доступа к админке.');
    const key = normalizeKey(newbieKey);
    const found = this.findNewbie(key);
    if (!found) return fail('Ключ не найден.');
    const next = Math.min(number(found.newbie['текущий_день'], 1) + 1, 5);
    this.updateNewbie(found.rowIndex, { 'текущий_день': next, 'статус_текущего_дня': 'available', 'день_завершён_мск': '', 'следующий_день_доступен_мск': '' });
    console.log(`next day unlocked manually: key=${key} day=${next} admin=${hash16(adminKey)}`);
    return this.getNewbieAdminState(adminKey, key);
  }

  forceOpenDay(adminKey, newbieKey, dayNumber) {
    if (!this.isAdminKey(adminKey)) return fail('Нет доступа к админке.');
    const key = normalizeKey(newbieKey);
    const found = this.findNewbie(key);
    if (!found) return fail('Ключ не найден.');
    const day = Math.max(1, Math.min(5, number(dayNumber, 1)));
    this.updateNewbie(found.rowIndex, { 'текущий_день': day, 'статус_текущего_дня': 'available', 'день_завершён_мск': '', 'следующий_день_доступен_мск': '' });
    console.log(`day unlocked manually: key=${key} day=${day} admin=${hash16(adminKey)}`);
    return this.getNewbieAdminState(adminKey, key);
  }

  getPreviewState(adminKey, dayNumber, routeVariantOrBlockId, selectedBlockId) {
    if (!this.isAdminKey(adminKey)) return fail('Нет доступа к админке.');
    const t = this.table(SHEETS.NEWBIES);
    const first = t.objects.find(n => normalizeKey(n.key));
    if (!first) return fail('Нет тестового новичка для preview.');
    const rawVariant = safe(routeVariantOrBlockId).trim().toLowerCase();
    const routeVariant = rawVariant === 'seller' ? 'seller' : 'default';
    const key = normalizeKey(first.key);
    const state = this.buildStudentState(key, {
      showWeekPlan: false,
      preview: true,
      dayNumber: Math.max(1, Math.min(5, number(dayNumber, 1))),
      routeVariant,
    });
    if (selectedBlockId) state.selectedBlockId = safe(selectedBlockId);
    return ok({ mode: 'student', state });
  }
}

module.exports = { OnboardingCore, SHEETS, READ_SHEETS, ok, fail };
