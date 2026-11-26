import { z } from 'zod'
import type { CalendarSlot } from '../lib/google-calendar.js'
import { logger } from '../lib/logger.js'
import { toOriginalLens } from '../lib/translit.js'
import type { LlmProvider } from './provider.js'

export const messageMediaSchema = z.object({
  kind: z.enum(['voice', 'video_note', 'audio']),
  duration: z.number().nonnegative(),
  transcribed: z.boolean().optional(),
  tooLong: z.boolean().optional(),
})

export type MessageMedia = z.infer<typeof messageMediaSchema>

export function formatMediaMmSs(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export function buildMediaFallbackTriage(media: {
  kind: 'voice' | 'video_note' | 'audio'
  duration: number
  tooLong?: boolean
}): TriageResult {
  const label = media.kind === 'video_note' ? 'Video' : 'Voice'
  const dur = formatMediaMmSs(media.duration)
  const gist = media.tooLong
    ? `${label} ${dur} · too long to transcribe`
    : `${label} ${dur} · couldn't transcribe`

  return {
    priority: 'needs_reply',
    intent: 'reply',
    gist: gist.slice(0, 120),
    lang: 'en',
    drafts: [
      { text: 'Will listen and reply', lens: 'Will listen and reply', slot: null },
      { text: 'Can you text it briefly?', lens: 'Can you text it briefly?', slot: null },
    ],
  }
}

export const triageDraftSchema = z.object({
  text: z.string().min(1).max(1000),
  lens: z.string().min(1).max(64),
  slot: z.string().nullable().optional().default(null),
})

export const triageResultSchema = z.object({
  priority: z.enum(['urgent', 'needs_reply', 'fyi', 'ignore']),
  intent: z.enum(['reply', 'schedule', 'info']),
  gist: z.string().min(1).max(120),
  lang: z.string().min(1).max(16).default('en'),
  drafts: z.array(triageDraftSchema).max(4),
})

export type TriageDraft = z.infer<typeof triageDraftSchema>
export type TriageResult = z.infer<typeof triageResultSchema>

export interface TriageInput {
  fromName: string
  text: string
  recentMessages: Array<{ fromName: string; text: string; receivedAt: number }>
  tz: string
  nowMs?: number
  freeSlots?: CalendarSlot[]
  calendarContext?: string
  relevantNotes?: Array<{ id: number; text: string }>
}

const TRIAGE_SYSTEM_PROMPT = `You are Pager, an AI triage assistant for smart glasses (Even Realities G2).
Analyze the incoming Telegram private message (with recent chat context) and return ONLY a single valid JSON object matching this exact schema:
{
  "priority": "urgent" | "needs_reply" | "fyi" | "ignore",
  "intent": "reply" | "schedule" | "info",
  "gist": string,
  "lang": string,
  "drafts": [
    { "text": string, "lens": string, "slot": null }
  ]
}

Rules:
- priority:
  - "urgent": ANY time-sensitive or high-importance message (not only meetings/calls!): deadlines today/now, "ASAP/срочно/тез/горит", urgent payment/money/access issues, problems blocking work, waiting for an immediate answer, or calls/meetings happening soon. Do NOT reserve "urgent" only for scheduling — evaluate importance immediately from content.
  - "needs_reply": direct question, task, or request expecting a response.
  - "fyi": short acknowledgement ("ok", "thanks", "got it", emoji) or status update needing no reply.
  - "ignore": spam, promos, automated bot/channel noise, greetings with no actionable content.
- intent:
  - "schedule": asking to meet, call, or find a free time slot.
  - "info": pure info/no action needed.
  - "reply": normal reply needed.
- gist: concise action summary <= 40 chars in the sender's original language/script (e.g. "Move call to 17?" or "Перенести созвон на 17?").
- lang: primary ISO 639-1 language code of the sender's message (e.g. "en", "ru", "uz").
- drafts:
  - Decide yourself how many replies are genuinely useful: from 1 to 4 (NEVER pad with extra options just to reach a number).
    - Simple thanks / acknowledgement (e.g. "Спасибо!", "Thanks!"): 1 reply (e.g. "Пожалуйста!").
    - Simple yes/no, knowledge, or capability question (e.g. "Знаешь...?", "Сможешь...?", "Есть...?", "Пойдешь...?"): 2–3 replies covering BOTH sides:
      1) Direct positive answer (e.g. "Да, знаю", "Да, смогу")
      2) Direct negative / don't-know answer (e.g. "Нет, не знаю", "Нет, не смогу")
      3) Optional short clarifying question or defer (e.g. "А что там?", "Напишу позже")
    - Complex request, scheduling, or multi-choice situation: up to 4 replies.
  - Every reply MUST differ in meaning/action (not just rewording the same idea). Avoid generic filler unless truly appropriate.
  - If "Relevant user notes" are provided and answer the sender's question (e.g. prices, rates, addresses, details), use those exact facts/numbers directly in the reply (e.g. "Сайт под ключ - от 800$").
  - Calendar safety (STRICT): If "Calendar context" says the user is BUSY at the requested time, NEVER generate replies saying "free", "yes", "works", or agreeing to that time — only offer free alternative slots or polite decline/reschedule. Never invent availability that contradicts Calendar context.
  - CRITICAL: Every draft's "text" MUST be concise (<= 32 characters) AND "lens" MUST be 100% IDENTICAL to "text" (exact same characters, no shortening or rephrasing, same original language/script — keep Russian in Cyrillic, English in English). The exact text shown on the glasses will be sent verbatim.
  - Always set "slot" to null.
- Output strictly raw JSON. No markdown fences, no explanations.`

const SCHEDULE_FALLBACK_RE =
  /\b(meet|meeting|call|schedule|calendar|slot|tomorrow|today|zoom|созвон|встрет\p{L}*|встреч\p{L}*|завтра|сегодня|удобно|время|слот)\b/iu

const URGENT_FALLBACK_RE =
  /(!{2,}|\b(urgent|asap|immediately|right now|deadline|emergency|sos|срочно|немедленно|прямо сейчас|горит|дедлайн|важно|тезро[кқ]|шошилинч)\b)/iu

export function buildFallbackTriage(input: {
  text: string
  fromName: string
  freeSlots?: CalendarSlot[]
}): TriageResult {
  const isCyrillic = /[а-яёўқғҳ]/i.test(input.text)
  const gist = toOriginalLens(input.text || input.fromName || 'New message', 40) || 'New message'
  const isUrgent = URGENT_FALLBACK_RE.test(input.text)
  const priority: 'urgent' | 'needs_reply' = isUrgent ? 'urgent' : 'needs_reply'
  const isSchedule = Boolean(
    input.freeSlots && input.freeSlots.length > 0 && SCHEDULE_FALLBACK_RE.test(input.text),
  )

  if (isSchedule && input.freeSlots && input.freeSlots.length > 0) {
    const slotDrafts: TriageDraft[] = input.freeSlots.slice(0, 2).map((s, idx) => ({
      text: idx === 0 ? `${s.label} works for me` : `How about ${s.label}?`,
      lens: toOriginalLens(idx === 0 ? `${s.label} works` : `${s.label}?`, 27) || s.label,
      slot: s.startIso,
    }))
    slotDrafts.push(
      isCyrillic
        ? { text: 'Отвечу чуть позже', lens: 'Отвечу чуть позже', slot: null }
        : { text: 'Will check my schedule', lens: 'Check schedule', slot: null },
    )
    return {
      priority,
      intent: 'schedule',
      gist,
      lang: isCyrillic ? 'ru' : 'en',
      drafts: slotDrafts,
    }
  }

  const isThanks = /^\s*(спасибо|спс|благодарю|рахмат|rahmat|thanks|thank you|thx)[!.,\s]*$/iu.test(
    input.text,
  )
  const isPing = /^\s*(ало|алло|привет|эй|тут|на связи|hello|hi|hey|ping)[?!.,\s]*$/iu.test(
    input.text,
  )
  const isQuestion =
    /\?/.test(input.text) || /(знаешь|можешь|сможешь|есть ли|\bknow\b|\bcan you\b)/iu.test(input.text)
  const drafts: TriageDraft[] = isCyrillic
    ? isThanks
      ? [{ text: 'Пожалуйста!', lens: 'Пожалуйста!', slot: null }]
      : isPing
        ? [
            { text: 'Да, на связи', lens: 'Да, на связи', slot: null },
            { text: 'Напишу чуть позже', lens: 'Напишу чуть позже', slot: null },
          ]
        : isQuestion
          ? [
              { text: 'Да, конечно', lens: 'Да, конечно', slot: null },
              { text: 'Нет, не знаю', lens: 'Нет, не знаю', slot: null },
            ]
          : [
              { text: 'Ок, принято', lens: 'Ок, принято', slot: null },
              { text: 'Отвечу чуть позже', lens: 'Отвечу чуть позже', slot: null },
            ]
    : isThanks
      ? [{ text: "You're welcome!", lens: "You're welcome!", slot: null }]
      : isPing
        ? [
            { text: 'Yes, I am here', lens: 'Yes, I am here', slot: null },
            { text: 'Back in 10 min', lens: 'Back in 10 min', slot: null },
          ]
        : isQuestion
          ? [
              { text: 'Yes, sure', lens: 'Yes, sure', slot: null },
              { text: "No, I don't know", lens: "No, I don't know", slot: null },
            ]
          : [
              { text: 'Got it, thanks', lens: 'Got it, thanks', slot: null },
              { text: 'Will reply shortly', lens: 'Will reply shortly', slot: null },
            ]

  return {
    priority,
    intent: 'reply',
    gist,
    lang: isCyrillic ? 'ru' : 'en',
    drafts,
  }
}

function normalizeTriageResult(
  raw: TriageResult,
  fallbackInput: { text: string; fromName: string; freeSlots?: CalendarSlot[] },
): TriageResult {
  const gist =
    toOriginalLens(raw.gist, 40) ||
    toOriginalLens(fallbackInput.text || fallbackInput.fromName, 40) ||
    'New message'
  const allowedSlots = new Set((fallbackInput.freeSlots ?? []).map((s) => s.startIso))
  const seenLens = new Set<string>()
  let drafts: TriageDraft[] = []
  for (const d of raw.drafts.slice(0, 4)) {
    const validSlot =
      d.slot && (allowedSlots.size === 0 || allowedSlots.has(d.slot)) ? d.slot : null
    const exact =
      toOriginalLens(d.lens || d.text, validSlot ? 27 : 32) ||
      toOriginalLens(d.text, 32) ||
      'Reply'
    const key = exact.toLowerCase()
    if (seenLens.has(key)) continue
    seenLens.add(key)
    drafts.push({
      text: exact,
      lens: exact,
      slot: validSlot,
    })
  }

  if ((raw.priority === 'urgent' || raw.priority === 'needs_reply') && drafts.length === 0) {
    drafts = buildFallbackTriage(fallbackInput).drafts
  }

  if (
    raw.intent === 'schedule' &&
    fallbackInput.freeSlots &&
    fallbackInput.freeSlots.length > 0 &&
    drafts.every((d) => d.slot === null)
  ) {
    const slotDrafts: TriageDraft[] = fallbackInput.freeSlots.slice(0, 2).map((s, idx) => ({
      text: idx === 0 ? `${s.label} works for me` : `How about ${s.label}?`,
      lens: toOriginalLens(idx === 0 ? `${s.label} works` : `${s.label}?`, 27) || s.label,
      slot: s.startIso,
    }))
    const remaining = drafts.slice(0, Math.max(0, 3 - slotDrafts.length))
    drafts = [...slotDrafts, ...remaining]
  }

  return {
    ...raw,
    gist,
    drafts,
  }
}

export function buildTriageUserPrompt(input: TriageInput): string {
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString()
  const historyLines = input.recentMessages
    .slice(-5)
    .map((m) => `- ${m.fromName}: ${m.text}`)
    .join('\n')
  const slotLines = (input.freeSlots ?? [])
    .map((s) => `- ${s.label} (${s.startIso})`)
    .join('\n')
  const noteLines = (input.relevantNotes ?? [])
    .slice(0, 3)
    .map((n) => `- ${n.text.slice(0, 240)}`)
    .join('\n')

  return [
    `Current UTC time: ${nowIso}`,
    `User timezone: ${input.tz}`,
    `Sender: ${input.fromName}`,
    input.calendarContext ? `Calendar context:\n${input.calendarContext}` : '',
    slotLines ? `Available calendar slots:\n${slotLines}` : '',
    noteLines ? `Relevant user notes:\n${noteLines}` : '',
    historyLines ? `Recent chat messages:\n${historyLines}` : '',
    `Latest incoming message:\n${input.text || '[media]'}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function triageMessage(
  input: TriageInput,
  provider: LlmProvider | null,
): Promise<{ result: TriageResult; usedFallback: boolean; providerId: string | null }> {
  if (!provider) {
    return {
      result: buildFallbackTriage(input),
      usedFallback: true,
      providerId: null,
    }
  }

  try {
    const raw = await provider.completeJson({
      system: TRIAGE_SYSTEM_PROMPT,
      user: buildTriageUserPrompt(input),
      schema: triageResultSchema,
      maxTokens: 250,
    })

    return {
      result: normalizeTriageResult(raw, {
        text: input.text,
        fromName: input.fromName,
        freeSlots: input.freeSlots,
      }),
      usedFallback: false,
      providerId: provider.id,
    }
  } catch (err) {
    logger.warn('triage_llm_failed_using_fallback', {
      provider: provider.id,
      errorName: err instanceof Error ? err.name : 'unknown',
      reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
    })
    return {
      result: buildFallbackTriage(input),
      usedFallback: true,
      providerId: provider.id,
    }
  }
}
