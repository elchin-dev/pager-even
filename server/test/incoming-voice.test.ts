import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import type { UserFromGetMe } from 'grammy/types'
import { paginateLensText } from '../../plugin/src/lib/paginate.js'
import { createGeminiProvider, type LlmProvider } from '../src/ai/provider.js'
import { createApp } from '../src/app.js'
import { createBot } from '../src/bot/index.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { devices, messages, users } from '../src/db/schema.js'
import { generateDeviceToken, sha256Hex } from '../src/lib/crypto.js'
import { subscribeUserEvents } from '../src/lib/events.js'

const TEST_BOT_INFO: UserFromGetMe = {
  id: 999001,
  is_bot: true,
  first_name: 'PagerBot',
  username: 'pager_even_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: true,
  has_main_web_app: false,
}

function waitForInboxSse(userId: number, timeoutMs = 2000): Promise<{ messageId?: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error('Timed out waiting for SSE inbox event'))
    }, timeoutMs)
    const unsub = subscribeUserEvents(userId, (evt) => {
      if (evt.type === 'inbox') {
        clearTimeout(timer)
        unsub()
        resolve({ messageId: evt.messageId })
      }
    })
  })
}

test('paginateLensText splits transcript into ~180-char lens pages on word boundaries', () => {
  assert.deepEqual(paginateLensText('Short voice note'), ['Short voice note'])

  const longTranscript = [
    'Привет! Слушай, мы только что закончили встречу с командой дизайна и обсудили дедлайн по релизу.',
    'Клиент просит перенести наш сегодняшний созвон с 15:00 на 17:00 по Ташкенту, потому что у них затянулось ревью.',
    'Подскажи, пожалуйста, сможешь ли ты подключиться в пять вечера или лучше перенести уже на завтрашнее утро?',
    'Если завтра утром тебе удобнее, напиши слот с 10:00 до 12:00, и я сразу подтвержу встречу в общем чате с клиентом.',
  ].join(' ')

  const pages = paginateLensText(longTranscript, 180)
  assert.equal(pages.length, 3)
  for (const page of pages) {
    assert.ok(page.length > 0 && page.length <= 180, `page exceeded 180 chars: ${page.length}`)
  }
  assert.equal(pages.join(' '), longTranscript)

  const unbroken = 'A'.repeat(400)
  const hardPages = paginateLensText(unbroken, 180)
  assert.equal(hardPages.length, 3)
  assert.equal(hardPages[0]?.length, 180)
  assert.equal(hardPages[1]?.length, 180)
  assert.equal(hardPages[2]?.length, 40)
})

test('createGeminiProvider.transcribeAudio sends inline audio, retries 503 once, and parses zod result', async () => {
  let calls = 0
  let capturedBody = ''

  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    model: 'gemini-3.5-flash-lite',
    fetchImpl: async (_input, init) => {
      calls += 1
      capturedBody = String(init?.body ?? '')
      if (calls === 1) {
        return new Response('unavailable', { status: 503 })
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"transcript":"Move call to 17:00 please?","lang":"en"}' }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })

  assert.ok(provider.transcribeAudio)
  const sampleWav = Buffer.from('RIFF-fake-wav-bytes')
  const res = await provider.transcribeAudio(sampleWav, 'audio/wav')
  assert.equal(calls, 2)
  assert.equal(res.transcript, 'Move call to 17:00 please?')
  assert.equal(res.lang, 'en')

  const parsedPayload = JSON.parse(capturedBody) as {
    contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>
  }
  const inlinePart = parsedPayload.contents[0]?.parts[0]?.inlineData
  assert.equal(inlinePart?.mimeType, 'audio/wav')
  assert.equal(inlinePart?.data, sampleWav.toString('base64'))
})

test('incoming voice, video_note, transcription failure, and tooLong media flow end-to-end', async () => {
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  try {
    const now = Date.now()
    db.insert(users)
      .values({
        id: 1,
        tgUserId: 1001,
        tgName: 'Owner',
        businessConnectionId: 'bc_in_voice',
        canReply: true,
        isEnabled: true,
        tz: 'Asia/Tashkent',
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

    const downloadedFileIds: string[] = []
    let failTranscribe = false
    let nextTranscript = 'Привет, давай перенесём наш созвон на 17:00 сегодня, удобно?'
    let nextGist = 'Move call to 17?'

    const mockProvider: LlmProvider = {
      id: 'gemini',
      model: 'mock-gemini',
      async transcribeAudio(buf, mime) {
        assert.equal(mime, 'audio/wav')
        assert.ok(buf.length > 0)
        if (failTranscribe) {
          throw new Error('stt_failed')
        }
        return { transcript: nextTranscript, lang: 'ru' }
      },
      async completeJson(opts) {
        return opts.schema.parse({
          priority: 'urgent',
          intent: 'schedule',
          gist: nextGist,
          lang: 'ru',
          drafts: [
            { text: 'Да, давай в 17:00', lens: 'Да, давай в 17:00', slot: null },
            { text: 'Могу в 17:30', lens: 'Могу в 17:30', slot: null },
            { text: 'Отвечу через полчаса', lens: 'Отвечу через полчаса', slot: null },
          ],
        })
      },
    }

    const bot = createBot('123456:TEST_TOKEN', {
      db,
      botConfig: { botInfo: TEST_BOT_INFO },
      getProvider: () => mockProvider,
      downloadTelegramFile: async (fileId) => {
        downloadedFileIds.push(fileId)
        return Buffer.from(`ogg-bytes-for-${fileId}`)
      },
      transcodeMediaToWav: async (inputBuf) => {
        assert.ok(inputBuf.length > 0)
        return Buffer.from('RIFF-16k-mono-wav')
      },
    })

    const webhookSecret = 'incoming_voice_secret'
    const app = createApp({
      db,
      tg: { bot, webhookSecret },
    })

    // 1) Normal incoming voice (0:40) -> transcribed + triaged + SSE inbox
    const sse1 = waitForInboxSse(1)
    const webhookRes1 = await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify({
        update_id: 501,
        business_message: {
          message_id: 71,
          date: Math.floor(now / 1000),
          business_connection_id: 'bc_in_voice',
          chat: { id: 8001, type: 'private', first_name: 'Aziz' },
          from: { id: 8001, is_bot: false, first_name: 'Aziz' },
          voice: {
            file_id: 'voice_file_40s',
            file_unique_id: 'uniq_40s',
            duration: 40,
            mime_type: 'audio/ogg',
            file_size: 18_400,
          },
        },
      }),
    })
    assert.equal(webhookRes1.status, 200)
    const evt1 = await sse1
    assert.ok(evt1.messageId)

    assert.deepEqual(downloadedFileIds, ['voice_file_40s'])

    const inboxRes1 = await app.request('/api/inbox', {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    assert.equal(inboxRes1.status, 200)
    const inboxJson1 = (await inboxRes1.json()) as {
      items: Array<{ id: number; from: string; preview: string; urgent: boolean }>
    }
    assert.equal(inboxJson1.items.length, 1)
    assert.equal(inboxJson1.items[0]?.from, 'Aziz')
    assert.ok(inboxJson1.items[0]?.preview.startsWith('(v0:40) Привет, давай перенесём'))
    assert.equal(inboxJson1.items[0]?.urgent, true)

    const cardRes1 = await app.request(`/api/msg/${evt1.messageId}`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    assert.equal(cardRes1.status, 200)
    const cardJson1 = (await cardRes1.json()) as {
      from: string
      gist: string
      transcript?: string
      media?: { kind: string; duration: number; transcribed?: boolean }
      drafts: Array<{ lens: string }>
    }
    assert.equal(cardJson1.from, 'Aziz')
    assert.equal(cardJson1.gist, nextTranscript)
    assert.equal(cardJson1.transcript, nextTranscript)
    assert.deepEqual(cardJson1.media, {
      kind: 'voice',
      duration: 40,
      transcribed: true,
    })
    assert.equal(cardJson1.drafts[0]?.lens, 'Да, давай в 17:00')

    // Ensure no audio bytes are persisted in DB
    const storedRow1 = db
      .select()
      .from(messages)
      .where(eq(messages.id, evt1.messageId!))
      .get()
    assert.equal(storedRow1?.text, nextTranscript)
    assert.ok(!storedRow1?.mediaJson?.includes('RIFF'))
    assert.ok(!storedRow1?.mediaJson?.includes('ogg-bytes'))

    // 2) Incoming video_note (0:15) -> (o0:15) prefix in Inbox
    nextTranscript = 'Посмотри макет на экране'
    nextGist = 'Check layout'
    const sse2 = waitForInboxSse(1)
    await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify({
        update_id: 502,
        business_message: {
          message_id: 72,
          date: Math.floor(now / 1000) + 1,
          business_connection_id: 'bc_in_voice',
          chat: { id: 8002, type: 'private', first_name: 'Timur' },
          from: { id: 8002, is_bot: false, first_name: 'Timur' },
          video_note: {
            file_id: 'vnote_15s',
            file_unique_id: 'uniq_vnote_15s',
            length: 240,
            duration: 15,
            file_size: 95_000,
          },
        },
      }),
    })
    await sse2

    const inboxRes2 = await app.request('/api/inbox', {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    const inboxJson2 = (await inboxRes2.json()) as {
      items: Array<{ chatId: number; preview: string }>
    }
    const vnoteItem = inboxJson2.items.find((it) => it.chatId === 8002)
    assert.equal(vnoteItem?.preview, '(o0:15) Посмотри макет на экране')

    // 3) Transcription error -> transcribed=false + fallback drafts ("Will listen and reply")
    failTranscribe = true
    const sse3 = waitForInboxSse(1)
    await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify({
        update_id: 503,
        business_message: {
          message_id: 73,
          date: Math.floor(now / 1000) + 2,
          business_connection_id: 'bc_in_voice',
          chat: { id: 8003, type: 'private', first_name: 'bekzod' },
          from: { id: 8003, is_bot: false, first_name: 'Bekzod' },
          voice: {
            file_id: 'voice_fail_40s',
            file_unique_id: 'uniq_fail_40s',
            duration: 40,
            file_size: 14_000,
          },
        },
      }),
    })
    const evt3 = await sse3
    const cardRes3 = await app.request(`/api/msg/${evt3.messageId}`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    const cardJson3 = (await cardRes3.json()) as {
      gist: string
      media?: { transcribed?: boolean }
      drafts: Array<{ lens: string }>
    }
    assert.equal(cardJson3.media?.transcribed, false)
    assert.equal(cardJson3.gist, "Voice 0:40 · couldn't transcribe")
    assert.equal(cardJson3.drafts[0]?.lens, 'Will listen and reply')

    // Verify fallback message still shows in Inbox
    const inboxRes3 = await app.request('/api/inbox', {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    const inboxJson3 = (await inboxRes3.json()) as {
      items: Array<{ chatId: number; preview: string }>
    }
    const failedInboxItem = inboxJson3.items.find((it) => it.chatId === 8003)
    assert.ok(failedInboxItem)
    assert.equal(failedInboxItem.preview, "(v0:40) couldn't transcribe")

    // 4) Duration > 5 min (7:12 = 432s) -> tooLong=true, getFile NOT called
    failTranscribe = false
    const downloadsBeforeTooLong = downloadedFileIds.length
    const sse4 = waitForInboxSse(1)
    await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify({
        update_id: 504,
        business_message: {
          message_id: 74,
          date: Math.floor(now / 1000) + 3,
          business_connection_id: 'bc_in_voice',
          chat: { id: 8004, type: 'private', first_name: 'Sardor' },
          from: { id: 8004, is_bot: false, first_name: 'Sardor' },
          voice: {
            file_id: 'voice_too_long_432s',
            file_unique_id: 'uniq_432s',
            duration: 432,
            file_size: 900_000,
          },
        },
      }),
    })
    const evt4 = await sse4
    assert.equal(downloadedFileIds.length, downloadsBeforeTooLong)

    const cardRes4 = await app.request(`/api/msg/${evt4.messageId}`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    const cardJson4 = (await cardRes4.json()) as {
      gist: string
      media?: { tooLong?: boolean; duration: number }
      drafts: Array<{ lens: string }>
    }
    assert.equal(cardJson4.media?.tooLong, true)
    assert.equal(cardJson4.gist, 'Voice 7:12 · too long to transcribe')
    assert.equal(cardJson4.drafts[0]?.lens, 'Will listen and reply')

    // 5) File size > 20 MB -> tooLong=true, getFile NOT called
    const sse5 = waitForInboxSse(1)
    await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify({
        update_id: 505,
        business_message: {
          message_id: 75,
          date: Math.floor(now / 1000) + 4,
          business_connection_id: 'bc_in_voice',
          chat: { id: 8005, type: 'private', first_name: 'Oleg' },
          from: { id: 8005, is_bot: false, first_name: 'Oleg' },
          audio: {
            file_id: 'audio_over_20mb',
            file_unique_id: 'uniq_21mb',
            duration: 90,
            file_size: 21 * 1024 * 1024,
          },
        },
      }),
    })
    const evt5 = await sse5
    assert.equal(downloadedFileIds.length, downloadsBeforeTooLong)

    const cardRes5 = await app.request(`/api/msg/${evt5.messageId}`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    const cardJson5 = (await cardRes5.json()) as {
      gist: string
      media?: { kind: string; tooLong?: boolean }
    }
    assert.equal(cardJson5.media?.kind, 'audio')
    assert.equal(cardJson5.media?.tooLong, true)
    assert.equal(cardJson5.gist, 'Voice 1:30 · too long to transcribe')

    // 6) Incoming sticker -> readable sticker label
    const sse6 = waitForInboxSse(1)
    await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify({
        update_id: 506,
        business_message: {
          message_id: 76,
          date: Math.floor(now / 1000) + 5,
          business_connection_id: 'bc_in_voice',
          chat: { id: 8006, type: 'private', first_name: 'Rustam' },
          from: { id: 8006, is_bot: false, first_name: 'Rustam' },
          sticker: {
            file_id: 'stk_1',
            file_unique_id: 'stk_u1',
            type: 'regular',
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: '👍',
            set_name: 'CutePack',
          },
        },
      }),
    })
    const evt6 = await sse6
    const cardRes6 = await app.request(`/api/msg/${evt6.messageId}`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    const cardJson6 = (await cardRes6.json()) as { gist: string; fullText: string }
    assert.equal(cardJson6.gist, '[Стикер: палец вверх]')
    assert.match(cardJson6.fullText, /Rustam: \[Стикер: палец вверх\]/)

    // 7) Incoming GIF (animation) -> shown as sticker with (GIF) in parentheses
    const sse7 = waitForInboxSse(1)
    await app.request('/tg/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify({
        update_id: 507,
        business_message: {
          message_id: 77,
          date: Math.floor(now / 1000) + 6,
          business_connection_id: 'bc_in_voice',
          chat: { id: 8007, type: 'private', first_name: 'Dima' },
          from: { id: 8007, is_bot: false, first_name: 'Dima' },
          animation: {
            file_id: 'gif_1',
            file_unique_id: 'gif_u1',
            width: 320,
            height: 240,
            duration: 3,
            file_name: 'giphy.mp4',
          },
          caption: 'Смотри как смешно',
        },
      }),
    })
    const evt7 = await sse7
    const cardRes7 = await app.request(`/api/msg/${evt7.messageId}`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    const cardJson7 = (await cardRes7.json()) as { gist: string; fullText: string }
    assert.equal(cardJson7.gist, '[Стикер (GIF)] Смотри как смешно')
    assert.match(cardJson7.fullText, /Dima: \[Стикер \(GIF\)\] Смотри как смешно/)
  } finally {
    sqlite.close()
  }
})
