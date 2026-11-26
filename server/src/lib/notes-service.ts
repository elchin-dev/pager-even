import { and, desc, eq, isNull, lte } from 'drizzle-orm'
import { z } from 'zod'
import { getProviderForUser, type LlmProvider } from '../ai/provider.js'
import type { AppDb } from '../db/index.js'
import { notes, promises, users } from '../db/schema.js'
import type { CalendarEventItem, GoogleCalendarClient } from './google-calendar.js'
import { createDefaultGoogleCalendarClient, resolveUserTimeZone } from './google-calendar.js'
import { logger } from './logger.js'
import { fetchUserUpcomingMeetings, formatTimeHHMM } from './meetings-service.js'
import { dispatchReminderOnce, type SendBotReminderFn } from './reminders.js'
import { parseNoteTaskReminder } from './time-parser.js'
import { toOriginalLens } from './translit.js'
import { getUserSettings } from '../routes/settings.js'

export interface NoteDto {
  id: number
  text: string
  meetingEventId: string | null
  meetingTitle: string | null
  remindAt: number | null
  remindTime: string | null
  taskCompleted: boolean
  createdAt: number
  updatedAt: number
}

export interface NoteDraftAnalysis {
  transcript: string
  matchedMeeting: {
    eventId: string
    title: string
    startTime: string
    label: string
  } | null
  taskReminder: {
    remindAt: number
    label: string
  } | null
}

const DOMAIN_SYNONYMS: Array<RegExp[]> = [
  [/прайс|цен|стоим|скольк|тариф|бюджет|\$|доллар|руб|сум|оплат|price|cost|rate/iu],
  [/сайт|лендинг|дизайн|разработ|проект|макет|тз|под ключ/iu],
  [/адрес|офис|локац|где|куда|этаж/iu],
  [/реквизит|карт|счет|счёт|инн|перевод/iu],
]

function tokenizeMeaningful(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9$]+/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .map((w) => (w.length > 5 ? w.slice(0, 5) : w))
}

/**
 * Selects up to `maxNotes` notes that are semantically / lexically relevant
 * to `queryText`. Does NOT return unrelated notes so LLM context stays focused.
 */
export function findRelevantNotes(
  db: AppDb,
  userId: number,
  queryText: string,
  maxNotes = 3,
): Array<{ id: number; text: string }> {
  if (!queryText.trim()) return []

  const allNotes = db
    .select({
      id: notes.id,
      text: notes.text,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(60)
    .all()

  if (allNotes.length === 0) return []

  const queryStems = new Set(tokenizeMeaningful(queryText))
  const scored: Array<{ id: number; text: string; score: number }> = []

  for (const n of allNotes) {
    let score = 0
    const noteStems = tokenizeMeaningful(n.text)
    for (const ns of noteStems) {
      if (queryStems.has(ns)) {
        score += 3
      }
    }
    for (const group of DOMAIN_SYNONYMS) {
      const pat = group[0]!
      if (pat.test(queryText) && pat.test(n.text)) {
        score += 4
      }
    }
    if (score > 0) {
      scored.push({ id: n.id, text: n.text, score })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxNotes)
    .map(({ id, text }) => ({ id, text }))
}

export function matchNoteToCalendarMeeting(
  text: string,
  events: CalendarEventItem[],
  tz: string,
): NoteDraftAnalysis['matchedMeeting'] {
  if (events.length === 0 || !text.trim()) return null
  const noteStems = tokenizeMeaningful(text)
  if (noteStems.length === 0) return null

  for (const ev of events) {
    const titleStems = tokenizeMeaningful(ev.summary)
    const attendeeStems = (ev.attendees ?? [])
      .filter((a) => !a.self)
      .flatMap((a) => tokenizeMeaningful(a.name))
    const allTarget = [...titleStems, ...attendeeStems]
    const hit = noteStems.some((ns) =>
      allTarget.some((ts) => ts === ns || (ns.length >= 4 && ts.startsWith(ns))),
    )
    if (hit) {
      const startTime = formatTimeHHMM(ev.startMs, tz)
      const cleanTitle = toOriginalLens(ev.summary, 18) || 'Встреча'
      return {
        eventId: ev.id,
        title: cleanTitle,
        startTime,
        label: `${cleanTitle} ${startTime}`,
      }
    }
  }

  return null
}

export async function analyzeNoteText(params: {
  db: AppDb
  userId: number
  text: string
  calendarClient?: GoogleCalendarClient
  nowMs?: number
}): Promise<NoteDraftAnalysis> {
  const now = params.nowMs ?? Date.now()
  const userRow = params.db
    .select({ tz: users.tz })
    .from(users)
    .where(eq(users.id, params.userId))
    .get()
  const tz = resolveUserTimeZone(userRow?.tz)

  let upcoming: CalendarEventItem[] = []
  try {
    const cal = params.calendarClient ?? createDefaultGoogleCalendarClient()
    const fetched = await fetchUserUpcomingMeetings({
      db: params.db,
      userId: params.userId,
      calendarClient: cal,
      nowMs: now,
      horizonHours: 48,
    })
    upcoming = fetched.events
  } catch {
    upcoming = []
  }

  const matchedMeeting = matchNoteToCalendarMeeting(params.text, upcoming, tz)
  const taskReminder = parseNoteTaskReminder(params.text, now, tz)

  return {
    transcript: params.text,
    matchedMeeting,
    taskReminder,
  }
}

export function formatNoteDto(
  row: typeof notes.$inferSelect,
  tz: string,
): NoteDto {
  return {
    id: row.id,
    text: row.text,
    meetingEventId: row.meetingEventId,
    meetingTitle: row.meetingTitle,
    remindAt: row.remindAt,
    remindTime: row.remindAt ? formatTimeHHMM(row.remindAt, tz) : null,
    taskCompleted: row.taskCompletedAt !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const PROMISE_TASK_SCHEMA = z.object({
  task: z.string().min(1).max(60),
  question: z.string().min(1).max(60),
})

export async function extractPromiseTaskWithAi(params: {
  contactName: string
  incomingText: string
  replyText: string
  provider?: LlmProvider | null
}): Promise<{ taskText: string; promptQuestion: string }> {
  const shortContact = toOriginalLens(params.contactName.split(/\s+/)[0] || params.contactName, 16)
  const fallbackAction = params.incomingText.trim()
    ? toOriginalLens(params.incomingText, 36)
    : toOriginalLens(params.replyText, 36)
  const fallbackTask = `Ответить (${shortContact}): ${fallbackAction}`.slice(0, 56)
  const fallbackQuestion = 'Напомнить об обещании?'

  if (!params.provider) {
    return { taskText: fallbackTask, promptQuestion: fallbackQuestion }
  }

  try {
    const out = await params.provider.completeJson({
      system: `Extract what the user promised to do in a Telegram reply.
Return ONLY raw JSON in Russian:
{
  "task": string,     // Imperative phrase <= 42 chars including recipient name in dative if natural, e.g. "Скинуть Азизу КП"
  "question": string  // Short question <= 36 chars starting with "Напомнить ...", e.g. "Напомнить скинуть КП?"
}`,
      user: `Contact: ${shortContact}\nTheir message: ${params.incomingText}\nMy reply: ${params.replyText}`,
      schema: PROMISE_TASK_SCHEMA,
      maxTokens: 100,
    })
    return {
      taskText: toOriginalLens(out.task, 48) || fallbackTask,
      promptQuestion: toOriginalLens(out.question, 42) || fallbackQuestion,
    }
  } catch {
    return { taskText: fallbackTask, promptQuestion: fallbackQuestion }
  }
}

export async function runTaskAndPromiseReminderTick(options: {
  db: AppDb
  nowMs?: number
  sendBotReminder?: SendBotReminderFn
}): Promise<number> {
  const now = options.nowMs ?? Date.now()
  let count = 0

  // 1) Due note tasks
  const dueNotes = options.db
    .select({
      id: notes.id,
      userId: notes.userId,
      text: notes.text,
      remindAt: notes.remindAt,
      tgUserId: users.tgUserId,
      tz: users.tz,
    })
    .from(notes)
    .innerJoin(users, eq(users.id, notes.userId))
    .where(and(isNull(notes.taskCompletedAt), lte(notes.remindAt, now)))
    .all()

  for (const row of dueNotes) {
    if (!row.remindAt) continue
    const cfg = getUserSettings(options.db, row.userId)
    if (!cfg.taskReminders) continue

    const tz = resolveUserTimeZone(row.tz)
    const hhmm = formatTimeHHMM(row.remindAt, tz)
    const cleanTask = toOriginalLens(row.text, 90) || 'Задача'

    const sent = await dispatchReminderOnce({
      db: options.db,
      userId: row.userId,
      tgUserId: row.tgUserId,
      nowMs: now,
      sendBotReminder: options.sendBotReminder,
      payload: {
        kind: 'task',
        sourceKey: `task:${row.id}:${row.remindAt}`,
        telegramText: `Напоминание · ${hhmm}\n${cleanTask}`,
        buttons: [
          { text: 'Готово', callbackData: `tk:done:${row.id}` },
          { text: '+1 час', callbackData: `tk:snooze:${row.id}` },
        ],
        glasses: {
          kind: 'task',
          header: `Напоминание · ${hhmm}`,
          title: cleanTask,
          subtitle: 'Задача из заметки',
          noteId: row.id,
        },
      },
    })
    if (sent) {
      logger.info('task_reminder_sent', { userId: row.userId, noteId: row.id })
      count += 1
    }
  }

  // 2) Due promises from chat replies
  const duePromises = options.db
    .select({
      id: promises.id,
      userId: promises.userId,
      chatId: promises.chatId,
      taskText: promises.taskText,
      promisedAtTime: promises.promisedAtTime,
      remindAt: promises.remindAt,
      tgUserId: users.tgUserId,
      tz: users.tz,
    })
    .from(promises)
    .innerJoin(users, eq(users.id, promises.userId))
    .where(and(isNull(promises.completedAt), lte(promises.remindAt, now)))
    .all()

  for (const p of duePromises) {
    const cfg = getUserSettings(options.db, p.userId)
    if (!cfg.taskReminders) continue

    const tz = resolveUserTimeZone(p.tz)
    const hhmm = formatTimeHHMM(p.remindAt, tz)
    const cleanTask = toOriginalLens(p.taskText, 80)

    const sent = await dispatchReminderOnce({
      db: options.db,
      userId: p.userId,
      tgUserId: p.tgUserId,
      nowMs: now,
      sendBotReminder: options.sendBotReminder,
      payload: {
        kind: 'promise',
        sourceKey: `promise:${p.id}:${p.remindAt}`,
        telegramText: `Напоминание · ${hhmm}\n${cleanTask}\nТы обещал в чате в ${p.promisedAtTime}`,
        buttons: [
          { text: 'Готово', callbackData: `pr:done:${p.id}` },
          { text: '+1 час', callbackData: `pr:snooze:${p.id}` },
        ],
        glasses: {
          kind: 'promise',
          header: `Напоминание · ${hhmm}`,
          title: cleanTask,
          subtitle: `Ты обещал в чате в ${p.promisedAtTime}`,
          promiseId: p.id,
          chatId: p.chatId,
        },
      },
    })
    if (sent) {
      logger.info('promise_reminder_sent', { userId: p.userId, promiseId: p.id })
      count += 1
    }
  }

  return count
}
