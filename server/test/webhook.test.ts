import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import { createBot } from '../src/bot/index.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { messages, users } from '../src/db/schema.js'

interface CapturedApiCall {
  method: string
  payload: Record<string, unknown>
}

test('migrations create all 8 tables and webhook handles start, business_connection, business_message, and ping/pong', async () => {
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  const tableRows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name")
    .all() as Array<{ name: string }>

  assert.deepEqual(
    tableRows.map((r) => r.name),
    [
      'actions',
      'ai_settings',
      'devices',
      'google_accounts',
      'link_tokens',
      'messages',
      'pair_codes',
      'sent_reminders',
      'user_settings',
      'users',
    ],
  )

  const apiCalls: CapturedApiCall[] = []
  const bot = createBot('123456:TEST_TOKEN_DO_NOT_USE', {
    db,
    botConfig: {
      botInfo: {
        id: 123456,
        is_bot: true,
        first_name: 'Pager',
        username: 'pager_even_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: true,
        has_main_web_app: false,
      },
    },
  })

  bot.api.config.use((_prev, method, payload) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> })
    return Promise.resolve({
      ok: true,
      result: {
        message_id: 999,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 2002, type: 'private', first_name: 'Aziz' },
        text: 'pong',
      },
    } as never)
  })

  const secret = 'test-webhook-secret-123'
  const app = createApp({
    corsOrigins: ['http://localhost:5173'],
    tg: { bot, webhookSecret: secret, db },
  })

  // 1) Unauthorized without/wrong header
  const unauthRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 1 }),
  })
  assert.equal(unauthRes.status, 401)
  assert.deepEqual(await unauthRes.json(), { error: 'unauthorized' })

  const wrongRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
    },
    body: JSON.stringify({ update_id: 1 }),
  })
  assert.equal(wrongRes.status, 401)

  // 2) /start command
  const startRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify({
      update_id: 10,
      message: {
        message_id: 1,
        date: 1700000000,
        chat: { id: 1001, type: 'private', first_name: 'Owner' },
        from: { id: 1001, is_bot: false, first_name: 'Owner' },
        text: '/start',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    }),
  })
  assert.equal(startRes.status, 200)
  assert.equal(apiCalls.length, 1)
  assert.equal(apiCalls[0]?.method, 'sendMessage')
  assert.match(String(apiCalls[0]?.payload.text), /Автоматизация чатов → @pager_even_bot/)
  assert.match(String(apiCalls[0]?.payload.text), /Telegram Business → Chatbots/)

  // 3) business_connection upsert
  const connRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify({
      update_id: 11,
      business_connection: {
        id: 'bc_abc123',
        user: { id: 1001, is_bot: false, first_name: 'Owner', username: 'owner_u' },
        user_chat_id: 1001,
        date: 1700000010,
        rights: { can_reply: true },
        is_enabled: true,
      },
    }),
  })
  assert.equal(connRes.status, 200)

  const ownerRow = db.select().from(users).where(eq(users.tgUserId, 1001)).get()
  assert.ok(ownerRow)
  assert.equal(ownerRow.businessConnectionId, 'bc_abc123')
  assert.equal(ownerRow.canReply, true)
  assert.equal(ownerRow.isEnabled, true)

  // 4) business_message FROM owner -> NOT saved
  const ownerMsgRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify({
      update_id: 12,
      business_message: {
        message_id: 50,
        date: 1700000020,
        business_connection_id: 'bc_abc123',
        chat: { id: 2002, type: 'private', first_name: 'Aziz' },
        from: { id: 1001, is_bot: false, first_name: 'Owner' },
        text: 'ping',
      },
    }),
  })
  assert.equal(ownerMsgRes.status, 200)
  assert.equal(db.select().from(messages).all().length, 0)
  assert.equal(apiCalls.length, 1)

  // 5) business_message FROM peer ("ping") -> saved (status=new, +48h) AND replies "pong" with business_connection_id
  const before = Date.now()
  const peerMsgRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify({
      update_id: 13,
      business_message: {
        message_id: 51,
        date: 1700000030,
        business_connection_id: 'bc_abc123',
        chat: { id: 2002, type: 'private', first_name: 'Aziz' },
        from: { id: 2002, is_bot: false, first_name: 'Aziz', last_name: 'K.' },
        text: 'ping',
      },
    }),
  })
  assert.equal(peerMsgRes.status, 200)

  const stored = db.select().from(messages).all()
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.status, 'new')
  assert.equal(stored[0]?.fromName, 'Aziz K.')
  assert.equal(stored[0]?.chatId, 2002)
  assert.ok(
    stored[0]!.expiresAt >= before + 48 * 60 * 60 * 1000 - 1000 &&
      stored[0]!.expiresAt <= Date.now() + 48 * 60 * 60 * 1000 + 1000,
  )

  assert.equal(apiCalls.length, 2)
  assert.equal(apiCalls[1]?.method, 'sendMessage')
  assert.equal(apiCalls[1]?.payload.chat_id, 2002)
  assert.equal(apiCalls[1]?.payload.text, 'pong')
  assert.equal(apiCalls[1]?.payload.business_connection_id, 'bc_abc123')

  sqlite.close()
})
