import { z, type ZodType } from 'zod'
import type { AppDb } from '../db/index.js'

export type ProviderId = 'gemini'

export const transcribeResultSchema = z.object({
  transcript: z.string(),
  lang: z.string().min(1).max(16).default('en'),
})

export type TranscribeResult = z.infer<typeof transcribeResultSchema>

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
  transcribeAudio?(buffer: Buffer, mime: string): Promise<TranscribeResult>
  describeImage?(buffer: Buffer, mime: string, kind: 'sticker' | 'gif'): Promise<string>
}

export type FetchLike = typeof fetch

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite'
const DEFAULT_TIMEOUT_MS = 20_000
const TRANSCRIBE_TIMEOUT_MS = 30_000

const TRANSCRIBE_SYSTEM_PROMPT = `You are a verbatim speech-to-text transcriber.
Transcribe the provided audio word-for-word in its original language and original script (e.g. Russian in Cyrillic, English in Latin).
Rules:
- Do NOT summarize, paraphrase, translate, or add commentary.
- If the audio is silent or unintelligible, set "transcript" to "".
- Output ONLY raw JSON matching: {"transcript": string, "lang": string} where "lang" is the ISO 639-1 code.`

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
        const body = JSON.stringify({
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
        })

        let lastHttpErr: Error | null = null
        for (let netAttempt = 0; netAttempt < 2; netAttempt += 1) {
          try {
            const res = await fetchImpl(endpoint, {
              method: 'POST',
              headers: {
                'x-goog-api-key': config.apiKey,
                'Content-Type': 'application/json',
              },
              body,
              signal: AbortSignal.timeout(timeoutMs),
            })

            if (res.status === 429 || res.status >= 500) {
              lastHttpErr = new Error(`gemini_http_${res.status}`)
              if (netAttempt === 0) {
                await new Promise((r) => setTimeout(r, 400))
                continue
              }
              throw lastHttpErr
            }

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
          } catch (err) {
            const isTimeout = err instanceof Error && err.name === 'TimeoutError'
            if (isTimeout && netAttempt === 0) {
              lastHttpErr = err
              continue
            }
            throw err
          }
        }

        throw lastHttpErr ?? new Error('gemini_request_failed')
      }, opts)
    },

    async transcribeAudio(buffer: Buffer, mime: string): Promise<TranscribeResult> {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
      const base64Audio = buffer.toString('base64')
      const transcribeTimeout = config.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS

      return runWithJsonRetry(
        async (instructionText) => {
          const body = JSON.stringify({
            systemInstruction: {
              parts: [{ text: TRANSCRIBE_SYSTEM_PROMPT }],
            },
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: mime,
                      data: base64Audio,
                    },
                  },
                  { text: instructionText },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0,
              maxOutputTokens: 1500,
            },
          })

          let lastErr: Error | null = null
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const res = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                  'x-goog-api-key': config.apiKey,
                  'Content-Type': 'application/json',
                },
                body,
                signal: AbortSignal.timeout(transcribeTimeout),
              })

              if (res.status === 429 || res.status >= 500) {
                lastErr = new Error(`gemini_transcribe_http_${res.status}`)
                if (attempt === 0) {
                  await new Promise((r) => setTimeout(r, 500))
                  continue
                }
                throw lastErr
              }

              if (!res.ok) {
                throw new Error(`gemini_transcribe_http_${res.status}`)
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
                throw new Error('gemini_transcribe_empty')
              }
              return text
            } catch (err) {
              const isTimeout = err instanceof Error && err.name === 'TimeoutError'
              if (isTimeout && attempt === 0) {
                lastErr = err
                continue
              }
              throw err
            }
          }

          throw lastErr ?? new Error('gemini_transcribe_failed')
        },
        {
          system: TRANSCRIBE_SYSTEM_PROMPT,
          user: 'Transcribe this audio verbatim into JSON: {"transcript": "...", "lang": "..."}',
          schema: transcribeResultSchema,
        },
      )
    },

    async describeImage(
      buffer: Buffer,
      mime: string,
      kind: 'sticker' | 'gif',
    ): Promise<string> {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
      const base64Data = buffer.toString('base64')
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'x-goog-api-key': config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: mime,
                    data: base64Data,
                  },
                },
                {
                  text: `Describe what is shown in this ${kind} in 2 to 5 words in Russian (if it has text, include the short text). No quotes, no markdown, no extra commentary.`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 48,
          },
        }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      })

      if (!res.ok) {
        throw new Error(`gemini_describe_http_${res.status}`)
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
        .replace(/[\r\n]+/g, ' ')
        .trim()
      if (!text) {
        throw new Error('gemini_describe_empty')
      }
      return text.slice(0, 60)
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
