import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getDb, type AppDb } from '../db/index.js'
import { userSettings } from '../db/schema.js'
import type { AuthEnv } from '../middleware/auth.js'

export type FeedMode = 'urgent' | 'all'

export interface UserSettingsDto {
  feedMode: FeedMode
  voiceEnabled: boolean
  conflictAlerts: boolean
}

const DEFAULT_SETTINGS: UserSettingsDto = {
  feedMode: 'urgent',
  voiceEnabled: true,
  conflictAlerts: true,
}

const updateSettingsSchema = z.object({
  feedMode: z.enum(['urgent', 'all']).optional(),
  voiceEnabled: z.boolean().optional(),
  conflictAlerts: z.boolean().optional(),
})

export function getUserSettings(db: AppDb, userId: number): UserSettingsDto {
  const row = db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .get()

  if (!row) {
    return { ...DEFAULT_SETTINGS }
  }

  return {
    feedMode: row.feedMode,
    voiceEnabled: row.voiceEnabled,
    conflictAlerts: row.conflictAlerts,
  }
}

export function createSettingsRouter(options?: { db?: AppDb }): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()

  router.get('/', (c) => {
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    return c.json(getUserSettings(db, authUser.id))
  })

  router.put('/', async (c) => {
    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }

    const parsed = updateSettingsSchema.safeParse(rawBody)
    if (!parsed.success) {
      return c.json({ error: 'invalid_settings' }, 400)
    }

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const current = getUserSettings(db, authUser.id)
    const next: UserSettingsDto = {
      feedMode: parsed.data.feedMode ?? current.feedMode,
      voiceEnabled: parsed.data.voiceEnabled ?? current.voiceEnabled,
      conflictAlerts: parsed.data.conflictAlerts ?? current.conflictAlerts,
    }
    const now = Date.now()

    db.insert(userSettings)
      .values({
        userId: authUser.id,
        feedMode: next.feedMode,
        voiceEnabled: next.voiceEnabled,
        conflictAlerts: next.conflictAlerts,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: {
          feedMode: next.feedMode,
          voiceEnabled: next.voiceEnabled,
          conflictAlerts: next.conflictAlerts,
          updatedAt: now,
        },
      })
      .run()

    return c.json(next)
  })

  return router
}
