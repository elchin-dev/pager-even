import type { CalendarEventItem } from './google-calendar.js'
import { formatTimeHHMM, getLocalDateKey } from './meetings-service.js'
import { parseProposedMeetingTime } from './time-parser.js'
import { toOriginalLens } from './translit.js'

export interface ProposedAltSlot {
  label: string
  startIso: string
  endIso: string
  displayWhen: string
}

export interface ProposedMeetingEvaluation {
  title: string
  startMs: number
  endMs: number
  startIso: string
  endIso: string
  displayWhen: string
  shortWhen: string
  isFree: boolean
  conflict: {
    title: string
    start: string
    end: string
    cardLine: string
    freeReplyDraft: string | null
  } | null
  altSlots: ProposedAltSlot[]
}

function hasOverlap(
  events: CalendarEventItem[],
  startMs: number,
  endMs: number,
): CalendarEventItem | null {
  for (const ev of events) {
    if (ev.allDay) continue
    if (ev.startMs < endMs && ev.endMs > startMs) {
      return ev
    }
  }
  return null
}

function findNearbyFreeSlots(
  events: CalendarEventItem[],
  baseStartMs: number,
  nowMs: number,
  tz: string,
  count = 3,
): ProposedAltSlot[] {
  const candidates: number[] = []
  // Check slots every 30 minutes after the base start up to +5 hours first
  for (let step = 1; step <= 10; step += 1) {
    candidates.push(baseStartMs + step * 30 * 60_000)
  }
  // Fallback: check 1 hour earlier if all forward slots are busy and still in the future
  if (baseStartMs - 60 * 60_000 > nowMs + 15 * 60_000) {
    candidates.push(baseStartMs - 60 * 60_000)
  }

  const todayKey = getLocalDateKey(nowMs, tz)
  const tomorrowKey = getLocalDateKey(nowMs + 24 * 60 * 60 * 1000, tz)
  const out: ProposedAltSlot[] = []

  for (const startMs of candidates) {
    if (startMs <= nowMs + 10 * 60_000) continue
    const endMs = startMs + 30 * 60_000
    if (hasOverlap(events, startMs, endMs)) continue

    const startHHMM = formatTimeHHMM(startMs, tz)
    const endHHMM = formatTimeHHMM(endMs, tz)
    const key = getLocalDateKey(startMs, tz)
    const dayPrefix = key === todayKey ? 'Сегодня' : key === tomorrowKey ? 'Завтра' : ''
    const displayWhen = dayPrefix ? `${dayPrefix} ${startHHMM}-${endHHMM}` : `${startHHMM}-${endHHMM}`
    const label = dayPrefix === 'Завтра' ? `Завтра ${startHHMM}` : `В ${startHHMM}`

    out.push({
      label,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      displayWhen,
    })
    if (out.length >= count) break
  }

  return out
}

/**
 * Pure deterministic code (NOT LLM) checking whether a message proposes a meeting time
 * and whether that proposed interval overlaps with any event in the user's Google Calendar.
 */
export function evaluateProposedMeeting(params: {
  fromName: string
  text: string
  events: CalendarEventItem[]
  nowMs: number
  tz: string
}): ProposedMeetingEvaluation | null {
  const parsed = parseProposedMeetingTime(params.text, params.nowMs, params.tz)
  if (!parsed) return null

  const shortSender = toOriginalLens(params.fromName.split(/\s+/)[0] || params.fromName, 16) || 'Контакт'
  const isCall = /(созвон|звонок|зум|zoom|call)/iu.test(params.text)
  const title = isCall ? `Созвон: ${shortSender}` : `Встреча: ${shortSender}`

  const overlapping = hasOverlap(params.events, parsed.startMs, parsed.endMs)
  const altSlots = findNearbyFreeSlots(
    params.events,
    overlapping ? overlapping.endMs - 30 * 60_000 : parsed.startMs,
    params.nowMs,
    params.tz,
    3,
  )

  if (!overlapping) {
    return {
      title,
      startMs: parsed.startMs,
      endMs: parsed.endMs,
      startIso: new Date(parsed.startMs).toISOString(),
      endIso: new Date(parsed.endMs).toISOString(),
      displayWhen: parsed.displayWhen,
      shortWhen: parsed.shortWhen,
      isFree: true,
      conflict: null,
      altSlots,
    }
  }

  const busyTitle = toOriginalLens(overlapping.summary, 22) || 'Встреча'
  const busyStart = formatTimeHHMM(overlapping.startMs, params.tz)
  const busyEnd = formatTimeHHMM(overlapping.endMs, params.tz)
  const shortBusyRange =
    busyStart.endsWith(':00') && busyEnd.endsWith(':00')
      ? `${busyStart.slice(0, 2)}-${busyEnd.slice(0, 2)}`
      : `${busyStart}-${busyEnd}`

  const firstFreeHHMM = altSlots[0]
    ? formatTimeHHMM(Date.parse(altSlots[0].startIso), params.tz)
    : null
  const freeReplyDraft = firstFreeHHMM
    ? toOriginalLens(`Занят, давай в ${firstFreeHHMM}?`, 32)
    : toOriginalLens('В это время занят, позже?', 32)

  return {
    title,
    startMs: parsed.startMs,
    endMs: parsed.endMs,
    startIso: new Date(parsed.startMs).toISOString(),
    endIso: new Date(parsed.endMs).toISOString(),
    displayWhen: parsed.displayWhen,
    shortWhen: parsed.shortWhen,
    isFree: false,
    conflict: {
      title: busyTitle,
      start: busyStart,
      end: busyEnd,
      cardLine: `У тебя ${busyTitle} ${shortBusyRange}`,
      freeReplyDraft,
    },
    altSlots,
  }
}
