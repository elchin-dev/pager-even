import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getProviderForUser, type LlmProvider } from '../ai/provider.js'
import { getDb, type AppDb } from '../db/index.js'
import { notes, promises, users } from '../db/schema.js'
import type { GoogleCalendarClient } from '../lib/google-calendar.js'
import { resolveUserTimeZone } from '../lib/google-calendar.js'
import { logger } from '../lib/logger.js'
import { analyzeNoteText, formatNoteDto } from '../lib/notes-service.js'
import type { AuthEnv } from '../middleware/auth.js'

const MAX_NOTE_VOICE_BYTES = 4 * 1024 * 1024
const idParamSchema = z.coerce.number().int().positive()

const createNoteSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  meetingEventId: z.string().trim().max(128).nullable().optional(),
  meetingTitle: z.string().trim().max(120).nullable().optional(),
  remindAt: z.number().int().positive().nullable().optional(),
})

const updateNoteSchema = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  meetingEventId: z.string().trim().max(128).nullable().optional(),
  meetingTitle: z.string().trim().max(120).nullable().optional(),
  remindAt: z.number().int().positive().nullable().optional(),
})

const createPromiseSchema = z.object({
  messageId: z.number().int().positive().nullable().optional(),
  chatId: z.number().int(),
  contactName: z.string().trim().min(1).max(80),
  replyText: z.string().trim().min(1).max(500),
  taskText: z.string().trim().min(1).max(160),
  promisedAtTime: z.string().trim().min(1).max(16),
  remindAt: z.number().int().positive(),
})

async function readBoundedAudio(req: Request, maxBytes: number): Promise<Buffer | 'too_large'> {
  const cl = req.headers.get('content-length')
  if (cl && Number(cl) > maxBytes) return 'too_large'
  if (!req.body) return Buffer.alloc(0)
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

export function createNotesRouter(options?: {
  db?: AppDb
  calendarClient?: GoogleCalendarClient
  getProvider?: (userId: number) => LlmProvider | null
  nowProvider?: () => number
}): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()
  const nowFn = options?.nowProvider ?? (() => Date.now())

  function getTz(db: AppDb, userId: number): string {
    const u = db.select({ tz: users.tz }).from(users).where(eq(users.id, userId)).get()
    return resolveUserTimeZone(u?.tz)
  }

  router.get('/', (c) => {
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const tz = getTz(db, authUser.id)
    const meetingFilter = c.req.query('meetingEventId')?.trim()

    const rows = db
      .select()
      .from(notes)
      .where(
        meetingFilter
          ? and(eq(notes.userId, authUser.id), eq(notes.meetingEventId, meetingFilter))
          : eq(notes.userId, authUser.id),
      )
      .orderBy(desc(notes.updatedAt), desc(notes.id))
      .limit(50)
      .all()

    return c.json({
      items: rows.map((r) => formatNoteDto(r, tz)),
    })
  })

  router.post('/transcribe', async (c) => {
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const wavBuf = await readBoundedAudio(c.req.raw, MAX_NOTE_VOICE_BYTES)
    if (wavBuf === 'too_large') {
      return c.json({ error: 'payload_too_large' }, 413)
    }
    if (wavBuf.length <= 44) {
      return c.json({ error: 'invalid_wav' }, 400)
    }

    const provider = options?.getProvider
      ? options.getProvider(authUser.id)
      : getProviderForUser(authUser.id, { db })
    if (!provider?.transcribeAudio) {
      return c.json({ error: 'stt_unavailable' }, 503)
    }

    try {
      const { transcript } = await provider.transcribeAudio(wavBuf, 'audio/wav')
      const cleaned = transcript.trim()
      if (!cleaned) {
        return c.json({ error: 'empty_transcript' }, 422)
      }

      const analysis = await analyzeNoteText({
        db,
        userId: authUser.id,
        text: cleaned,
        calendarClient: options?.calendarClient,
        nowMs: nowFn(),
      })

      logger.info('note_voice_transcribed', {
        userId: authUser.id,
        textLen: cleaned.length,
        hasMeetingMatch: Boolean(analysis.matchedMeeting),
        hasTaskReminder: Boolean(analysis.taskReminder),
      })

      return c.json(analysis)
    } catch (err) {
      logger.warn('note_voice_transcribe_failed', {
        userId: authUser.id,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
      return c.json({ error: 'transcribe_failed' }, 502)
    }
  })

  router.post('/', async (c) => {
    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    const parsed = createNoteSchema.safeParse(rawBody)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()
    const tz = getTz(db, authUser.id)

    const res = db
      .insert(notes)
      .values({
        userId: authUser.id,
        text: parsed.data.text,
        meetingEventId: parsed.data.meetingEventId ?? null,
        meetingTitle: parsed.data.meetingTitle ?? null,
        remindAt: parsed.data.remindAt ?? null,
        taskCompletedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const noteId = Number(res.lastInsertRowid)
    const row = db.select().from(notes).where(eq(notes.id, noteId)).get()!

    logger.info('note_created', {
      userId: authUser.id,
      noteId,
      textLen: row.text.length,
      hasReminder: row.remindAt !== null,
    })

    return c.json({ note: formatNoteDto(row, tz) }, 201)
  })

  router.put('/:id', async (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) return c.json({ error: 'invalid_id' }, 400)

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    const parsed = updateNoteSchema.safeParse(rawBody)
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const existing = db
      .select()
      .from(notes)
      .where(and(eq(notes.id, parsedId.data), eq(notes.userId, authUser.id)))
      .get()
    if (!existing) return c.json({ error: 'not_found' }, 404)

    const now = nowFn()
    db.update(notes)
      .set({
        text: parsed.data.text ?? existing.text,
        meetingEventId:
          parsed.data.meetingEventId !== undefined
            ? parsed.data.meetingEventId
            : existing.meetingEventId,
        meetingTitle:
          parsed.data.meetingTitle !== undefined
            ? parsed.data.meetingTitle
            : existing.meetingTitle,
        remindAt:
          parsed.data.remindAt !== undefined ? parsed.data.remindAt : existing.remindAt,
        updatedAt: now,
      })
      .where(eq(notes.id, existing.id))
      .run()

    const updated = db.select().from(notes).where(eq(notes.id, existing.id)).get()!
    logger.info('note_updated', {
      userId: authUser.id,
      noteId: existing.id,
      textLen: updated.text.length,
    })
    return c.json({ note: formatNoteDto(updated, getTz(db, authUser.id)) })
  })

  router.post('/:id/append-voice', async (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) return c.json({ error: 'invalid_id' }, 400)

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const existing = db
      .select()
      .from(notes)
      .where(and(eq(notes.id, parsedId.data), eq(notes.userId, authUser.id)))
      .get()
    if (!existing) return c.json({ error: 'not_found' }, 404)

    const wavBuf = await readBoundedAudio(c.req.raw, MAX_NOTE_VOICE_BYTES)
    if (wavBuf === 'too_large') return c.json({ error: 'payload_too_large' }, 413)
    if (wavBuf.length <= 44) return c.json({ error: 'invalid_wav' }, 400)

    const provider = options?.getProvider
      ? options.getProvider(authUser.id)
      : getProviderForUser(authUser.id, { db })
    if (!provider?.transcribeAudio) return c.json({ error: 'stt_unavailable' }, 503)

    try {
      const { transcript } = await provider.transcribeAudio(wavBuf, 'audio/wav')
      const added = transcript.trim()
      if (!added) return c.json({ error: 'empty_transcript' }, 422)

      const nextText = `${existing.text}\n${added}`.slice(0, 2000)
      const now = nowFn()
      db.update(notes)
        .set({ text: nextText, updatedAt: now })
        .where(eq(notes.id, existing.id))
        .run()

      const updated = db.select().from(notes).where(eq(notes.id, existing.id)).get()!
      logger.info('note_voice_appended', {
        userId: authUser.id,
        noteId: existing.id,
        addedLen: added.length,
      })
      return c.json({ note: formatNoteDto(updated, getTz(db, authUser.id)) })
    } catch {
      return c.json({ error: 'transcribe_failed' }, 502)
    }
  })

  router.post('/:id/done', (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) return c.json({ error: 'invalid_id' }, 400)
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()
    db.update(notes)
      .set({ taskCompletedAt: now, updatedAt: now })
      .where(and(eq(notes.id, parsedId.data), eq(notes.userId, authUser.id)))
      .run()
    return c.json({ ok: true })
  })

  router.post('/:id/snooze', (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) return c.json({ error: 'invalid_id' }, 400)
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()
    const nextRemindAt = now + 3600_000
    db.update(notes)
      .set({ remindAt: nextRemindAt, taskCompletedAt: null, updatedAt: now })
      .where(and(eq(notes.id, parsedId.data), eq(notes.userId, authUser.id)))
      .run()
    return c.json({ ok: true, remindAt: nextRemindAt })
  })

  router.delete('/:id', (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) return c.json({ error: 'invalid_id' }, 400)
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const res = db
      .delete(notes)
      .where(and(eq(notes.id, parsedId.data), eq(notes.userId, authUser.id)))
      .run()
    if (res.changes === 0) return c.json({ error: 'not_found' }, 404)
    logger.info('note_deleted', { userId: authUser.id, noteId: parsedId.data })
    return c.json({ ok: true })
  })

  return router
}

export function createPromisesRouter(options?: {
  db?: AppDb
  nowProvider?: () => number
}): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()
  const nowFn = options?.nowProvider ?? (() => Date.now())

  router.post('/', async (c) => {
    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    const parsed = createPromiseSchema.safeParse(rawBody)
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()

    const res = db
      .insert(promises)
      .values({
        userId: authUser.id,
        messageId: parsed.data.messageId ?? null,
        chatId: parsed.data.chatId,
        contactName: parsed.data.contactName,
        replyText: parsed.data.replyText,
        taskText: parsed.data.taskText,
        promisedAtTime: parsed.data.promisedAtTime,
        remindAt: parsed.data.remindAt,
        completedAt: null,
        createdAt: now,
      })
      .run()

    const promiseId = Number(res.lastInsertRowid)
    logger.info('promise_created', { userId: authUser.id, promiseId })
    return c.json({ ok: true, id: promiseId }, 201)
  })

  router.post('/:id/done', (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) return c.json({ error: 'invalid_id' }, 400)
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    db.update(promises)
      .set({ completedAt: nowFn() })
      .where(and(eq(promises.id, parsedId.data), eq(promises.userId, authUser.id)))
      .run()
    return c.json({ ok: true })
  })

  router.post('/:id/snooze', (c) => {
    const parsedId = idParamSchema.safeParse(c.req.param('id'))
    if (!parsedId.success) return c.json({ error: 'invalid_id' }, 400)
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const nextRemindAt = nowFn() + 3600_000
    db.update(promises)
      .set({ remindAt: nextRemindAt, completedAt: null })
      .where(and(eq(promises.id, parsedId.data), eq(promises.userId, authUser.id)))
      .run()
    return c.json({ ok: true, remindAt: nextRemindAt })
  })

  return router
}
