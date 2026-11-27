import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const DEVICE_TOKEN_KEY = 'pager_device_token'

export const API_BASE_URL = (
  import.meta.env?.VITE_API_BASE_URL || 'http://localhost:8787'
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
export type UiLang = 'ru' | 'en'

export interface UserSettings {
  feedMode: FeedMode
  chatView: ChatView
  voiceEnabled: boolean
  conflictAlerts: boolean
  uiLang?: UiLang
}

export interface MessageMedia {
  kind: 'voice' | 'video_note' | 'audio'
  duration: number
  transcribed?: boolean
  tooLong?: boolean
}

export interface HomeSenderSummary {
  chatId: number
  name: string
  count: number
}

export interface HomeMeetingItem {
  id: string
  title: string
  startTime: string
  endTime: string
  minutesUntil: number | null
}

export interface HomeResponse {
  nowTime: string
  headerMeeting: string
  nextMeetingLine: string | null
  messages: {
    total: number
    urgent: number
    senders: HomeSenderSummary[]
  }
  meetings: {
    connected: boolean
    todayCount: number
    items: HomeMeetingItem[]
  }
  digest: {
    enabled: boolean
    count: number
  }
}

export interface MeetingListItem {
  id: string
  title: string
  startTime: string
  endTime: string
  startMs: number
  endMs: number
  isTomorrow: boolean
  minutesUntil: number | null
  attendees: string[]
}

export interface MeetingsListResponse {
  connected: boolean
  hasWriteScope: boolean
  todayCount: number
  items: MeetingListItem[]
}

export interface MeetingBrief {
  id: string
  title: string
  startTime: string
  endTime: string
  isTomorrow: boolean
  minutesUntil: number | null
  attendees: string[]
  summary: string
  notesCount: number
  canSendLate: boolean
  lateRecipientName: string | null
  reschedulePreview: string
  hasWriteScope: boolean
}

export interface GlassesReminderEvent {
  kind: 'meeting' | 'task' | 'promise'
  header: string
  title: string
  subtitle: string
  eventId?: string
  noteId?: number
  promiseId?: number
  chatId?: number
}

export interface ProposedAltSlot {
  label: string
  startIso: string
  endIso: string
  displayWhen: string
}

export interface ProposedMeetingInfo {
  title: string
  startMs: number
  endMs: number
  startIso: string
  endIso: string
  displayWhen: string
  shortWhen: string
  isFree: boolean
  conflict: {
    title: string
    start: string
    end: string
    cardLine: string
    freeReplyDraft: string | null
  } | null
  altSlots: ProposedAltSlot[]
}

export interface PromiseSuggestion {
  chatId: number
  messageId: number
  contactName: string
  headerSentTo: string
  replyText: string
  promptQuestion: string
  taskText: string
  promisedAtTime: string
  defaultOption: { label: string; remindAt: number }
  altOptions: Array<{ label: string; remindAt: number }>
}

export interface NoteItem {
  id: number
  text: string
  meetingEventId: string | null
  meetingTitle: string | null
  remindAt: number | null
  remindTime: string | null
  taskCompleted: boolean
  createdAt: number
  updatedAt: number
}

export interface NoteDraftAnalysis {
  transcript: string
  matchedMeeting: {
    eventId: string
    title: string
    startTime: string
    label: string
  } | null
  taskReminder: {
    remindAt: number
    label: string
  } | null
}

export interface DigestListItem {
  id: number
  channel: string
  gist: string
  time: string
}

export interface DigestPostDetail {
  id: number
  channel: string
  time: string
  gist: string
  text: string
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
  conflictLine?: string
  proposedMeeting?: ProposedMeetingInfo
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
  timeoutMs = 8000,
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
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
}

export async function fetchHome(bridge: EvenAppBridge, lang?: UiLang): Promise<HomeResponse> {
  const q = lang ? `?lang=${encodeURIComponent(lang)}` : ''
  const res = await apiFetch(bridge, `/api/home${q}`, { method: 'GET' })
  return parseJson<HomeResponse>(res)
}

export async function fetchMeetings(bridge: EvenAppBridge): Promise<MeetingsListResponse> {
  const res = await apiFetch(bridge, '/api/meetings', { method: 'GET' })
  return parseJson<MeetingsListResponse>(res)
}

export async function fetchMeetingBrief(
  bridge: EvenAppBridge,
  eventId: string,
): Promise<MeetingBrief> {
  const res = await apiFetch(bridge, `/api/meetings/${encodeURIComponent(eventId)}`, {
    method: 'GET',
  })
  return parseJson<MeetingBrief>(res)
}

export async function sendMeetingLate(
  bridge: EvenAppBridge,
  eventId: string,
): Promise<{ ok: true; sentCount: number }> {
  const res = await apiFetch(bridge, `/api/meetings/${encodeURIComponent(eventId)}/late`, {
    method: 'POST',
  })
  return parseJson<{ ok: true; sentCount: number }>(res)
}

export async function rescheduleMeeting(
  bridge: EvenAppBridge,
  eventId: string,
): Promise<{ ok: true; newRange: string }> {
  const res = await apiFetch(bridge, `/api/meetings/${encodeURIComponent(eventId)}/reschedule`, {
    method: 'POST',
  })
  return parseJson<{ ok: true; newRange: string }>(res)
}

export async function createCalendarMeeting(
  bridge: EvenAppBridge,
  body: { title: string; startIso: string; endIso: string; description?: string },
): Promise<{ ok: true; eventId: string }> {
  const res = await apiFetch(bridge, '/api/meetings/create', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseJson<{ ok: true; eventId: string }>(res)
}

export async function prepareMeetingBriefVoice(
  bridge: EvenAppBridge,
  wavBytes: Uint8Array,
  chatId?: number,
  prevUserSaid?: string,
): Promise<{ userSaid: string; aiAdded: string; combinedDescription: string }> {
  const copy = new Uint8Array(wavBytes.byteLength)
  copy.set(wavBytes)
  const blob = new Blob([copy.buffer], { type: 'audio/wav' })
  const qs = new URLSearchParams()
  if (chatId) qs.set('chatId', String(chatId))
  if (prevUserSaid) qs.set('prev', prevUserSaid)
  const query = qs.toString() ? `?${qs.toString()}` : ''
  const res = await apiFetch(
    bridge,
    `/api/meetings/brief-voice${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: blob,
    },
    35_000,
  )
  return parseJson<{ userSaid: string; aiAdded: string; combinedDescription: string }>(res)
}

export async function fetchNotes(
  bridge: EvenAppBridge,
  meetingEventId?: string,
): Promise<{ items: NoteItem[] }> {
  const q = meetingEventId ? `?meetingEventId=${encodeURIComponent(meetingEventId)}` : ''
  const res = await apiFetch(bridge, `/api/notes${q}`, { method: 'GET' })
  return parseJson<{ items: NoteItem[] }>(res)
}

export async function transcribeNoteVoice(
  bridge: EvenAppBridge,
  wavBytes: Uint8Array,
): Promise<NoteDraftAnalysis> {
  const copy = new Uint8Array(wavBytes.byteLength)
  copy.set(wavBytes)
  const blob = new Blob([copy.buffer], { type: 'audio/wav' })
  const res = await apiFetch(
    bridge,
    '/api/notes/transcribe',
    {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: blob,
    },
    35_000,
  )
  return parseJson<NoteDraftAnalysis>(res)
}

export async function createNote(
  bridge: EvenAppBridge,
  body: {
    text: string
    meetingEventId?: string | null
    meetingTitle?: string | null
    remindAt?: number | null
  },
): Promise<{ note: NoteItem }> {
  const res = await apiFetch(bridge, '/api/notes', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseJson<{ note: NoteItem }>(res)
}

export async function updateNote(
  bridge: EvenAppBridge,
  id: number,
  body: {
    text?: string
    meetingEventId?: string | null
    meetingTitle?: string | null
    remindAt?: number | null
  },
): Promise<{ note: NoteItem }> {
  const res = await apiFetch(bridge, `/api/notes/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  return parseJson<{ note: NoteItem }>(res)
}

export async function appendNoteVoice(
  bridge: EvenAppBridge,
  id: number,
  wavBytes: Uint8Array,
): Promise<{ note: NoteItem }> {
  const copy = new Uint8Array(wavBytes.byteLength)
  copy.set(wavBytes)
  const blob = new Blob([copy.buffer], { type: 'audio/wav' })
  const res = await apiFetch(
    bridge,
    `/api/notes/${id}/append-voice`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: blob,
    },
    35_000,
  )
  return parseJson<{ note: NoteItem }>(res)
}

export async function deleteNote(bridge: EvenAppBridge, id: number): Promise<{ ok: true }> {
  const res = await apiFetch(bridge, `/api/notes/${id}`, { method: 'DELETE' })
  return parseJson<{ ok: true }>(res)
}

export async function completeTaskNote(bridge: EvenAppBridge, id: number): Promise<{ ok: true }> {
  const res = await apiFetch(bridge, `/api/notes/${id}/done`, { method: 'POST' })
  return parseJson<{ ok: true }>(res)
}

export async function snoozeTaskNote(bridge: EvenAppBridge, id: number): Promise<{ ok: true }> {
  const res = await apiFetch(bridge, `/api/notes/${id}/snooze`, { method: 'POST' })
  return parseJson<{ ok: true }>(res)
}

export async function createPromiseReminder(
  bridge: EvenAppBridge,
  body: {
    messageId?: number | null
    chatId: number
    contactName: string
    replyText: string
    taskText: string
    promisedAtTime: string
    remindAt: number
  },
): Promise<{ ok: true; id: number }> {
  const res = await apiFetch(bridge, '/api/promises', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseJson<{ ok: true; id: number }>(res)
}

export async function completePromiseReminder(
  bridge: EvenAppBridge,
  id: number,
): Promise<{ ok: true }> {
  const res = await apiFetch(bridge, `/api/promises/${id}/done`, { method: 'POST' })
  return parseJson<{ ok: true }>(res)
}

export async function snoozePromiseReminder(
  bridge: EvenAppBridge,
  id: number,
): Promise<{ ok: true }> {
  const res = await apiFetch(bridge, `/api/promises/${id}/snooze`, { method: 'POST' })
  return parseJson<{ ok: true }>(res)
}

export async function fetchDigestList(
  bridge: EvenAppBridge,
): Promise<{ items: DigestListItem[] }> {
  const res = await apiFetch(bridge, '/api/digest', { method: 'GET' })
  return parseJson<{ items: DigestListItem[] }>(res)
}

export async function fetchDigestPost(
  bridge: EvenAppBridge,
  id: number,
): Promise<DigestPostDetail> {
  const res = await apiFetch(bridge, `/api/digest/${id}`, { method: 'GET' })
  return parseJson<DigestPostDetail>(res)
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

export interface SendReplyResponse {
  ok: true
  tgMessageId: number
  eventCreated?: boolean
  promiseSuggestion?: PromiseSuggestion
  suggestCreateMeeting?: boolean
  proposedMeeting?: ProposedMeetingInfo
}

export async function sendMessageReply(
  bridge: EvenAppBridge,
  id: number,
  draftIndex: number,
): Promise<SendReplyResponse> {
  const res = await apiFetch(bridge, `/api/msg/${id}/send`, {
    method: 'POST',
    body: JSON.stringify({ draftIndex }),
  })
  return parseJson<SendReplyResponse>(res)
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
  const res = await apiFetch(
    bridge,
    `/api/msg/${id}/voice`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: blob,
    },
    25_000,
  )
  return parseJson<{ ok: true; tgMessageId: number; durationSec: number }>(res)
}

export interface InboxStreamEvent {
  type?: string
  messageId?: number
  chatId?: number
}

export function subscribeInboxStream(
  bridge: EvenAppBridge,
  handlers: {
    onInbox: (event?: InboxStreamEvent) => void
    onReminder?: (reminder: GlassesReminderEvent) => void
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
          let eventData: InboxStreamEvent | undefined
          for (const line of rawBlock.split('\n')) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim()
            } else if (line.startsWith('data:')) {
              const rawJson = line.slice(5).trim()
              if (rawJson) {
                try {
                  eventData = JSON.parse(rawJson) as InboxStreamEvent
                } catch {
                  // ignore non-JSON SSE data
                }
              }
            }
          }

          if (eventName === 'ready') {
            if (hasConnectedOnce) {
              handlers.onInbox()
            }
            hasConnectedOnce = true
          } else if (eventName === 'inbox') {
            handlers.onInbox(eventData)
          } else if (eventName === 'reminder' && eventData && handlers.onReminder) {
            handlers.onReminder(eventData as unknown as GlassesReminderEvent)
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
