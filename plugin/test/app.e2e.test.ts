import assert from 'node:assert/strict'
import test from 'node:test'
import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { startGlassesApp } from '../src/glasses/app.ts'

const utf8 = new TextEncoder()
const FORBIDDEN_LVGL_GLYPHS = ['✓', '⚠', '▸']

interface RenderedContainer {
  kind: 'startup' | 'rebuild'
  containerTotalNum: number
  textObject?: Array<{ containerID?: number; containerName?: string; content?: string; isEventCapture?: number }>
  listObject?: Array<{
    containerID?: number
    containerName?: string
    isEventCapture?: number
    itemContainer?: { itemCount?: number; itemName?: string[] }
  }>
  menuObject?: {
    itemCount?: number
    menuItems?: Array<{ itemID?: number; itemName?: string }>
  }
}

interface MockHarness {
  bridge: EvenAppBridge
  renders: RenderedContainer[]
  upgrades: Array<{ containerID?: number; content?: string }>
  apiCalls: Array<{ method: string; path: string; body: unknown }>
  emitEvent: (ev: Record<string, unknown>) => void
  pushSse: (eventName: string, data: unknown) => void
  lastRender: () => RenderedContainer
  shutdown: () => Promise<void>
  restore: () => Promise<void>
}

function validateEvenHubLimits(payload: RenderedContainer, stepLabel: string): void {
  const texts = payload.textObject ?? []
  const lists = payload.listObject ?? []
  const actualCount = texts.length + lists.length

  assert.ok(
    payload.containerTotalNum <= 3,
    `[${stepLabel}] containerTotalNum=${payload.containerTotalNum} exceeds max 3`,
  )
  assert.equal(
    payload.containerTotalNum,
    actualCount,
    `[${stepLabel}] containerTotalNum=${payload.containerTotalNum} != actual ${actualCount}`,
  )

  const captureCount =
    texts.filter((t) => t.isEventCapture === 1).length +
    lists.filter((l) => l.isEventCapture === 1).length
  assert.equal(
    captureCount,
    1,
    `[${stepLabel}] expected exactly 1 container with isEventCapture=1, got ${captureCount}`,
  )

  for (const t of texts) {
    const content = t.content ?? ''
    for (const bad of FORBIDDEN_LVGL_GLYPHS) {
      assert.ok(
        !content.includes(bad),
        `[${stepLabel}] forbidden LVGL glyph "${bad}" found in text "${content}"`,
      )
    }
  }

  for (const l of lists) {
    const items = l.itemContainer?.itemName ?? []
    assert.equal(
      l.itemContainer?.itemCount,
      items.length,
      `[${stepLabel}] list itemCount mismatch`,
    )
    for (const item of items) {
      const byteLen = utf8.encode(item).length
      assert.ok(
        byteLen <= 63,
        `[${stepLabel}] list item "${item}" is ${byteLen} UTF-8 bytes (> 63 limit)`,
      )
      for (const bad of FORBIDDEN_LVGL_GLYPHS) {
        assert.ok(
          !item.includes(bad),
          `[${stepLabel}] forbidden LVGL glyph "${bad}" found in list item "${item}"`,
        )
      }
    }
  }

  const menuItems = payload.menuObject?.menuItems ?? []
  for (const m of menuItems) {
    const name = m.itemName ?? ''
    const byteLen = utf8.encode(name).length
    assert.ok(
      byteLen <= 32,
      `[${stepLabel}] menu item "${name}" is ${byteLen} UTF-8 bytes (> 32 limit)`,
    )
    for (const bad of FORBIDDEN_LVGL_GLYPHS) {
      assert.ok(
        !name.includes(bad),
        `[${stepLabel}] forbidden LVGL glyph "${bad}" found in menu item "${name}"`,
      )
    }
  }
}

function createTestHarness(options?: {
  onApiCall?: (method: string, path: string, body: unknown) => { status?: number; json: unknown } | null
}): MockHarness {
  const renders: RenderedContainer[] = []
  const upgrades: Array<{ containerID?: number; content?: string }> = []
  const apiCalls: Array<{ method: string; path: string; body: unknown }> = []
  const listeners: Array<(ev: Record<string, unknown>) => void> = []
  const storage = new Map<string, string>([['pager_device_token', 'test_device_token_123']])

  let sseController: ReadableStreamDefaultController<Uint8Array> | null = null

  // Minimal DOM + window globals for Node.js
  const origWindow = (globalThis as Record<string, unknown>).window
  const origDocument = (globalThis as Record<string, unknown>).document
  const origLocalStorage = (globalThis as Record<string, unknown>).localStorage
  const origFetch = globalThis.fetch

  const fakeRoot = {
    innerHTML: '',
    addEventListener() {},
  }
  ;(globalThis as Record<string, unknown>).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  }
  ;(globalThis as Record<string, unknown>).document = {
    getElementById: (id: string) => (id === 'app' ? fakeRoot : null),
  }
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  }

  const defaultFixtures = (method: string, path: string, body: unknown): { status?: number; json: unknown } => {
    if (options?.onApiCall) {
      const custom = options.onApiCall(method, path, body)
      if (custom) return custom
    }

    if (path === '/api/home' && method === 'GET') {
      return {
        json: {
          nowTime: '14:50',
          headerMeeting: 'Standup через 10 мин',
          nextMeetingLine: null,
          messages: {
            total: 6,
            urgent: 1,
            senders: [
              { chatId: 101, name: 'Азиз', count: 3 },
              { chatId: 102, name: 'Дильноза', count: 2 },
              { chatId: 103, name: 'Мама', count: 1 },
            ],
          },
          meetings: {
            connected: true,
            todayCount: 3,
            items: [
              {
                id: 'ev_standup',
                title: 'Standup',
                startTime: '15:00',
                endTime: '15:30',
                minutesUntil: 10,
              },
            ],
          },
          digest: {
            enabled: true,
            count: 2,
          },
        },
      }
    }

    if (path.startsWith('/api/inbox') && method === 'GET') {
      return {
        json: {
          mode: 'urgent',
          counts: { urgent: 2, all: 6 },
          items: [
            {
              id: 50,
              chatId: 101,
              from: 'Азиз',
              preview: 'Пришли КП до вечера',
              priority: 'urgent',
              urgent: true,
              hasConflict: false,
              receivedAt: Date.now() - 60_000,
              media: null,
            },
            {
              id: 51,
              chatId: 102,
              from: 'Дильноза',
              preview: 'Созвон завтра в 15:30?',
              priority: 'needs_reply',
              urgent: true,
              hasConflict: true,
              receivedAt: Date.now() - 120_000,
              media: null,
            },
          ],
        },
      }
    }

    if (path === '/api/msg/50' && method === 'GET') {
      return {
        json: {
          id: 50,
          chatId: 101,
          from: 'Азиз Каримов',
          priority: 'urgent',
          intent: 'reply',
          gist: 'Пришли КП до вечера',
          fullText: 'Привет! Пришли КП по проекту до вечера, пожалуйста.',
          chatView: 'new_only',
          history: [],
          media: null,
          transcript: null,
          drafts: [
            { index: 0, lens: 'Не успею, скину вечером', text: 'Не успею, скину вечером' },
            { index: 1, lens: 'Отправлю через час', text: 'Отправлю через час' },
          ],
        },
      }
    }

    if (path === '/api/msg/51' && method === 'GET') {
      return {
        json: {
          id: 51,
          chatId: 102,
          from: 'Дильноза',
          priority: 'needs_reply',
          intent: 'schedule',
          gist: 'Созвон завтра 15:30',
          fullText: 'Привет! Созвон завтра в 15:30 по редизайну?',
          chatView: 'new_only',
          history: [],
          media: null,
          transcript: null,
          conflictLine: 'У тебя Standup 15-16',
          proposedMeeting: {
            title: 'Созвон: Дильноза',
            startIso: '2026-11-27T10:30:00.000Z',
            endIso: '2026-11-27T11:00:00.000Z',
            displayWhen: 'Завтра 15:30-16:00',
            isFree: false,
            conflict: {
              title: 'Standup',
              start: '15:00',
              end: '16:00',
              cardLine: 'У тебя Standup 15-16',
            },
            altSlots: [
              {
                label: 'Завтра 16:00',
                startIso: '2026-11-27T11:00:00.000Z',
                endIso: '2026-11-27T11:30:00.000Z',
                displayWhen: 'Завтра 16:00-16:30',
              },
            ],
          },
          drafts: [
            { index: 0, lens: 'Занят, давай в 16:00?', text: 'Занят, давай в 16:00?' },
            { index: 1, lens: 'Да, давай в 15:30', text: 'Да, давай в 15:30' },
          ],
        },
      }
    }

    if (path === '/api/msg/50/send' && method === 'POST') {
      return {
        json: {
          ok: true,
          tgMessageId: 777,
          promiseSuggestion: {
            chatId: 101,
            messageId: 50,
            contactName: 'Азиз',
            headerSentTo: 'Отправлено: Азиз',
            replyText: 'Не успею, скину вечером',
            promptQuestion: 'Напомнить скинуть КП?',
            taskText: 'Скинуть Азизу КП',
            promisedAtTime: '14:52',
            defaultOption: {
              label: 'Да, сегодня в 19:00',
              remindAt: Date.now() + 4 * 3600_000,
            },
            altOptions: [
              { label: 'Через 1 час', remindAt: Date.now() + 3600_000 },
              { label: 'Завтра 9:00', remindAt: Date.now() + 18 * 3600_000 },
              { label: 'Завтра 19:00', remindAt: Date.now() + 28 * 3600_000 },
            ],
          },
        },
      }
    }

    if (path === '/api/msg/51/send' && method === 'POST') {
      return {
        json: {
          ok: true,
          tgMessageId: 778,
          suggestCreateMeeting: true,
          proposedMeeting: {
            title: 'Созвон: Дильноза',
            startIso: '2026-11-27T10:30:00.000Z',
            endIso: '2026-11-27T11:00:00.000Z',
            displayWhen: 'Завтра 15:30-16:00',
            isFree: false,
            conflict: {
              title: 'Standup',
              start: '15:00',
              end: '16:00',
              cardLine: 'У тебя Standup 15-16',
            },
            altSlots: [
              {
                label: 'Завтра 16:00',
                startIso: '2026-11-27T11:00:00.000Z',
                endIso: '2026-11-27T11:30:00.000Z',
                displayWhen: 'Завтра 16:00-16:30',
              },
            ],
          },
        },
      }
    }

    if (path === '/api/promises' && method === 'POST') {
      return { status: 201, json: { id: 1 } }
    }

    if (path.startsWith('/api/promises/') && method === 'POST') {
      return { json: { ok: true } }
    }

    if (path === '/api/meetings' && method === 'GET') {
      return {
        json: {
          connected: true,
          hasWriteScope: true,
          todayCount: 2,
          items: [
            {
              id: 'ev_standup',
              title: 'Standup',
              startTime: '15:00',
              endTime: '15:30',
              startMs: Date.now() + 10 * 60_000,
              endMs: Date.now() + 40 * 60_000,
              isTomorrow: false,
              minutesUntil: 10,
              attendees: ['Азиз'],
            },
            {
              id: 'ev_design',
              title: 'Дизайн ревью',
              startTime: '10:00',
              endTime: '11:00',
              startMs: Date.now() + 20 * 3600_000,
              endMs: Date.now() + 21 * 3600_000,
              isTomorrow: true,
              minutesUntil: null,
              attendees: ['Дильноза'],
            },
          ],
        },
      }
    }

    if ((path === '/api/meetings/ev_standup' || path === '/api/meetings/ev_standup/brief') && method === 'GET') {
      return {
        json: {
          id: 'ev_standup',
          title: 'Standup',
          startTime: '15:00',
          endTime: '15:30',
          minutesUntil: 10,
          isTomorrow: false,
          summary: 'Обсудить релиз G2 и статус задач по бэкенду.',
          notesCount: 2,
          canSendLate: true,
          lateRecipientName: 'Азиз',
          canReschedule: true,
          reschedulePreview: '15:00 -> 15:30-16:00',
        },
      }
    }

    if (path === '/api/meetings/ev_standup/reschedule' && method === 'POST') {
      return { json: { ok: true, newStartTime: '15:30', newEndTime: '16:00' } }
    }

    if (path === '/api/meetings/create' && method === 'POST') {
      return { status: 201, json: { ok: true, eventId: 'ev_new_1' } }
    }

    if (path === '/api/notes/transcribe' && method === 'POST') {
      return {
        json: {
          transcript: 'Завтра в 10 напомни про Standup подготовить отчёт',
          matchedMeeting: {
            eventId: 'ev_standup',
            title: 'Standup',
            startTime: '15:00',
            label: 'Standup 15:00',
          },
          taskReminder: {
            remindAt: Date.now() + 20 * 3600_000,
            label: 'завтра 10:00',
          },
        },
      }
    }

    if (path === '/api/notes' && method === 'POST') {
      return {
        status: 201,
        json: {
          id: 10,
          text: (body as { text?: string })?.text ?? 'Note',
          meetingEventId: (body as { meetingEventId?: string | null })?.meetingEventId ?? null,
          meetingTitle: (body as { meetingTitle?: string | null })?.meetingTitle ?? null,
          remindAt: (body as { remindAt?: number | null })?.remindAt ?? null,
          remindTime: '10:00',
          taskCompleted: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
    }

    if (path.startsWith('/api/notes') && method === 'GET') {
      return {
        json: {
          items: [
            {
              id: 10,
              text: 'Завтра в 10 напомни про Standup подготовить отчёт',
              meetingEventId: 'ev_standup',
              meetingTitle: 'Standup 15:00',
              remindAt: Date.now() + 20 * 3600_000,
              remindTime: '10:00',
              taskCompleted: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        },
      }
    }

    if (path === '/api/notes/10' && method === 'DELETE') {
      return { json: { ok: true } }
    }

    if (path === '/api/digest' && method === 'GET') {
      return {
        json: {
          items: [
            {
              id: 301,
              channel: 'Крипто Daily',
              gist: 'Биткоин обновил максимум выше 98000',
              time: '14:20',
              publishedAt: Date.now() - 600_000,
            },
          ],
        },
      }
    }

    if (path === '/api/digest/301' && method === 'GET') {
      return {
        json: {
          id: 301,
          channel: 'Крипто Daily',
          time: '14:20',
          gist: 'Биткоин обновил максимум выше 98000',
          text:
            'Первый абзац длинной новости про рынок криптовалют, приток средств в биржевые фонды и реакцию инвесторов на макроэкономические данные. ' +
            'Второй абзац с подробным разбором уровней поддержки и сопротивления, ожиданиями аналитиков на следующую неделю и комментариями крупных фондов по ликвидности.',
        },
      }
    }

    return { json: { ok: true } }
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsedUrl = new URL(urlStr)
    const path = parsedUrl.pathname + parsedUrl.search
    const method = (init?.method ?? 'GET').toUpperCase()

    if (parsedUrl.pathname === '/api/stream') {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          sseController = ctrl
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    let parsedBody: unknown = undefined
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body)
      } catch {
        parsedBody = init.body
      }
    } else if (init?.body) {
      parsedBody = '[binary]'
    }

    apiCalls.push({ method, path, body: parsedBody })
    const res = defaultFixtures(method, path, parsedBody)
    return new Response(JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  const bridge = {
    async getLocalStorage(key: string) {
      return storage.get(key) ?? ''
    },
    async setLocalStorage(key: string, value: string) {
      storage.set(key, value)
      return true
    },
    async createStartUpPageContainer(payload: Record<string, unknown>) {
      const rec = { kind: 'startup' as const, ...(payload as unknown as Omit<RenderedContainer, 'kind'>) }
      validateEvenHubLimits(rec, `startup #${renders.length + 1}`)
      renders.push(rec)
      return 0
    },
    async rebuildPageContainer(payload: Record<string, unknown>) {
      const rec = { kind: 'rebuild' as const, ...(payload as unknown as Omit<RenderedContainer, 'kind'>) }
      validateEvenHubLimits(rec, `rebuild #${renders.length + 1}`)
      renders.push(rec)
      return true
    },
    async textContainerUpgrade(payload: { containerID?: number; content?: string }) {
      const content = payload.content ?? ''
      for (const bad of FORBIDDEN_LVGL_GLYPHS) {
        assert.ok(!content.includes(bad), `forbidden LVGL glyph "${bad}" in upgrade "${content}"`)
      }
      upgrades.push(payload)
      return true
    },
    async audioControl() {
      return true
    },
    async shutDownPageContainer() {
      return true
    },
    onEvenHubEvent(cb: (ev: Record<string, unknown>) => void) {
      listeners.push(cb)
      return () => {
        const idx = listeners.indexOf(cb)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  } as unknown as EvenAppBridge

  const emitEvent = (ev: Record<string, unknown>) => {
    for (const fn of [...listeners]) {
      fn(ev)
    }
  }

  const pushSse = (eventName: string, data: unknown) => {
    if (!sseController) throw new Error('SSE stream not connected')
    const chunk = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
    sseController.enqueue(utf8.encode(chunk))
  }

  const shutdown = async () => {
    // Navigate to home via menu, wait for home screen, then double-click to dispose timers & SSE cleanly
    emitEvent({ menuItemClickEvent: { itemID: 2 } })
    await flush(30)
    emitEvent({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    await flush(20)
    try {
      sseController?.close()
    } catch {
      // already closed
    }
  }

  const restore = async () => {
    await shutdown()
    ;(globalThis as Record<string, unknown>).window = origWindow
    ;(globalThis as Record<string, unknown>).document = origDocument
    ;(globalThis as Record<string, unknown>).localStorage = origLocalStorage
    globalThis.fetch = origFetch
  }

  return {
    bridge,
    renders,
    upgrades,
    apiCalls,
    emitEvent,
    pushSse,
    lastRender: () => {
      const last = renders[renders.length - 1]
      assert.ok(last, 'Expected at least one rendered container')
      return last
    },
    shutdown,
    restore,
  }
}

async function flush(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

test('E2E Flow 1: Home -> Inbox -> Card -> Quick Reply -> Promise Reminder confirmation', async () => {
  const h = createTestHarness()
  try {
    await startGlassesApp(h.bridge)
    await flush()

    // 1) Home rendered with time, nearest meeting, senders, and 3 buttons
    const home = h.lastRender()
    assert.match(home.textObject?.[0]?.content ?? '', /14:50/)
    assert.match(home.textObject?.[0]?.content ?? '', /Standup через 10 мин/)
    assert.match(home.textObject?.[1]?.content ?? '', /Азиз 3/)
    const homeItems = home.listObject?.[0]?.itemContainer?.itemName ?? []
    assert.equal(homeItems.length, 3)
    assert.match(homeItems[0]!, /Сообщения/)
    assert.match(homeItems[1]!, /Встречи/)
    assert.match(homeItems[2]!, /Дайджест/)

    // 2) Tap "Сообщения" (index 0) -> Inbox
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    const inbox = h.lastRender()
    const inboxItems = inbox.listObject?.[0]?.itemContainer?.itemName ?? []
    assert.equal(inbox.textObject?.[0]?.content, 'Сообщения: 6, срочные: 2')
    assert.equal(inbox.textObject?.[1]?.containerName, 'divider')
    assert.doesNotMatch(inbox.textObject?.[0]?.content ?? '', /PAGER|new/i)
    assert.equal(inboxItems.length, 2)
    assert.match(inboxItems[0]!, /^Азиз: Пришли КП/)
    assert.match(inboxItems[1]!, /^!! Дильноза: /)

    // 3) Tap Aziz (index 0) -> card-full -> tap -> card drafts
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    assert.match(h.lastRender().textObject?.[2]?.content ?? '', /Пришли КП по проекту/)
    // Chat header = sender name only, with a border-bottom divider container under it
    const chatFull = h.lastRender()
    assert.equal(chatFull.textObject?.[0]?.content, '! Азиз Каримов')
    assert.equal(chatFull.textObject?.[1]?.containerName, 'divider')

    h.emitEvent({
      textEvent: { eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    const cardDrafts = h.lastRender().listObject?.[0]?.itemContainer?.itemName ?? []
    assert.equal(cardDrafts[0], 'Не успею, скину вечером')
    assert.equal(cardDrafts[cardDrafts.length - 1], 'Пропустить')

    // 4) Tap draft 0 -> 1s undo countdown -> auto sends -> opens promise-confirm screen
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush(1250)

    const promiseScreen = h.lastRender()
    assert.equal(promiseScreen.textObject?.[0]?.content, 'Отправлено: Азиз')
    assert.match(promiseScreen.textObject?.[1]?.content ?? '', /Напомнить скинуть КП\?/)
    const promiseItems = promiseScreen.listObject?.[0]?.itemContainer?.itemName ?? []
    assert.equal(promiseItems[0], 'Да, сегодня в 19:00')
    assert.equal(promiseItems[1], 'Другое время')
    assert.equal(promiseItems[2], 'Не надо')

    // 5) Confirm promise -> calls POST /api/promises and returns to Inbox
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    assert.ok(h.apiCalls.some((c) => c.method === 'POST' && c.path === '/api/promises'))
  } finally {
    await h.restore()
  }
})

test('E2E Flow 2: Meetings -> Brief -> Reschedule +30 min with 3s undo cancellation', async () => {
  const h = createTestHarness()
  try {
    await startGlassesApp(h.bridge)
    await flush()

    // Tap "Встречи" (index 1)
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 1, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    const meetingsList = h.lastRender().listObject?.[0]?.itemContainer?.itemName ?? []
    assert.equal(meetingsList.length, 2)
    assert.match(meetingsList[0]!, /15:00\s+Standup/)
    assert.match(meetingsList[0]!, /через 10 мин/)
    assert.match(meetingsList[1]!, /завтра/)

    // Tap Standup (index 0) -> full-screen meeting-brief first
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    const brief = h.lastRender()
    assert.equal(brief.textObject?.[0]?.content, 'Standup')
    assert.equal(brief.textObject?.[1]?.containerName, 'divider')
    assert.match(brief.textObject?.[2]?.content ?? '', /15:00-15:30/)
    assert.match(brief.textObject?.[2]?.content ?? '', /Обсудить релиз G2/)

    // Tap brief -> opens meeting-card action panel (only Late 5 min & Move +30 min, no Notes button)
    h.emitEvent({
      textEvent: { eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    const actionPanel = h.lastRender()
    const actions = actionPanel.listObject?.[0]?.itemContainer?.itemName ?? []
    assert.deepEqual(actions, ['Опаздываю на 5 мин', 'Перенести +30 мин'])

    // Tap "Перенести +30 мин" (index 1) -> 3s undo screen
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 1, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush(50)
    const undoScreen = h.lastRender()
    assert.match(undoScreen.textObject?.[1]?.content ?? '', /15:00 -> 15:30-16:00/)
    assert.match(undoScreen.textObject?.[1]?.content ?? '', /2x тап — отмена/)

    // Double-tap within 3 seconds -> cancels Google Calendar mutation!
    h.emitEvent({
      sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT },
    })
    await flush(100)
    assert.equal(
      h.apiCalls.some((c) => c.path.includes('/reschedule')),
      false,
      'Reschedule MUST NOT be called when cancelled within 3s undo window',
    )
    assert.equal(h.lastRender().textObject?.[0]?.content, 'Standup')
  } finally {
    await h.restore()
  }
})

test('E2E Flow 3: Menu -> New Voice Note -> Match Meeting & Reminder -> Save -> My Notes -> Delete Undo', async () => {
  const h = createTestHarness()
  try {
    await startGlassesApp(h.bridge)
    await flush()

    // Open Menu -> "Новая заметка" (itemID = 3)
    h.emitEvent({ menuItemClickEvent: { itemID: 3 } })
    await flush()
    assert.match(h.lastRender().textObject?.[0]?.content ?? '', /Говори/)

    // Feed >= 0.6s of fake 16kHz PCM audio (20KB > 16KB min) and tap to finish
    h.emitEvent({ audioEvent: { audioPcm: new Uint8Array(24_000) } })
    await flush(750)
    h.emitEvent({ textEvent: { eventType: OsEventTypeList.CLICK_EVENT } })
    await flush(100)

    // Note review screen should show matched meeting + reminder + save options
    assert.ok(h.apiCalls.some((c) => c.method === 'POST' && c.path === '/api/notes/transcribe'))
    const review = h.lastRender()
    assert.match(review.textObject?.[1]?.content ?? '', /Напоминание: завтра 10:00/)
    const revItems = review.listObject?.[0]?.itemContainer?.itemName ?? []
    assert.ok(revItems.includes('Привязать: Standup 15:00'))
    assert.ok(revItems.includes('Сохранить с напоминанием'))
    assert.ok(revItems.includes('Без напоминания'))

    // Tap "Привязать: Standup 15:00"
    const bindIdx = revItems.indexOf('Привязать: Standup 15:00')
    assert.ok(bindIdx >= 0)
    h.emitEvent({
      listEvent: { currentSelectItemIndex: bindIdx, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    // Now tap "Сохранить с напоминанием" (index 0)
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()

    const createCall = h.apiCalls.find((c) => c.method === 'POST' && c.path === '/api/notes')
    assert.ok(createCall)
    assert.equal((createCall.body as { meetingEventId?: string }).meetingEventId, 'ev_standup')
    assert.ok((createCall.body as { remindAt?: number }).remindAt)

    // Open Menu -> "Мои заметки" (itemID = 4) -> open note -> Delete -> cancel in 3s
    h.emitEvent({ menuItemClickEvent: { itemID: 4 } })
    await flush()
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    const detailItems = h.lastRender().listObject?.[0]?.itemContainer?.itemName ?? []
    assert.deepEqual(detailItems, ['Дописать голосом', 'Привязать к встрече', 'Удалить'])

    // Tap "Удалить" (index 2), then cancel with double-tap
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 2, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush(50)
    h.emitEvent({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    await flush(100)
    assert.equal(
      h.apiCalls.some((c) => c.method === 'DELETE' && c.path === '/api/notes/10'),
      false,
      'Note delete MUST NOT be sent when cancelled in 3s window',
    )
  } finally {
    await h.restore()
  }
})

test('E2E Flow 4 & 5 & 6: Conflict Create Meeting (3s undo), Digest Pagination, and SSE Promise Reminder Overlay', async () => {
  const h = createTestHarness()
  try {
    await startGlassesApp(h.bridge)
    await flush()

    // Flow 5: Digest list -> post -> swipe next/prev -> 2x tap back to home
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 2, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    const digList = h.lastRender().listObject?.[0]?.itemContainer?.itemName ?? []
    assert.equal(digList.length, 1)
    assert.match(digList[0]!, /Крипто Daily/)

    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    assert.match(h.lastRender().textObject?.[0]?.content ?? '', /1\/2/)

    // Swipe down -> page 2/2
    h.emitEvent({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    await flush()
    assert.ok(h.upgrades.some((u) => (u.content ?? '').includes('2/2')))

    // 2x tap -> digest-list -> 2x tap -> home
    h.emitEvent({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    await flush()
    h.emitEvent({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    await flush()

    // Flow 4: Open Inbox -> Dilnoza (conflict) -> reply first -> THEN "Новая встреча" -> cancel 3s
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 1, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    h.emitEvent({ textEvent: { eventType: OsEventTypeList.CLICK_EVENT } })
    await flush()
    const card = h.lastRender()
    assert.match(card.textObject?.[0]?.content ?? '', /У тебя Standup 15-16/)
    assert.match(card.textObject?.[0]?.content ?? '', /^Дильноза\n-+\n/)
    const draftItems = card.listObject?.[0]?.itemContainer?.itemName ?? []
    assert.deepEqual(draftItems, ['Занят, давай в 16:00?', 'Да, давай в 15:30', 'Пропустить'])

    // Tap affirmative reply "Да, давай в 15:30" (index 1) -> 1s send undo -> opens "Новая встреча" AFTER reply
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 1, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush(1250)
    const newMeeting = h.lastRender()
    assert.equal(newMeeting.textObject?.[0]?.content, 'Новая встреча')
    assert.match(newMeeting.textObject?.[1]?.content ?? '', /!! занят: Standup/)

    // Tap "Создать без брифа" (index 1) -> 3s undo -> cancel via double-tap
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 1, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush(50)
    h.emitEvent({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    await flush(100)
    assert.equal(
      h.apiCalls.some((c) => c.path === '/api/meetings/create'),
      false,
      'Meeting create MUST NOT fire when cancelled in 3s undo window',
    )

    // Flow 6: Push live SSE promise reminder overlay -> tap "Готово"
    h.pushSse('reminder', {
      kind: 'promise',
      key: 'promise:1',
      header: 'Напоминание · 19:00',
      title: 'Скинуть Азизу КП',
      subtitle: 'Ты обещал в чате в 14:52',
      promiseId: 1,
      chatId: 101,
    })
    await flush()
    const remScreen = h.lastRender()
    assert.equal(remScreen.textObject?.[0]?.content, 'Напоминание · 19:00')
    assert.match(remScreen.textObject?.[1]?.content ?? '', /Ты обещал в чате в 14:52/)
    assert.deepEqual(remScreen.listObject?.[0]?.itemContainer?.itemName, [
      'Готово',
      'Открыть чат',
      '+1 час',
    ])

    // Tap "Готово" (index 0) -> calls POST /api/promises/1/done
    h.emitEvent({
      listEvent: { currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT },
    })
    await flush()
    assert.ok(h.apiCalls.some((c) => c.method === 'POST' && c.path === '/api/promises/1/done'))
  } finally {
    await h.restore()
  }
})

test('E2E Flow 7: Menu language toggle switches UI between Russian and English', async () => {
  const h = createTestHarness()
  try {
    await startGlassesApp(h.bridge)
    await flush()

    // Default is RU
    const homeRu = h.lastRender()
    assert.match(homeRu.listObject?.[0]?.itemContainer?.itemName?.[0] ?? '', /Сообщения/)
    assert.ok(
      (homeRu.menuObject?.menuItems ?? []).some(
        (m) => m.itemID === 5 && m.itemName === 'Language: EN',
      ),
    )

    // Click menu item 5 -> switch to EN
    h.emitEvent({ menuItemClickEvent: { itemID: 5 } })
    await flush(50)
    const homeEn = h.lastRender()
    assert.match(homeEn.listObject?.[0]?.itemContainer?.itemName?.[0] ?? '', /Messages/)
    assert.match(homeEn.listObject?.[0]?.itemContainer?.itemName?.[1] ?? '', /Meetings/)
    assert.ok(
      (homeEn.menuObject?.menuItems ?? []).some((m) => m.itemID === 5 && m.itemName === 'Язык: RU'),
    )

    // Click menu item 5 again -> switch back to RU
    h.emitEvent({ menuItemClickEvent: { itemID: 5 } })
    await flush(50)
    const homeRuAgain = h.lastRender()
    assert.match(homeRuAgain.listObject?.[0]?.itemContainer?.itemName?.[0] ?? '', /Сообщения/)
  } finally {
    await h.restore()
  }
})
