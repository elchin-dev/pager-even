import { and, desc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getProviderForUser, type LlmProvider } from '../ai/provider.js'
import { getDb, type AppDb } from '../db/index.js'
import { googleAccounts, messages, notes, users } from '../db/schema.js'
import { decryptSecret } from '../lib/crypto.js'
import {
  createDefaultGoogleCalendarClient,
  hasCalendarWriteScope,
  resolveUserTimeZone,
  type GoogleCalendarClient,
} from '../lib/google-calendar.js'
import { logger } from '../lib/logger.js'
import {
  fetchUserUpcomingMeetings,
  formatTimeHHMM,
  generateMeetingBriefSummary,
  getLocalDateKey,
  matchAttendeesToTelegramChats,
  rescheduleMeetingByMinutes,
  sendLateNoticeForMeeting,
  type MeetingBriefView,
  type MeetingListItem,
} from '../lib/meetings-service.js'
import { toOriginalLens } from '../lib/translit.js'
import type { AuthEnv } from '../middleware/auth.js'
import type { SendTelegramMessageFn } from './msg.js'

export function createMeetingsRouter(options?: {
  db?: AppDb
  calendarClient?: GoogleCalendarClient
  sendTelegramMessage?: SendTelegramMessageFn
  getProvider?: (userId: number) => LlmProvider | null
  nowProvider?: () => number
}): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()
  const calendarClient = options?.calendarClient ?? createDefaultGoogleCalendarClient()
  const nowFn = options?.nowProvider ?? (() => Date.now())

  router.get('/', async (c) => {
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()

    try {
      const { connected, hasWriteScope, tz, events } = await fetchUserUpcomingMeetings({
        db,
        userId: authUser.id,
        calendarClient,
        nowMs: now,
        horizonHours: 48,
      })

      const todayKey = getLocalDateKey(now, tz)
      const tomorrowKey = getLocalDateKey(now + 24 * 60 * 60 * 1000, tz)

      const filtered = events.filter((ev) => {
        const key = getLocalDateKey(ev.startMs, tz)
        return key === todayKey || key === tomorrowKey
      })

      const items: MeetingListItem[] = filtered.slice(0, 12).map((ev) => {
        const isTomorrow = getLocalDateKey(ev.startMs, tz) === tomorrowKey
        const diffMin = Math.round((ev.startMs - now) / 60_000)
        return {
          id: ev.id,
          title: toOriginalLens(ev.summary, 40) || 'Встреча',
          startTime: formatTimeHHMM(ev.startMs, tz),
          endTime: formatTimeHHMM(ev.endMs, tz),
          startMs: ev.startMs,
          endMs: ev.endMs,
          isTomorrow,
          minutesUntil: !isTomorrow && diffMin > 0 && diffMin < 60 ? diffMin : null,
          attendees: (ev.attendees ?? [])
            .filter((a) => !a.self)
            .map((a) => toOriginalLens(a.name.split(/\s+/)[0] || a.name, 14))
            .filter(Boolean)
            .slice(0, 3),
        }
      })

      const todayCount = items.filter((it) => !it.isTomorrow).length

      logger.info('meetings_fetched', {
        userId: authUser.id,
        todayCount,
        totalCount: items.length,
        connected,
      })

      return c.json({
        connected,
        hasWriteScope,
        todayCount,
        items,
      })
    } catch (err) {
      logger.warn('meetings_fetch_failed', {
        userId: authUser.id,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
      return c.json({ error: 'calendar_fetch_failed' }, 502)
    }
  })

  router.post('/create', async (c) => {
    const bodySchema = z.object({
      title: z.string().trim().min(1).max(120),
      startIso: z.string().trim().min(10),
      endIso: z.string().trim().min(10),
      description: z.string().trim().max(2000).optional(),
    })

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    const parsed = bodySchema.safeParse(rawBody)
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const account = db
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, authUser.id))
      .get()
    if (!account) return c.json({ error: 'calendar_not_connected' }, 400)
    if (!hasCalendarWriteScope(account.scope)) {
      return c.json({ error: 'calendar_readonly' }, 403)
    }

    const userRow = db
      .select({ tz: users.tz })
      .from(users)
      .where(eq(users.id, authUser.id))
      .get()
    const tz = resolveUserTimeZone(userRow?.tz)

    try {
      const refreshToken = decryptSecret(account.refreshTokenEnc)
      const created = await calendarClient.createEvent({
        refreshToken,
        summary: parsed.data.title,
        description: parsed.data.description,
        startIso: parsed.data.startIso,
        endIso: parsed.data.endIso,
        timeZone: tz,
      })
      logger.info('meeting_created', { userId: authUser.id, hasBrief: Boolean(parsed.data.description) })
      return c.json({ ok: true, eventId: created.eventId }, 201)
    } catch (err) {
      logger.warn('meeting_create_failed', {
        userId: authUser.id,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
      return c.json({ error: 'meeting_create_failed' }, 502)
    }
  })

  router.post('/brief-voice', async (c) => {
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const chatIdQuery = Number(c.req.query('chatId') ?? 0)
    const prevSaid = (c.req.query('prev') ?? '').trim()

    const reader = c.req.raw.body?.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > 4 * 1024 * 1024) {
            await reader.cancel()
            return c.json({ error: 'payload_too_large' }, 413)
          }
          chunks.push(value)
        }
      }
    }
    const wavBuf = Buffer.concat(chunks)
    if (wavBuf.length <= 44) return c.json({ error: 'invalid_wav' }, 400)

    const provider = options?.getProvider
      ? options.getProvider(authUser.id)
      : getProviderForUser(authUser.id, { db })
    if (!provider?.transcribeAudio) return c.json({ error: 'stt_unavailable' }, 503)

    try {
      const { transcript } = await provider.transcribeAudio(wavBuf, 'audio/wav')
      const spoken = transcript.trim()
      if (!spoken) return c.json({ error: 'empty_transcript' }, 422)

      const userSaid = prevSaid ? `${prevSaid} ${spoken}`.slice(0, 600) : spoken.slice(0, 600)

      let aiAdded = ''
      if (chatIdQuery) {
        const now = nowFn()
        const chatRows = db
          .select({
            fromName: messages.fromName,
            isFromOwner: messages.isFromOwner,
            text: messages.text,
          })
          .from(messages)
          .where(
            and(
              eq(messages.userId, authUser.id),
              eq(messages.chatId, chatIdQuery),
              gt(messages.expiresAt, now),
            ),
          )
          .orderBy(desc(messages.receivedAt), desc(messages.id))
          .limit(6)
          .all()
          .reverse()

        if (chatRows.length > 0) {
          const chatLog = chatRows
            .map((r) => `${r.isFromOwner ? 'Me' : r.fromName}: ${r.text.slice(0, 160)}`)
            .join('\n')
          try {
            const schema = z.object({ context: z.string().min(1).max(160) })
            const res = await provider.completeJson({
              system: `Extract important meeting context from the Telegram chat (what the other person asked for or expects) in 1 concise Russian sentence (<= 90 chars). Output ONLY raw JSON: {"context": string}.`,
              user: `My voice brief: ${userSaid}\n\nChat:\n${chatLog}`,
              schema,
              maxTokens: 90,
            })
            aiAdded = toOriginalLens(res.context, 90)
          } catch {
            const lastIncoming = [...chatRows].reverse().find((r) => !r.isFromOwner)
            if (lastIncoming) {
              aiAdded = toOriginalLens(lastIncoming.text, 80)
            }
          }
        }
      }

      const combinedDescription = [
        `Бриф: ${userSaid}`,
        aiAdded ? `Из переписки: ${aiAdded}` : '',
      ]
        .filter(Boolean)
        .join('\n')

      logger.info('meeting_voice_brief_prepared', {
        userId: authUser.id,
        userLen: userSaid.length,
        aiLen: aiAdded.length,
      })

      return c.json({
        userSaid: toOriginalLens(userSaid, 120),
        aiAdded,
        combinedDescription,
      })
    } catch {
      return c.json({ error: 'brief_voice_failed' }, 502)
    }
  })

  router.get('/:id', async (c) => {
    const eventId = c.req.param('id')?.trim()
    if (!eventId) {
      return c.json({ error: 'invalid_event_id' }, 400)
    }

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()

    try {
      const { hasWriteScope, tz, events } = await fetchUserUpcomingMeetings({
        db,
        userId: authUser.id,
        calendarClient,
        nowMs: now,
        horizonHours: 72,
      })

      const ev = events.find((item) => item.id === eventId)
      if (!ev) {
        return c.json({ error: 'not_found' }, 404)
      }

      const tomorrowKey = getLocalDateKey(now + 24 * 60 * 60 * 1000, tz)
      const isTomorrow = getLocalDateKey(ev.startMs, tz) === tomorrowKey
      const diffMin = Math.round((ev.startMs - now) / 60_000)

      const matchedChats = matchAttendeesToTelegramChats(db, authUser.id, ev.attendees)
      const provider = options?.getProvider ? options.getProvider(authUser.id) : undefined
      const summary = await generateMeetingBriefSummary({
        db,
        userId: authUser.id,
        event: ev,
        matchedChats,
        provider,
        nowMs: now,
      })

      const startTime = formatTimeHHMM(ev.startMs, tz)
      const endTime = formatTimeHHMM(ev.endMs, tz)
      const shiftedStart = formatTimeHHMM(ev.startMs + 30 * 60_000, tz)
      const shiftedEnd = formatTimeHHMM(ev.endMs + 30 * 60_000, tz)

      const noteRows = db
        .select({ id: notes.id })
        .from(notes)
        .where(and(eq(notes.userId, authUser.id), eq(notes.meetingEventId, ev.id)))
        .all()

      const brief: MeetingBriefView = {
        id: ev.id,
        title: toOriginalLens(ev.summary, 48) || 'Встреча',
        startTime,
        endTime,
        isTomorrow,
        minutesUntil: !isTomorrow && diffMin > 0 && diffMin < 60 ? diffMin : null,
        attendees: (ev.attendees ?? [])
          .filter((a) => !a.self)
          .map((a) => toOriginalLens(a.name.split(/\s+/)[0] || a.name, 14))
          .filter(Boolean)
          .slice(0, 3),
        summary,
        notesCount: noteRows.length,
        canSendLate: matchedChats.length > 0,
        lateRecipientName: matchedChats[0]?.fromName
          ? toOriginalLens(matchedChats[0].fromName, 20)
          : null,
        reschedulePreview: `${startTime} -> ${shiftedStart}-${shiftedEnd}`,
        hasWriteScope,
      }

      return c.json(brief)
    } catch (err) {
      logger.warn('meeting_brief_failed', {
        userId: authUser.id,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
      return c.json({ error: 'meeting_brief_failed' }, 502)
    }
  })

  router.post('/:id/late', async (c) => {
    const eventId = c.req.param('id')?.trim()
    if (!eventId) return c.json({ error: 'invalid_event_id' }, 400)

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()

    try {
      const { events } = await fetchUserUpcomingMeetings({
        db,
        userId: authUser.id,
        calendarClient,
        nowMs: now,
        horizonHours: 72,
      })
      const ev = events.find((item) => item.id === eventId)
      if (!ev) return c.json({ error: 'not_found' }, 404)

      const result = await sendLateNoticeForMeeting({
        db,
        userId: authUser.id,
        event: ev,
        sendTelegramMessage: options?.sendTelegramMessage,
      })

      if (result.sentCount === 0) {
        return c.json({ error: 'no_matched_attendee' }, 404)
      }

      logger.info('meeting_late_sent', {
        userId: authUser.id,
        sentCount: result.sentCount,
      })

      return c.json({ ok: true, sentCount: result.sentCount })
    } catch (err) {
      logger.warn('meeting_late_failed', {
        userId: authUser.id,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
      return c.json({ error: 'meeting_late_failed' }, 502)
    }
  })

  router.post('/:id/reschedule', async (c) => {
    const eventId = c.req.param('id')?.trim()
    if (!eventId) return c.json({ error: 'invalid_event_id' }, 400)

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()

    try {
      const { events, tz } = await fetchUserUpcomingMeetings({
        db,
        userId: authUser.id,
        calendarClient,
        nowMs: now,
        horizonHours: 72,
      })
      const ev = events.find((item) => item.id === eventId)
      if (!ev) return c.json({ error: 'not_found' }, 404)

      const res = await rescheduleMeetingByMinutes({
        db,
        userId: authUser.id,
        event: ev,
        shiftMinutes: 30,
        calendarClient,
        tz,
      })

      if (!res.ok) {
        return c.json({ error: res.error }, res.error === 'calendar_readonly' ? 403 : 400)
      }

      logger.info('meeting_rescheduled', {
        userId: authUser.id,
        shiftMinutes: 30,
      })

      return c.json({ ok: true, newRange: res.newRange })
    } catch (err) {
      logger.warn('meeting_reschedule_failed', {
        userId: authUser.id,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
      return c.json({ error: 'meeting_reschedule_failed' }, 502)
    }
  })

  return router
}
