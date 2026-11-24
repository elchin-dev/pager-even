import { and, desc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { triageResultSchema } from '../ai/triage.js'
import { getDb, type AppDb } from '../db/index.js'
import { messages } from '../db/schema.js'
import { toLens } from '../lib/translit.js'
import type { AuthEnv } from '../middleware/auth.js'
import { getUserSettings, type FeedMode } from './settings.js'

const modeQuerySchema = z.enum(['urgent', 'all'])

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

    const rawMode = c.req.query('mode')
    let mode: FeedMode
    if (rawMode !== undefined) {
      const parsedMode = modeQuerySchema.safeParse(rawMode)
      if (!parsedMode.success) {
        return c.json({ error: 'invalid_mode' }, 400)
      }
      mode = parsedMode.data
    } else {
      mode = getUserSettings(db, authUser.id).feedMode
    }

    const now = Date.now()
    const rows = db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        fromName: messages.fromName,
        text: messages.text,
        aiJson: messages.aiJson,
        receivedAt: messages.receivedAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.userId, authUser.id),
          eq(messages.status, 'new'),
          gt(messages.expiresAt, now),
        ),
      )
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .all()

    const allGrouped = new Map<number, InboxItem & { receivedAt: number }>()
    const urgentGrouped = new Map<number, InboxItem & { receivedAt: number }>()

    for (const row of rows) {
      const ai = parseAiJson(row.aiJson)
      const priority: InboxItem['priority'] = ai?.priority ?? 'needs_reply'
      const hasConflict = Boolean(ai?.conflict)
      const hasDrafts = Boolean(ai && ai.drafts.length > 0)
      const isUrgentRow =
        (priority === 'urgent' || (priority === 'needs_reply' && hasConflict)) && hasDrafts

      const existingAll = allGrouped.get(row.chatId)
      if (existingAll) {
        existingAll.count += 1
        if (isUrgentRow) {
          existingAll.urgent = true
          if (priority === 'urgent') {
            existingAll.priority = 'urgent'
          }
        }
        if (hasConflict) {
          existingAll.hasConflict = true
        }
      } else {
        allGrouped.set(row.chatId, {
          id: row.id,
          chatId: row.chatId,
          from: toLens(row.fromName, 12),
          preview: toLens(row.text || '[media]', 40),
          count: 1,
          priority,
          urgent: isUrgentRow,
          hasConflict,
          receivedAt: row.receivedAt,
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
            from: toLens(row.fromName, 12),
            preview: toLens(row.text || '[media]', 40),
            count: 1,
            priority,
            urgent: true,
            hasConflict,
            receivedAt: row.receivedAt,
          })
        }
      }
    }

    const source = mode === 'urgent' ? urgentGrouped : allGrouped
    const items = Array.from(source.values())
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, 10)
      .map(({ receivedAt: _receivedAt, ...item }) => item)

    return c.json({
      mode,
      counts: {
        urgent: urgentGrouped.size,
        all: allGrouped.size,
      },
      items,
    })
  })

  return router
}
