# AGENTS.md — Pager (AI pager for Telegram on Even Realities G2)

Solo hackathon project for "Heads Up: Even Realities Hackathon" (DoraHacks).
**Hard deadline: 2026-11-29 23:59 GMT+4. Target submit: 2026-11-29 20:00.**
Full product spec: @docs/SPEC.md (read it before any feature work). Current task prompts: @docs/NEXT-v5.md.

## Communication
- Talk to the user in **Russian**. Code, identifiers, comments, commit messages: **English**.
- Keep explanations short. After each task, say exactly how to verify it (command + expected result).

## Repo layout
```
/AGENTS.md            ← this file
/docs/SPEC.md         ← product spec (source of truth for features)
/docs/NEXT-v5.md      ← current scope + step-by-step prompts
/plugin/              ← Even Hub plugin (Vite + TypeScript + @evenrealities/even_hub_sdk)
  app.json            ← Even Hub manifest (network whitelist, mic permission)
  src/glasses/        ← lens screens + state machine + SDK wrapper
  src/phone/          ← phone-side UI inside the WebView (pairing, status)
  src/lib/            ← api client, translit, wav encoder
/server/              ← Backend (Node 20 + TypeScript + Hono)
  src/routes/         ← /api/*, /tg/webhook, /auth/*, /privacy, /terms, /health
  src/bot/            ← grammY bot (commands, business_connection, business_message)
  src/ai/             ← LLM provider adapter + prompts + zod schemas
  src/voice/          ← ffmpeg WAV → OGG/Opus + sendVoice
  src/google/         ← OAuth + calendar slots
  src/db/             ← Drizzle schema + migrations (better-sqlite3)
  src/lib/            ← crypto (AES-256-GCM), tokens, translit, logger
```

## Golden rules (non-negotiable)
1. **Never invent Even Hub SDK APIs.** Before calling any SDK method, open the type definitions in
   `plugin/node_modules/@evenrealities/even_hub_sdk/` (`*.d.ts`) and/or https://hub.evenrealities.com/docs.
   If something is unclear, write a tiny spike and test it in the simulator first.
2. **No secrets in `plugin/`** and never commit `.env`. All keys live in server env. Keep `.env.example` up to date.
3. **Real APIs only** in the main code path (Telegram, Google, LLM, ffmpeg). Mocks only inside tests.
4. **Small vertical slices.** Each task must end runnable and verifiable. Don't refactor unrelated code.
5. **Do not log message text, tokens or API keys.** Log ids and statuses only.
6. Prefer `fetch` + zod over heavy vendor SDKs (except grammY and googleapis/google-auth-library).
7. When a task is done, update `README.md` sections if behavior/setup changed.

## Even G2 platform constraints (verified from official docs)
- Canvas 576×288 per eye, 4-bit greyscale (green). No HTML/CSS on lenses: UI is SDK containers at absolute px.
- Per page: max 4 image + 8 other containers, **but the simulator rejects >4 containers → we use ≤3**.
- Exactly **one** container has `isEventCapture: 1`; it receives input.
- `createStartUpPageContainer` is called **exactly once** at startup. Screen changes → `rebuildPageContainer`.
  Text-only changes → `textContainerUpgrade` (needs same `containerID` + `containerName`, no flicker).
- Text limits: 1000 chars for create/rebuild, 2000 for `textContainerUpgrade`. Full screen ≈ 400–500 chars.
- List container: ≤20 items, ≤64 chars each, native highlight/scroll, **no in-place update** (rebuild page).
- `containerName` ≤16 chars, unique per page.
- `menuObject` (contextual menu, ≤10 items, `itemName` ≤32 bytes, `itemID` ≠ 0) is **replaced on every rebuild** →
  always re-send it. Selection arrives as `event.menuItemClickEvent.itemID`.
- Input via `bridge.onEvenHubEvent(event => …)`: `textEvent` / `listEvent` carry `eventType`
  (`CLICK_EVENT`=0 — may arrive as `undefined`, treat undefined as click; `SCROLL_TOP_EVENT`=1; `SCROLL_BOTTOM_EVENT`=2;
  `DOUBLE_CLICK_EVENT`=3). Long press arrives on `event.sysEvent` (`LONG_PRESS_EVENT`=9, `LONG_PRESS_RELEASE_EVENT`=10).
  The OS may steal tap+hold for its menu → every long-press feature must also exist as a menu item.
- Audio: `bridge.audioControl(true, AudioInputSource.Glasses)` (only after the startup page exists; needs
  `g2-microphone` permission) → chunks in `event.audioEvent.audioPcm` (Uint8Array, PCM s16le, 16 kHz, mono, ~100 ms).
  Stop with `audioControl(false)`.
- Storage: `bridge.setLocalStorage(key, value)` / `bridge.getLocalStorage(key)`.
- Exit from root screen: `shutDownPageContainer(1)` (system confirm dialog).
- Network: every origin must be listed in `app.json` → `permissions[{name:"network", whitelist:[full origins]}]`.
  Whitelist does NOT bypass CORS → server must send correct CORS headers and answer OPTIONS preflight.
- Android WebView may be killed in background → plugin must cold-start cleanly (token from storage → Inbox).
- **Font: only ASCII/Latin-1 + arrows/box-drawing/blocks are documented. Cyrillic is likely dropped silently.**
  Everything shown on lenses goes through `toLens()` (translit + truncate). Original text is still sent to Telegram.
- Simulator: `npx evenhub-simulator http://localhost:5173` (mic via `--aid`, list devices `--list-audio-input-devices`).
  Simulator is not pixel-perfect; hardware may differ.

## Lens UX rules
- One idea per screen, 2–4 short lines. Lens strings ≤32 chars (drafts), header ≤40 chars.
- Layout: header text (y=0,h≈44) + gist text (y≈44,h≈70) + list of actions (rest, `isEventCapture:1`).
- Gestures: swipe = move, tap = do, double tap = back/cancel, long press = voice (+ menu duplicate).
- Destructive/sending actions: 3-second undo window ("Sending… 2×tap cancel").

## Server conventions
- Hono + zod validation on every route. Errors → `{error: code}` JSON, never stack traces.
- DB: Drizzle + better-sqlite3, file path from `DATABASE_PATH` (Railway volume in prod).
- Auth for `/api/*`: `Authorization: Bearer <deviceToken>`; DB stores SHA-256 hash only.
- Telegram: grammY with **webhook** + `secret_token`; verify `X-Telegram-Bot-Api-Secret-Token`.
  Handle `business_connection` (store `id`, `rights` (BusinessBotRights, replaced `can_reply` in Bot API 9.0), `is_enabled`)
  and `business_message` (upsert sender into `contacts`).
  Replies on behalf of the user: `sendMessage` / `sendVoice` with `business_connection_id` (check grammY types).
  `allowed_updates`: message, business_connection, business_message, edited_business_message.
  Never use MTProto/user sessions.
- **Scope v5 (do NOT build anything else):** feed modes Urgent/All, voice recorder → voice message, calendar conflicts,
  brief + next meeting, onboarding wizard, production setup. Out of scope: autoreply, tone filter, speech-to-text,
  projects/invites, BYOK page. If a task seems to need them, ask the user first.
- User settings (`user_settings`: feed_mode urgent|all, voice_enabled, conflict_alerts, last_opened_at) live on the server;
  the phone UI edits them, the lens only toggles feed mode via the menu.
- Voice recorder: NO transcription and NO AI. WAV → OGG/Opus via ffmpeg (installed in Dockerfile; spawn with stdin/stdout,
  no temp files) → `sendVoice` with `business_connection_id`. Never store audio.
  Duration rules on the lens (thresholds in config): <0.7 s discard ("Too short"); 0.7–2 s and >30 s → explicit
  Send/Discard confirmation, no auto-send; 2–30 s → 3-second countdown with double-tap cancel. Max 60 s (auto-stop).
- Calendar conflicts: triage extracts `when` (ISO start/end in the user's tz, default Asia/Tashkent); the **server**
  (not the LLM) checks overlap with Google Calendar events; on conflict the bot DMs the user (not the contact) a warning,
  drafts propose free slots with `+cal`. Conflict never sends anything to the contact by itself.
- Triage runs **when the message arrives** (webhook), not when the plugin opens.
- AI: `LlmProvider` adapter (current: Gemini via `AI_DEFAULT_PROVIDER`). Output always validated by zod; 1 retry,
  then `buildFallbackTriage`. Per-user daily cap on AI calls.
- Secrets at rest (Google refresh token): AES-256-GCM with `ENCRYPTION_KEY` (32 bytes, base64).
- One-time links (pairing code, Google connect): random, hashed, 10-minute TTL, single use.
- TTL job: delete message texts older than 48 h.
- CORS: allow only origins from `CORS_ORIGINS` env (comma-separated).
- Startup must be idempotent: migrations → setWebhook → ready. Missing env → clear error naming the variable.

## Env vars (server/.env)
```
PORT=8787
PUBLIC_BASE_URL=https://<railway-domain>
DATABASE_PATH=./data/pager.db
CORS_ORIGINS=http://localhost:5173
ENCRYPTION_KEY=<base64 32 bytes>
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=<random>
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
AI_DEFAULT_PROVIDER=gemini
AI_DEFAULT_MODEL=<gemini fast model id>
GEMINI_API_KEY=
DEFAULT_TZ=Asia/Tashkent
```
Plugin config: only `VITE_API_BASE_URL` (public, not a secret).
Environments: Railway `staging` (auto-deploy from main, separate bot + DB) and `production` (manual / release tag only).
Plugin config: only `VITE_API_BASE_URL` (public, not a secret).

## Commands
- Plugin: `cd plugin && npm run dev` → `npx evenhub-simulator http://localhost:5173` → pack: `npx evenhub pack`
- Real glasses: `npx evenhub qr --url http://<LAN-IP>:5173`
- Server: `cd server && npm run dev` (tsx watch) · `npm run db:migrate` · `npm test`
- Local webhook: deploy to Railway early, or tunnel (`cloudflared tunnel --url http://localhost:8787`).

## Definition of done (per feature)
- Works end-to-end with real APIs in the simulator.
- No secrets in client, no message text in logs.
- Lens text fits (≤4 lines, translit applied).
- README updated; `.env.example` updated.
