import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import type { UserFromGetMe } from 'grammy/types'
import type { LlmProvider } from '../src/ai/provider.js'
import { createApp } from '../src/app.js'
import { createBot } from '../src/bot/index.js'
import { buildChannelsView, buildNotesListView, buildSettingsView } from '../src/bot/management.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { channels, devices, googleAccounts, messages, notes, users } from '../src/db/schema.js'
import { encryptSecret, generateDeviceToken, sha256Hex } from '../src/lib/crypto.js'
import {
  parseTelegramPublicChannelHtml,
  syncSingleChannel,
} from '../src/lib/digest-service.js'
import { subscribeUserEvents, type UserEvent } from '../src/lib/events.js'
import type { CalendarEventItem, GoogleCalendarClient } from '../src/lib/google-calendar.js'
import { findRelevantNotes, runTaskAndPromiseReminderTick } from '../src/lib/notes-service.js'
import { parseProposedMeetingTime } from '../src/lib/time-parser.js'
import { createMeetingsRouter } from '../src/routes/meetings.js'
import { createMsgRouter } from '../src/routes/msg.js'
import { createNotesRouter, createPromisesRouter } from '../src/routes/notes.js'
import { Hono } from 'hono'
import { createBearerAuthMiddleware, type AuthEnv } from '../src/middleware/auth.js'

const TEST_BOT_INFO: UserFromGetMe = {
  id: 999002,
  is_bot: true,
  first_name: 'PagerBot',
  username: 'pager_even_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: true,
  has_main_web_app: false,
}

function makeFakeWav(): Buffer {
  const buf = Buffer.alloc(128)
  buf.write('RIFF', 0, 'ascii')
  return buf
}

test('Prompt 4 & 5: voice notes, relevant-note filtering for replies, task reminders, and promise reminders', async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64')
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  try {
    // 2026-11-26 14:52 Asia/Tashkent = 2026-11-26T09:52:00.000Z
    const nowMs = Date.parse('2026-11-26T09:52:00.000Z')

    db.insert(users)
      .values({
        id: 1,
        tgUserId: 1001,
        tgName: 'Owner',
        businessConnectionId: 'bc_p45',
        canReply: true,
        isEnabled: true,
        tz: 'Asia/Tashkent',
        createdAt: nowMs,
      })
      .run()

    const token = generateDeviceToken()
    db.insert(devices)
      .values({ userId: 1, tokenHash: sha256Hex(token), createdAt: nowMs, revokedAt: null })
      .run()

    db.insert(googleAccounts)
      .values({
        userId: 1,
        email: 'owner@example.com',
        refreshTokenEnc: encryptSecret('rt'),
        scope: 'https://www.googleapis.com/auth/calendar.events',
        updatedAt: nowMs,
      })
      .run()

    const mockCal: GoogleCalendarClient = {
      async listBusyIntervals() {
        return []
      },
      async listUpcomingEvents() {
        return [
          {
            id: 'ev_standup',
            summary: 'Standup',
            startMs: nowMs + 8 * 60_000, // 15:00
            endMs: nowMs + 38 * 60_000,
            allDay: false,
          },
        ]
      },
      async createEvent() {
        return { eventId: 'ev_new' }
      },
    }

    let nextStt = 'через 2 минуты напомни выпить воды на Standup'
    const mockProvider: LlmProvider = {
      id: 'gemini',
      model: 'mock',
      async transcribeAudio() {
        return { transcript: nextStt, lang: 'ru' }
      },
      async completeJson(opts) {
        return opts.schema.parse({
          task: 'Скинуть Азизу КП',
          question: 'Напомнить скинуть КП?',
        })
      },
    }

    const app = new Hono<AuthEnv>()
    app.use('/api/*', createBearerAuthMiddleware(db))
    app.route(
      '/api/notes',
      createNotesRouter({
        db,
        calendarClient: mockCal,
        getProvider: () => mockProvider,
        nowProvider: () => nowMs,
      }),
    )
    app.route('/api/promises', createPromisesRouter({ db, nowProvider: () => nowMs }))
    app.route(
      '/api/msg',
      createMsgRouter({
        db,
        sendTelegramMessage: async () => ({ messageId: 555 }),
        getProvider: () => mockProvider,
        nowProvider: () => nowMs,
      }),
    )

    // 1) Transcribe voice note -> detects Standup 15:00 + 2-minute task reminder
    const trRes = await app.request('/api/notes/transcribe', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' },
      body: makeFakeWav(),
    })
    assert.equal(trRes.status, 200)
    const trJson = (await trRes.json()) as {
      transcript: string
      matchedMeeting: { eventId: string; label: string } | null
      taskReminder: { remindAt: number; label: string } | null
    }
    assert.equal(trJson.matchedMeeting?.eventId, 'ev_standup')
    assert.equal(trJson.matchedMeeting?.label, 'Standup 15:00')
    assert.equal(trJson.taskReminder?.remindAt, nowMs + 2 * 60_000)

    // Save task note + price note + unrelated note
    await app.request('/api/notes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Выпить воды',
        remindAt: trJson.taskReminder?.remindAt,
      }),
    })
    await app.request('/api/notes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'прайс: лендинг 300 долларов, сайт 800' }),
    })
    await app.request('/api/notes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'купить корм коту в субботу' }),
    })

    // Relevant note filter picks ONLY price note when client asks price
    const matchedNotes = findRelevantNotes(db, 1, 'Сколько стоит сделать сайт под ключ?')
    assert.equal(matchedNotes.length, 1)
    assert.match(matchedNotes[0]!.text, /сайт 800/)

    // 2) Outgoing reply WITH promise -> returns promiseSuggestion ("Да, сегодня в 19:00", "Напомнить скинуть КП?")
    db.insert(messages)
      .values({
        id: 50,
        userId: 1,
        chatId: 9001,
        tgMessageId: 10,
        fromName: 'Азиз Каримов',
        businessConnectionId: 'bc_p45',
        text: 'Пришли КП по проекту',
        receivedAt: nowMs - 30_000,
        status: 'new',
        aiJson: JSON.stringify({
          priority: 'urgent',
          intent: 'reply',
          gist: 'Пришли КП',
          lang: 'ru',
          drafts: [
            { text: 'Не успею, скину вечером', lens: 'Не успею, скину вечером', slot: null },
            { text: 'Да, хорошо', lens: 'Да, хорошо', slot: null },
          ],
        }),
        expiresAt: nowMs + 86_400_000,
      })
      .run()

    const sendRes = await app.request('/api/msg/50/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftIndex: 0 }),
    })
    assert.equal(sendRes.status, 200)
    const sendJson = (await sendRes.json()) as {
      promiseSuggestion?: {
        promptQuestion: string
        taskText: string
        promisedAtTime: string
        defaultOption: { label: string; remindAt: number }
      }
    }
    assert.ok(sendJson.promiseSuggestion)
    assert.equal(sendJson.promiseSuggestion.promptQuestion, 'Напомнить скинуть КП?')
    assert.equal(sendJson.promiseSuggestion.taskText, 'Скинуть Азизу КП')
    assert.equal(sendJson.promiseSuggestion.promisedAtTime, '14:52')
    assert.equal(sendJson.promiseSuggestion.defaultOption.label, 'Да, сегодня в 19:00')

    // Save promise reminder and run reminder tick at 19:01
    await app.request('/api/promises', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId: 50,
        chatId: 9001,
        contactName: 'Азиз',
        replyText: 'Не успею, скину вечером',
        taskText: 'Скинуть Азизу КП',
        promisedAtTime: '14:52',
        remindAt: sendJson.promiseSuggestion.defaultOption.remindAt,
      }),
    })

    const sseEvents: UserEvent[] = []
    const unsub = subscribeUserEvents(1, (ev) => sseEvents.push(ev))
    const botMessages: string[] = []

    const fired = await runTaskAndPromiseReminderTick({
      db,
      nowMs: Date.parse('2026-11-26T14:01:00.000Z'), // 19:01 Tashkent
      sendBotReminder: async ({ text }) => {
        botMessages.push(text)
      },
    })
    assert.equal(fired, 2) // 1 due task ("Выпить воды") + 1 due promise ("Скинуть Азизу КП")
    assert.ok(botMessages.some((t) => t.includes('Выпить воды')))
    assert.ok(botMessages.some((t) => t.includes('Скинуть Азизу КП') && t.includes('14:52')))
    assert.equal(sseEvents.length, 2)
    unsub()
  } finally {
    sqlite.close()
  }
})

test('Prompt 6 & 7: deterministic busy conflict alert + free slot first draft + voice brief meeting creation', async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 6).toString('base64')
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  try {
    // 2026-11-26 14:00 Asia/Tashkent = 2026-11-26T09:00:00.000Z
    const nowMs = Date.parse('2026-11-26T09:00:00.000Z')

    db.insert(users)
      .values({
        id: 1,
        tgUserId: 1001,
        tgName: 'Owner',
        businessConnectionId: 'bc_p67',
        canReply: true,
        isEnabled: true,
        tz: 'Asia/Tashkent',
        createdAt: nowMs,
      })
      .run()

    const token = generateDeviceToken()
    db.insert(devices)
      .values({ userId: 1, tokenHash: sha256Hex(token), createdAt: nowMs, revokedAt: null })
      .run()

    db.insert(googleAccounts)
      .values({
        userId: 1,
        email: 'owner@example.com',
        refreshTokenEnc: encryptSecret('rt'),
        scope: 'https://www.googleapis.com/auth/calendar.events',
        updatedAt: nowMs,
      })
      .run()

    // Tomorrow 15:00-16:00 Tashkent = 2026-11-27T10:00:00Z..11:00:00Z
    const tomorrowStandup: CalendarEventItem = {
      id: 'ev_tom_standup',
      summary: 'Standup',
      startMs: Date.parse('2026-11-27T10:00:00.000Z'),
      endMs: Date.parse('2026-11-27T11:00:00.000Z'),
      allDay: false,
    }

    const createdEvents: Array<{ summary: string; description?: string; startIso: string }> = []
    const mockCal: GoogleCalendarClient = {
      async listBusyIntervals() {
        return []
      },
      async listUpcomingEvents() {
        return [tomorrowStandup]
      },
      async createEvent(p) {
        createdEvents.push({ summary: p.summary, description: p.description, startIso: p.startIso })
        return { eventId: 'ev_created_brief' }
      },
    }

    const mockProvider: LlmProvider = {
      id: 'gemini',
      model: 'mock',
      async transcribeAudio() {
        return { transcript: 'Показать демо и обсудить сроки', lang: 'ru' }
      },
      async completeJson(opts) {
        // Handles both triage and brief context
        try {
          return opts.schema.parse({
            priority: 'needs_reply',
            intent: 'schedule',
            gist: 'Созвон завтра 15:30',
            lang: 'ru',
            drafts: [{ text: 'Да, давай в 15:30', lens: 'Да, давай в 15:30', slot: null }],
          })
        } catch {
          return opts.schema.parse({ context: 'Дильноза ждёт оценку по редизайну' })
        }
      },
    }

    const ownerAlerts: string[] = []
    const bot = createBot('123456:TEST', {
      db,
      botConfig: { botInfo: TEST_BOT_INFO },
      getProvider: () => mockProvider,
      calendarClient: mockCal,
      sendOwnerAlert: async (_tgId, text) => {
        ownerAlerts.push(text)
      },
      nowProvider: () => nowMs,
    })

    const webhookSecret = 'sec_67'
    const app = createApp({
      db,
      calendarClient: mockCal,
      tg: { bot, webhookSecret },
    })
    app.route(
      '/api/meetings-test',
      createMeetingsRouter({
        db,
        calendarClient: mockCal,
        getProvider: () => mockProvider,
        nowProvider: () => nowMs,
      }),
    )

    // Dilnoza proposes tomorrow 15:30 -> overlaps Standup 15:00-16:00!
    const whRes = await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify({
        update_id: 701,
        business_message: {
          message_id: 88,
          date: Math.floor(nowMs / 1000),
          business_connection_id: 'bc_p67',
          chat: { id: 7701, type: 'private', first_name: 'Дильноза' },
          from: { id: 7701, is_bot: false, first_name: 'Дильноза' },
          text: 'Привет! Созвон завтра в 15:30 по редизайну?',
        },
      }),
    })
    assert.equal(whRes.status, 200)

    // Bot alerted owner about conflict
    assert.equal(ownerAlerts.length, 1)
    assert.match(ownerAlerts[0]!, /Ты занят\. Дильноза предлагает встречу завтра 15:30 — у тебя Standup 15:00–16:00/)

    // Inbox marks hasConflict = true
    const inbRes = await app.request('/api/inbox', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const inb = (await inbRes.json()) as { items: Array<{ id: number; hasConflict: boolean }> }
    assert.equal(inb.items[0]?.hasConflict, true)
    const msgId = inb.items[0]!.id

    // Card shows conflictLine "У тебя Standup 15-16", 1st draft offers free slot 16:00, and proposedMeeting is attached
    const cardRes = await app.request(`/api/msg/${msgId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const card = (await cardRes.json()) as {
      conflictLine?: string
      drafts: Array<{ lens: string }>
      proposedMeeting?: { title: string; isFree: boolean }
    }
    assert.equal(card.conflictLine, 'У тебя Standup 15-16')
    assert.equal(card.drafts[0]?.lens, 'Занят, давай в 16:00?')
    // Crucial: affirmative AI draft "Да, давай в 15:30" MUST be stripped when busy!
    assert.equal(
      card.drafts.some((d) => /да,\s*давай|свобод/iu.test(d.lens)),
      false,
    )
    assert.equal(card.proposedMeeting?.isFree, false)

    // Regression: "15 00" (space) with 14:45-15:45 overlap also strips any "свободен" draft
    const overlapLunch = parseProposedMeetingTime(
      'Ты свободен завтра в 15 00?',
      nowMs,
      'Asia/Tashkent',
    )
    assert.ok(overlapLunch)
    assert.equal(overlapLunch.displayWhen, 'Завтра 15:00-15:30')

    // Voice brief + create meeting saves description into Google Calendar
    const briefApp = new Hono<AuthEnv>()
    briefApp.use('/api/*', createBearerAuthMiddleware(db))
    briefApp.route(
      '/api/meetings',
      createMeetingsRouter({
        db,
        calendarClient: mockCal,
        getProvider: () => mockProvider,
        nowProvider: () => nowMs,
      }),
    )

    const bvRes = await briefApp.request('/api/meetings/brief-voice?chatId=7701', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' },
      body: makeFakeWav(),
    })
    assert.equal(bvRes.status, 200)
    const bv = (await bvRes.json()) as {
      userSaid: string
      aiAdded: string
      combinedDescription: string
    }
    assert.equal(bv.userSaid, 'Показать демо и обсудить сроки')
    assert.equal(bv.aiAdded, 'Дильноза ждёт оценку по редизайну')

    const crRes = await briefApp.request('/api/meetings/create', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Созвон: Дильноза',
        startIso: '2026-11-27T11:00:00.000Z',
        endIso: '2026-11-27T11:30:00.000Z',
        description: bv.combinedDescription,
      }),
    })
    assert.equal(crRes.status, 201)
    assert.equal(createdEvents.length, 1)
    assert.match(createdEvents[0]!.description ?? '', /Показать демо/)
    assert.match(createdEvents[0]!.description ?? '', /Дильноза ждёт оценку/)

    // Lunch time ("во время обеда") resolves to 13:00-14:00
    const lunch = parseProposedMeetingTime(
      'Я свободен ли во время обеда?',
      Date.parse('2026-11-26T05:00:00.000Z'), // 10:00 Tashkent
      'Asia/Tashkent',
    )
    assert.ok(lunch)
    assert.equal(lunch.displayWhen, 'Сегодня 13:00-14:00')
  } finally {
    sqlite.close()
  }
})

test('Prompt 8 & 9: public t.me/s/<channel> digest scraper, 30m rate limit, Home button activation, and Bot views', async () => {
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  try {
    const nowMs = Date.parse('2026-11-26T10:00:00.000Z')
    db.insert(users)
      .values({
        id: 1,
        tgUserId: 1001,
        tgName: 'Owner',
        businessConnectionId: 'bc_p89',
        canReply: true,
        isEnabled: true,
        tz: 'Asia/Tashkent',
        createdAt: nowMs,
      })
      .run()

    const token = generateDeviceToken()
    db.insert(devices)
      .values({ userId: 1, tokenHash: sha256Hex(token), createdAt: nowMs, revokedAt: null })
      .run()

    // Private channel HTML without tgme_channel_info -> isPublic = false
    const priv = parseTelegramPublicChannelHtml('<html><body>Private</body></html>', 'secretchan')
    assert.equal(priv.isPublic, false)

    // Public channel HTML -> parses title & posts
    const sampleHtml = `
      <div class="tgme_channel_info">
        <div class="tgme_channel_info_header_title"><span>Крипто Daily</span></div>
      </div>
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="cryptodaily/101">
          <div class="tgme_widget_message_text">Биткоин обновил максимум выше 98000 долларов на фоне притока в ETF.</div>
          <time datetime="2026-11-26T09:20:00+00:00"></time>
        </div>
      </div>
    `
    const parsed = parseTelegramPublicChannelHtml(sampleHtml, 'cryptodaily')
    assert.equal(parsed.isPublic, true)
    assert.equal(parsed.title, 'Крипто Daily')
    assert.equal(parsed.posts.length, 1)
    assert.equal(parsed.posts[0]?.postId, 101)

    const ins = db
      .insert(channels)
      .values({
        userId: 1,
        username: 'cryptodaily',
        title: 'Крипто Daily',
        lastCheckedAt: null,
        lastPostId: null,
        createdAt: nowMs,
      })
      .run()
    const chRow = db.select().from(channels).where(eq(channels.id, Number(ins.lastInsertRowid))).get()!

    const sync1 = await syncSingleChannel({
      db,
      channelRow: chRow,
      fetchChannel: async () => parsed,
      provider: null,
      nowMs,
    })
    assert.equal(sync1.addedPosts, 1)

    // Immediate re-check within 30 min -> rate-limited
    const updatedChRow = db.select().from(channels).where(eq(channels.id, chRow.id)).get()!
    const sync2 = await syncSingleChannel({
      db,
      channelRow: updatedChRow,
      fetchChannel: async () => parsed,
      provider: null,
      nowMs: nowMs + 5 * 60_000,
    })
    assert.equal(sync2.skippedRateLimit, true)

    // Home now enables Digest button with count = 1, and GET /api/digest returns the post
    let fakeNow = nowMs
    const app = createApp({ db, nowProvider: () => fakeNow })
    const homeRes = await app.request('/api/home', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const homeJson = (await homeRes.json()) as { digest: { enabled: boolean; count: number } }
    assert.equal(homeJson.digest.enabled, true)
    assert.equal(homeJson.digest.count, 1)

    const digListRes = await app.request('/api/digest', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const digList = (await digListRes.json()) as {
      items: Array<{ id: number; channel: string; gist: string; time: string }>
    }
    assert.equal(digList.items.length, 1)
    assert.equal(digList.items[0]?.channel, 'Крипто Daily')
    assert.equal(digList.items[0]?.time, '14:20')

    // Next local day (2026-11-27 00:05 Tashkent): yesterday's digest posts are cleared/hidden
    fakeNow = Date.parse('2026-11-26T19:05:00.000Z')
    const homeNextDay = (await (
      await app.request('/api/home', { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { digest: { enabled: boolean; count: number } }
    assert.equal(homeNextDay.digest.count, 0)
    const digNextDay = (await (
      await app.request('/api/digest', { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { items: unknown[] }
    assert.equal(digNextDay.items.length, 0)

    // Bot management views (/settings, /notes, /channels) include inline buttons
    db.insert(notes)
      .values({
        userId: 1,
        text: 'Тестовая заметка',
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .run()

    const settingsView = buildSettingsView(db, 1)
    assert.match(settingsView.text, /Очки: подключены/)
    assert.ok(settingsView.replyMarkup.inline_keyboard.length >= 3)

    const notesView = buildNotesListView(db, 1)
    assert.match(notesView.text, /1\. Тестовая заметка/)
    assert.equal(notesView.replyMarkup.inline_keyboard[0]?.length, 4)

    const channelsView = buildChannelsView(db, 1)
    assert.match(channelsView.text, /Крипто Daily/)
    assert.ok(channelsView.replyMarkup.inline_keyboard.length >= 2)
  } finally {
    sqlite.close()
  }
})
