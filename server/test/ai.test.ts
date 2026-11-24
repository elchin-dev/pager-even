import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import {
  createAnthropicProvider,
  createOpenRouterProvider,
  type LlmProvider,
} from '../src/ai/provider.js'
import { triageMessage } from '../src/ai/triage.js'

const sampleSchema = z.object({
  ok: z.boolean(),
  note: z.string(),
})

test('createAnthropicProvider sends expected headers/body and retries once on invalid JSON', async () => {
  let calls = 0
  const provider = createAnthropicProvider({
    apiKey: 'test-anthropic-key',
    model: 'claude-3-5-haiku-latest',
    fetchImpl: async (url, init) => {
      calls += 1
      assert.equal(url, 'https://api.anthropic.com/v1/messages')
      const headers = init?.headers as Record<string, string>
      assert.equal(headers['x-api-key'], 'test-anthropic-key')
      assert.equal(headers['anthropic-version'], '2023-06-01')

      const text =
        calls === 1
          ? 'not valid json at all'
          : '```json\n{"ok":true,"note":"retried"}\n```'

      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const result = await provider.completeJson({
    system: 'sys',
    user: 'usr',
    schema: sampleSchema,
  })

  assert.equal(calls, 2)
  assert.deepEqual(result, { ok: true, note: 'retried' })
})

test('createOpenRouterProvider sends Bearer auth + json_object and fails after 2 bad responses', async () => {
  let calls = 0
  const provider = createOpenRouterProvider({
    apiKey: 'test-openrouter-key',
    model: 'anthropic/claude-3.5-haiku',
    fetchImpl: async (url, init) => {
      calls += 1
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
      const headers = init?.headers as Record<string, string>
      assert.equal(headers.Authorization, 'Bearer test-openrouter-key')

      const body = JSON.parse(String(init?.body)) as {
        response_format?: { type?: string }
      }
      assert.equal(body.response_format?.type, 'json_object')

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"wrongField": 123}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  await assert.rejects(() =>
    provider.completeJson({
      system: 'sys',
      user: 'usr',
      schema: sampleSchema,
    }),
  )
  assert.equal(calls, 2)
})

test('triageMessage normalizes gist <= 40 and draft.lens <= 32, and falls back when provider fails or is null', async () => {
  const mockProvider: LlmProvider = {
    id: 'anthropic',
    model: 'mock',
    async completeJson() {
      return {
        priority: 'urgent',
        intent: 'reply',
        gist: 'Просит срочно прислать коммерческое предложение сегодня до 17:00',
        lang: 'ru',
        drafts: [
          {
            text: 'Да, пришлю до 17:00 сегодня обязательно',
            lens: 'Да, пришлю до 17:00 сегодня обязательно',
            slot: null,
          },
        ],
      } as never
    },
  }

  const ok = await triageMessage(
    {
      fromName: 'Aziz',
      text: 'Пришли КП до 17:00',
      recentMessages: [],
      tz: 'Asia/Tashkent',
    },
    mockProvider,
  )

  assert.equal(ok.usedFallback, false)
  assert.equal(ok.result.priority, 'urgent')
  assert.ok(ok.result.gist.length <= 40)
  assert.ok(!/[а-яё]/i.test(ok.result.gist))
  assert.ok(ok.result.drafts[0]!.lens.length <= 32)
  assert.ok(!/[а-яё]/i.test(ok.result.drafts[0]!.lens))

  const fallback = await triageMessage(
    {
      fromName: 'Mom',
      text: 'Позвони вечером',
      recentMessages: [],
      tz: 'UTC',
    },
    null,
  )
  assert.equal(fallback.usedFallback, true)
  assert.equal(fallback.result.priority, 'needs_reply')
  assert.equal(fallback.result.lang, 'ru')
  assert.equal(fallback.result.drafts.length, 3)
})
