import { z } from 'zod'
import type { CalendarSlot } from '../lib/google-calendar.js'
import { logger } from '../lib/logger.js'
import { toLens } from '../lib/translit.js'
import type { LlmProvider } from './provider.js'

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
  drafts: z.array(triageDraftSchema).max(3),
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
- gist: concise English/ASCII action summary <= 40 chars (e.g. "Asks for KP by 17:00").
- lang: primary ISO 639-1 language code of the sender's message (e.g. "en", "ru", "uz").
- drafts:
  - If priority is "urgent" or "needs_reply", provide 3 distinct, natural, context-specific replies in the sender's language ("text") that directly answer what the sender asked (avoid generic filler like "Yes, sounds good" or "Will reply shortly" unless truly appropriate):
    1) Direct positive/actionable answer (e.g. confirming with specific next step or accepting the request).
    2) Specific alternative, clarifying question, or counter-offer tailored to the message.
    3) Polite defer/busy response with a realistic timeframe (e.g. "Сейчас на встрече, отвечу через час").
  - For every draft, "lens" must be <= 32 chars in ASCII/Latin-1 (transliterate non-Latin scripts into Latin, keep it clear and readable on smart glasses).
  - If intent is "schedule" and "Available calendar slots" are provided, use 2-3 of those exact slots in drafts: set "slot" to the slot's exact ISO start string, and keep "lens" <= 27 chars (e.g. "Tomorrow 15:00 works"). Otherwise set "slot" to null.
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
  const gist = toLens(input.text || input.fromName || 'New message', 40) || 'New message'
  const isUrgent = URGENT_FALLBACK_RE.test(input.text)
  const priority: 'urgent' | 'needs_reply' = isUrgent ? 'urgent' : 'needs_reply'
  const isSchedule = Boolean(
    input.freeSlots && input.freeSlots.length > 0 && SCHEDULE_FALLBACK_RE.test(input.text),
  )

  if (isSchedule && input.freeSlots && input.freeSlots.length > 0) {
    const slotDrafts: TriageDraft[] = input.freeSlots.slice(0, 2).map((s, idx) => ({
      text: idx === 0 ? `${s.label} works for me` : `How about ${s.label}?`,
      lens: toLens(idx === 0 ? `${s.label} works` : `${s.label}?`, 27) || s.label,
      slot: s.startIso,
    }))
    slotDrafts.push(
      isCyrillic
        ? { text: 'Отвечу чуть позже', lens: 'Otvechu chut pozzhe', slot: null }
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

  const drafts: TriageDraft[] = isCyrillic
    ? [
        { text: 'Да, хорошо', lens: 'Da, khorosho', slot: null },
        { text: 'Отвечу чуть позже', lens: 'Otvechu chut pozzhe', slot: null },
        { text: 'Созвонимся позже?', lens: 'Sozvonimsya pozzhe?', slot: null },
      ]
    : [
        { text: 'Yes, sounds good', lens: 'Yes, sounds good', slot: null },
        { text: 'Will reply shortly', lens: 'Will reply shortly', slot: null },
        { text: 'Can we call later?', lens: 'Can we call later?', slot: null },
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
  const gist = toLens(raw.gist, 40) || toLens(fallbackInput.text || fallbackInput.fromName, 40) || 'New message'
  const allowedSlots = new Set((fallbackInput.freeSlots ?? []).map((s) => s.startIso))
  let drafts = raw.drafts.slice(0, 3).map((d) => {
    const validSlot =
      d.slot && (allowedSlots.size === 0 || allowedSlots.has(d.slot)) ? d.slot : null
    return {
      text: d.text.trim(),
      lens: toLens(d.lens || d.text, validSlot ? 27 : 32) || toLens(d.text, 32) || 'Reply',
      slot: validSlot,
    }
  })

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
      lens: toLens(idx === 0 ? `${s.label} works` : `${s.label}?`, 27) || s.label,
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

  return [
    `Current UTC time: ${nowIso}`,
    `User timezone: ${input.tz}`,
    `Sender: ${input.fromName}`,
    slotLines ? `Available calendar slots:\n${slotLines}` : '',
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
      maxTokens: 500,
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
