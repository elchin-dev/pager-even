import { and, desc, eq, gt, gte } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { triageResultSchema } from '../ai/triage.js'
import { getDb, type AppDb } from '../db/index.js'
import { googleAccounts, channels, digestPosts, messages, users } from '../db/schema.js'
import { decryptSecret } from '../lib/crypto.js'
import {
  createDefaultGoogleCalendarClient,
  resolveUserTimeZone,
  type CalendarEventItem,
  type GoogleCalendarClient,
} from '../lib/google-calendar.js'
import { logger } from '../lib/logger.js'
import { localClockToEpochMs } from '../lib/time-parser.js'
import { toOriginalLens } from '../lib/translit.js'
import type { AuthEnv } from '../middleware/auth.js'
import { getUserSettings, type UiLang } from './settings.js'

const homeAiSchema = triageResultSchema.extend({
  conflict: z
    .object({
      title: z.string(),
      start: z.string(),
      end: z.string(),
    })
    .nullable()
    .optional(),
})

export interface HomeSenderSummary {
  chatId: number
  name: string
  count: number
}

export interface HomeMeetingItem {
  id: string
  title: string
  startTime: string
  endTime: string
  minutesUntil: number | null
}

export interface HomeResponse {
  nowTime: string
  headerMeeting: string
  nextMeetingLine: string | null
  messages: {
    total: number
    urgent: number
    senders: HomeSenderSummary[]
  }
  meetings: {
    connected: boolean
    todayCount: number
    items: HomeMeetingItem[]
  }
  digest: {
    enabled: boolean
    count: number
  }
}

const CALENDAR_CACHE_TTL_MS = 30_000
const calendarCache = new Map<number, { fetchedAt: number; events: CalendarEventItem[] }>()

function formatTimeHHMM(ms: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms))
    const hh = parts.find((p) => p.type === 'hour')?.value ?? '00'
    const mm = parts.find((p) => p.type === 'minute')?.value ?? '00'
    return `${hh === '24' ? '00' : hh}:${mm}`
  } catch {
    return new Date(ms).toISOString().slice(11, 16)
  }
}

function getLocalDateKey(ms: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms))
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970'
    const m = parts.find((p) => p.type === 'month')?.value ?? '01'
    const d = parts.find((p) => p.type === 'day')?.value ?? '01'
    return `${y}-${m}-${d}`
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

function formatShortDate(ms: number, tz: string, lang: UiLang): string {
  try {
    const parts = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'ru-RU', {
      timeZone: tz,
      day: 'numeric',
      month: 'short',
    }).formatToParts(new Date(ms))
    const day = parts.find((p) => p.type === 'day')?.value ?? ''
    const month = (parts.find((p) => p.type === 'month')?.value ?? '').replace(/\.$/, '')
    return `${day} ${month}`.trim()
  } catch {
    return new Date(ms).toISOString().slice(5, 10)
  }
}

function shortSenderName(raw: string): string {
  const cleaned = toOriginalLens(raw, 20)
  const firstWord = cleaned.split(/\s+/)[0] || cleaned
  return toOriginalLens(firstWord, 12) || 'Chat'
}

function parseAi(raw: string | null) {
  if (!raw) return null
  try {
    const parsed = homeAiSchema.safeParse(JSON.parse(raw) as unknown)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function createHomeRouter(options?: {
  db?: AppDb
  calendarClient?: GoogleCalendarClient
  nowProvider?: () => number
}): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()
  const calendarClient = options?.calendarClient ?? createDefaultGoogleCalendarClient()
  const nowFn = options?.nowProvider ?? (() => Date.now())

  router.get('/', async (c) => {
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()

    const userRow = db
      .select({ tz: users.tz })
      .from(users)
      .where(eq(users.id, authUser.id))
      .get()
    const tz = resolveUserTimeZone(userRow?.tz)
    const nowTime = formatTimeHHMM(now, tz)
    const queryLang = c.req.query('lang')
    const uiLang: UiLang =
      queryLang === 'en' || queryLang === 'ru'
        ? queryLang
        : getUserSettings(db, authUser.id).uiLang

    // 1. Unread incoming messages grouped by chatId (newest first)
    const msgRows = db
      .select({
        chatId: messages.chatId,
        fromName: messages.fromName,
        aiJson: messages.aiJson,
        receivedAt: messages.receivedAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.userId, authUser.id),
          eq(messages.status, 'new'),
          eq(messages.isFromOwner, false),
          gt(messages.expiresAt, now),
        ),
      )
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .all()

    const sendersMap = new Map<number, HomeSenderSummary>()
    const urgentChats = new Set<number>()

    for (const row of msgRows) {
      const existing = sendersMap.get(row.chatId)
      if (existing) {
        existing.count += 1
      } else {
        sendersMap.set(row.chatId, {
          chatId: row.chatId,
          name: shortSenderName(row.fromName),
          count: 1,
        })
      }

      const ai = parseAi(row.aiJson)
      if (
        ai &&
        ai.drafts.length > 0 &&
        (ai.priority === 'urgent' || (ai.priority === 'needs_reply' && Boolean(ai.conflict)))
      ) {
        urgentChats.add(row.chatId)
      }
    }

    const topSenders = Array.from(sendersMap.values()).slice(0, 3)

    // 2. Upcoming Google Calendar events (best-effort, cached 30s)
    const googleRow = db
      .select({ refreshTokenEnc: googleAccounts.refreshTokenEnc })
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, authUser.id))
      .get()

    let upcomingEvents: CalendarEventItem[] = []
    const isGoogleConnected = Boolean(googleRow)

    if (googleRow && calendarClient.listUpcomingEvents) {
      const cached = calendarCache.get(authUser.id)
      if (cached && now - cached.fetchedAt < CALENDAR_CACHE_TTL_MS && !options?.calendarClient) {
        upcomingEvents = cached.events
      } else {
        try {
          const refreshToken = decryptSecret(googleRow.refreshTokenEnc)
          const timeMinIso = new Date(now).toISOString()
          const timeMaxIso = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString()
          upcomingEvents = await calendarClient.listUpcomingEvents({
            refreshToken,
            timeMinIso,
            timeMaxIso,
            maxResults: 20,
          })
          if (!options?.calendarClient) {
            calendarCache.set(authUser.id, { fetchedAt: now, events: upcomingEvents })
          }
        } catch (err) {
          logger.warn('home_calendar_fetch_failed', {
            userId: authUser.id,
            errorName: err instanceof Error ? err.name : 'unknown',
          })
          upcomingEvents = cached?.events ?? []
        }
      }
    }

    const todayKey = getLocalDateKey(now, tz)
    const tomorrowKey = getLocalDateKey(now + 24 * 60 * 60 * 1000, tz)

    const timedFuture = upcomingEvents
      .filter((ev) => !ev.allDay && ev.endMs > now)
      .sort((a, b) => a.startMs - b.startMs)

    const todayEvents = timedFuture.filter((ev) => getLocalDateKey(ev.startMs, tz) === todayKey)
    const nextTodayEvent = todayEvents.find((ev) => ev.startMs >= now) ?? todayEvents[0] ?? null

    let headerMeeting = uiLang === 'en' ? 'no meetings' : 'встреч нет'
    if (nextTodayEvent) {
      const shortTitle =
        toOriginalLens(nextTodayEvent.summary, 16) || (uiLang === 'en' ? 'Meeting' : 'Встреча')
      const diffMin = Math.round((nextTodayEvent.startMs - now) / 60_000)
      if (diffMin > 0 && diffMin < 60) {
        headerMeeting =
          uiLang === 'en'
            ? `${shortTitle} in ${diffMin} min`
            : `${shortTitle} через ${diffMin} мин`
      } else {
        headerMeeting = `${shortTitle} ${formatTimeHHMM(nextTodayEvent.startMs, tz)}`
      }
    }

    const nextAny = timedFuture.find((ev) => ev.startMs >= now) ?? null
    let nextMeetingLine: string | null = null
    if (nextAny) {
      const nextKey = getLocalDateKey(nextAny.startMs, tz)
      const startHHMM = formatTimeHHMM(nextAny.startMs, tz)
      const diffMin = Math.round((nextAny.startMs - now) / 60_000)
      if (nextKey === todayKey) {
        nextMeetingLine =
          diffMin > 0 && diffMin < 60
            ? uiLang === 'en'
              ? `next meeting in ${diffMin} min`
              : `след. встреча через ${diffMin} мин`
            : uiLang === 'en'
              ? `next meeting today ${startHHMM}`
              : `след. встреча сегодня ${startHHMM}`
      } else if (nextKey === tomorrowKey) {
        nextMeetingLine =
          uiLang === 'en'
            ? `next meeting tomorrow ${startHHMM}`
            : `след. встреча завтра ${startHHMM}`
      } else {
        nextMeetingLine =
          uiLang === 'en'
            ? `next meeting ${formatShortDate(nextAny.startMs, tz, 'en')} ${startHHMM}`
            : `след. встреча ${formatShortDate(nextAny.startMs, tz, 'ru')} ${startHHMM}`
      }
    }

    const meetingItems: HomeMeetingItem[] = todayEvents.slice(0, 10).map((ev) => {
      const diffMin = Math.round((ev.startMs - now) / 60_000)
      return {
        id: ev.id,
        title: toOriginalLens(ev.summary, 48) || 'Встреча',
        startTime: formatTimeHHMM(ev.startMs, tz),
        endTime: formatTimeHHMM(ev.endMs, tz),
        minutesUntil: diffMin > 0 && diffMin < 60 ? diffMin : null,
      }
    })

    logger.info('home_fetched', {
      userId: authUser.id,
      totalNew: msgRows.length,
      urgentChats: urgentChats.size,
      meetingsToday: todayEvents.length,
    })

    const userChannels = db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.userId, authUser.id))
      .all()
    const todayStartMs = localClockToEpochMs(now, tz, 0, 0, 0)
    const activeDigestPosts =
      userChannels.length > 0
        ? db
            .select({ id: digestPosts.id })
            .from(digestPosts)
            .where(
              and(
                eq(digestPosts.userId, authUser.id),
                gte(digestPosts.publishedAt, todayStartMs),
                gt(digestPosts.expiresAt, now),
              ),
            )
            .all()
        : []

    const response: HomeResponse = {
      nowTime,
      headerMeeting,
      nextMeetingLine,
      messages: {
        total: msgRows.length,
        urgent: urgentChats.size,
        senders: topSenders,
      },
      meetings: {
        connected: isGoogleConnected,
        todayCount: todayEvents.length,
        items: meetingItems,
      },
      digest: {
        enabled: userChannels.length > 0,
        count: activeDigestPosts.length,
      },
    }

    return c.json(response)
  })

  return router
}
