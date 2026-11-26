import { and, desc, eq, gt } from 'drizzle-orm'
import { Api, InputFile } from 'grammy'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  buildFallbackTriage,
  buildMediaFallbackTriage,
  formatMediaMmSs,
  messageMediaSchema,
  triageResultSchema,
  type MessageMedia,
  type TriageResult,
} from '../ai/triage.js'
import { getDb, type AppDb } from '../db/index.js'
import { actions, googleAccounts, messages, users } from '../db/schema.js'
import { decryptSecret } from '../lib/crypto.js'
import {
  createDefaultGoogleCalendarClient,
  resolveUserTimeZone,
  type GoogleCalendarClient,
} from '../lib/google-calendar.js'
import { logger } from '../lib/logger.js'
import { toOriginalLens } from '../lib/translit.js'
import type { AuthEnv } from '../middleware/auth.js'
import { transcodeWavToOpus, type TranscodeWavFn } from '../voice/transcode.js'
import { getUserSettings } from './settings.js'

const MAX_VOICE_BYTES = 4 * 1024 * 1024

const idParamSchema = z.coerce.number().int().positive()

const sendBodySchema = z
  .object({
    draftIndex: z.number().int().min(0).max(3).optional(),
    text: z.string().trim().min(1).max(4000).optional(),
    createEvent: z.boolean().optional(),
  })
  .refine((val) => val.draftIndex !== undefined || val.text !== undefined, {
    message: 'draftIndex or text is required',
  })

export type SendTelegramMessageFn = (params: {
  chatId: number
  text: string
  businessConnectionId: string
}) => Promise<{ messageId: number }>

function createDefaultSender(): SendTelegramMessageFn {
  return async ({ chatId, text, businessConnectionId }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    }
    const api = new Api(token)
    const sent = await api.sendMessage(chatId, text, {
      business_connection_id: businessConnectionId,
    })
    return { messageId: sent.message_id }
  }
}

function parseMediaJson(raw: string | null): MessageMedia | null {
  if (!raw) return null
  try {
    const parsed = messageMediaSchema.safeParse(JSON.parse(raw) as unknown)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function parseAiOrFallback(
  raw: string | null,
  fallbackInput: { text: string; fromName: string; media?: MessageMedia | null },
): TriageResult {
  if (raw) {
    try {
      const parsed = triageResultSchema.safeParse(JSON.parse(raw) as unknown)
      if (parsed.success) {
        return parsed.data
      }
    } catch {
      // ignore invalid stored JSON
    }
  }
  if (fallbackInput.media && fallbackInput.media.transcribed !== true) {
    return buildMediaFallbackTriage(fallbackInput.media)
  }
  return buildFallbackTriage(fallbackInput)
}

export type SendTelegramVoiceFn = (params: {
  chatId: number
  oggBuffer: Buffer
  durationSec: number
  businessConnectionId: string
}) => Promise<{ messageId: number }>

function createDefaultVoiceSender(): SendTelegramVoiceFn {
  return async ({ chatId, oggBuffer, durationSec, businessConnectionId }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    }
    const api = new Api(token)
    const sent = await api.sendVoice(chatId, new InputFile(oggBuffer, 'voice.ogg'), {
      business_connection_id: businessConnectionId,
      duration: Math.max(1, Math.round(durationSec)),
    })
    return { messageId: sent.message_id }
  }
}

async function readBoundedBody(req: Request, maxBytes: number): Promise<Buffer | 'too_large'> {
  const contentLengthHeader = req.headers.get('content-length')
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader)
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      return 'too_large'
    }
  }

  if (!req.body) {
    return Buffer.alloc(0)
  }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return 'too_large'
      }
      chunks.push(value)
    }
  }

  return Buffer.concat(chunks)
}

export function createMsgRouter(options?: {
  db?: AppDb
  sendTelegramMessage?: SendTelegramMessageFn
  sendTelegramVoice?: SendTelegramVoiceFn
  transcodeWav?: TranscodeWavFn
  calendarClient?: GoogleCalendarClient
}): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()
  const sendTelegram = options?.sendTelegramMessage ?? createDefaultSender()
  const sendVoice = options?.sendTelegramVoice ?? createDefaultVoiceSender()
  const transcodeWav = options?.transcodeWav ?? transcodeWavToOpus
  const calendarClient = options?.calendarClient ?? createDefaultGoogleCalendarClient()

  router.get('/:id', (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) {
      return c.json({ error: 'invalid_message_id' }, 400)
    }

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()

    const row = db
      .select()
      .from(messages)
      .where(and(eq(messages.id, parsedId.data), eq(messages.userId, authUser.id)))
      .get()

    if (!row) {
      return c.json({ error: 'not_found' }, 404)
    }

    const media = parseMediaJson(row.mediaJson)
    const ai = parseAiOrFallback(row.aiJson, {
      text: row.text,
      fromName: row.fromName,
      media,
    })

    const drafts = ai.drafts.slice(0, 4).map((d, index) => ({
      index,
      lens: toOriginalLens(d.lens || d.text, 32) || 'Reply',
      slot: null,
      hasCal: false,
    }))

    const userCfg = getUserSettings(db, authUser.id)
    const now = Date.now()
    const threadRows = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.userId, authUser.id),
          eq(messages.chatId, row.chatId),
          gt(messages.expiresAt, now),
        ),
      )
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .limit(8)
      .all()

    const displayRows = threadRows.length > 0 ? threadRows : [row]
    const fullText = displayRows
      .map((m) => {
        if (m.isFromOwner) {
          return `You: ${toOriginalLens(m.text || '[media]', 220)}`
        }
        const mMedia = parseMediaJson(m.mediaJson)
        const sender = toOriginalLens(m.fromName || row.fromName, 20) || 'Chat'
        if (mMedia) {
          const prefix =
            mMedia.kind === 'video_note'
              ? `(o${formatMediaMmSs(mMedia.duration)})`
              : `(v${formatMediaMmSs(mMedia.duration)})`
          const body = mMedia.tooLong
            ? 'too long to transcribe'
            : mMedia.transcribed === false
              ? "couldn't transcribe"
              : toOriginalLens(m.text || '', 220)
          return `${sender}: ${prefix} ${body}`.trim()
        }
        return `${sender}: ${toOriginalLens(m.text || '[media]', 220)}`
      })
      .join('\n')
      .slice(0, 900)

    let compactGist: string
    if (media) {
      const label = media.kind === 'video_note' ? 'Video' : 'Voice'
      const dur = formatMediaMmSs(media.duration)
      if (media.tooLong) {
        compactGist = `${label} ${dur} · too long to transcribe`
      } else if (media.transcribed === false) {
        compactGist = `${label} ${dur} · couldn't transcribe`
      } else {
        compactGist = toOriginalLens(row.text || ai.gist || `${label} ${dur}`, 72)
      }
    } else {
      compactGist = toOriginalLens(row.text || '[media]', 72)
    }

    const transcript =
      media && media.transcribed ? toOriginalLens(row.text || '', 2000) : undefined

    return c.json({
      id: row.id,
      chatId: row.chatId,
      from: toOriginalLens(row.fromName, 20),
      priority: ai.priority === 'urgent' ? 'urgent' : 'needs_reply',
      intent: ai.intent,
      chatView: userCfg.chatView,
      gist: compactGist,
      fullText: fullText || compactGist,
      hasMore: true,
      text: toOriginalLens(row.text || '[media]', 120),
      ...(media ? { media } : {}),
      ...(transcript ? { transcript } : {}),
      drafts,
    })
  })

  router.post('/:id/send', async (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) {
      return c.json({ error: 'invalid_message_id' }, 400)
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }

    const parsedBody = sendBodySchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()

    const row = db
      .select()
      .from(messages)
      .where(and(eq(messages.id, parsedId.data), eq(messages.userId, authUser.id)))
      .get()

    if (!row) {
      return c.json({ error: 'not_found' }, 404)
    }

    const owner = db.select().from(users).where(eq(users.id, authUser.id)).get()
    const connectionId = row.businessConnectionId || owner?.businessConnectionId
    if (!connectionId) {
      return c.json({ error: 'no_business_connection' }, 400)
    }

    let replyText = parsedBody.data.text
    let selectedSlot: string | null = null
    if (!replyText && parsedBody.data.draftIndex !== undefined) {
      const ai = parseAiOrFallback(row.aiJson, {
        text: row.text,
        fromName: row.fromName,
        media: parseMediaJson(row.mediaJson),
      })
      const draft = ai.drafts[parsedBody.data.draftIndex]
      if (!draft) {
        return c.json({ error: 'invalid_draft_index' }, 400)
      }
      replyText = toOriginalLens(draft.lens || draft.text, 32) || draft.text
      selectedSlot = draft.slot ?? null
    }

    if (!replyText) {
      return c.json({ error: 'empty_reply' }, 400)
    }

    let sent: { messageId: number }
    try {
      sent = await sendTelegram({
        chatId: row.chatId,
        text: replyText,
        businessConnectionId: connectionId,
      })
    } catch (err) {
      logger.error('msg_send_telegram_failed', {
        userId: authUser.id,
        messageId: row.id,
        chatId: row.chatId,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
      return c.json({ error: 'telegram_send_failed' }, 502)
    }

    const now = Date.now()
    db.transaction((tx) => {
      tx.update(messages)
        .set({ status: 'seen' })
        .where(
          and(
            eq(messages.userId, authUser.id),
            eq(messages.chatId, row.chatId),
            eq(messages.status, 'new'),
            eq(messages.isFromOwner, false),
          ),
        )
        .run()

      tx.update(messages)
        .set({ status: 'replied' })
        .where(eq(messages.id, row.id))
        .run()

      tx.insert(messages)
        .values({
          userId: authUser.id,
          chatId: row.chatId,
          tgMessageId: sent.messageId,
          fromTgUserId: owner?.tgUserId ?? null,
          fromName: owner?.tgName || 'You',
          businessConnectionId: connectionId,
          isFromOwner: true,
          text: replyText,
          receivedAt: now,
          status: 'replied',
          expiresAt: now + 48 * 60 * 60 * 1000,
        })
        .onConflictDoNothing()
        .run()

      tx.insert(actions)
        .values({
          messageId: row.id,
          type: 'reply',
          payload: JSON.stringify({
            tgMessageId: sent.messageId,
            draftIndex: parsedBody.data.draftIndex ?? null,
          }),
          createdAt: now,
        })
        .run()
    })

    const eventCreated = false
    let eventId: string | undefined

    logger.info('msg_replied', {
      userId: authUser.id,
      messageId: row.id,
      chatId: row.chatId,
      replyTgMessageId: sent.messageId,
      eventCreated,
    })

    return c.json({
      ok: true,
      tgMessageId: sent.messageId,
      ...(eventCreated ? { eventCreated, eventId } : {}),
    })
  })

  router.post('/:id/skip', (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) {
      return c.json({ error: 'invalid_message_id' }, 400)
    }

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()

    const row = db
      .select()
      .from(messages)
      .where(and(eq(messages.id, parsedId.data), eq(messages.userId, authUser.id)))
      .get()

    if (!row) {
      return c.json({ error: 'not_found' }, 404)
    }

    db.update(messages)
      .set({ status: 'skipped' })
      .where(
        and(
          eq(messages.userId, authUser.id),
          eq(messages.chatId, row.chatId),
          eq(messages.status, 'new'),
          eq(messages.isFromOwner, false),
        ),
      )
      .run()

    logger.info('msg_skipped', {
      userId: authUser.id,
      messageId: row.id,
      chatId: row.chatId,
    })

    return c.json({ ok: true })
  })

  router.post('/:id/voice', async (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) {
      return c.json({ error: 'invalid_message_id' }, 400)
    }

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()

    const row = db
      .select()
      .from(messages)
      .where(and(eq(messages.id, parsedId.data), eq(messages.userId, authUser.id)))
      .get()

    if (!row) {
      return c.json({ error: 'not_found' }, 404)
    }

    const owner = db.select().from(users).where(eq(users.id, authUser.id)).get()
    const connectionId = row.businessConnectionId || owner?.businessConnectionId
    if (!connectionId) {
      return c.json({ error: 'no_business_connection' }, 400)
    }

    const bodyResult = await readBoundedBody(c.req.raw, MAX_VOICE_BYTES)
    if (bodyResult === 'too_large') {
      return c.json({ error: 'payload_too_large' }, 413)
    }
    if (bodyResult.length <= 44) {
      return c.json({ error: 'invalid_wav' }, 400)
    }

    let oggBuffer: Buffer
    let durationSec: number
    let sent: { messageId: number }
    try {
      const transcoded = await transcodeWav(bodyResult)
      oggBuffer = transcoded.oggBuffer
      durationSec = transcoded.durationSec
      sent = await sendVoice({
        chatId: row.chatId,
        oggBuffer,
        durationSec,
        businessConnectionId: connectionId,
      })
    } catch (err) {
      logger.error('msg_voice_failed', {
        userId: authUser.id,
        messageId: row.id,
        chatId: row.chatId,
        errorName: err instanceof Error ? err.name : 'unknown',
        reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
      })
      return c.json({ error: 'voice_failed' }, 502)
    }

    const now = Date.now()
    db.transaction((tx) => {
      tx.update(messages)
        .set({ status: 'seen' })
        .where(
          and(
            eq(messages.userId, authUser.id),
            eq(messages.chatId, row.chatId),
            eq(messages.status, 'new'),
            eq(messages.isFromOwner, false),
          ),
        )
        .run()

      tx.update(messages)
        .set({ status: 'replied' })
        .where(eq(messages.id, row.id))
        .run()

      tx.insert(actions)
        .values({
          messageId: row.id,
          type: 'voice',
          payload: JSON.stringify({
            tgMessageId: sent.messageId,
            durationSec,
          }),
          createdAt: now,
        })
        .run()
    })

    logger.info('msg_voice_replied', {
      userId: authUser.id,
      messageId: row.id,
      chatId: row.chatId,
      replyTgMessageId: sent.messageId,
      durationSec,
    })

    return c.json({
      ok: true,
      tgMessageId: sent.messageId,
      durationSec,
    })
  })

  return router
}
