import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import type { LlmProvider } from '../src/ai/provider.js'
import { createApp } from '../src/app.js'
import { createBot } from '../src/bot/index.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { actions, devices, googleAccounts, messages, users } from '../src/db/schema.js'
import { decryptSecret, encryptSecret, generateDeviceToken, sha256Hex } from '../src/lib/crypto.js'
import { computeFreeSlots, type GoogleCalendarClient } from '../src/lib/google-calendar.js'

const TEST_ENC_KEY = randomBytes(32).toString('base64')

test('encryptSecret and decryptSecret round-trip with AES-256-GCM and reject tampering', () => {
  const prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = TEST_ENC_KEY
  try {
    const enc = encryptSecret('1//0g_secret_refresh_token')
    assert.ok(enc.startsWith('v1:'))
    assert.equal(decryptSecret(enc), '1//0g_secret_refresh_token')

    const tampered = `${enc.slice(0, -2)}AA`
    assert.throws(() => decryptSecret(tampered))
  } finally {
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prevKey
  }
})

test('computeFreeSlots skips busy intervals and respects working hours', () => {
  // 2026-11-24T09:10:00Z -> next hour is 10:00Z, which is >= 30 min away
  const nowMs = Date.parse('2026-11-24T09:10:00.000Z')
  const busyIntervals = [
    {
      startMs: Date.parse('2026-11-24T10:00:00.000Z'),
      endMs: Date.parse('2026-11-24T11:30:00.000Z'),
    },
  ]

  const slots = computeFreeSlots({
    busyIntervals,
    nowMs,
    tz: 'UTC',
    days: 3,
    workStartHour: 10,
    workEndHour: 18,
    limit: 3,
  })

  assert.equal(slots.length, 3)
  assert.equal(slots[0].label, 'Today 12:00')
  assert.equal(slots[1].label, 'Today 13:00')
  assert.equal(slots[2].label, 'Today 14:00')

  // Verify Asia/Tashkent (UTC+5): 13:10 Tashkent = 08:10 UTC -> Today 14:00 Tashkent = 09:00 UTC
  const tashkentSlots = computeFreeSlots({
    busyIntervals: [],
    nowMs: Date.parse('2026-11-24T08:10:00.000Z'),
    tz: 'Asia/Tashkent',
    days: 3,
    workStartHour: 10,
    workEndHour: 18,
    limit: 1,
  })
  assert.equal(tashkentSlots[0]?.label, 'Today 14:00')
  assert.equal(tashkentSlots[0]?.startIso, '2026-11-24T09:00:00.000Z')
})

test('/google command -> one-time /auth/google/start -> /callback encrypts refresh token', async () => {
  const prevKey = process.env.ENCRYPTION_KEY
  const prevBase = process.env.PUBLIC_BASE_URL
  process.env.ENCRYPTION_KEY = TEST_ENC_KEY
  process.env.PUBLIC_BASE_URL = 'https://pager.example.com'

  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  try {
    const botReplies: string[] = []
    const bot = createBot('123:test-token', {
      db,
      botConfig: {
        botInfo: {
          id: 999999,
          is_bot: true,
          first_name: 'PagerBot',
          username: 'pager_even_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
          can_connect_to_business: true,
          has_main_web_app: false,
        },
        client: {
          fetch: (async (url: string | URL, init?: RequestInit) => {
            const target = String(url)
            if (target.endsWith('/sendMessage') && init?.body) {
              const payload = JSON.parse(String(init.body)) as { text?: string }
              if (payload.text) botReplies.push(payload.text)
            }
            return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }) as typeof fetch,
        },
      },
    })

    const app = createApp({
      db,
      tg: { bot, webhookSecret: 'sec_123' },
      googleAuth: {
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
        publicBaseUrl: 'https://pager.example.com',
        exchangeCode: async () => ({
          accessToken: 'ya29.access',
          refreshToken: '1//refresh-xyz',
          scope: 'https://www.googleapis.com/auth/calendar.events',
        }),
        fetchEmail: async () => 'owner@example.com',
        fetchTimeZone: async () => 'Asia/Tashkent',
      },
    })

    const webhookRes = await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'sec_123',
      },
      body: JSON.stringify({
        update_id: 901,
        message: {
          message_id: 1,
          date: 1700000000,
          chat: { id: 1001, type: 'private' },
          from: { id: 1001, is_bot: false, first_name: 'Owner' },
          text: '/google',
          entities: [{ offset: 0, length: 7, type: 'bot_command' }],
        },
      }),
    })
    assert.equal(webhookRes.status, 200)
    assert.equal(botReplies.length, 1)

    const match = botReplies[0].match(/https:\/\/pager\.example\.com(\/auth\/google\/start\?t=[^\s]+)/)
    assert.ok(match, 'bot reply should contain one-time /auth/google/start link')
    const startPath = match[1]

    const startRes = await app.request(startPath)
    assert.equal(startRes.status, 302)
    const location = startRes.headers.get('location')
    assert.ok(location?.startsWith('https://accounts.google.com/o/oauth2/v2/auth'))
    const state = new URL(location).searchParams.get('state')
    assert.ok(state)

    const cbRes = await app.request(`/auth/google/callback?code=auth_code_1&state=${encodeURIComponent(state)}`)
    assert.equal(cbRes.status, 200)
    const html = await cbRes.text()
    assert.match(html, /Google Calendar connected/)

    // One-time token and state cannot be reused after callback completes
    const reuseStartRes = await app.request(startPath)
    assert.equal(reuseStartRes.status, 400)
    const cbReuseRes = await app.request(`/auth/google/callback?code=auth_code_1&state=${encodeURIComponent(state)}`)
    assert.equal(cbReuseRes.status, 400)

    const acc = db.select().from(googleAccounts).where(eq(googleAccounts.userId, 1)).get()
    assert.ok(acc)
    assert.equal(acc.email, 'owner@example.com')
    assert.notEqual(acc.refreshTokenEnc, '1//refresh-xyz')
    assert.equal(decryptSecret(acc.refreshTokenEnc), '1//refresh-xyz')
  } finally {
    sqlite.close()
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prevKey
    if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL
    else process.env.PUBLIC_BASE_URL = prevBase
  }
})

test('schedule intent includes slots with +cal and POST /api/msg/:id/send creates Calendar event', async () => {
  const prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = TEST_ENC_KEY

  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  try {
    const now = Date.now()
    db.insert(users)
      .values({
        id: 1,
        tgUserId: 1001,
        tgName: 'Owner',
        businessConnectionId: 'bc_cal_1',
        canReply: true,
        isEnabled: true,
        tz: 'UTC',
        createdAt: now,
      })
      .run()

    const deviceToken = generateDeviceToken()
    db.insert(devices)
      .values({
        userId: 1,
        tokenHash: sha256Hex(deviceToken),
        createdAt: now,
        revokedAt: null,
      })
      .run()

    db.insert(googleAccounts)
      .values({
        userId: 1,
        email: 'owner@example.com',
        refreshTokenEnc: encryptSecret('1//refresh-cal'),
        scope: 'https://www.googleapis.com/auth/calendar.events',
        updatedAt: now,
      })
      .run()

    const createdEvents: Array<{ summary: string; startIso: string; endIso: string }> = []
    const sentReplies: Array<{ chatId: number; text: string }> = []

    const mockCalendar: GoogleCalendarClient = {
      async listBusyIntervals() {
        return []
      },
      async createEvent({ summary, startIso, endIso }) {
        createdEvents.push({ summary, startIso, endIso })
        return { eventId: 'gcal_evt_42' }
      },
    }

    const mockProvider: LlmProvider = {
      id: 'gemini',
      async completeJson({ user }) {
        const slotMatch = user.match(/\(([^)]+Z)\)/)
        const slotIso = slotMatch?.[1] ?? new Date(Date.now() + 3600_000).toISOString()
        return {
          priority: 'needs_reply',
          intent: 'schedule',
          gist: 'Wants to meet tomorrow',
          lang: 'en',
          drafts: [
            { text: 'Tomorrow 15:00 works for me', lens: 'Tomorrow 15:00 works', slot: slotIso },
            { text: 'Let me check my schedule', lens: 'Check schedule', slot: null },
            { text: 'Can we talk next week?', lens: 'Next week?', slot: null },
          ],
        } as never
      },
    }

    const bot = createBot('123:test-token', {
      db,
      getProvider: () => mockProvider,
      calendarClient: mockCalendar,
      botConfig: {
        botInfo: {
          id: 999999,
          is_bot: true,
          first_name: 'PagerBot',
          username: 'pager_even_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
          can_connect_to_business: true,
          has_main_web_app: false,
        },
      },
    })

    const app = createApp({
      db,
      tg: { bot, webhookSecret: 'sec_123' },
      calendarClient: mockCalendar,
      sendTelegramMessage: async ({ chatId, text }) => {
        sentReplies.push({ chatId, text })
        return { messageId: 888 }
      },
    })

    const hookRes = await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'sec_123',
      },
      body: JSON.stringify({
        update_id: 902,
        business_message: {
          message_id: 77,
          date: Math.floor(now / 1000),
          business_connection_id: 'bc_cal_1',
          chat: { id: 6060, type: 'private' },
          from: { id: 6060, is_bot: false, first_name: 'Dilnoza' },
          text: 'Can we meet tomorrow?',
        },
      }),
    })
    assert.equal(hookRes.status, 200)

    const stored = db.select().from(messages).where(eq(messages.chatId, 6060)).get()
    assert.ok(stored)

    const cardRes = await app.request(`/api/msg/${stored.id}`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    assert.equal(cardRes.status, 200)
    const card = (await cardRes.json()) as {
      intent: string
      drafts: Array<{ index: number; lens: string; slot: string | null; hasCal: boolean }>
    }
    assert.equal(card.intent, 'schedule')
    assert.equal(card.drafts[0].hasCal, true)
    assert.ok(card.drafts[0].lens.endsWith('+cal'))
    assert.equal(card.drafts[1].hasCal, false)

    const sendRes = await app.request(`/api/msg/${stored.id}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ draftIndex: 0 }),
    })
    assert.equal(sendRes.status, 200)
    const sendJson = (await sendRes.json()) as {
      ok: boolean
      tgMessageId: number
      eventCreated?: boolean
      eventId?: string
    }
    assert.equal(sendJson.ok, true)
    assert.equal(sendJson.tgMessageId, 888)
    assert.equal(sendJson.eventCreated, true)
    assert.equal(sendJson.eventId, 'gcal_evt_42')

    assert.equal(sentReplies.length, 1)
    assert.equal(sentReplies[0].text, 'Tomorrow 15:00 works for me')
    assert.equal(createdEvents.length, 1)
    assert.equal(createdEvents[0].summary, 'Meeting: Dilnoza')

    const eventActions = db
      .select()
      .from(actions)
      .where(eq(actions.messageId, stored.id))
      .all()
      .filter((a) => a.type === 'event')
    assert.equal(eventActions.length, 1)
  } finally {
    sqlite.close()
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prevKey
  }
})
