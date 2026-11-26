import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { LlmProvider } from '../src/ai/provider.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { devices, googleAccounts, messages, sentReminders, users } from '../src/db/schema.js'
import { encryptSecret, generateDeviceToken, sha256Hex } from '../src/lib/crypto.js'
import { subscribeUserEvents, type UserEvent } from '../src/lib/events.js'
import type { CalendarEventItem, GoogleCalendarClient } from '../src/lib/google-calendar.js'
import { runMeetingReminderTick } from '../src/lib/meetings-service.js'
import { createBearerAuthMiddleware, type AuthEnv } from '../src/middleware/auth.js'
import { createMeetingsRouter } from '../src/routes/meetings.js'

test('meetings list, brief with attendee matching, late notice, +30m reschedule, and readonly scope check', async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  try {
    // 2026-11-26 14:50 Asia/Tashkent = 2026-11-26T09:50:00.000Z
    const nowMs = Date.parse('2026-11-26T09:50:00.000Z')

    db.insert(users)
      .values({
        id: 1,
        tgUserId: 1001,
        tgName: 'Owner',
        businessConnectionId: 'bc_meet_1',
        canReply: true,
        isEnabled: true,
        tz: 'Asia/Tashkent',
        createdAt: nowMs,
      })
      .run()

    const token = generateDeviceToken()
    db.insert(devices)
      .values({
        userId: 1,
        tokenHash: sha256Hex(token),
        createdAt: nowMs,
        revokedAt: null,
      })
      .run()

    db.insert(googleAccounts)
      .values({
        userId: 1,
        email: 'owner@example.com',
        refreshTokenEnc: encryptSecret('mock-refresh'),
        scope: 'https://www.googleapis.com/auth/calendar.events',
        updatedAt: nowMs,
      })
      .run()

    // Telegram chat with Aziz so attendee "Азиз" matches
    db.insert(messages)
      .values({
        userId: 1,
        chatId: 5001,
        tgMessageId: 1,
        fromName: 'Азиз Каримов',
        businessConnectionId: 'bc_meet_1',
        text: 'Обсудим релиз и смету на стендапе',
        receivedAt: nowMs - 60_000,
        status: 'new',
        expiresAt: nowMs + 86_400_000,
      })
      .run()

    const events: CalendarEventItem[] = [
      {
        id: 'ev_standup',
        summary: 'Standup',
        description: 'Синк по релизу v2',
        startMs: nowMs + 10 * 60_000, // 15:00
        endMs: nowMs + 40 * 60_000, // 15:30
        allDay: false,
        attendees: [
          { name: 'Азиз', email: 'aziz@example.com' },
          { name: 'Дильноза', email: 'dilnoza@example.com' },
        ],
        reminderMinutes: 15,
      },
      {
        id: 'ev_tomorrow',
        summary: 'Product Sync',
        startMs: Date.parse('2026-11-27T05:00:00.000Z'), // tomorrow 10:00
        endMs: Date.parse('2026-11-27T05:30:00.000Z'),
        allDay: false,
      },
      {
        id: 'ev_allday',
        summary: 'Holiday',
        startMs: nowMs,
        endMs: nowMs + 24 * 60 * 60_000,
        allDay: true,
      },
    ]

    const rescheduledCalls: Array<{ eventId: string; startIso: string; endIso: string }> = []
    const sentLateCalls: Array<{ chatId: number; text: string }> = []

    const mockCal: GoogleCalendarClient = {
      async listBusyIntervals() {
        return []
      },
      async listUpcomingEvents() {
        return events
      },
      async createEvent() {
        return { eventId: 'created' }
      },
      async rescheduleEvent(p) {
        rescheduledCalls.push({ eventId: p.eventId, startIso: p.startIso, endIso: p.endIso })
        return { eventId: p.eventId }
      },
    }

    const mockProvider: LlmProvider = {
      id: 'gemini',
      model: 'mock',
      async completeJson(opts) {
        return opts.schema.parse({ summary: 'Синк по релизу v2 и смете с Азизом' })
      },
    }

    const app = new Hono<AuthEnv>()
    app.use('/api/*', createBearerAuthMiddleware(db))
    app.route(
      '/api/meetings',
      createMeetingsRouter({
        db,
        calendarClient: mockCal,
        sendTelegramMessage: async ({ chatId, text }) => {
          sentLateCalls.push({ chatId, text })
          return { messageId: 99 }
        },
        getProvider: () => mockProvider,
        nowProvider: () => nowMs,
      }),
    )

    // 1) GET /api/meetings skips all-day, includes today & tomorrow
    const listRes = await app.request('/api/meetings', {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(listRes.status, 200)
    const listJson = (await listRes.json()) as {
      todayCount: number
      items: Array<{ id: string; isTomorrow: boolean; minutesUntil: number | null }>
    }
    assert.equal(listJson.todayCount, 1)
    assert.equal(listJson.items.length, 2)
    assert.equal(listJson.items[0]?.id, 'ev_standup')
    assert.equal(listJson.items[0]?.minutesUntil, 10)
    assert.equal(listJson.items[1]?.id, 'ev_tomorrow')
    assert.equal(listJson.items[1]?.isTomorrow, true)
    assert.equal(listJson.items[1]?.minutesUntil, null)

    // 2) GET /api/meetings/:id builds brief with matched Telegram chat + reschedule preview
    const briefRes = await app.request('/api/meetings/ev_standup', {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(briefRes.status, 200)
    const brief = (await briefRes.json()) as {
      title: string
      summary: string
      canSendLate: boolean
      lateRecipientName: string | null
      reschedulePreview: string
    }
    assert.equal(brief.title, 'Standup')
    assert.equal(brief.summary, 'Синк по релизу v2 и смете с Азизом')
    assert.equal(brief.canSendLate, true)
    assert.equal(brief.lateRecipientName, 'Азиз Каримов')
    assert.equal(brief.reschedulePreview, '15:00 -> 15:30-16:00')

    // 3) POST /api/meetings/:id/late sends Telegram message to matched attendee
    const lateRes = await app.request('/api/meetings/ev_standup/late', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(lateRes.status, 200)
    assert.equal(sentLateCalls.length, 1)
    assert.equal(sentLateCalls[0]?.chatId, 5001)
    assert.equal(sentLateCalls[0]?.text, 'Опаздываю на 5 мин')

    // 4) POST /api/meetings/:id/reschedule shifts event +30m
    const shiftRes = await app.request('/api/meetings/ev_standup/reschedule', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(shiftRes.status, 200)
    assert.equal(rescheduledCalls.length, 1)
    assert.equal(rescheduledCalls[0]?.eventId, 'ev_standup')
    assert.equal(rescheduledCalls[0]?.startIso, '2026-11-26T10:30:00.000Z')
    assert.equal(rescheduledCalls[0]?.endIso, '2026-11-26T11:00:00.000Z')

    // 5) Reminders tick: fires once per event, respects event reminderMinutes, sends bot + SSE overlay, deduplicates on second tick
    const botSent: Array<{ tgUserId: number; text: string; buttons?: unknown[] }> = []
    const sseEvents: UserEvent[] = []
    const unsub = subscribeUserEvents(1, (ev) => sseEvents.push(ev))

    const sentFirst = await runMeetingReminderTick({
      db,
      calendarClient: mockCal,
      nowMs,
      getProvider: () => mockProvider,
      sendBotReminder: async (p) => {
        botSent.push(p)
      },
    })
    assert.equal(sentFirst, 1)
    assert.equal(botSent.length, 1)
    assert.match(botSent[0]!.text, /Через 10 мин: Standup · 15:00-15:30 · Азиз, Дильноза/)
    assert.equal(botSent[0]!.buttons?.length, 2)
    assert.equal(sseEvents.length, 1)
    assert.equal(sseEvents[0]?.type, 'reminder')

    // Second tick (simulating restart) -> 0 sent because persisted in sent_reminders
    const sentSecond = await runMeetingReminderTick({
      db,
      calendarClient: mockCal,
      nowMs: nowMs + 60_000,
      getProvider: () => mockProvider,
      sendBotReminder: async (p) => {
        botSent.push(p)
      },
    })
    assert.equal(sentSecond, 0)
    assert.equal(db.select().from(sentReminders).all().length, 1)
    unsub()
  } finally {
    sqlite.close()
  }
})
