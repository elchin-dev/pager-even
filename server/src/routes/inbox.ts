import { and, desc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { triageResultSchema, type TriageResult } from '../ai/triage.js'
import { getDb, type AppDb } from '../db/index.js'
import { messages } from '../db/schema.js'
import { toLens } from '../lib/translit.js'
import type { AuthEnv } from '../middleware/auth.js'

export interface InboxItem {
  id: number
  chatId: number
  from: string
  preview: string
  count: number
  priority: 'urgent' | 'needs_reply'
}

function parseAiJson(raw: string | null): TriageResult | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    const result = triageResultSchema.safeParse(parsed)
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

    const grouped = new Map<number, InboxItem & { receivedAt: number }>()

    for (const row of rows) {
      const ai = parseAiJson(row.aiJson)
      if (ai && (ai.priority === 'ignore' || ai.priority === 'fyi')) {
        continue
      }

      const priority: 'urgent' | 'needs_reply' =
        ai?.priority === 'urgent' ? 'urgent' : 'needs_reply'

      const existing = grouped.get(row.chatId)
      if (existing) {
        existing.count += 1
        if (priority === 'urgent') {
          existing.priority = 'urgent'
        }
        continue
      }

      grouped.set(row.chatId, {
        id: row.id,
        chatId: row.chatId,
        from: toLens(row.fromName, 12),
        preview: toLens(ai?.gist || row.text || '[media]', 40),
        count: 1,
        priority,
        receivedAt: row.receivedAt,
      })
    }

    const items = Array.from(grouped.values())
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority === 'urgent' ? -1 : 1
        }
        return b.receivedAt - a.receivedAt
      })
      .slice(0, 10)
      .map(({ receivedAt: _receivedAt, ...item }) => item)

    return c.json({ items })
  })

  return router
}
