# QA_REPORT_NODE_STABILIZATION.md

## Какие команды запускал

1. Попытка обязательной проверки:

```bash
ssh -o BatchMode=yes localhost "cd /home/DenisErmakov/apps/onboarding_cross_node && npm run check"
```

2. Локальная логическая проверка helper-функции для следующего рабочего дня 07:00 MSK:

```bash
node -
```

Во временном inline-скрипте были воспроизведены функции:
- `getMskParts`
- `dateFromMskParts`
- `isWeekendMsk`
- `buildNextWorkdayUnlockMsk`

И проверены кейсы:
- Friday -> Monday 07:00 MSK
- Monday 06:30 -> Tuesday 07:00 MSK
- Monday 10:30 -> Tuesday 07:00 MSK

## Результаты

### 1. `npm run check`

Запустить не удалось из этой сессии, потому что нет shell-доступа к Linux-окружению проекта.

Результат попытки:
- `ssh: connect to host localhost port 22: Connection refused`

Вывод:
- обязательная команда не выполнена не из-за кода, а из-за ограничения среды QA-сессии.
- перед restart ее нужно выполнить уже внутри окружения проекта.

### 2. Активный `google.script.run`

Во время QA был найден оставшийся активный legacy-блок в `public/index.html`, содержащий:
- `google.script.run`
- старую реализацию `sendHelp`
- первую дублирующую реализацию `completeBlock`
- первую дублирующую реализацию `completeDay`
- первую дублирующую реализацию `resetToLogin`

Этот блок был удален минимальным патчем в ходе QA.

Итог после фикса:
- активного `google.script.run` в проверенном активном хвосте клиентского runtime больше нет.
- help flow идет через `runServer('submitHelpRequestV43', ...)`.

### 3. Дубли функций

В ходе QA был подтвержден и исправлен остаточный дубль-кусок.

После минимального фикса в активной клиентской ветке осталась одна реализация:
- `adminPreviewDay`
- `openMaterial`
- `completeBlock`
- `completeDay`
- `resetToLogin`
- `sendHelp`

### 4. Старая заглушка `следующий рабочий день 07:00 МСК`

В активном коде `completeDay()` заглушка больше не используется.

Теперь в `onboarding_core.js`:
- считается `unlockAt = buildNextWorkdayUnlockMsk(completedAt)`
- в `следующий_день_доступен_мск` записывается `formatMsk(unlockAt)`

### 5. `completeDay()` пишет timestamp, а не текст

Проверено по коду:
- `completeDay()` формирует реальный объект даты
- записывает строку времени через `formatMsk(unlockAt)`

То есть сервер теперь пишет timestamp в MSK-формате, а не текстовую заглушку.

### 6. Friday -> Monday 07:00 MSK

Локальная логическая проверка helper-функции показала:

- `19.06.2026 12:00:00 => 22.06.2026 07:00:00`
- `22.06.2026 06:30:00 => 23.06.2026 07:00:00`
- `22.06.2026 10:30:00 => 23.06.2026 07:00:00`

Вывод:
- пятница корректно переводится на понедельник 07:00 MSK;
- завершение дня до 07:00 не открывает тот же день, а уводит на следующий рабочий день 07:00.

### 7. `recordMaterialOpened()` + `completeBlock()` -> completed material session с duration

Проверено по коду:
- `recordMaterialOpened()` создает session со статусом `open`
- `completeBlock()` вызывает `closeLatestOpenMaterialSession(key, blockId)`
- `closeLatestOpenMaterialSession()` заполняет:
  - `completed_at_msk`
  - `completed_at_iso`
  - `duration_sec`
  - `duration_min`
  - `status = completed`
- обновление идет через существующий update-механизм в тот же лист `Сессии_материалов`

Вывод:
- кодовая связка теперь полная и согласованная.

### 8. Preview не пишет progress/material/help

Проверено по активной клиентской ветке:
- `openMaterial()` в preview только открывает ссылку и не вызывает запись
- `completeBlock()` в preview показывает мягкое сообщение и не пишет прогресс
- `completeDay()` в preview показывает мягкое сообщение и не завершает день
- `sendHelp()` в preview показывает мягкий отказ и не отправляет реальный help request
- `getPreviewState()` помечает state как `preview = true`

Вывод:
- на уровне активного frontend flow preview-защита соблюдается.

## Что нашёл

Главная находка QA:
- в `public/index.html` после предыдущего патча оставался живой legacy-блок с `google.script.run` и дублирующими функциями.

Это был реальный дефект, потому что требование "нет активных `google.script.run` и нет дублей функций" формально не выполнялось.

## Что исправил

Минимально исправил только `public/index.html`:
- удалил оставшийся старый активный блок с:
  - `google.script.run`
  - старым `sendHelp`
  - старым `completeBlock`
  - старым `completeDay`
  - старым `resetToLogin`
- остальную логику не трогал.

Никаких изменений в:
- `.env`
- Google Sheets schema
- `appscript/`
- reverse proxy
- deploy/restart

не вносил.

## Можно ли делать restart

Пока не рекомендую делать restart вслепую.

Причина:
- обязательный `npm run check` из этой QA-сессии не был выполнен из-за отсутствия shell-доступа к Linux-окружению.

Рекомендация:
1. На сервере в рабочей директории выполнить:

```bash
cd /home/DenisErmakov/apps/onboarding_cross_node
npm run check
```

2. Если `npm run check` проходит без ошибок, после этого restart уже можно планировать.

Итоговый статус:
- кодовая QA-проверка пройдена;
- найден и исправлен один остаточный frontend legacy-дефект;
- restart допустим только после реального `npm run check` в окружении проекта.
