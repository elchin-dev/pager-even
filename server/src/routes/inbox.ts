import { and, desc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  formatMediaMmSs,
  messageMediaSchema,
  triageResultSchema,
  type MessageMedia,
} from '../ai/triage.js'
import { getDb, type AppDb } from '../db/index.js'
import { messages } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { toOriginalLens } from '../lib/translit.js'
import type { AuthEnv } from '../middleware/auth.js'
import { getUserSettings, type ChatView, type FeedMode } from './settings.js'

const modeQuerySchema = z.enum(['urgent', 'all'])
const chatViewQuerySchema = z.enum(['new_only', 'with_history'])

const inboxAiSchema = triageResultSchema.extend({
  conflict: z
    .object({
      title: z.string(),
      start: z.string(),
      end: z.string(),
    })
    .nullable()
    .optional(),
})

type InboxAi = z.infer<typeof inboxAiSchema>

export interface InboxItem {
  id: number
  chatId: number
  from: string
  preview: string
  count: number
  priority: 'urgent' | 'needs_reply' | 'fyi' | 'ignore'
  urgent: boolean
  hasConflict: boolean
  media?: MessageMedia | null
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

function formatInboxPreviewText(
  row: { isFromOwner: boolean; text: string },
  media: MessageMedia | null,
  ai: InboxAi | null,
): string {
  if (row.isFromOwner) {
    return toOriginalLens(`You: ${row.text || '[media]'}`, 40)
  }
  if (!media) {
    return toOriginalLens(row.text || '[media]', 40)
  }
  const prefix =
    media.kind === 'video_note'
      ? `(o${formatMediaMmSs(media.duration)})`
      : `(v${formatMediaMmSs(media.duration)})`
  if (media.tooLong) {
    return toOriginalLens(`${prefix} too long`, 40)
  }
  if (media.transcribed === false) {
    return toOriginalLens(`${prefix} couldn't transcribe`, 40)
  }
  const spoken = (row.text || ai?.gist || '').trim()
  return toOriginalLens(spoken ? `${prefix} ${spoken}` : prefix, 40)
}

function parseAiJson(raw: string | null): InboxAi | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    const result = inboxAiSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function createInboxRouter(options?: { db?: AppDb }): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()

  router.get('/', (c) => {
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const userCfg = getUserSettings(db, authUser.id)

    const rawMode = c.req.query('mode')
    let mode: FeedMode
    if (rawMode !== undefined) {
      const parsedMode = modeQuerySchema.safeParse(rawMode)
      if (!parsedMode.success) {
        return c.json({ error: 'invalid_mode' }, 400)
      }
      mode = parsedMode.data
    } else {
      mode = userCfg.feedMode
    }

    const rawChatView = c.req.query('chatView')
    let chatView: ChatView
    if (rawChatView !== undefined) {
      const parsedChatView = chatViewQuerySchema.safeParse(rawChatView)
      if (!parsedChatView.success) {
        return c.json({ error: 'invalid_chat_view' }, 400)
      }
      chatView = parsedChatView.data
    } else {
      chatView = userCfg.chatView
    }

    const now = Date.now()
    const baseWhere = and(
      eq(messages.userId, authUser.id),
      eq(messages.status, 'new'),
      eq(messages.isFromOwner, false),
      gt(messages.expiresAt, now),
    )

    const rows = db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        fromName: messages.fromName,
        isFromOwner: messages.isFromOwner,
        status: messages.status,
        text: messages.text,
        aiJson: messages.aiJson,
        mediaJson: messages.mediaJson,
        receivedAt: messages.receivedAt,
      })
      .from(messages)
      .where(baseWhere)
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .all()

    const allGrouped = new Map<
      number,
      InboxItem & { receivedAt: number; hasIncomingId: boolean }
    >()
    const urgentGrouped = new Map<number, InboxItem & { receivedAt: number }>()

    for (const row of rows) {
      const isUnreadIncoming = !row.isFromOwner && row.status === 'new'
      const ai = row.isFromOwner ? null : parseAiJson(row.aiJson)
      const media = row.isFromOwner ? null : parseMediaJson(row.mediaJson)
      const priority: InboxItem['priority'] = ai?.priority ?? 'needs_reply'
      const hasConflict = Boolean(ai?.conflict)
      const hasDrafts = Boolean(ai && ai.drafts.length > 0)
      const isUrgentRow =
        isUnreadIncoming &&
        (priority === 'urgent' || (priority === 'needs_reply' && hasConflict)) &&
        hasDrafts

      const formattedPreview = formatInboxPreviewText(row, media, ai)

      const existingAll = allGrouped.get(row.chatId)
      if (existingAll) {
        if (isUnreadIncoming) {
          existingAll.count += 1
        }
        // In with_history, if the newest row was owner's reply, take contact name from incoming row
        if (!row.isFromOwner && !existingAll.hasIncomingId) {
          existingAll.id = row.id
          existingAll.from = toOriginalLens(row.fromName, 12)
          existingAll.hasIncomingId = true
        }
        if (isUrgentRow) {
          if (!existingAll.urgent) {
            existingAll.id = row.id
            existingAll.preview = formattedPreview
            existingAll.hasIncomingId = true
          }
          existingAll.urgent = true
          if (priority === 'urgent') {
            existingAll.priority = 'urgent'
          }
        }
        if (isUnreadIncoming && hasConflict) {
          existingAll.hasConflict = true
        }
      } else {
        allGrouped.set(row.chatId, {
          id: row.id,
          chatId: row.chatId,
          from: row.isFromOwner ? 'Chat' : toOriginalLens(row.fromName, 12),
          preview: formattedPreview,
          count: isUnreadIncoming ? 1 : 0,
          priority,
          urgent: isUrgentRow,
          hasConflict: isUnreadIncoming ? hasConflict : false,
          ...(media ? { media } : {}),
          receivedAt: row.receivedAt,
          hasIncomingId: !row.isFromOwner,
        })
      }

      if (isUrgentRow) {
        const existingUrgent = urgentGrouped.get(row.chatId)
        if (existingUrgent) {
          existingUrgent.count += 1
          if (priority === 'urgent') {
            existingUrgent.priority = 'urgent'
          }
          if (hasConflict) {
            existingUrgent.hasConflict = true
          }
        } else {
          urgentGrouped.set(row.chatId, {
            id: row.id,
            chatId: row.chatId,
            from: toOriginalLens(row.fromName, 12),
            preview: formattedPreview,
            count: 1,
            priority,
            urgent: true,
            hasConflict,
            ...(media ? { media } : {}),
            receivedAt: row.receivedAt,
          })
        }
      }
    }

    const source = rawMode === 'urgent' ? urgentGrouped : allGrouped
    const items = Array.from(source.values())
      .sort((a, b) => {
        if (a.urgent !== b.urgent) {
          return a.urgent ? -1 : 1
        }
        return b.receivedAt - a.receivedAt
      })
      .slice(0, 10)
      .map((entry) => {
        const { receivedAt: _receivedAt, ...rest } = entry
        if ('hasIncomingId' in rest) {
          const { hasIncomingId: _ignored, ...clean } = rest
          return clean
        }
        return rest
      })

    logger.info('inbox_fetched', {
      userId: authUser.id,
      count: items.length,
      urgent: urgentGrouped.size,
    })

    return c.json({
      mode: rawMode === 'urgent' ? 'urgent' : 'all',
      chatView: 'new_only',
      counts: {
        urgent: urgentGrouped.size,
        all: allGrouped.size,
      },
      items,
    })
  })

  return router
}
