# Pager: пошаговый план с промптами для Antigravity

Как пользоваться:
1. Создай пустую папку `pager/`, положи в неё `AGENTS.md` и `docs/SPEC.md`. `git init`, первый коммит.
2. Открой папку в Antigravity. Агент сам подхватит `AGENTS.md` из корня.
3. Давай агенту **по одному промпту**. После каждого сделай проверку из блока «Проверка» и закоммить.
4. Если агент «придумывает» методы SDK, верни его к правилу №1 из AGENTS.md.

---

## День 0, вторник 24.11: подготовка (руками, ~1 час)

Это нужно сделать самому, агент это не сделает:

- [ ] **Telegram-бот.** @BotFather → `/newbot` → сохрани токен. Затем `/mybots` → бот → Bot Settings → **Secretary Mode (раньше называлось Business Mode) → включить**. ✅ сделано
- [ ] **Подключи бота к себе (без Premium).** Обнови Telegram до последней версии → открой **свой профиль → Изменить → Автоматизация чатов** (Chat Automation) → введи @username бота → разреши ответы на сообщения, выбери чаты (для теста 1–2 чата со вторым аккаунтом). Меню Settings → Telegram Business → Chatbots есть только у Premium, его искать не нужно.
- [ ] **Второй аккаунт для теста.** Нужен кто-то, кто будет писать тебе: второй номер или друг.
- [ ] **Google Cloud.** Создай проект → включи Google Calendar API → OAuth consent screen (External, Testing) → добавь свой email в Test users → Credentials → OAuth Client ID (Web application). Redirect URI добавишь позже, когда будет домен.
- [ ] **Ключи.** Anthropic (или OpenRouter) API key, Groq API key.
- [ ] **Railway.** Аккаунт, новый пустой проект (деплой подключим в промпте 3).
- [ ] **GitHub.** Публичный репозиторий `pager` (или приватный до сдачи, публичным сделать к 29.11).
- [ ] `npm i -g @evenrealities/evenhub-simulator @evenrealities/evenhub-cli`

---

## Промпт 1. Каркас монорепо

```
Прочитай AGENTS.md и docs/SPEC.md.
Создай каркас монорепо:
1) plugin/ — из официального шаблона: `npx degit even-realities/evenhub-templates/minimal plugin`, затем npm install.
   Убедись, что app.json содержит network-permission с whitelist ["http://localhost:8787"] и разрешение на микрофон очков
   (точное имя поля и формат возьми из шаблона/доков, не выдумывай).
2) server/ — Node 20 + TypeScript + Hono + tsx (dev), zod, drizzle-orm + better-sqlite3, grammY.
   Маршрут GET /health → {ok:true}. CORS из env CORS_ORIGINS.
3) Корень: .gitignore (node_modules, .env, data/, *.db, dist, *.ehpk), server/.env.example по списку из AGENTS.md,
   README.md с заголовками разделов (заполним позже).
Ничего лишнего не добавляй. В конце дай команды запуска и проверки.
```
**Проверка:** `cd server && npm run dev` → `curl localhost:8787/health` возвращает `{ok:true}`. `cd plugin && npm run dev` + `npx evenhub-simulator http://localhost:5173` показывает экран шаблона.

---

## Промпт 2. Спайк: шрифт и жесты (30 минут, очень важно)

```
В plugin/ сделай временный спайк-экран (src/glasses/spike.ts, подключи вместо экрана шаблона):
1) Text-контейнер с тестовыми строками:
   "Latin: Hello, Aziz! 17:00"
   "Cyrillic: Привет, Азиз!"
   "Uzbek latin: Oʻzbekiston, gʻ, sh"
   "Symbols: > • ● ○ ▲ ▼ ━ ─ ✓ !"
2) List-контейнер на 3 пункта с isEventCapture:1.
3) Логируй на экран (textContainerUpgrade во втором текстовом контейнере) и в console все события из onEvenHubEvent:
   тип события, eventType, индекс выбранного пункта списка, sysEvent, menuItemClickEvent.
4) Добавь menuObject с пунктами "Voice reply"(1), "Skip"(2), "Refresh"(3).
Сначала открой .d.ts SDK и используй точные имена типов и полей. Всего не больше 3 контейнеров.
```
**Проверка:** в симуляторе видно, отображается ли кириллица и узбекские апострофы. Покликай: тап, двойной тап, свайпы, долгий тап, меню. **Пришли мне результат** (что видно, какие события и поля приходят). На этом строим экраны.

---

## Промпт 3. Бот: приём business-сообщений + деплой на Railway

```
В server/:
1) Drizzle-схема и миграции для таблиц users, devices, pair_codes, link_tokens, messages, actions из docs/SPEC.md §5
   (google_accounts и ai_settings тоже создай сразу, логику потом).
2) grammY-бот в webhook-режиме: POST /tg/webhook, проверка заголовка X-Telegram-Bot-Api-Secret-Token.
   Скрипт npm run bot:set-webhook вызывает setWebhook с secret_token и allowed_updates, включающими
   message, business_connection, business_message, edited_business_message, my_chat_member, chat_join_request.
3) Обработчики:
   - business_connection → upsert users (tg_user_id, business_connection_id, can_reply, is_enabled).
   - business_message → если сообщение НЕ от владельца подключения, сохранить в messages (status=new, expires_at=+48h).
     Временно, для проверки: если текст == "ping", ответить "pong" от имени владельца через business_connection_id.
   - /start → приветствие и инструкция подключения: «Профиль → Изменить → Автоматизация чатов → @бот» (у Premium: Settings → Telegram Business → Chatbots).
4) Логи без текста сообщений.
5) Подготовь деплой на Railway: Dockerfile или nixpacks-настройки, volume под DATABASE_PATH, команда миграций при старте.
   Распиши мне шаги в Railway UI (переменные окружения, volume, домен).
Проверь типы grammY для business-апдейтов и параметра business_connection_id, не выдумывай.
```
**Проверка:** после деплоя и `npm run bot:set-webhook` со второго аккаунта пишешь себе «ping» → в чате появляется «pong» **от твоего имени**. В БД есть запись в messages. Если работает, главный технический риск закрыт.

---

## День 1, среда 25.11: сквозной скелет

### Промпт 4. Сопряжение (pairing)

```
Реализуй pairing по docs/SPEC.md §5 «Сопряжение»:
server:
- POST /api/pair/start → создаёт pair_codes {code: 6 цифр, pair_id: uuid, expires_at: +10 мин} → {pairId, code, botUsername}.
- Бот: /start <code> (deep link) и просто текст из 6 цифр → привязывает pair_code к пользователю, отвечает
  "Glasses connected ✓" + напоминание подключить бота в «Автоматизации чатов», если business_connection ещё нет.
- GET /api/pair/status?pairId= → {status:"pending"} или один раз {status:"paired", deviceToken}
  (токен 32 байта base64url, в devices хранится только SHA-256). Повторный запрос после выдачи → "expired".
- Middleware Bearer-авторизации для /api/* (кроме pair/*). /unpair в боте отзывает все устройства.
plugin:
- src/lib/api.ts (базовый URL из VITE_API_BASE_URL, Bearer из storage).
- Экран Pairing на линзах: "Pair with Telegram" / "Send 482913 to @<bot>" / "waiting…", опрос статуса каждые 2 с.
- Phone UI (src/phone): тот же код + кнопка-ссылка https://t.me/<bot>?start=<code>.
- После успеха сохранить токен через bridge.setLocalStorage и перейти на экран Inbox (пока заглушка-текст).
- При старте: если токен есть → сразу Inbox.
```
**Проверка:** чистый старт симулятора → на линзе код → отправляешь боту → через ~2 с экран меняется. Перезапуск симулятора → сразу Inbox.

### Промпт 5. Inbox из реального API

```
server: GET /api/inbox → до 10 сообщений status in (new) этого пользователя, сгруппированных по чату (последнее сообщение),
сортировка: received_at desc. Каждый элемент: {id, chatId, from: toLens(name, 12), preview: toLens(text, 40), count}.
Реализуй src/lib/translit.ts (ru + uz кириллица → латиница, обрезка с "…", вырезание неподдерживаемых символов)
и используй его в toLens. Покрой translit unit-тестами.
GET /api/stream — SSE: событие "inbox" при новом business_message этого пользователя (in-memory pub/sub).
plugin: экран Inbox по раскладке из AGENTS.md: шапка "PAGER · N need reply", список (list-контейнер) "from  preview".
Пустое состояние: "All clear ✓". Обновление по SSE через rebuildPageContainer (не чаще раза в 1 с).
Свайп — по списку, тап — пока лог, двойной тап — shutDownPageContainer(1). menuObject пересылай при каждом rebuild.
```
**Проверка (главная за день):** второй аккаунт пишет тебе в Telegram → **через 1–2 секунды строка появляется в симуляторе.** Сделай короткую запись экрана, пригодится для видео.

---

## Дальше

Промпты 1–5 выполнены (см. статус в `docs/NEXT-v5.md`). Актуальный объём и следующие промпты A–F — **в `docs/NEXT-v5.md`**.
Старый план (автоответчик, фильтр тона, голос→текст, проекты/приглашения, BYOK) снят из объёма.
