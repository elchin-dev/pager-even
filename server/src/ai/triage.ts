import { z } from 'zod'
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
  - "urgent": time-sensitive request, deadline today/now, waiting for immediate answer, call/meeting happening soon.
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
  - If priority is "urgent" or "needs_reply", provide 3 distinct, natural, short replies in the sender's language ("text").
  - If priority is "fyi" or "ignore", you may return 0 to 3 short drafts.
  - For every draft, "lens" must be <= 32 chars in ASCII/Latin-1 (transliterate non-Latin scripts into Latin).
  - Always set "slot" to null during triage.
- Output strictly raw JSON. No markdown fences, no explanations.`

export function buildFallbackTriage(input: { text: string; fromName: string }): TriageResult {
  const isCyrillic = /[а-яёўқғҳ]/i.test(input.text)
  const gist = toLens(input.text || input.fromName || 'New message', 40) || 'New message'

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
    priority: 'needs_reply',
    intent: 'reply',
    gist,
    lang: isCyrillic ? 'ru' : 'en',
    drafts,
  }
}

function normalizeTriageResult(raw: TriageResult, fallbackInput: { text: string; fromName: string }): TriageResult {
  const gist = toLens(raw.gist, 40) || toLens(fallbackInput.text || fallbackInput.fromName, 40) || 'New message'
  const drafts = raw.drafts.slice(0, 3).map((d) => ({
    text: d.text.trim(),
    lens: toLens(d.lens || d.text, 32) || toLens(d.text, 32) || 'Reply',
    slot: null,
  }))

  if ((raw.priority === 'urgent' || raw.priority === 'needs_reply') && drafts.length === 0) {
    return {
      ...raw,
      gist,
      drafts: buildFallbackTriage(fallbackInput).drafts,
    }
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

  return [
    `Current UTC time: ${nowIso}`,
    `User timezone: ${input.tz}`,
    `Sender: ${input.fromName}`,
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
      result: normalizeTriageResult(raw, input),
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
