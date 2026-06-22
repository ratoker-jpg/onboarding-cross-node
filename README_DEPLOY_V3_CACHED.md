# onboarding_cross v3-cached

Версия без эмуляции Apps Script на каждый клик.

## Что поменялось

- Google Sheets читается пачкой через `batchGet`.
- Данные хранятся в локальном snapshot: `data/cache/onboarding_snapshot.json`.
- Вход по ключу и рендер состояния идут из кеша, поэтому не выбивают квоту Google Sheets.
- Прогресс/вопросы/логи пишутся сначала в локальный кеш и очередь `data/queue/sheets_queue.jsonl`.
- Очередь отправляется в Google Sheets пачками/по таймеру.

## Установка на сервер

```bash
cd ~/apps
mv onboarding_cross_node onboarding_cross_node_broken_$(date +%Y%m%d_%H%M%S) 2>/dev/null || true
mkdir -p ~/apps/onboarding_cross_node
unzip -o ~/apps/onboarding_cross_node_v3_cached.zip -d ~/apps/onboarding_cross_node
cd ~/apps/onboarding_cross_node
cp .env.example .env
nano .env
npm install
npm run check
```

В `.env` должны быть реальные значения:

```env
GOOGLE_OAUTH_CLIENT=/home/DenisErmakov/web-server/secrets/google-oauth-client.json
GOOGLE_OAUTH_TOKEN=/home/DenisErmakov/web-server/secrets/google-oauth-token.json
SPREADSHEET_ID=1cIUSFXfb3l1bc8E9ZWXs90osDVp7F1Wx511DNKQkvV4
ADMIN_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
PORT=8020
BASE_PATH=/onboarding_cross
CACHE_TTL_MS=60000
PUSH_INTERVAL_MS=15000
```

## Первый pull

```bash
npm run sync:pull
```

## Запуск

```bash
pkill -u "$USER" -f "apps/onboarding_cross_node" 2>/dev/null || true
rm -f app.log
nohup npm start > app.log 2>&1 &
sleep 3
tail -n 80 app.log
```

## Проверка

```bash
curl -i http://127.0.0.1:8020/api/onboarding/health
curl -s -X POST http://127.0.0.1:8020/api/onboarding/run \
  -H "Content-Type: application/json" \
  --data '{"method":"loginRouteV43","args":["EXAMPLE05"]}' | head -c 1000; echo
curl -I http://127.0.0.1:8010/onboarding_cross/
```

## Ручная синхронизация

Pull из Google Sheets:

```bash
curl -X POST http://127.0.0.1:8020/api/onboarding/sync/pull
```

Push очереди в Google Sheets:

```bash
curl -X POST http://127.0.0.1:8020/api/onboarding/sync/push
```

## Важно

Это MVP. Основной сценарий новичка закрыт: вход, показ дней/блоков/материалов, старт дня, завершение блоков, завершение дня, вопросы, базовая админка. Если в старом Apps Script были редкие специальные функции, они могут быть не реализованы и будут возвращать ошибку `Метод ... пока не реализован в v3-cached`.
