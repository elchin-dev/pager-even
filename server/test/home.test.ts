import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { devices, googleAccounts, messages, users } from '../src/db/schema.js'
import { encryptSecret, generateDeviceToken, sha256Hex } from '../src/lib/crypto.js'
import type { CalendarEventItem, GoogleCalendarClient } from '../src/lib/google-calendar.js'
import { createHomeRouter, type HomeResponse } from '../src/routes/home.js'
import { Hono } from 'hono'
import { createBearerAuthMiddleware, type AuthEnv } from '../src/middleware/auth.js'

test('GET /api/home returns time, nearest meeting (<60m vs >=60m vs none), top 3 senders newest-first, and counts', async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  try {
    // 2026-11-26 14:50 Asia/Tashkent (UTC+5) = 2026-11-26T09:50:00.000Z
    const nowMs = Date.parse('2026-11-26T09:50:00.000Z')

    db.insert(users)
      .values({
        id: 1,
        tgUserId: 1001,
        tgName: 'Owner',
        businessConnectionId: 'bc_home_1',
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
        refreshTokenEnc: encryptSecret('mock-refresh-token'),
        scope: 'calendar',
        updatedAt: nowMs,
      })
      .run()

    // Insert 6 unread messages across 4 chats: Aziz (3, newest), Dilnoza (2), Mama (1), Old (1)
    const urgentAi = JSON.stringify({
      priority: 'urgent',
      intent: 'reply',
      gist: 'Срочно',
      lang: 'ru',
      drafts: [{ text: 'Да', lens: 'Да', slot: null }],
    })
    const normalAi = JSON.stringify({
      priority: 'needs_reply',
      intent: 'reply',
      gist: 'Ок',
      lang: 'ru',
      drafts: [{ text: 'Ок', lens: 'Ок', slot: null }],
    })

    db.insert(messages)
      .values([
        {
          userId: 1,
          chatId: 400,
          tgMessageId: 1,
          fromName: 'Олег',
          text: 'Старое',
          receivedAt: nowMs - 40_000,
          status: 'new',
          aiJson: normalAi,
          expiresAt: nowMs + 86_400_000,
        },
        {
          userId: 1,
          chatId: 300,
          tgMessageId: 2,
          fromName: 'Мама',
          text: 'Позвони',
          receivedAt: nowMs - 30_000,
          status: 'new',
          aiJson: normalAi,
          expiresAt: nowMs + 86_400_000,
        },
        {
          userId: 1,
          chatId: 200,
          tgMessageId: 3,
          fromName: 'Дильноза',
          text: 'Привет 1',
          receivedAt: nowMs - 25_000,
          status: 'new',
          aiJson: normalAi,
          expiresAt: nowMs + 86_400_000,
        },
        {
          userId: 1,
          chatId: 200,
          tgMessageId: 4,
          fromName: 'Дильноза',
          text: 'Привет 2',
          receivedAt: nowMs - 20_000,
          status: 'new',
          aiJson: normalAi,
          expiresAt: nowMs + 86_400_000,
        },
        {
          userId: 1,
          chatId: 100,
          tgMessageId: 5,
          fromName: 'Азиз Каримов',
          text: 'Срочно 1',
          receivedAt: nowMs - 15_000,
          status: 'new',
          aiJson: urgentAi,
          expiresAt: nowMs + 86_400_000,
        },
        {
          userId: 1,
          chatId: 100,
          tgMessageId: 6,
          fromName: 'Азиз Каримов',
          text: 'Срочно 2',
          receivedAt: nowMs - 10_000,
          status: 'new',
          aiJson: normalAi,
          expiresAt: nowMs + 86_400_000,
        },
        {
          userId: 1,
          chatId: 100,
          tgMessageId: 7,
          fromName: 'Азиз Каримов',
          text: 'Срочно 3',
          receivedAt: nowMs - 5_000,
          status: 'new',
          aiJson: normalAi,
          expiresAt: nowMs + 86_400_000,
        },
      ])
      .run()

    let mockEvents: CalendarEventItem[] = [
      {
        id: 'ev1',
        summary: 'Standup',
        startMs: nowMs + 10 * 60_000, // 15:00 (in 10 min)
        endMs: nowMs + 40 * 60_000,
        allDay: false,
      },
      {
        id: 'ev2',
        summary: 'Design Review',
        startMs: nowMs + 130 * 60_000, // 17:00
        endMs: nowMs + 160 * 60_000,
        allDay: false,
      },
    ]

    const mockCal: GoogleCalendarClient = {
      async listBusyIntervals() {
        return []
      },
      async listUpcomingEvents() {
        return mockEvents
      },
      async createEvent() {
        return { eventId: 'evt_1' }
      },
    }

    const app = new Hono<AuthEnv>()
    app.use('/api/*', createBearerAuthMiddleware(db))
    app.route('/api/home', createHomeRouter({ db, calendarClient: mockCal, nowProvider: () => nowMs }))

    // Case 1: Meeting in 10 min (< 60 min) + unread messages
    const res1 = await app.request('/api/home', {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res1.status, 200)
    const home1 = (await res1.json()) as HomeResponse
    assert.equal(home1.nowTime, '14:50')
    assert.equal(home1.headerMeeting, 'Standup через 10 мин')
    assert.equal(home1.messages.total, 7)
    assert.equal(home1.messages.urgent, 1)
    assert.deepEqual(home1.messages.senders, [
      { chatId: 100, name: 'Азиз', count: 3 },
      { chatId: 200, name: 'Дильноза', count: 2 },
      { chatId: 300, name: 'Мама', count: 1 },
    ])
    assert.equal(home1.meetings.todayCount, 2)
    assert.equal(home1.meetings.items[0]?.minutesUntil, 10)
    assert.equal(home1.meetings.items[1]?.minutesUntil, null)
    assert.equal(home1.digest.enabled, false)

    // Case 2: Meeting later than 60 min -> shows "Standup 16:30" (no "через N мин")
    mockEvents = [
      {
        id: 'ev3',
        summary: 'Standup',
        startMs: nowMs + 100 * 60_000, // 16:30
        endMs: nowMs + 130 * 60_000,
        allDay: false,
      },
    ]
    const res2 = await app.request('/api/home', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const home2 = (await res2.json()) as HomeResponse
    assert.equal(home2.headerMeeting, 'Standup 16:30')

    // Case 3: No meetings today, next meeting tomorrow at 10:00
    mockEvents = [
      {
        id: 'ev4',
        summary: 'Sync',
        startMs: Date.parse('2026-11-27T05:00:00.000Z'), // 2026-11-27 10:00 Tashkent
        endMs: Date.parse('2026-11-27T05:30:00.000Z'),
        allDay: false,
      },
    ]
    const res3 = await app.request('/api/home', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const home3 = (await res3.json()) as HomeResponse
    assert.equal(home3.headerMeeting, 'встреч нет')
    assert.equal(home3.nextMeetingLine, 'след. встреча завтра 10:00')
    assert.equal(home3.meetings.todayCount, 0)

    // Also verify route is wired in createApp()
    const fullApp = createApp({ db, calendarClient: mockCal })
    const res4 = await fullApp.request('/api/home', {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res4.status, 200)
  } finally {
    sqlite.close()
  }
})
