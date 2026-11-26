import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createGeminiProvider, type LlmProvider } from '../src/ai/provider.js'
import { triageMessage } from '../src/ai/triage.js'

const sampleSchema = z.object({
  ok: z.boolean(),
  note: z.string(),
})

test('createGeminiProvider sends expected headers/body and retries once on invalid JSON', async () => {
  let calls = 0
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    model: 'gemini-flash-latest',
    fetchImpl: async (url, init) => {
      calls += 1
      assert.equal(
        url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      )
      const headers = init?.headers as Record<string, string>
      assert.equal(headers['x-goog-api-key'], 'test-gemini-key')

      const body = JSON.parse(String(init?.body)) as {
        systemInstruction?: { parts?: Array<{ text?: string }> }
        generationConfig?: { responseMimeType?: string }
      }
      assert.equal(body.systemInstruction?.parts?.[0]?.text, 'sys')
      assert.equal(body.generationConfig?.responseMimeType, 'application/json')

      const text =
        calls === 1
          ? 'not valid json at all'
          : '```json\n{"ok":true,"note":"retried"}\n```'

      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text }] } }],
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

test('createGeminiProvider fails after 2 invalid schema responses', async () => {
  let calls = 0
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    model: 'gemini-flash-latest',
    fetchImpl: async () => {
      calls += 1
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"wrongField": 123}' }] } }],
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
    id: 'gemini',
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
  assert.ok(/[а-яё]/i.test(ok.result.gist))
  assert.ok(ok.result.drafts[0]!.lens.length <= 32)
  assert.ok(/[а-яё]/i.test(ok.result.drafts[0]!.lens))

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
  assert.ok(fallback.result.drafts.length >= 1 && fallback.result.drafts.length <= 2)

  const thanksFallback = await triageMessage(
    {
      fromName: 'Aziz',
      text: 'Спасибо!',
      recentMessages: [],
      tz: 'Asia/Tashkent',
    },
    null,
  )
  assert.equal(thanksFallback.usedFallback, true)
  assert.equal(thanksFallback.result.drafts.length, 1)
  assert.equal(thanksFallback.result.drafts[0]?.lens, 'Пожалуйста!')

  const fourDraftProvider: LlmProvider = {
    id: 'gemini',
    model: 'mock',
    async completeJson() {
      return {
        priority: 'needs_reply',
        intent: 'reply',
        gist: 'Сложная просьба по проекту',
        lang: 'ru',
        drafts: [
          { text: 'Да, сделаю сегодня', lens: 'Да, сделаю сегодня', slot: null },
          { text: 'Могу завтра утром', lens: 'Могу завтра утром', slot: null },
          { text: 'Нужны детали по ТЗ', lens: 'Нужны детали по ТЗ', slot: null },
          { text: 'Не успею, давай позже', lens: 'Не успею, давай позже', slot: null },
        ],
      } as never
    },
  }
  const fourRes = await triageMessage(
    {
      fromName: 'Client',
      text: 'Нужно переделать макет и смету до вечера',
      recentMessages: [],
      tz: 'Asia/Tashkent',
    },
    fourDraftProvider,
  )
  assert.equal(fourRes.result.drafts.length, 4)
  for (const d of fourRes.result.drafts) {
    assert.equal(d.text, d.lens)
    assert.ok(d.lens.length <= 32)
  }

  const scheduleFallback = await triageMessage(
    {
      fromName: 'Eric',
      text: 'Can we meet tomorrow?',
      recentMessages: [],
      tz: 'UTC',
      freeSlots: [
        {
          startIso: '2026-11-25T10:00:00.000Z',
          endIso: '2026-11-25T10:30:00.000Z',
          label: 'Tomorrow 15:00',
        },
        {
          startIso: '2026-11-25T11:00:00.000Z',
          endIso: '2026-11-25T11:30:00.000Z',
          label: 'Tomorrow 16:00',
        },
      ],
    },
    null,
  )
  assert.equal(scheduleFallback.usedFallback, true)
  assert.equal(scheduleFallback.result.intent, 'schedule')
  assert.equal(scheduleFallback.result.drafts[0]?.slot, '2026-11-25T10:00:00.000Z')
  assert.equal(scheduleFallback.result.drafts[1]?.slot, '2026-11-25T11:00:00.000Z')
  assert.equal(scheduleFallback.result.drafts[2]?.slot, null)

  const urgentFallback = await triageMessage(
    {
      fromName: 'Boss',
      text: 'Срочно оплатите счёт сегодня!!',
      recentMessages: [],
      tz: 'Asia/Tashkent',
    },
    null,
  )
  assert.equal(urgentFallback.usedFallback, true)
  assert.equal(urgentFallback.result.priority, 'urgent')

  const questionFallback = await triageMessage(
    {
      fromName: 'Friend',
      text: 'Ты знаешь про стим?',
      recentMessages: [],
      tz: 'Asia/Tashkent',
    },
    null,
  )
  assert.equal(questionFallback.usedFallback, true)
  assert.ok(
    questionFallback.result.drafts.some((d) => /не знаю|нет/i.test(d.lens)),
    'question fallback should include a negative/don’t-know option',
  )
})
