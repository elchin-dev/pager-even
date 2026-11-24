import { eq } from 'drizzle-orm'
import type { ZodType } from 'zod'
import { getDb, type AppDb } from '../db/index.js'
import { aiSettings } from '../db/schema.js'

export type ProviderId = 'anthropic' | 'gemini' | 'openai' | 'openrouter'

export interface CompleteJsonOptions<T> {
  system: string
  user: string
  schema: ZodType<T, any, any>
  maxTokens?: number
}

export interface LlmProvider {
  readonly id: ProviderId
  readonly model: string
  completeJson<T>(opts: CompleteJsonOptions<T>): Promise<T>
}

export type FetchLike = typeof fetch

const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-latest'
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-3.5-haiku'
const DEFAULT_TIMEOUT_MS = 10_000

function extractJsonText(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) {
    return fenced[1].trim()
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }
  return trimmed
}

function resolveDefaultModel(provider: ProviderId, envModel?: string): string {
  const cleaned = envModel?.trim()
  if (cleaned && !cleaned.startsWith('<')) {
    return cleaned
  }
  if (provider === 'openrouter') return DEFAULT_OPENROUTER_MODEL
  return DEFAULT_ANTHROPIC_MODEL
}

async function runWithJsonRetry<T>(
  invoke: (userPrompt: string) => Promise<string>,
  opts: CompleteJsonOptions<T>,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? opts.user
        : `${opts.user}\n\nIMPORTANT: Your previous response was not valid JSON matching the required schema. Output ONLY a single raw JSON object with no markdown or commentary.`

    const rawText = await invoke(prompt)
    try {
      const jsonText = extractJsonText(rawText)
      const parsed = JSON.parse(jsonText) as unknown
      return opts.schema.parse(parsed)
    } catch (err) {
      lastError = err
    }
  }

  throw lastError instanceof Error ? lastError : new Error('llm_invalid_json')
}

export function createAnthropicProvider(config: {
  apiKey: string
  model?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}): LlmProvider {
  const model = resolveDefaultModel('anthropic', config.model)
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    id: 'anthropic',
    model,
    async completeJson<T>(opts: CompleteJsonOptions<T>): Promise<T> {
      return runWithJsonRetry(async (userPrompt) => {
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: opts.maxTokens ?? 600,
            temperature: 0.2,
            system: opts.system,
            messages: [{ role: 'user', content: userPrompt }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })

        if (!res.ok) {
          throw new Error(`anthropic_http_${res.status}`)
        }

        const data = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>
        }
        const text = (data.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text ?? '')
          .join('')

        if (!text) {
          throw new Error('anthropic_empty_response')
        }
        return text
      }, opts)
    },
  }
}

export function createOpenRouterProvider(config: {
  apiKey: string
  model?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}): LlmProvider {
  const model = resolveDefaultModel('openrouter', config.model)
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    id: 'openrouter',
    model,
    async completeJson<T>(opts: CompleteJsonOptions<T>): Promise<T> {
      return runWithJsonRetry(async (userPrompt) => {
        const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'Pager G2',
          },
          body: JSON.stringify({
            model,
            max_tokens: opts.maxTokens ?? 600,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: opts.system },
              { role: 'user', content: userPrompt },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })

        if (!res.ok) {
          throw new Error(`openrouter_http_${res.status}`)
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>
        }
        const text = data.choices?.[0]?.message?.content ?? ''
        if (!text) {
          throw new Error('openrouter_empty_response')
        }
        return text
      }, opts)
    },
  }
}

export function getServerDefaultProvider(fetchImpl?: FetchLike): LlmProvider | null {
  const requested = process.env.AI_DEFAULT_PROVIDER?.trim().toLowerCase()
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim()
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim()
  const envModel = process.env.AI_DEFAULT_MODEL

  if (requested === 'openrouter') {
    if (openrouterKey) {
      return createOpenRouterProvider({ apiKey: openrouterKey, model: envModel, fetchImpl })
    }
    return null
  }

  if (requested === 'anthropic' || !requested) {
    if (anthropicKey) {
      return createAnthropicProvider({ apiKey: anthropicKey, model: envModel, fetchImpl })
    }
    if (!requested && openrouterKey) {
      return createOpenRouterProvider({ apiKey: openrouterKey, model: envModel, fetchImpl })
    }
  }

  return null
}

export function getProviderForUser(
  userId: number,
  options?: { db?: AppDb; fetchImpl?: FetchLike },
): LlmProvider | null {
  const db = options?.db ?? getDb()
  const settings = db.select().from(aiSettings).where(eq(aiSettings.userId, userId)).get()

  if (settings && settings.mode === 'byok' && settings.keyEnc) {
    // BYOK key decryption will be wired with the /settings/ai flow; fall back to server provider until then.
    return getServerDefaultProvider(options?.fetchImpl)
  }

  return getServerDefaultProvider(options?.fetchImpl)
}
