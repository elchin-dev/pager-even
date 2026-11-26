import { Hono } from 'hono'
import type { LlmProvider } from '../ai/provider.js'
import { getDb, type AppDb } from '../db/index.js'
import {
  createDefaultGoogleCalendarClient,
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
        notesCount: 0,
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
