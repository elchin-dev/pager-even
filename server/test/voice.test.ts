import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import { createDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { actions, devices, messages, users } from '../src/db/schema.js'
import { generateDeviceToken, sha256Hex } from '../src/lib/crypto.js'
import { checkFfmpegAvailable, parseWavDurationSec } from '../src/voice/transcode.js'

function buildTestWav(durationSec: number, sampleRate = 16_000): Buffer {
  const dataBytes = Math.round(durationSec * sampleRate * 2) & ~1
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

test('parseWavDurationSec extracts duration from 16kHz s16le mono WAV header', () => {
  const wav = buildTestWav(3.5)
  assert.equal(parseWavDurationSec(wav), 3.5)
  assert.throws(() => parseWavDurationSec(Buffer.from('not-a-wav')))
})

test('checkFfmpegAvailable updates /health ffmpeg field without throwing', async () => {
  const ok = await checkFfmpegAvailable()
  assert.equal(typeof ok, 'boolean')
  const app = createApp()
  const res = await app.request('/health')
  assert.equal(res.status, 200)
  const json = (await res.json()) as { ok: boolean; ffmpeg?: boolean }
  assert.equal(json.ok, true)
  assert.equal(json.ffmpeg, ok)
})

test('POST /api/msg/:id/voice enforces ownership, 4MB limit, sends voice, records duration without audio, and returns voice_failed on error', async () => {
  const { sqlite, db } = createDb(':memory:')
  runMigrations(db)

  try {
    const now = Date.now()
    db.insert(users)
      .values([
        {
          id: 1,
          tgUserId: 1001,
          tgName: 'Owner',
          businessConnectionId: 'bc_voice_1',
          canReply: true,
          isEnabled: true,
          createdAt: now,
        },
        {
          id: 2,
          tgUserId: 2002,
          tgName: 'Other',
          businessConnectionId: 'bc_voice_2',
          canReply: true,
          isEnabled: true,
          createdAt: now,
        },
      ])
      .run()

    const token1 = generateDeviceToken()
    const token2 = generateDeviceToken()
    db.insert(devices)
      .values([
        { userId: 1, tokenHash: sha256Hex(token1), createdAt: now, revokedAt: null },
        { userId: 2, tokenHash: sha256Hex(token2), createdAt: now, revokedAt: null },
      ])
      .run()

    db.insert(messages)
      .values({
        id: 100,
        userId: 1,
        chatId: 7777,
        tgMessageId: 12,
        fromTgUserId: 7777,
        fromName: 'Eric',
        businessConnectionId: 'bc_voice_1',
        text: 'Send me a voice update',
        receivedAt: now,
        status: 'new',
        expiresAt: now + 86_400_000,
      })
      .run()

    let shouldFail = false
    const voiceCalls: Array<{
      chatId: number
      oggBytes: number
      durationSec: number
      businessConnectionId: string
    }> = []

    const app = createApp({
      db,
      transcodeWav: async (wavBuf) => {
        if (shouldFail) {
          throw new Error('ffmpeg_failed')
        }
        const durationSec = parseWavDurationSec(wavBuf)
        return { oggBuffer: Buffer.from('OggS-mock-opus-payload'), durationSec }
      },
      sendTelegramVoice: async ({ chatId, oggBuffer, durationSec, businessConnectionId }) => {
        voiceCalls.push({
          chatId,
          oggBytes: oggBuffer.length,
          durationSec,
          businessConnectionId,
        })
        return { messageId: 909 }
      },
    })

    const validWav = buildTestWav(4.2)

    // 1) Wrong owner -> 404
    const wrongOwnerRes = await app.request('/api/msg/100/voice', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token2}`,
        'Content-Type': 'audio/wav',
      },
      body: validWav,
    })
    assert.equal(wrongOwnerRes.status, 404)

    // 2) Body > 4 MB -> 413
    const hugeBuf = Buffer.alloc(4 * 1024 * 1024 + 128)
    const tooLargeRes = await app.request('/api/msg/100/voice', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Content-Type': 'audio/wav',
      },
      body: hugeBuf,
    })
    assert.equal(tooLargeRes.status, 413)

    // 3) Transcode failure -> 502 { error: 'voice_failed' }
    shouldFail = true
    const failRes = await app.request('/api/msg/100/voice', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Content-Type': 'audio/wav',
      },
      body: validWav,
    })
    assert.equal(failRes.status, 502)
    assert.deepEqual(await failRes.json(), { error: 'voice_failed' })

    // 4) Success -> sends OGG/Opus voice, marks replied, stores only duration in actions
    shouldFail = false
    const okRes = await app.request('/api/msg/100/voice', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Content-Type': 'audio/wav',
      },
      body: validWav,
    })
    assert.equal(okRes.status, 200)
    const okJson = (await okRes.json()) as {
      ok: boolean
      tgMessageId: number
      durationSec: number
    }
    assert.equal(okJson.ok, true)
    assert.equal(okJson.tgMessageId, 909)
    assert.equal(okJson.durationSec, 4.2)

    assert.equal(voiceCalls.length, 1)
    assert.equal(voiceCalls[0]?.chatId, 7777)
    assert.equal(voiceCalls[0]?.businessConnectionId, 'bc_voice_1')
    assert.equal(voiceCalls[0]?.durationSec, 4.2)

    const updatedMsg = db.select().from(messages).where(eq(messages.id, 100)).get()
    assert.equal(updatedMsg?.status, 'replied')

    const voiceActions = db.select().from(actions).where(eq(actions.messageId, 100)).all()
    assert.equal(voiceActions.length, 1)
    assert.equal(voiceActions[0]?.type, 'voice')
    assert.deepEqual(JSON.parse(voiceActions[0]!.payload), {
      tgMessageId: 909,
      durationSec: 4.2,
    })
  } finally {
    sqlite.close()
  }
})
