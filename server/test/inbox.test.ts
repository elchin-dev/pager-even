import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { createBot } from '../src/bot/index.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { generateDeviceToken, sha256Hex } from '../src/lib/crypto.js'
import { devices, messages, users } from '../src/db/schema.js'

function setupAppWithUser() {
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  const now = Date.now()
  db.insert(users)
    .values({
      id: 1,
      tgUserId: 1001,
      tgName: 'Owner',
      businessConnectionId: 'bc_inbox_1',
      canReply: true,
      isEnabled: true,
      createdAt: now,
    })
    .run()

  const token = generateDeviceToken()
  db.insert(devices)
    .values({
      userId: 1,
      tokenHash: sha256Hex(token),
      createdAt: now,
      revokedAt: null,
    })
    .run()

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

  const secret = 'test-webhook-secret'
  const app = createApp({
    corsOrigins: ['http://localhost:5173'],
    db,
    tg: { bot, webhookSecret: secret },
  })

  return { sqlite, db, app, token, secret }
}

test('GET /api/inbox groups by chat, filters status=new, sorts received_at desc, limits to 10, and applies toLens', async () => {
  const { sqlite, db, app, token } = setupAppWithUser()
  const now = Date.now()

  // Insert 12 chats: 11 with status=new (chat 101 has 2 new messages), 1 with status=replied
  for (let i = 1; i <= 11; i += 1) {
    db.insert(messages)
      .values({
        userId: 1,
        chatId: 100 + i,
        tgMessageId: i,
        fromTgUserId: 200 + i,
        fromName: i === 11 ? 'Азиз Каримов Старший' : `User ${i}`,
        businessConnectionId: 'bc_inbox_1',
        text: i === 11 ? 'Привет! Пришлите пожалуйста КП до 17:00 сегодня 🔥' : `Msg ${i}`,
        receivedAt: now + i * 1000,
        status: 'new',
        expiresAt: now + 86_400_000,
      })
      .run()
  }

  // Older message in chat 101 -> count should be 2, latest preview kept
  db.insert(messages)
    .values({
      userId: 1,
      chatId: 101,
      tgMessageId: 99,
      fromTgUserId: 201,
      fromName: 'User 1',
      businessConnectionId: 'bc_inbox_1',
      text: 'Older msg 1',
      receivedAt: now + 500,
      status: 'new',
      expiresAt: now + 86_400_000,
    })
    .run()

  // Replied chat -> excluded
  db.insert(messages)
    .values({
      userId: 1,
      chatId: 999,
      tgMessageId: 1,
      fromTgUserId: 999,
      fromName: 'Done',
      businessConnectionId: 'bc_inbox_1',
      text: 'Already replied',
      receivedAt: now + 99_000,
      status: 'replied',
      expiresAt: now + 86_400_000,
    })
    .run()

  const res = await app.request('/api/inbox?mode=all', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    mode: string
    counts: { urgent: number; all: number }
    items: Array<{ id: number; chatId: number; from: string; preview: string; count: number }>
  }

  assert.equal(body.mode, 'all')
  assert.equal(body.counts.all, 11)
  assert.equal(body.counts.urgent, 0)
  assert.equal(body.items.length, 10)
  // Latest chat (111) comes first
  assert.equal(body.items[0]?.chatId, 111)
  assert.ok(body.items[0]!.from.length <= 12)
  assert.equal(body.items[0]?.from, 'Азиз Каримо…')
  assert.ok(body.items[0]!.preview.length <= 40)
  assert.ok(!body.items[0]!.preview.includes('🔥'))

  // Chat 101 was the oldest of the 11 new chats, so with limit 10 it is excluded;
  // verify grouping count on chat 102 when we add another message to chat 102
  db.insert(messages)
    .values({
      userId: 1,
      chatId: 102,
      tgMessageId: 100,
      fromTgUserId: 202,
      fromName: 'User 2',
      businessConnectionId: 'bc_inbox_1',
      text: 'Second msg 2',
      receivedAt: now + 50_000,
      status: 'new',
      expiresAt: now + 86_400_000,
    })
    .run()

  const res2 = await app.request('/api/inbox?mode=all', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body2 = (await res2.json()) as {
    items: Array<{ id: number; chatId: number; from: string; preview: string; count: number }>
  }
  assert.equal(body2.items[0]?.chatId, 102)
  assert.equal(body2.items[0]?.count, 2)
  assert.equal(body2.items[0]?.preview, 'Second msg 2')

  sqlite.close()
})

test('GET /api/stream emits SSE inbox event on new business_message', async () => {
  const { sqlite, app, token, secret } = setupAppWithUser()
  const controller = new AbortController()

  const streamRes = await app.request('/api/stream', {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
  assert.equal(streamRes.status, 200)
  assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/)

  const reader = streamRes.body!.getReader()
  const decoder = new TextDecoder()

  // Read initial ready event
  const first = await reader.read()
  assert.equal(first.done, false)
  assert.match(decoder.decode(first.value), /event: ready/)

  // Trigger incoming business_message via webhook
  const webhookRes = await app.request('/tg/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify({
      update_id: 700,
      business_message: {
        message_id: 55,
        date: 1700001000,
        business_connection_id: 'bc_inbox_1',
        chat: { id: 3003, type: 'private', first_name: 'Dilnoza' },
        from: { id: 3003, is_bot: false, first_name: 'Dilnoza' },
        text: 'Meet tomorrow?',
      },
    }),
  })
  assert.equal(webhookRes.status, 200)

  const second = await reader.read()
  assert.equal(second.done, false)
  const chunk = decoder.decode(second.value)
  assert.match(chunk, /event: inbox/)
  assert.match(chunk, /"chatId":3003/)

  await reader.cancel()
  controller.abort()
  sqlite.close()
})

test('GET/PUT /api/settings and GET /api/inbox?mode=urgent|all filter both feed modes accurately', async () => {
  const { sqlite, db, app, token } = setupAppWithUser()
  const now = Date.now()

  // Default settings
  const settingsRes1 = await app.request('/api/settings', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(settingsRes1.status, 200)
  const settings1 = (await settingsRes1.json()) as {
    feedMode: string
    chatView: string
    voiceEnabled: boolean
    conflictAlerts: boolean
  }
  assert.deepEqual(settings1, {
    feedMode: 'urgent',
    chatView: 'new_only',
    voiceEnabled: true,
    conflictAlerts: true,
  })

  // Invalid settings rejected
  const badSettingsRes = await app.request('/api/settings', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ feedMode: 'unknown' }),
  })
  assert.equal(badSettingsRes.status, 400)

  // 1) ignore message
  db.insert(messages)
    .values({
      userId: 1,
      chatId: 401,
      tgMessageId: 1,
      fromTgUserId: 401,
      fromName: 'Promo Bot',
      businessConnectionId: 'bc_inbox_1',
      text: '50% discount today only!',
      receivedAt: now + 6000,
      status: 'new',
      aiJson: JSON.stringify({
        priority: 'ignore',
        intent: 'info',
        gist: 'Promo spam',
        lang: 'en',
        drafts: [],
      }),
      expiresAt: now + 86_400_000,
    })
    .run()

  // 2) fyi message
  db.insert(messages)
    .values({
      userId: 1,
      chatId: 402,
      tgMessageId: 2,
      fromTgUserId: 402,
      fromName: 'Bob',
      businessConnectionId: 'bc_inbox_1',
      text: 'Ok thanks!',
      receivedAt: now + 5000,
      status: 'new',
      aiJson: JSON.stringify({
        priority: 'fyi',
        intent: 'info',
        gist: 'Says ok thanks',
        lang: 'en',
        drafts: [],
      }),
      expiresAt: now + 86_400_000,
    })
    .run()

  // 3) needs_reply WITHOUT conflict (excluded from urgent, included in all)
  db.insert(messages)
    .values({
      userId: 1,
      chatId: 403,
      tgMessageId: 3,
      fromTgUserId: 403,
      fromName: 'Mom',
      businessConnectionId: 'bc_inbox_1',
      text: 'Call tonight?',
      receivedAt: now + 4000,
      status: 'new',
      aiJson: JSON.stringify({
        priority: 'needs_reply',
        intent: 'reply',
        gist: 'Call tonight?',
        lang: 'en',
        drafts: [{ text: 'Sure', lens: 'Sure', slot: null }],
      }),
      expiresAt: now + 86_400_000,
    })
    .run()

  // 4) urgent WITH drafts (included in urgent)
  db.insert(messages)
    .values({
      userId: 1,
      chatId: 404,
      tgMessageId: 4,
      fromTgUserId: 404,
      fromName: 'Aziz K.',
      businessConnectionId: 'bc_inbox_1',
      text: 'KP by 17:00?',
      receivedAt: now + 3000,
      status: 'new',
      aiJson: JSON.stringify({
        priority: 'urgent',
        intent: 'reply',
        gist: 'Asks for KP by 17:00',
        lang: 'en',
        drafts: [{ text: 'Sending soon', lens: 'Sending soon', slot: null }],
      }),
      expiresAt: now + 86_400_000,
    })
    .run()

  // 5) needs_reply WITH calendar conflict and drafts (included in urgent!)
  db.insert(messages)
    .values({
      userId: 1,
      chatId: 405,
      tgMessageId: 5,
      fromTgUserId: 405,
      fromName: 'Dilnoza',
      businessConnectionId: 'bc_inbox_1',
      text: 'Meet Thu 15:00?',
      receivedAt: now + 2000,
      status: 'new',
      aiJson: JSON.stringify({
        priority: 'needs_reply',
        intent: 'schedule',
        gist: 'Meet Thu 15:00?',
        lang: 'en',
        conflict: {
          title: 'Standup',
          start: '2026-11-26T10:00:00.000Z',
          end: '2026-11-26T11:00:00.000Z',
        },
        drafts: [{ text: 'Busy at 15:00, 17:00?', lens: 'Busy, 17:00 works?', slot: null }],
      }),
      expiresAt: now + 86_400_000,
    })
    .run()

  // 6) urgent WITHOUT drafts (not answerable -> excluded from urgent, included in all)
  db.insert(messages)
    .values({
      userId: 1,
      chatId: 406,
      tgMessageId: 6,
      fromTgUserId: 406,
      fromName: 'Alert Bot',
      businessConnectionId: 'bc_inbox_1',
      text: 'Server CPU 99%',
      receivedAt: now + 1000,
      status: 'new',
      aiJson: JSON.stringify({
        priority: 'urgent',
        intent: 'info',
        gist: 'CPU 99%',
        lang: 'en',
        drafts: [],
      }),
      expiresAt: now + 86_400_000,
    })
    .run()

  // ?mode=urgent filters to urgent/conflict + drafts only
  const urgentRes = await app.request('/api/inbox?mode=urgent', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(urgentRes.status, 200)
  const urgentBody = (await urgentRes.json()) as {
    mode: string
    counts: { urgent: number; all: number }
    items: Array<{
      id: number
      chatId: number
      preview: string
      priority: string
      urgent: boolean
      hasConflict: boolean
    }>
  }

  assert.equal(urgentBody.mode, 'urgent')
  assert.deepEqual(urgentBody.counts, { urgent: 2, all: 6 })
  assert.equal(urgentBody.items.length, 2)
  assert.equal(urgentBody.items[0]?.chatId, 404)
  assert.equal(urgentBody.items[0]?.preview, 'KP by 17:00?')
  assert.equal(urgentBody.items[0]?.urgent, true)
  assert.equal(urgentBody.items[1]?.chatId, 405)
  assert.equal(urgentBody.items[1]?.hasConflict, true)
  assert.equal(urgentBody.items[1]?.urgent, true)

  // Switch user setting to 'all' via PUT /api/settings
  const putRes = await app.request('/api/settings', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ feedMode: 'all', voiceEnabled: false }),
  })
  assert.equal(putRes.status, 200)
  const updatedSettings = (await putRes.json()) as {
    feedMode: string
    chatView: string
    voiceEnabled: boolean
    conflictAlerts: boolean
  }
  assert.deepEqual(updatedSettings, {
    feedMode: 'all',
    chatView: 'new_only',
    voiceEnabled: false,
    conflictAlerts: true,
  })

  // Now GET /api/inbox uses 'all' from user_settings, sorted by received_at desc
  const allRes = await app.request('/api/inbox', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(allRes.status, 200)
  const allBody = (await allRes.json()) as {
    mode: string
    counts: { urgent: number; all: number }
    items: Array<{ chatId: number; urgent: boolean; hasConflict: boolean }>
  }

  assert.equal(allBody.mode, 'all')
  assert.deepEqual(allBody.counts, { urgent: 2, all: 6 })
  // Urgent items appear first, then sorted by received_at desc
  assert.deepEqual(
    allBody.items.map((i) => i.chatId),
    [404, 405, 401, 402, 403, 406],
  )
  assert.equal(allBody.items.find((i) => i.chatId === 404)?.urgent, true)
  assert.equal(allBody.items.find((i) => i.chatId === 405)?.urgent, true)
  assert.equal(allBody.items.find((i) => i.chatId === 403)?.urgent, false)
  assert.equal(allBody.items.find((i) => i.chatId === 401)?.urgent, false)
  assert.equal(allBody.items.find((i) => i.chatId === 406)?.urgent, false)

  // Explicit query param overrides user_settings
  const overrideRes = await app.request('/api/inbox?mode=urgent', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(overrideRes.status, 200)
  const overrideBody = (await overrideRes.json()) as { mode: string; items: unknown[] }
  assert.equal(overrideBody.mode, 'urgent')
  assert.equal(overrideBody.items.length, 2)

  // Multi-message chat: urgent older msg + non-urgent newer msg promotes urgent preview/id in All mode
  db.insert(messages)
    .values([
      {
        userId: 1,
        chatId: 505,
        tgMessageId: 1,
        fromTgUserId: 505,
        fromName: 'Timur',
        businessConnectionId: 'bc_inbox_1',
        text: 'Urgent: send contract now!',
        receivedAt: now + 7000,
        status: 'new',
        aiJson: JSON.stringify({
          priority: 'urgent',
          intent: 'reply',
          gist: 'Send contract',
          lang: 'en',
          drafts: [{ text: 'Sending', lens: 'Sending', slot: null }],
        }),
        expiresAt: now + 86_400_000,
      },
      {
        userId: 1,
        chatId: 505,
        tgMessageId: 2,
        fromTgUserId: 505,
        fromName: 'Timur',
        businessConnectionId: 'bc_inbox_1',
        text: 'btw ok',
        receivedAt: now + 8000,
        status: 'new',
        aiJson: JSON.stringify({
          priority: 'fyi',
          intent: 'info',
          gist: 'Ok',
          lang: 'en',
          drafts: [],
        }),
        expiresAt: now + 86_400_000,
      },
    ])
    .run()

  const multiAllRes = await app.request('/api/inbox?mode=all', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const multiAllBody = (await multiAllRes.json()) as {
    items: Array<{ chatId: number; preview: string; count: number; urgent: boolean }>
  }
  const timur = multiAllBody.items.find((i) => i.chatId === 505)
  assert.ok(timur)
  assert.equal(timur.count, 2)
  assert.equal(timur.urgent, true)
  assert.equal(timur.preview, 'Urgent: send contract now!')

  // Replied chat 606 is hidden after reply
  db.insert(messages)
    .values([
      {
        userId: 1,
        chatId: 606,
        tgMessageId: 1,
        fromTgUserId: 606,
        fromName: 'Sara',
        businessConnectionId: 'bc_inbox_1',
        isFromOwner: false,
        text: 'Hello Sara msg',
        receivedAt: now + 9000,
        status: 'replied',
        expiresAt: now + 86_400_000,
      },
      {
        userId: 1,
        chatId: 606,
        tgMessageId: 2,
        fromTgUserId: 1001,
        fromName: 'Owner',
        businessConnectionId: 'bc_inbox_1',
        isFromOwner: true,
        text: 'Hi Sara!',
        receivedAt: now + 9500,
        status: 'replied',
        expiresAt: now + 86_400_000,
      },
    ])
    .run()

  const newOnlyRes = await app.request('/api/inbox', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const newOnlyBody = (await newOnlyRes.json()) as { items: Array<{ chatId: number }> }
  assert.equal(newOnlyBody.items.some((i) => i.chatId === 606), false)

  sqlite.close()
})
