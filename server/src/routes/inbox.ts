import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
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
}

export function createInboxRouter(options?: { db?: AppDb }): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()

  router.get('/', (c) => {
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()

    const rows = db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        fromName: messages.fromName,
        text: messages.text,
        receivedAt: messages.receivedAt,
      })
      .from(messages)
      .where(and(eq(messages.userId, authUser.id), eq(messages.status, 'new')))
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .all()

    const grouped = new Map<number, InboxItem>()
    for (const row of rows) {
      const existing = grouped.get(row.chatId)
      if (existing) {
        existing.count += 1
        continue
      }
      if (grouped.size >= 10) {
        continue
      }
      grouped.set(row.chatId, {
        id: row.id,
        chatId: row.chatId,
        from: toLens(row.fromName, 12),
        preview: toLens(row.text || '[media]', 40),
        count: 1,
      })
    }

    return c.json({
      items: Array.from(grouped.values()),
    })
  })

  return router
}
