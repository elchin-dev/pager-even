import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { generateDeviceToken, sha256Hex } from '../src/lib/crypto.js'
import { actions, devices, messages, users } from '../src/db/schema.js'

function setupMsgApp() {
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  const now = Date.now()
  db.insert(users)
    .values({
      id: 1,
      tgUserId: 1001,
      tgName: 'Owner',
      businessConnectionId: 'bc_msg_1',
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

  const sentCalls: Array<{ chatId: number; text: string; businessConnectionId: string }> = []

  const app = createApp({
    corsOrigins: ['http://localhost:5173'],
    db,
    sendTelegramMessage: async (params) => {
      sentCalls.push(params)
      return { messageId: 777 }
    },
  })

  return { sqlite, db, app, token, sentCalls }
}

test('GET /api/msg/:id returns card with gist and 3 lens drafts, POST /send sends original draft via business_connection', async () => {
  const { sqlite, db, app, token, sentCalls } = setupMsgApp()
  const now = Date.now()

  db.insert(messages)
    .values({
      id: 10,
      userId: 1,
      chatId: 5005,
      tgMessageId: 42,
      fromTgUserId: 5005,
      fromName: 'Азиз Каримов',
      businessConnectionId: 'bc_msg_1',
      text: 'Привет! Пришли КП до 17:00',
      receivedAt: now,
      status: 'new',
      aiJson: JSON.stringify({
        priority: 'urgent',
        intent: 'reply',
        gist: 'Asks for KP by 17:00',
        lang: 'ru',
        drafts: [
          { text: 'Да, пришлю до 17:00', lens: 'Da, prishlyu do 17:00', slot: null },
          { text: 'Можно завтра утром?', lens: 'Mozhno zavtra utrom?', slot: null },
          { text: 'Наберу через 10 минут', lens: 'Naberu cherez 10 min', slot: null },
        ],
      }),
      expiresAt: now + 86_400_000,
    })
    .run()

  const cardRes = await app.request('/api/msg/10', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(cardRes.status, 200)
  const card = (await cardRes.json()) as {
    id: number
    from: string
    priority: string
    gist: string
    drafts: Array<{ index: number; lens: string }>
  }
  assert.equal(card.id, 10)
  assert.equal(card.from, 'Aziz Karimov')
  assert.equal(card.priority, 'urgent')
  assert.equal(card.gist, 'Privet! Prishli KP do 17:00')
  assert.equal(card.drafts.length, 3)
  assert.equal(card.drafts[0]?.lens, 'Da, prishlyu do 17:00')

  const sendRes = await app.request('/api/msg/10/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ draftIndex: 0 }),
  })
  assert.equal(sendRes.status, 200)
  assert.deepEqual(await sendRes.json(), { ok: true, tgMessageId: 777 })

  assert.equal(sentCalls.length, 1)
  assert.equal(sentCalls[0]?.chatId, 5005)
  assert.equal(sentCalls[0]?.text, 'Да, пришлю до 17:00')
  assert.equal(sentCalls[0]?.businessConnectionId, 'bc_msg_1')

  const updated = db.select().from(messages).where(eq(messages.id, 10)).get()
  assert.equal(updated?.status, 'replied')

  // In with_history mode, GET /api/msg/10 includes both incoming message and "You: ..." reply
  await app.request('/api/settings', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chatView: 'with_history' }),
  })
  const historyCardRes = await app.request('/api/msg/10', {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(historyCardRes.status, 200)
  const historyCard = (await historyCardRes.json()) as {
    chatView: string
    gist: string
    fullText: string
    hasMore: boolean
  }
  assert.equal(historyCard.chatView, 'with_history')
  assert.equal(historyCard.gist, 'Privet! Prishli KP do 17:00')
  assert.equal(historyCard.hasMore, true)
  assert.match(historyCard.fullText, /Privet! Prishli KP do 17:00/)
  assert.match(historyCard.fullText, /You: Da, prishlyu do 17:00/)

  const actionRows = db.select().from(actions).all()
  assert.equal(actionRows.length, 1)
  assert.equal(actionRows[0]?.type, 'reply')

  sqlite.close()
})

test('POST /api/msg/:id/skip marks message skipped and removes chat from Inbox', async () => {
  const { sqlite, db, app, token } = setupMsgApp()
  const now = Date.now()

  db.insert(messages)
    .values({
      id: 20,
      userId: 1,
      chatId: 6006,
      tgMessageId: 100,
      fromTgUserId: 6006,
      fromName: 'Mom',
      businessConnectionId: 'bc_msg_1',
      text: 'Call tonight?',
      receivedAt: now,
      status: 'new',
      aiJson: null,
      expiresAt: now + 86_400_000,
    })
    .run()

  const skipRes = await app.request('/api/msg/20/skip', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(skipRes.status, 200)
  assert.deepEqual(await skipRes.json(), { ok: true })

  const row = db.select().from(messages).where(eq(messages.id, 20)).get()
  assert.equal(row?.status, 'skipped')

  const inboxRes = await app.request('/api/inbox', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const inbox = (await inboxRes.json()) as { items: unknown[] }
  assert.equal(inbox.items.length, 0)

  sqlite.close()
})
