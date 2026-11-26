import { and, desc, eq, gt, isNotNull } from 'drizzle-orm'
import { Api } from 'grammy'
import { z } from 'zod'
import { getProviderForUser, type LlmProvider } from '../ai/provider.js'
import type { AppDb } from '../db/index.js'
import { googleAccounts, messages, notes, users } from '../db/schema.js'
import { decryptSecret } from './crypto.js'
import { runChannelsDigestTick } from './digest-service.js'
import { getUserSettings } from '../routes/settings.js'
import {
  createDefaultGoogleCalendarClient,
  hasCalendarWriteScope,
  resolveUserTimeZone,
  type CalendarAttendee,
  type CalendarEventItem,
  type GoogleCalendarClient,
} from './google-calendar.js'
import { logger } from './logger.js'
import { findRelevantNotes } from './notes-service.js'
import { dispatchReminderOnce, type SendBotReminderFn } from './reminders.js'
import { toOriginalLens } from './translit.js'
import type { SendTelegramMessageFn } from '../routes/msg.js'

const DEFAULT_REMINDER_MINUTES = 10
const BRIEF_SCHEMA = z.object({
  summary: z.string().min(1).max(200),
})

export interface MatchedAttendeeChat {
  attendeeName: string
  chatId: number
  fromName: string
  businessConnectionId: string
}

export interface MeetingListItem {
  id: string
  title: string
  startTime: string
  endTime: string
  startMs: number
  endMs: number
  isTomorrow: boolean
  minutesUntil: number | null
  attendees: string[]
}

export interface MeetingBriefView {
  id: string
  title: string
  startTime: string
  endTime: string
  isTomorrow: boolean
  minutesUntil: number | null
  attendees: string[]
  summary: string
  notesCount: number
  canSendLate: boolean
  lateRecipientName: string | null
  reschedulePreview: string
  hasWriteScope: boolean
}

export function formatTimeHHMM(ms: number, tz: string): string {
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

export function getLocalDateKey(ms: number, tz: string): string {
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

export function resolveEventReminderMinutes(ev: CalendarEventItem): number {
  if (typeof ev.reminderMinutes === 'number' && ev.reminderMinutes > 0) {
    return ev.reminderMinutes
  }
  if (typeof ev.defaultReminderMinutes === 'number' && ev.defaultReminderMinutes > 0) {
    return ev.defaultReminderMinutes
  }
  return DEFAULT_REMINDER_MINUTES
}

function normalizeNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]+/gi, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length >= 3)
}

export function matchAttendeesToTelegramChats(
  db: AppDb,
  userId: number,
  attendees: CalendarAttendee[] | undefined,
): MatchedAttendeeChat[] {
  const nonSelf = (attendees ?? []).filter((a) => !a.self)
  if (nonSelf.length === 0) return []

  const recentChats = db
    .select({
      chatId: messages.chatId,
      fromName: messages.fromName,
      businessConnectionId: messages.businessConnectionId,
    })
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.isFromOwner, false),
        isNotNull(messages.businessConnectionId),
      ),
    )
    .orderBy(desc(messages.receivedAt), desc(messages.id))
    .limit(100)
    .all()

  const uniqueChats = new Map<number, { fromName: string; businessConnectionId: string }>()
  for (const row of recentChats) {
    if (!uniqueChats.has(row.chatId) && row.businessConnectionId) {
      uniqueChats.set(row.chatId, {
        fromName: row.fromName,
        businessConnectionId: row.businessConnectionId,
      })
    }
  }

  const matched: MatchedAttendeeChat[] = []
  const usedChatIds = new Set<number>()

  for (const attendee of nonSelf) {
    const attendeeTokens = normalizeNameTokens(attendee.name)
    if (attendeeTokens.length === 0) continue

    for (const [chatId, chat] of uniqueChats.entries()) {
      if (usedChatIds.has(chatId)) continue
      const chatTokens = normalizeNameTokens(chat.fromName)
      const isMatch = attendeeTokens.some((at) =>
        chatTokens.some((ct) => ct === at || (at.length >= 4 && ct.startsWith(at)) || (ct.length >= 4 && at.startsWith(ct))),
      )
      if (isMatch) {
        usedChatIds.add(chatId)
        matched.push({
          attendeeName: attendee.name,
          chatId,
          fromName: chat.fromName,
          businessConnectionId: chat.businessConnectionId,
        })
        break
      }
    }
  }

  return matched
}

export async function generateMeetingBriefSummary(params: {
  db: AppDb
  userId: number
  event: CalendarEventItem
  matchedChats: MatchedAttendeeChat[]
  provider?: LlmProvider | null
  nowMs?: number
}): Promise<string> {
  const now = params.nowMs ?? Date.now()
  const eventDescription = params.event.description?.trim() ?? ''

  const attachedNotes = params.db
    .select({ id: notes.id, text: notes.text })
    .from(notes)
    .where(and(eq(notes.userId, params.userId), eq(notes.meetingEventId, params.event.id)))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(5)
    .all()
  const attachedIds = new Set(attachedNotes.map((n) => n.id))
  const matchedUnlinkedNotes = findRelevantNotes(
    params.db,
    params.userId,
    params.event.summary,
    3,
  ).filter((n) => !attachedIds.has(n.id))
  const noteSnippets = [...attachedNotes, ...matchedUnlinkedNotes]
    .slice(0, 5)
    .map((n) => n.text.slice(0, 160))
    .filter(Boolean)

  const chatSnippets: string[] = []
  for (const match of params.matchedChats.slice(0, 3)) {
    const rows = params.db
      .select({
        fromName: messages.fromName,
        isFromOwner: messages.isFromOwner,
        text: messages.text,
      })
      .from(messages)
      .where(
        and(
          eq(messages.userId, params.userId),
          eq(messages.chatId, match.chatId),
          gt(messages.expiresAt, now),
        ),
      )
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .limit(3)
      .all()
      .reverse()

    for (const r of rows) {
      if (r.text.trim()) {
        chatSnippets.push(`${r.isFromOwner ? 'You' : r.fromName}: ${r.text.slice(0, 140)}`)
      }
    }
  }

  if (!eventDescription && noteSnippets.length === 0 && chatSnippets.length === 0) {
    return 'Без описания'
  }

  const fallbackParts: string[] = []
  if (eventDescription) fallbackParts.push(eventDescription)
  if (noteSnippets[0]) fallbackParts.push(`Заметка: ${noteSnippets[0]}`)
  if (fallbackParts.length === 0 && chatSnippets.length > 0) {
    fallbackParts.push(chatSnippets[chatSnippets.length - 1] ?? '')
  }
  const fallbackText = toOriginalLens(fallbackParts.filter(Boolean).join(' · '), 130)

  const provider =
    params.provider !== undefined
      ? params.provider
      : getProviderForUser(params.userId, { db: params.db })

  if (!provider) {
    return fallbackText || 'Без описания'
  }

  try {
    const res = await provider.completeJson({
      system: `You summarize a calendar meeting brief for smart glasses in 1-2 short lines (<= 130 chars total) in Russian (keep original names/terms).
Combine the event description, attached/matching user notes (MUST include key points from notes if present), and recent Telegram chat context with attendees (if provided).
Output ONLY raw JSON: {"summary": string}. No markdown, no quotes around the summary.`,
      user: [
        `Event title: ${params.event.summary}`,
        eventDescription ? `Description: ${eventDescription.slice(0, 400)}` : '',
        noteSnippets.length > 0 ? `User notes for this meeting:\n${noteSnippets.join('\n')}` : '',
        chatSnippets.length > 0 ? `Recent Telegram messages:\n${chatSnippets.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      schema: BRIEF_SCHEMA,
      maxTokens: 140,
    })
    return toOriginalLens(res.summary, 130) || fallbackText || 'Без описания'
  } catch {
    return fallbackText || 'Без описания'
  }
}

export async function fetchUserUpcomingMeetings(params: {
  db: AppDb
  userId: number
  calendarClient: GoogleCalendarClient
  nowMs: number
  horizonHours?: number
}): Promise<{
  connected: boolean
  hasWriteScope: boolean
  tz: string
  events: CalendarEventItem[]
}> {
  const userRow = params.db
    .select({ tz: users.tz })
    .from(users)
    .where(eq(users.id, params.userId))
    .get()
  const tz = resolveUserTimeZone(userRow?.tz)

  const account = params.db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.userId, params.userId))
    .get()

  if (!account || !params.calendarClient.listUpcomingEvents) {
    return {
      connected: Boolean(account),
      hasWriteScope: hasCalendarWriteScope(account?.scope),
      tz,
      events: [],
    }
  }

  const refreshToken = decryptSecret(account.refreshTokenEnc)
  const horizonMs = (params.horizonHours ?? 48) * 60 * 60 * 1000
  const rawEvents = await params.calendarClient.listUpcomingEvents({
    refreshToken,
    timeMinIso: new Date(params.nowMs).toISOString(),
    timeMaxIso: new Date(params.nowMs + horizonMs).toISOString(),
    maxResults: 30,
  })

  const timedEvents = rawEvents
    .filter((ev) => !ev.allDay && ev.endMs > params.nowMs)
    .sort((a, b) => a.startMs - b.startMs)

  return {
    connected: true,
    hasWriteScope: hasCalendarWriteScope(account.scope),
    tz,
    events: timedEvents,
  }
}

export async function sendLateNoticeForMeeting(params: {
  db: AppDb
  userId: number
  event: CalendarEventItem
  sendTelegramMessage?: SendTelegramMessageFn
}): Promise<{ sentCount: number; recipientName: string | null }> {
  const matched = matchAttendeesToTelegramChats(params.db, params.userId, params.event.attendees)
  if (matched.length === 0) {
    return { sentCount: 0, recipientName: null }
  }

  const sender: SendTelegramMessageFn =
    params.sendTelegramMessage ??
    (async ({ chatId, text, businessConnectionId }) => {
      const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
      const sent = await new Api(token).sendMessage(chatId, text, {
        business_connection_id: businessConnectionId,
      })
      return { messageId: sent.message_id }
    })

  let sentCount = 0
  for (const target of matched) {
    await sender({
      chatId: target.chatId,
      text: 'Опаздываю на 5 мин',
      businessConnectionId: target.businessConnectionId,
    })
    sentCount += 1
  }

  return { sentCount, recipientName: matched[0]?.fromName ?? null }
}

export async function rescheduleMeetingByMinutes(params: {
  db: AppDb
  userId: number
  event: CalendarEventItem
  shiftMinutes: number
  calendarClient: GoogleCalendarClient
  tz: string
}): Promise<{ ok: true; newRange: string } | { ok: false; error: 'calendar_readonly' | 'calendar_not_connected' }> {
  const account = params.db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.userId, params.userId))
    .get()

  if (!account) {
    return { ok: false, error: 'calendar_not_connected' }
  }
  if (!hasCalendarWriteScope(account.scope)) {
    return { ok: false, error: 'calendar_readonly' }
  }
  if (!params.calendarClient.rescheduleEvent) {
    throw new Error('rescheduleEvent not supported by calendar client')
  }

  const shiftMs = params.shiftMinutes * 60_000
  const newStartMs = params.event.startMs + shiftMs
  const newEndMs = params.event.endMs + shiftMs
  const refreshToken = decryptSecret(account.refreshTokenEnc)

  await params.calendarClient.rescheduleEvent({
    refreshToken,
    eventId: params.event.id,
    startIso: new Date(newStartMs).toISOString(),
    endIso: new Date(newEndMs).toISOString(),
    timeZone: params.tz,
  })

  return {
    ok: true,
    newRange: `${formatTimeHHMM(newStartMs, params.tz)}-${formatTimeHHMM(newEndMs, params.tz)}`,
  }
}

export async function runMeetingReminderTick(options: {
  db: AppDb
  calendarClient?: GoogleCalendarClient
  nowMs?: number
  getProvider?: (userId: number) => LlmProvider | null
  sendBotReminder?: SendBotReminderFn
}): Promise<number> {
  const now = options.nowMs ?? Date.now()
  const calendarClient = options.calendarClient ?? createDefaultGoogleCalendarClient()

  const accounts = options.db
    .select({
      userId: googleAccounts.userId,
      tgUserId: users.tgUserId,
      tz: users.tz,
    })
    .from(googleAccounts)
    .innerJoin(users, eq(users.id, googleAccounts.userId))
    .all()

  let dispatchedCount = 0

  for (const acc of accounts) {
    try {
      const userCfg = getUserSettings(options.db, acc.userId)
      if (!userCfg.meetingReminders) continue

      const { events, tz } = await fetchUserUpcomingMeetings({
        db: options.db,
        userId: acc.userId,
        calendarClient,
        nowMs: now,
        horizonHours: 24,
      })

      for (const ev of events) {
        if (ev.allDay || ev.startMs <= now) continue
        const leadMinutes = resolveEventReminderMinutes(ev)
        const diffMs = ev.startMs - now
        if (diffMs > leadMinutes * 60_000) continue

        const minsLeft = Math.max(1, Math.round(diffMs / 60_000))
        const startHHMM = formatTimeHHMM(ev.startMs, tz)
        const endHHMM = formatTimeHHMM(ev.endMs, tz)
        const attendeeNames = (ev.attendees ?? [])
          .filter((a) => !a.self)
          .map((a) => toOriginalLens(a.name.split(/\s+/)[0] || a.name, 14))
          .filter(Boolean)
          .slice(0, 3)

        const matchedChats = matchAttendeesToTelegramChats(options.db, acc.userId, ev.attendees)
        const provider = options.getProvider ? options.getProvider(acc.userId) : undefined
        const summary = userCfg.briefAlerts
          ? await generateMeetingBriefSummary({
              db: options.db,
              userId: acc.userId,
              event: ev,
              matchedChats,
              provider,
              nowMs: now,
            })
          : ''

        const attachedNotes = userCfg.briefAlerts
          ? options.db
              .select({ text: notes.text })
              .from(notes)
              .where(and(eq(notes.userId, acc.userId), eq(notes.meetingEventId, ev.id)))
              .limit(3)
              .all()
          : []
        const notesLine =
          attachedNotes.length > 0
            ? `Заметки (${attachedNotes.length}): ${attachedNotes.map((n) => toOriginalLens(n.text, 50)).join(' · ')}`
            : ''

        const attendeePart = attendeeNames.length > 0 ? ` · ${attendeeNames.join(', ')}` : ''
        const titleClean = toOriginalLens(ev.summary, 48) || 'Встреча'
        const telegramLines = [
          `Через ${minsLeft} мин: ${titleClean} · ${startHHMM}-${endHHMM}${attendeePart}`,
          summary && summary !== 'Без описания' ? summary : '',
          notesLine,
        ].filter(Boolean)

        const sent = await dispatchReminderOnce({
          db: options.db,
          userId: acc.userId,
          tgUserId: acc.tgUserId,
          nowMs: now,
          sendBotReminder: options.sendBotReminder,
          payload: {
            kind: 'meeting',
            sourceKey: `meeting:${ev.id}:${ev.startMs}`,
            telegramText: telegramLines.join('\n'),
            buttons: [
              { text: 'Опаздываю 5 мин', callbackData: `mt:late:${ev.id.slice(0, 48)}` },
              { text: 'Перенести +30', callbackData: `mt:shift:${ev.id.slice(0, 48)}` },
            ],
            glasses: {
              kind: 'meeting',
              header: 'Встреча',
              title: titleClean,
              subtitle: `${startHHMM}-${endHHMM}${attendeePart}`,
              eventId: ev.id,
            },
          },
        })

        if (sent) {
          dispatchedCount += 1
        }
      }
    } catch (err) {
      logger.warn('meeting_reminder_tick_user_failed', {
        userId: acc.userId,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
    }
  }

  return dispatchedCount
}

export function startMeetingReminderScheduler(options: {
  db: AppDb
  calendarClient?: GoogleCalendarClient
  intervalMs?: number
}): () => void {
  const intervalMs = options.intervalMs ?? 60_000
  const timer = setInterval(() => {
    void runMeetingReminderTick({
      db: options.db,
      calendarClient: options.calendarClient,
    })
    void import('./notes-service.js').then(({ runTaskAndPromiseReminderTick }) =>
      runTaskAndPromiseReminderTick({ db: options.db }),
    )
    void runChannelsDigestTick({ db: options.db })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
