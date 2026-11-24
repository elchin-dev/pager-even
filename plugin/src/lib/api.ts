import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const DEVICE_TOKEN_KEY = 'pager_device_token'

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787'
).replace(/\/+$/, '')

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized')
    this.name = 'UnauthorizedError'
  }
}

export interface PairStartResponse {
  pairId: string
  code: string
  botUsername: string
}

export type PairStatusResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'paired'; deviceToken: string }

export type FeedMode = 'urgent' | 'all'
export type ChatView = 'new_only' | 'with_history'

export interface UserSettings {
  feedMode: FeedMode
  chatView: ChatView
  voiceEnabled: boolean
  conflictAlerts: boolean
}

export interface MessageMedia {
  kind: 'voice' | 'video_note' | 'audio'
  duration: number
  transcribed?: boolean
  tooLong?: boolean
}

export interface InboxItem {
  id: number
  chatId: number
  from: string
  preview: string
  count: number
  priority?: 'urgent' | 'needs_reply' | 'fyi' | 'ignore'
  urgent?: boolean
  hasConflict?: boolean
  media?: MessageMedia | null
}

export interface InboxCounts {
  urgent: number
  all: number
}

export interface InboxResponse {
  mode: FeedMode
  chatView: ChatView
  counts: InboxCounts
  items: InboxItem[]
}

export interface MessageDraft {
  index: number
  lens: string
  slot?: string | null
  hasCal?: boolean
}

export interface MessageCard {
  id: number
  chatId: number
  from: string
  priority: 'urgent' | 'needs_reply'
  intent: 'reply' | 'schedule' | 'info'
  gist: string
  fullText?: string
  hasMore?: boolean
  text: string
  media?: MessageMedia
  transcript?: string
  drafts: MessageDraft[]
}

export async function getStoredDeviceToken(bridge: EvenAppBridge): Promise<string | null> {
  try {
    const raw = await bridge.getLocalStorage(DEVICE_TOKEN_KEY)
    const trimmed = raw?.trim()
    return trimmed ? trimmed : null
  } catch {
    return null
  }
}

export async function saveDeviceToken(bridge: EvenAppBridge, token: string): Promise<void> {
  await bridge.setLocalStorage(DEVICE_TOKEN_KEY, token)
}

export async function clearDeviceToken(bridge: EvenAppBridge): Promise<void> {
  await bridge.setLocalStorage(DEVICE_TOKEN_KEY, '')
}

async function parseJson<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    throw new UnauthorizedError()
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export async function startPairing(): Promise<PairStartResponse> {
  const res = await fetch(`${API_BASE_URL}/api/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  return parseJson<PairStartResponse>(res)
}

export async function getPairingStatus(pairId: string): Promise<PairStatusResponse> {
  const url = `${API_BASE_URL}/api/pair/status?pairId=${encodeURIComponent(pairId)}`
  const res = await fetch(url, { method: 'GET' })
  return parseJson<PairStatusResponse>(res)
}

export async function apiFetch(
  bridge: EvenAppBridge,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getStoredDeviceToken(bridge)
  const headers = new Headers(init.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  })
}

export async function fetchInbox(
  bridge: EvenAppBridge,
  mode?: FeedMode,
): Promise<InboxResponse> {
  const query = mode ? `?mode=${encodeURIComponent(mode)}` : ''
  const res = await apiFetch(bridge, `/api/inbox${query}`, { method: 'GET' })
  return parseJson<InboxResponse>(res)
}

export async function fetchSettings(bridge: EvenAppBridge): Promise<UserSettings> {
  const res = await apiFetch(bridge, '/api/settings', { method: 'GET' })
  return parseJson<UserSettings>(res)
}

export async function updateSettings(
  bridge: EvenAppBridge,
  patch: Partial<UserSettings>,
): Promise<UserSettings> {
  const res = await apiFetch(bridge, '/api/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  return parseJson<UserSettings>(res)
}

export async function fetchMessageCard(
  bridge: EvenAppBridge,
  id: number,
): Promise<MessageCard> {
  const res = await apiFetch(bridge, `/api/msg/${id}`, { method: 'GET' })
  return parseJson<MessageCard>(res)
}

export async function sendMessageReply(
  bridge: EvenAppBridge,
  id: number,
  draftIndex: number,
): Promise<{ ok: true; tgMessageId: number; eventCreated?: boolean }> {
  const res = await apiFetch(bridge, `/api/msg/${id}/send`, {
    method: 'POST',
    body: JSON.stringify({ draftIndex }),
  })
  return parseJson<{ ok: true; tgMessageId: number; eventCreated?: boolean }>(res)
}

export async function skipMessage(
  bridge: EvenAppBridge,
  id: number,
): Promise<{ ok: true }> {
  const res = await apiFetch(bridge, `/api/msg/${id}/skip`, {
    method: 'POST',
  })
  return parseJson<{ ok: true }>(res)
}

export async function sendVoiceReply(
  bridge: EvenAppBridge,
  id: number,
  wavBytes: Uint8Array,
): Promise<{ ok: true; tgMessageId: number; durationSec: number }> {
  const copy = new Uint8Array(wavBytes.byteLength)
  copy.set(wavBytes)
  const blob = new Blob([copy.buffer], { type: 'audio/wav' })
  const res = await apiFetch(bridge, `/api/msg/${id}/voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: blob,
  })
  return parseJson<{ ok: true; tgMessageId: number; durationSec: number }>(res)
}

export function subscribeInboxStream(
  bridge: EvenAppBridge,
  handlers: {
    onInbox: () => void
    onUnauthorized: () => void
  },
): () => void {
  let stopped = false
  let hasConnectedOnce = false
  let activeController: AbortController | null = null
  let reconnectTimer: number | null = null

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, 3000)
  }

  const connect = async () => {
    if (stopped) return
    const token = await getStoredDeviceToken(bridge)
    if (!token || stopped) return

    activeController = new AbortController()
    try {
      const res = await fetch(`${API_BASE_URL}/api/stream`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        signal: activeController.signal,
      })

      if (res.status === 401) {
        stopped = true
        handlers.onUnauthorized()
        return
      }

      if (!res.ok || !res.body) {
        scheduleReconnect()
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!stopped) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let sepIndex = buffer.indexOf('\n\n')
        while (sepIndex !== -1) {
          const rawBlock = buffer.slice(0, sepIndex)
          buffer = buffer.slice(sepIndex + 2)

          let eventName = 'message'
          for (const line of rawBlock.split('\n')) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim()
            }
          }

          if (eventName === 'ready') {
            if (hasConnectedOnce) {
              handlers.onInbox()
            }
            hasConnectedOnce = true
          } else if (eventName === 'inbox') {
            handlers.onInbox()
          }

          sepIndex = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // Ignore abort / transient network failures and reconnect below
    }

    if (!stopped) {
      scheduleReconnect()
    }
  }

  void connect()

  return () => {
    stopped = true
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    activeController?.abort()
    activeController = null
  }
}
