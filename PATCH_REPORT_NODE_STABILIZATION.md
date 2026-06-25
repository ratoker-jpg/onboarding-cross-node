# PATCH_REPORT_NODE_STABILIZATION.md

## 1. Что было сломано

- Во frontend оставались активные legacy-хвосты Apps Script, включая живой `google.script.run` для help flow.
- В `public/index.html` были дубли ключевых функций: `adminPreviewDay`, `openMaterial`, `completeBlock`, `completeDay`, `resetToLogin`, `sendHelp`.
- `material sessions` записывали только `open`, но серверная логика закрытия сессии и расчета `duration` отсутствовала.
- После завершения дня в `следующий_день_доступен_мск` писалась текстовая заглушка вместо реального unlock time.
- Preview был частично защищен, но не везде давал мягкое поведение в UI и не был явно помечен как preview state.

## 2. Root cause

- Node MVP собирался поверх старого Apps Script frontend/backend подхода, и часть переходной логики осталась в активном клиенте.
- Серверный слой уже вел кэш и очередь, но логика `material sessions` и календарного unlock не была доведена до полного цикла.
- Preview защита была в основном клиентской и не была аккуратно доведена во всех пользовательских действиях.

## 3. Какие файлы изменены

- `public/index.html`
- `onboarding_core.js`

## 4. Какие функции изменены

### `public/index.html`

- `renderOptionalBlocks`
- `adminPreviewDay`
- `openMaterial`
- `completeBlock`
- `completeDay`
- `resetToLogin`
- `sendHelp`
- добавлен `showPreviewNotice`
- удалены дубли активных реализаций перечисленных функций

### `onboarding_core.js`

- добавлены helper-функции для MSK-времени и следующего рабочего дня
- `buildStudentState`
- `recordMaterialOpened`
- `completeBlock`
- `completeDay`
- `forceOpenNextDay`
- `forceOpenDay`
- `getPreviewState`
- добавлены:
  - `findLatestOpenMaterialSession`
  - `closeLatestOpenMaterialSession`
  - `maybeUnlockNextDay`

## 5. Что сделано по frontend legacy cleanup

- Убран активный `google.script.run` из help flow.
- Все активные пользовательские действия оставлены на одном Node API пути: `/api/onboarding/run`.
- Удалены дубли `adminPreviewDay`, `openMaterial`, `completeBlock`, `completeDay`, `sendHelp`.
- Оставлена одна активная реализация `resetToLogin`.
- Preview-поведение в UI стало явным:
  - попытка завершить шаг в preview показывает мягкое сообщение;
  - попытка завершить день в preview показывает мягкое сообщение;
  - help из preview не отправляет реальный запрос;
  - optional block action в preview теперь не пишет прогресс.

## 6. Что сделано по material sessions

- `recordMaterialOpened()` по-прежнему создает запись со статусом `open`.
- В `completeBlock()` добавлено закрытие последней открытой material session для того же `key + block_id`.
- При закрытии заполняются:
  - `completed_at_iso`
  - `completed_at_msk`
  - `duration_sec`
  - `duration_min`
  - `status = completed`
- Обновление идет через уже существующий runtime update-подход без изменения Google Sheets schema.
- Если открытая material session не найдена, блок все равно завершается, а в лог пишется диагностическое сообщение.

## 7. Что сделано по 07:00 MSK / выходным

- Добавлены helper-функции для безопасной работы с московским временем без внешних библиотек.
- После `completeDay()` для дней `< 5` сервер теперь вычисляет реальный unlock time на следующий рабочий день в `07:00 MSK`.
- Суббота и воскресенье пропускаются.
- Если день завершен в пятницу, следующий unlock переносится на понедельник `07:00 MSK`.
- Если студент заходит после наступления unlock time, `buildStudentState()` автоматически открывает следующий день через `maybeUnlockNextDay()`.
- Admin `forceOpenNextDay` и `forceOpenDay` продолжают работать сразу и обходят календарный lock.

## 8. Как защищён preview

- `getPreviewState()` теперь помечает state как `preview = true`.
- Во frontend preview не записывает:
  - progress
  - material sessions
  - complete block
  - complete day
  - real help request
- Открытие ссылки материала в preview разрешено, но `recordMaterialOpened` не вызывается.
- Вместо «молчаливого return» для ключевых действий теперь показывается мягкое уведомление.

## 9. Что сознательно не трогал

- `.env` и любые секреты
- Google Sheets schema и заголовки листов
- reverse proxy / внешний URL
- папку `appscript/`
- деплой / restart / reload production
- бизнес-контент маршрута и тексты обучения
- структуру snapshot/queue как таковую

## 10. Команды проверки и результат

Попытался выполнить обязательную проверку:

```bash
npm run check
```

Но из этой сессии нет shell-доступа к Linux-окружению проекта. Дополнительно была проверена возможность запуска команды через `ssh localhost`, результат:

```bash
ssh -o BatchMode=yes localhost "cd /home/DenisErmakov/apps/onboarding_cross_node && npm run check"
```

Результат:

- `ssh: connect to host localhost port 22: Connection refused`

Итог:

- кодовые изменения внесены;
- обязательную команду `npm run check` из этой сессии запустить не удалось из-за отсутствия shell-доступа к среде проекта;
- требуется выполнить ее уже на стороне сервера/хоста проекта.

## 11. Ручной тест-план

1. Student login валидным ключом.
2. Admin login через `ADMIN_KEY`.
3. Нажать `Сменить ключ` из админки и снова войти как студент.
4. Открыть материал в student flow.
5. Подождать 30 секунд.
6. Нажать `Всё получилось` и проверить, что блок завершается.
7. Проверить в `Сессии_материалов`, что для последней сессии появились `completed_at_*`, `duration_*`, `status=completed`.
8. Завершить день и проверить, что в `следующий_день_доступен_мск` записано реальное время, а не текстовая заглушка.
9. Проверить locked screen до наступления `07:00 MSK` следующего рабочего дня.
10. Проверить, что после `07:00 MSK` студент видит следующий день.
11. Проверить сценарий Friday -> Monday `07:00 MSK`.
12. Проверить `forceOpenNextDay` из админки.
13. Проверить `forceOpenDay` на днях `1-5`.
14. Открыть preview дня.
15. В preview открыть материал и убедиться, что ссылка открывается, но material session не пишется.
16. В preview попробовать завершить шаг и день — UI должен показать мягкое сообщение, прогресс не меняется.
17. В preview открыть `?` и отправить help — должен показаться мягкий отказ без реальной записи.

## 12. Нужен ли deploy/restart

- Да, чтобы новый код реально начал обслуживать трафик, потребуется restart/reload серверного процесса.
- Я этого не делал.
- Перед restart желательно вручную выполнить `npm run check` в окружении проекта.

Жду проверки, deploy/restart не делал.
