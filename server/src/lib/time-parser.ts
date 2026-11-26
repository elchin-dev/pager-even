import { formatTimeHHMM, getLocalDateKey } from './meetings-service.js'

interface TzParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function getTzNumericParts(ms: number, tz: string): TzParts {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms))
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    const rawHour = get('hour')
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: rawHour === 24 ? 0 : rawHour,
      minute: get('minute'),
    }
  } catch {
    const d = new Date(ms)
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    }
  }
}

/**
 * Converts local (year, month, day + dayOffset, hour, minute) in `tz` to UTC epoch ms.
 */
export function localClockToEpochMs(
  baseNowMs: number,
  tz: string,
  dayOffset: number,
  hour: number,
  minute: number,
): number {
  const base = getTzNumericParts(baseNowMs, tz)
  const approxUtc = Date.UTC(base.year, base.month - 1, base.day + dayOffset, hour, minute, 0, 0)
  const check = getTzNumericParts(approxUtc, tz)
  const desiredUtcLike = Date.UTC(base.year, base.month - 1, base.day + dayOffset, hour, minute)
  const actualUtcLike = Date.UTC(check.year, check.month - 1, check.day, check.hour, check.minute)
  return approxUtc + (desiredUtcLike - actualUtcLike)
}

export function formatReminderWhenLabel(targetMs: number, nowMs: number, tz: string): string {
  const todayKey = getLocalDateKey(nowMs, tz)
  const tomorrowKey = getLocalDateKey(nowMs + 24 * 60 * 60 * 1000, tz)
  const targetKey = getLocalDateKey(targetMs, tz)
  const hhmm = formatTimeHHMM(targetMs, tz)
  if (targetKey === todayKey) {
    return `сегодня в ${hhmm}`
  }
  if (targetKey === tomorrowKey) {
    return `завтра ${hhmm}`
  }
  return hhmm
}

export interface ParsedTaskReminder {
  remindAt: number
  label: string
}

/**
 * Parses explicit or relative reminder expressions in a voice/text note, e.g.:
 * - "через 2 минуты напомни выпить воды"
 * - "через полчаса позвонить"
 * - "завтра в 10 напомни отправить счёт"
 * - "сегодня в 18:30 купить молоко"
 * - "напомни вечером проверить отчёт"
 */
export function parseNoteTaskReminder(
  text: string,
  nowMs: number,
  tz: string,
): ParsedTaskReminder | null {
  const lower = text.toLowerCase()
  const hasRemindCue =
    /(напомн|не забыть|задач|позвон|отправ|скин|провер|выпить|купить|сдела|встреч|remind|call|send)/iu.test(
      lower,
    )

  // 1) Relative: "через N мин/минут/час/часа/часов" or "через полчаса" / "через час" / "через минуту"
  if (/через\s+полчаса/iu.test(lower)) {
    const remindAt = nowMs + 30 * 60_000
    return { remindAt, label: formatReminderWhenLabel(remindAt, nowMs, tz) }
  }

  const relMinMatch = lower.match(/через\s+(\d{1,3})\s*(мин(?![\p{L}])|м(?![\p{L}])|минут|минуту|минуты)/iu)
  if (relMinMatch) {
    const mins = Math.max(1, Number(relMinMatch[1]))
    const remindAt = nowMs + mins * 60_000
    return {
      remindAt,
      label: `через ${mins} мин (${formatTimeHHMM(remindAt, tz)})`,
    }
  }

  if (/через\s+минут[уы](?![\p{L}])/iu.test(lower)) {
    const remindAt = nowMs + 60_000
    return { remindAt, label: `через 1 мин (${formatTimeHHMM(remindAt, tz)})` }
  }

  const relHourMatch = lower.match(/через\s+(\d{1,2})\s*(час(?![\p{L}])|часа|часов|ч(?![\p{L}]))/iu)
  if (relHourMatch) {
    const hrs = Math.max(1, Number(relHourMatch[1]))
    const remindAt = nowMs + hrs * 3600_000
    return { remindAt, label: formatReminderWhenLabel(remindAt, nowMs, tz) }
  }

  if (/через\s+час(?![\p{L}])/iu.test(lower)) {
    const remindAt = nowMs + 3600_000
    return { remindAt, label: formatReminderWhenLabel(remindAt, nowMs, tz) }
  }

  // 2) Clock time: "завтра в 10:30" / "завтра в 10" / "сегодня в 19:00" / "в 14:00"
  const isTomorrow = /(?<![\p{L}\p{N}])(завтра|tomorrow)(?![\p{L}\p{N}])/iu.test(lower)
  const isAfterTomorrow = /(?<![\p{L}\p{N}])послезавтра(?![\p{L}\p{N}])/iu.test(lower)
  const dayOffsetBase = isAfterTomorrow ? 2 : isTomorrow ? 1 : 0

  const clockMatch = lower.match(/(?<![\p{L}\p{N}])(?:в|at)\s*(\d{1,2})(?:[:.](\d{2}))?(?![\p{L}\p{N}])/iu)
  if (clockMatch && (hasRemindCue || isTomorrow || isAfterTomorrow || /сегодня/iu.test(lower))) {
    let hour = Number(clockMatch[1])
    const minute = clockMatch[2] ? Number(clockMatch[2]) : 0
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      if (/вечер/iu.test(lower) && hour >= 1 && hour <= 11) {
        hour += 12
      }
      let remindAt = localClockToEpochMs(nowMs, tz, dayOffsetBase, hour, minute)
      if (dayOffsetBase === 0 && remindAt <= nowMs + 30_000) {
        remindAt = localClockToEpochMs(nowMs, tz, 1, hour, minute)
      }
      const label = formatReminderWhenLabel(remindAt, nowMs, tz).replace(/^сегодня в /, 'сегодня ')
      return { remindAt, label }
    }
  }

  // 3) Named times of day with remind cue ("напомни вечером", "завтра утром")
  if (hasRemindCue || isTomorrow) {
    if (/(?<![\p{L}\p{N}])(вечером|сегодня вечером|tonight)(?![\p{L}\p{N}])/iu.test(lower)) {
      let remindAt = localClockToEpochMs(nowMs, tz, dayOffsetBase, 19, 0)
      if (remindAt <= nowMs + 60_000) {
        remindAt = localClockToEpochMs(nowMs, tz, dayOffsetBase + 1, 19, 0)
      }
      return { remindAt, label: formatReminderWhenLabel(remindAt, nowMs, tz) }
    }
    if (/(?<![\p{L}\p{N}])(утром|завтра утром)(?![\p{L}\p{N}])/iu.test(lower)) {
      let remindAt = localClockToEpochMs(nowMs, tz, isTomorrow ? 1 : 0, 9, 0)
      if (remindAt <= nowMs + 60_000) {
        remindAt = localClockToEpochMs(nowMs, tz, 1, 9, 0)
      }
      return { remindAt, label: formatReminderWhenLabel(remindAt, nowMs, tz) }
    }
    if (isTomorrow && hasRemindCue) {
      const remindAt = localClockToEpochMs(nowMs, tz, 1, 9, 0)
      return { remindAt, label: formatReminderWhenLabel(remindAt, nowMs, tz) }
    }
  }

  return null
}

export interface PromiseTimeOption {
  label: string
  remindAt: number
}

export function resolvePromiseReminderTimes(
  replyText: string,
  nowMs: number,
  tz: string,
): {
  defaultOption: PromiseTimeOption
  altOptions: PromiseTimeOption[]
} | null {
  const lower = replyText.toLowerCase()
  const hasPromiseVerb =
    /(скину|отправлю|пришлю|вышлю|отвечу|напишу|позвоню|наберу|перезвоню|проверю|посмотрю|гляну|уточню|сделаю|подготовлю|вернусь|will send|will reply|will call|will check|send later|call you|back in|get back)/iu.test(
      lower,
    )
  const hasDeferCue =
    /(вечером|утром|завтра|послезавтра|через\s+\d+|через\s+час|через\s+полчаса|чуть позже|позже|скоро|tonight|tomorrow|in \d+\s*min|in an hour|shortly|later)/iu.test(
      lower,
    )

  if (!hasPromiseVerb && !hasDeferCue) {
    return null
  }
  // Pure decline ("Нет, не смогу", "Не знаю") is NOT a promise
  if (/^\s*(нет|не смогу|не знаю|не получится|no(?![\p{L}]))/iu.test(lower) && !hasPromiseVerb) {
    return null
  }

  let targetMs: number | null = null
  const isTomorrow = /(?<![\p{L}\p{N}])(завтра|tomorrow)(?![\p{L}\p{N}])/iu.test(lower)

  const relMin = lower.match(/через\s+(\d{1,3})\s*(мин|минут|минуту|минуты|min)/iu)
  const relHour = lower.match(/через\s+(\d{1,2})\s*(час(?![\p{L}])|часа|часов|ч(?![\p{L}])|hour)/iu)
  const clockMatch = lower.match(/(?<![\p{L}\p{N}])(?:в|at|до)\s*(\d{1,2})(?:[:.](\d{2}))?(?![\p{L}\p{N}])/iu)

  if (relMin) {
    targetMs = nowMs + Math.max(1, Number(relMin[1])) * 60_000
  } else if (/через\s+полчаса/iu.test(lower)) {
    targetMs = nowMs + 30 * 60_000
  } else if (relHour) {
    targetMs = nowMs + Math.max(1, Number(relHour[1])) * 3600_000
  } else if (/через\s+час(?![\p{L}])|(?<![\p{L}])in an hour(?![\p{L}])/iu.test(lower)) {
    targetMs = nowMs + 3600_000
  } else if (clockMatch) {
    const hh = Number(clockMatch[1])
    const mm = clockMatch[2] ? Number(clockMatch[2]) : 0
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      targetMs = localClockToEpochMs(nowMs, tz, isTomorrow ? 1 : 0, hh, mm)
      if (!isTomorrow && targetMs <= nowMs + 60_000) {
        targetMs = localClockToEpochMs(nowMs, tz, 1, hh, mm)
      }
    }
  } else if (/(?<![\p{L}\p{N}])(вечером|tonight)(?![\p{L}\p{N}])/iu.test(lower)) {
    targetMs = localClockToEpochMs(nowMs, tz, isTomorrow ? 1 : 0, 19, 0)
    if (targetMs <= nowMs + 60_000) {
      targetMs = localClockToEpochMs(nowMs, tz, 1, 19, 0)
    }
  } else if (/(?<![\p{L}\p{N}])утром(?![\p{L}\p{N}])/iu.test(lower)) {
    targetMs = localClockToEpochMs(nowMs, tz, isTomorrow ? 1 : 0, 9, 0)
    if (targetMs <= nowMs + 60_000) {
      targetMs = localClockToEpochMs(nowMs, tz, 1, 9, 0)
    }
  } else if (isTomorrow) {
    targetMs = localClockToEpochMs(nowMs, tz, 1, 9, 0)
  } else if (hasPromiseVerb) {
    // e.g. "Проверю и напишу", "Отвечу чуть позже" -> default +1 hour
    targetMs = nowMs + 3600_000
  }

  if (!targetMs) return null

  const todayKey = getLocalDateKey(nowMs, tz)
  const tomorrowKey = getLocalDateKey(nowMs + 24 * 60 * 60 * 1000, tz)
  const targetKey = getLocalDateKey(targetMs, tz)
  const hhmm = formatTimeHHMM(targetMs, tz)

  let defaultLabel: string
  if (targetKey === todayKey) {
    defaultLabel = `Да, сегодня в ${hhmm}`
  } else if (targetKey === tomorrowKey) {
    defaultLabel = `Да, завтра в ${hhmm}`
  } else {
    defaultLabel = `Да, в ${hhmm}`
  }

  const altOptions: PromiseTimeOption[] = [
    { label: 'Через 1 час', remindAt: nowMs + 3600_000 },
    { label: 'Завтра 9:00', remindAt: localClockToEpochMs(nowMs, tz, 1, 9, 0) },
    { label: 'Завтра 19:00', remindAt: localClockToEpochMs(nowMs, tz, 1, 19, 0) },
  ]

  return {
    defaultOption: { label: defaultLabel, remindAt: targetMs },
    altOptions,
  }
}

export interface ProposedMeetingTime {
  startMs: number
  endMs: number
  displayWhen: string // e.g. "Завтра 15:30-16:00"
  shortWhen: string   // e.g. "завтра 15:30"
}

/**
 * Extracts a proposed meeting/call time from an incoming message using deterministic code:
 * e.g. "Созвон завтра в 15:30?", "Встретимся сегодня в 17:00?", "Can we call tomorrow at 14:00?"
 */
export function parseProposedMeetingTime(
  text: string,
  nowMs: number,
  tz: string,
): ProposedMeetingTime | null {
  const lower = text.toLowerCase()
  const isLunchMention =
    /(?<![\p{L}\p{N}])(во время обеда|в обед|на обед|в обеденное время)(?![\p{L}\p{N}])/iu.test(
      lower,
    )
  const hasMeetingCue =
    /(созвон|звонок|встрет|встреч|митинг|синк|зум|zoom|meet|call|sync|кофе|обсуд|слот|удобно|сможешь|свобод|занят|план)/iu.test(
      lower,
    )
  if (!hasMeetingCue && !isLunchMention) return null

  const isTomorrow = /(?<![\p{L}\p{N}])(завтра|tomorrow)(?![\p{L}\p{N}])/iu.test(lower)
  const isAfterTomorrow = /(?<![\p{L}\p{N}])послезавтра(?![\p{L}\p{N}])/iu.test(lower)
  const dayOffset = isAfterTomorrow ? 2 : isTomorrow ? 1 : 0

  const timeMatch =
    lower.match(/(?<![\p{L}\p{N}])(?:в|на|at|к)\s*(\d{1,2})(?:[:.\s](\d{2}))?(?![\p{L}\p{N}])/iu) ??
    lower.match(/(?<![\p{N}])(\d{1,2})[:.](\d{2})(?![\p{N}])/u) ??
    lower.match(/(?<![\p{L}\p{N}])(\d{1,2})\s+(00|15|30|45)(?![\p{L}\p{N}])/u)

  let hour: number
  let minute: number
  let durationMinutes = 30

  if (timeMatch) {
    hour = Number(timeMatch[1])
    minute = timeMatch[2] ? Number(timeMatch[2]) : 0
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    if (/вечер|дня/iu.test(lower) && hour >= 1 && hour <= 7) {
      hour += 12
    }
  } else if (isLunchMention) {
    hour = 13
    minute = 0
    durationMinutes = 60
  } else {
    return null
  }

  let startMs = localClockToEpochMs(nowMs, tz, dayOffset, hour, minute)
  if (dayOffset === 0 && startMs <= nowMs - 15 * 60_000) {
    startMs = localClockToEpochMs(nowMs, tz, 1, hour, minute)
  }
  const endMs = startMs + durationMinutes * 60_000

  const todayKey = getLocalDateKey(nowMs, tz)
  const tomorrowKey = getLocalDateKey(nowMs + 24 * 60 * 60 * 1000, tz)
  const targetKey = getLocalDateKey(startMs, tz)
  const startHHMM = formatTimeHHMM(startMs, tz)
  const endHHMM = formatTimeHHMM(endMs, tz)

  const dayWordCap =
    targetKey === todayKey ? 'Сегодня' : targetKey === tomorrowKey ? 'Завтра' : 'Послезавтра'
  const dayWordLow = dayWordCap.toLowerCase()

  return {
    startMs,
    endMs,
    displayWhen: `${dayWordCap} ${startHHMM}-${endHHMM}`,
    shortWhen: `${dayWordLow} ${startHHMM}`,
  }
}
