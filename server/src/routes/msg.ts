import { and, desc, eq, gt } from 'drizzle-orm'
import { Api } from 'grammy'
import { Hono } from 'hono'
import { z } from 'zod'
import { buildFallbackTriage, triageResultSchema, type TriageResult } from '../ai/triage.js'
import { getDb, type AppDb } from '../db/index.js'
import { actions, googleAccounts, messages, users } from '../db/schema.js'
import { decryptSecret } from '../lib/crypto.js'
import {
  createDefaultGoogleCalendarClient,
  resolveUserTimeZone,
  type GoogleCalendarClient,
} from '../lib/google-calendar.js'
import { logger } from '../lib/logger.js'
import { toLens } from '../lib/translit.js'
import type { AuthEnv } from '../middleware/auth.js'
import { getUserSettings } from './settings.js'

const idParamSchema = z.coerce.number().int().positive()

const sendBodySchema = z
  .object({
    draftIndex: z.number().int().min(0).max(2).optional(),
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

function parseAiOrFallback(raw: string | null, fallbackInput: { text: string; fromName: string }): TriageResult {
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
  return buildFallbackTriage(fallbackInput)
}

export function createMsgRouter(options?: {
  db?: AppDb
  sendTelegramMessage?: SendTelegramMessageFn
  calendarClient?: GoogleCalendarClient
}): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()
  const sendTelegram = options?.sendTelegramMessage ?? createDefaultSender()
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

    const ai = parseAiOrFallback(row.aiJson, {
      text: row.text,
      fromName: row.fromName,
    })

    const drafts = ai.drafts.slice(0, 3).map((d, index) => {
      const slot = d.slot ?? null
      const hasCal = Boolean(slot)
      const baseLens = toLens(d.lens || d.text, hasCal ? 27 : 32) || 'Reply'
      const lens = hasCal && !baseLens.endsWith('+cal') ? `${baseLens} +cal` : baseLens
      return {
        index,
        lens,
        slot,
        hasCal,
      }
    })

    const userCfg = getUserSettings(db, authUser.id)
    const now = Date.now()
    const threadRows =
      userCfg.chatView === 'with_history'
        ? db
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
            .limit(4)
            .all()
            .reverse()
        : db
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.userId, authUser.id),
                eq(messages.chatId, row.chatId),
                eq(messages.status, 'new'),
                eq(messages.isFromOwner, false),
                gt(messages.expiresAt, now),
              ),
            )
            .orderBy(desc(messages.receivedAt), desc(messages.id))
            .limit(3)
            .all()
            .reverse()

    const displayRows = threadRows.length > 0 ? threadRows : [row]
    const formattedThread = displayRows
      .map((m) => {
        if (m.isFromOwner) {
          return toLens(`You: ${m.text || '[media]'}`, 52)
        }
        const mAi = parseAiOrFallback(m.aiJson, { text: m.text, fromName: m.fromName })
        const urgentPrefix = displayRows.length > 1 && mAi.priority === 'urgent' ? '! ' : ''
        return `${urgentPrefix}${toLens(m.text || '[media]', displayRows.length > 1 ? 50 : 80)}`
      })
      .join('\n')

    const originalText = toLens(row.text || '[media]', 80)

    return c.json({
      id: row.id,
      chatId: row.chatId,
      from: toLens(row.fromName, 20),
      priority: ai.priority === 'urgent' ? 'urgent' : 'needs_reply',
      intent: ai.intent,
      chatView: userCfg.chatView,
      gist: formattedThread || originalText,
      text: toLens(row.text || '[media]', 120),
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
      })
      const draft = ai.drafts[parsedBody.data.draftIndex]
      if (!draft) {
        return c.json({ error: 'invalid_draft_index' }, 400)
      }
      replyText = draft.text
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

    let eventCreated = false
    let eventId: string | undefined
    if (selectedSlot && parsedBody.data.createEvent !== false) {
      const googleAcc = db
        .select()
        .from(googleAccounts)
        .where(eq(googleAccounts.userId, authUser.id))
        .get()
      const startMs = Date.parse(selectedSlot)
      if (googleAcc && !Number.isNaN(startMs)) {
        const startIso = new Date(startMs).toISOString()
        const endIso = new Date(startMs + 30 * 60_000).toISOString()
        const summary = `Meeting: ${toLens(row.fromName, 40) || row.fromName}`
        try {
          const refreshToken = decryptSecret(googleAcc.refreshTokenEnc)
          const created = await calendarClient.createEvent({
            refreshToken,
            summary,
            startIso,
            endIso,
            timeZone: resolveUserTimeZone(owner?.tz),
          })
          eventCreated = true
          eventId = created.eventId
          db.insert(actions)
            .values({
              messageId: row.id,
              type: 'event',
              payload: JSON.stringify({
                eventId,
                startIso,
                endIso,
                summary,
              }),
              createdAt: Date.now(),
            })
            .run()
        } catch (err) {
          logger.error('msg_send_calendar_event_failed', {
            userId: authUser.id,
            messageId: row.id,
            errorName: err instanceof Error ? err.name : 'unknown',
          })
        }
      }
    }

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

  return router
}
