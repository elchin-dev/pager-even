import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const DEVICE_TOKEN_KEY = 'pager_device_token'

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787'
).replace(/\/+$/, '')

export interface PairStartResponse {
  pairId: string
  code: string
  botUsername: string
}

export type PairStatusResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'paired'; deviceToken: string }

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
