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

export interface InboxItem {
  id: number
  chatId: number
  from: string
  preview: string
  count: number
  priority?: 'urgent' | 'needs_reply'
}

export interface InboxResponse {
  items: InboxItem[]
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

export async function fetchInbox(bridge: EvenAppBridge): Promise<InboxItem[]> {
  const res = await apiFetch(bridge, '/api/inbox', { method: 'GET' })
  const data = await parseJson<InboxResponse>(res)
  return data.items
}

export function subscribeInboxStream(
  bridge: EvenAppBridge,
  handlers: {
    onInbox: () => void
    onUnauthorized: () => void
  },
): () => void {
  let stopped = false
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

          if (eventName === 'inbox') {
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
