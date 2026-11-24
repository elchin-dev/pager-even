import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import { createBot } from '../src/bot/index.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { sha256Hex } from '../src/lib/crypto.js'
import { devices, pairCodes } from '../src/db/schema.js'

interface CapturedApiCall {
  method: string
  payload: Record<string, unknown>
}

function createTestHarness() {
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

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
        message_id: 100 + apiCalls.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1001, type: 'private', first_name: 'Owner' },
        text: 'ok',
      },
    } as never)
  })

  const secret = 'test-webhook-secret-123'
  const app = createApp({
    corsOrigins: ['http://localhost:5173'],
    db,
    tg: { bot, webhookSecret: secret },
    pair: { botUsername: 'pager_even_bot' },
  })

  app.get('/api/protected-ping', (c) => {
    const authUser = c.get('authUser')
    return c.json({ ok: true, userId: authUser.id })
  })

  return { sqlite, db, app, apiCalls, secret }
}

test('pairing via /start <code> returns one-time deviceToken, protects /api/*, and /unpair revokes all devices', async () => {
  const { sqlite, db, app, apiCalls, secret } = createTestHarness()

  // Protected /api/* rejects without token
  const unauthRes = await app.request('/api/protected-ping')
  assert.equal(unauthRes.status, 401)
  assert.deepEqual(await unauthRes.json(), { error: 'unauthorized' })

  // 1) Start pairing
  const startRes = await app.request('/api/pair/start', { method: 'POST' })
  assert.equal(startRes.status, 200)
  const started = (await startRes.json()) as {
    pairId: string
    code: string
    botUsername: string
  }
  assert.match(started.code, /^\d{6}$/)
  assert.equal(started.botUsername, 'pager_even_bot')

  // 2) Poll before user claims code -> pending
  const pendingRes = await app.request(`/api/pair/status?pairId=${started.pairId}`)
  assert.equal(pendingRes.status, 200)
  assert.deepEqual(await pendingRes.json(), { status: 'pending' })

  // 3) User opens /start <code> in Telegram
  const tgStartRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify({
      update_id: 201,
      message: {
        message_id: 1,
        date: 1700000100,
        chat: { id: 5001, type: 'private', first_name: 'Elchin' },
        from: { id: 5001, is_bot: false, first_name: 'Elchin' },
        text: `/start ${started.code}`,
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    }),
  })
  assert.equal(tgStartRes.status, 200)
  assert.equal(apiCalls.length, 1)
  assert.match(String(apiCalls[0]?.payload.text), /Glasses connected ✓/)
  assert.match(String(apiCalls[0]?.payload.text), /Автоматизация чатов/)

  // 4) First status poll -> paired + deviceToken
  const pairedRes = await app.request(`/api/pair/status?pairId=${started.pairId}`)
  assert.equal(pairedRes.status, 200)
  const pairedBody = (await pairedRes.json()) as {
    status: string
    deviceToken?: string
  }
  assert.equal(pairedBody.status, 'paired')
  assert.ok(pairedBody.deviceToken && pairedBody.deviceToken.length >= 40)

  // Verify DB stores only SHA-256 hash, not raw token
  const deviceRows = db.select().from(devices).all()
  assert.equal(deviceRows.length, 1)
  assert.equal(deviceRows[0]?.tokenHash, sha256Hex(pairedBody.deviceToken!))
  assert.notEqual(deviceRows[0]?.tokenHash, pairedBody.deviceToken)

  // 5) Second status poll -> expired (one-time delivery)
  const replayRes = await app.request(`/api/pair/status?pairId=${started.pairId}`)
  assert.equal(replayRes.status, 200)
  assert.deepEqual(await replayRes.json(), { status: 'expired' })

  // 6) Protected /api/* accepts valid Bearer token
  const okProtected = await app.request('/api/protected-ping', {
    headers: { Authorization: `Bearer ${pairedBody.deviceToken}` },
  })
  assert.equal(okProtected.status, 200)
  assert.deepEqual(await okProtected.json(), { ok: true, userId: 1 })

  // 7) /unpair revokes all devices for user
  const unpairRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify({
      update_id: 202,
      message: {
        message_id: 2,
        date: 1700000120,
        chat: { id: 5001, type: 'private', first_name: 'Elchin' },
        from: { id: 5001, is_bot: false, first_name: 'Elchin' },
        text: '/unpair',
        entities: [{ offset: 0, length: 7, type: 'bot_command' }],
      },
    }),
  })
  assert.equal(unpairRes.status, 200)

  // 8) Old token is now rejected
  const revokedProtected = await app.request('/api/protected-ping', {
    headers: { Authorization: `Bearer ${pairedBody.deviceToken}` },
  })
  assert.equal(revokedProtected.status, 401)

  sqlite.close()
})

test('pairing via plain 6-digit message skips business instructions when business_connection is already enabled', async () => {
  const { sqlite, db, app, apiCalls, secret } = createTestHarness()

  // Simulate existing enabled business connection
  await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify({
      update_id: 301,
      business_connection: {
        id: 'bc_ready_1',
        user: { id: 6001, is_bot: false, first_name: 'Aziz' },
        user_chat_id: 6001,
        date: 1700000200,
        rights: { can_reply: true },
        is_enabled: true,
      },
    }),
  })

  const startRes = await app.request('/api/pair/start', { method: 'POST' })
  const started = (await startRes.json()) as { pairId: string; code: string }

  const msgRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify({
      update_id: 302,
      message: {
        message_id: 10,
        date: 1700000210,
        chat: { id: 6001, type: 'private', first_name: 'Aziz' },
        from: { id: 6001, is_bot: false, first_name: 'Aziz' },
        text: started.code,
      },
    }),
  })
  assert.equal(msgRes.status, 200)
  assert.equal(apiCalls.length, 1)
  assert.equal(apiCalls[0]?.payload.text, 'Glasses connected ✓')

  const statusRes = await app.request(`/api/pair/status?pairId=${started.pairId}`)
  const statusBody = (await statusRes.json()) as { status: string; deviceToken?: string }
  assert.equal(statusBody.status, 'paired')
  assert.ok(statusBody.deviceToken)

  // Expired pair code returns expired
  const expiredStart = await app.request('/api/pair/start', { method: 'POST' })
  const expiredBody = (await expiredStart.json()) as { pairId: string }
  db.update(pairCodes)
    .set({ expiresAt: Date.now() - 1000 })
    .where(eq(pairCodes.pairId, expiredBody.pairId))
    .run()

  const expiredStatus = await app.request(`/api/pair/status?pairId=${expiredBody.pairId}`)
  assert.deepEqual(await expiredStatus.json(), { status: 'expired' })

  sqlite.close()
})
