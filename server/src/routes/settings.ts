import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getDb, type AppDb } from '../db/index.js'
import { userSettings } from '../db/schema.js'
import type { AuthEnv } from '../middleware/auth.js'

export type FeedMode = 'urgent' | 'all'
export type ChatView = 'new_only' | 'with_history'

export interface UserSettingsDto {
  feedMode: FeedMode
  chatView: ChatView
  voiceEnabled: boolean
  conflictAlerts: boolean
  meetingReminders: boolean
  briefAlerts: boolean
  taskReminders: boolean
}

const DEFAULT_SETTINGS: UserSettingsDto = {
  feedMode: 'urgent',
  chatView: 'new_only',
  voiceEnabled: true,
  conflictAlerts: true,
  meetingReminders: true,
  briefAlerts: true,
  taskReminders: true,
}

const updateSettingsSchema = z.object({
  feedMode: z.enum(['urgent', 'all']).optional(),
  chatView: z.enum(['new_only', 'with_history']).optional(),
  voiceEnabled: z.boolean().optional(),
  conflictAlerts: z.boolean().optional(),
  meetingReminders: z.boolean().optional(),
  briefAlerts: z.boolean().optional(),
  taskReminders: z.boolean().optional(),
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
    chatView: row.chatView,
    voiceEnabled: row.voiceEnabled,
    conflictAlerts: row.conflictAlerts,
    meetingReminders: row.meetingReminders ?? true,
    briefAlerts: row.briefAlerts ?? true,
    taskReminders: row.taskReminders ?? true,
  }
}

export function patchUserSettings(
  db: AppDb,
  userId: number,
  patch: Partial<UserSettingsDto>,
): UserSettingsDto {
  const current = getUserSettings(db, userId)
  const next: UserSettingsDto = {
    feedMode: patch.feedMode ?? current.feedMode,
    chatView: patch.chatView ?? current.chatView,
    voiceEnabled: patch.voiceEnabled ?? current.voiceEnabled,
    conflictAlerts: patch.conflictAlerts ?? current.conflictAlerts,
    meetingReminders: patch.meetingReminders ?? current.meetingReminders,
    briefAlerts: patch.briefAlerts ?? current.briefAlerts,
    taskReminders: patch.taskReminders ?? current.taskReminders,
  }
  const now = Date.now()

  db.insert(userSettings)
    .values({
      userId,
      feedMode: next.feedMode,
      chatView: next.chatView,
      voiceEnabled: next.voiceEnabled,
      conflictAlerts: next.conflictAlerts,
      meetingReminders: next.meetingReminders,
      briefAlerts: next.briefAlerts,
      taskReminders: next.taskReminders,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        feedMode: next.feedMode,
        chatView: next.chatView,
        voiceEnabled: next.voiceEnabled,
        conflictAlerts: next.conflictAlerts,
        meetingReminders: next.meetingReminders,
        briefAlerts: next.briefAlerts,
        taskReminders: next.taskReminders,
        updatedAt: now,
      },
    })
    .run()

  return next
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
    return c.json(patchUserSettings(db, authUser.id, parsed.data))
  })

  return router
}
