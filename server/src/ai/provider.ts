import type { ZodType } from 'zod'
import type { AppDb } from '../db/index.js'

export type ProviderId = 'gemini'

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

const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
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

function resolveDefaultModel(envModel?: string): string {
  const cleaned = envModel?.trim()
  if (cleaned && !cleaned.startsWith('<')) {
    return cleaned
  }
  return DEFAULT_GEMINI_MODEL
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

export function createGeminiProvider(config: {
  apiKey: string
  model?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}): LlmProvider {
  const model = resolveDefaultModel(config.model)
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    id: 'gemini',
    model,
    async completeJson<T>(opts: CompleteJsonOptions<T>): Promise<T> {
      return runWithJsonRetry(async (userPrompt) => {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'x-goog-api-key': config.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: opts.system }],
            },
            contents: [
              {
                role: 'user',
                parts: [{ text: userPrompt }],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2,
              maxOutputTokens: opts.maxTokens ?? 600,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })

        if (!res.ok) {
          throw new Error(`gemini_http_${res.status}`)
        }

        const data = (await res.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string }>
            }
          }>
        }

        const text = (data.candidates?.[0]?.content?.parts ?? [])
          .map((part) => part.text ?? '')
          .join('')

        if (!text) {
          throw new Error('gemini_empty_response')
        }
        return text
      }, opts)
    },
  }
}

export function getServerDefaultProvider(fetchImpl?: FetchLike): LlmProvider | null {
  const geminiKey = process.env.GEMINI_API_KEY?.trim()
  if (!geminiKey) {
    return null
  }
  return createGeminiProvider({
    apiKey: geminiKey,
    model: process.env.AI_DEFAULT_MODEL,
    fetchImpl,
  })
}

export function getProviderForUser(
  _userId: number,
  options?: { db?: AppDb; fetchImpl?: FetchLike },
): LlmProvider | null {
  return getServerDefaultProvider(options?.fetchImpl)
}
