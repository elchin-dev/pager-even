export interface BusyInterval {
  startMs: number
  endMs: number
}

export interface CalendarSlot {
  startIso: string
  endIso: string
  label: string
}

export interface CalendarEventItem {
  id: string
  summary: string
  startMs: number
  endMs: number
  allDay: boolean
}

export interface GoogleCalendarClient {
  listBusyIntervals(params: {
    refreshToken: string
    timeMinIso: string
    timeMaxIso: string
  }): Promise<BusyInterval[]>
  listUpcomingEvents?(params: {
    refreshToken: string
    timeMinIso: string
    timeMaxIso: string
    maxResults?: number
  }): Promise<CalendarEventItem[]>
  createEvent(params: {
    refreshToken: string
    summary: string
    startIso: string
    endIso: string
    timeZone: string
  }): Promise<{ eventId: string }>
}

export const GOOGLE_CALENDAR_SCOPE =
  'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email'

export function buildGoogleAuthUrl(params: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPE)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', params.state)
  return url.toString()
}

export async function exchangeCodeForTokens(params: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  fetchImpl?: typeof fetch
}): Promise<{
  accessToken: string
  refreshToken: string | null
  scope: string
}> {
  const fetchFn = params.fetchImpl ?? fetch
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
  })

  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status})`)
  }

  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    scope?: string
  }

  if (!data.access_token) {
    throw new Error('Google token response missing access_token')
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    scope: data.scope ?? GOOGLE_CALENDAR_SCOPE,
  }
}

export async function refreshGoogleAccessToken(params: {
  refreshToken: string
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
}): Promise<string> {
  const fetchFn = params.fetchImpl ?? fetch
  const body = new URLSearchParams({
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: 'refresh_token',
  })

  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status})`)
  }

  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) {
    throw new Error('Google refresh response missing access_token')
  }
  return data.access_token
}

export function resolveUserTimeZone(storedTz?: string | null): string {
  const trimmed = storedTz?.trim()
  if (trimmed && trimmed !== 'UTC') {
    return trimmed
  }
  const envTz = process.env.DEFAULT_TZ?.trim()
  return envTz && !envTz.startsWith('<') ? envTz : 'Asia/Tashkent'
}

export async function fetchGoogleUserEmail(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { email?: string }
    return data.email ?? null
  } catch {
    return null
  }
}

export async function fetchPrimaryCalendarTimeZone(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(3000),
      },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { timeZone?: string }
    return data.timeZone?.trim() || null
  } catch {
    return null
  }
}

export function createDefaultGoogleCalendarClient(
  fetchImpl: typeof fetch = fetch,
): GoogleCalendarClient {
  function getCredentials(): { clientId: string; clientSecret: string } {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured')
    }
    return { clientId, clientSecret }
  }

  return {
    async listBusyIntervals({ refreshToken, timeMinIso, timeMaxIso }) {
      const { clientId, clientSecret } = getCredentials()
      const accessToken = await refreshGoogleAccessToken({
        refreshToken,
        clientId,
        clientSecret,
        fetchImpl,
      })

      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
      url.searchParams.set('singleEvents', 'true')
      url.searchParams.set('orderBy', 'startTime')
      url.searchParams.set('timeMin', timeMinIso)
      url.searchParams.set('timeMax', timeMaxIso)
      url.searchParams.set('maxResults', '50')

      const res = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(3000),
      })

      if (!res.ok) {
        throw new Error(`Google Calendar list failed (${res.status})`)
      }

      const data = (await res.json()) as {
        items?: Array<{
          status?: string
          transparency?: string
          start?: { dateTime?: string; date?: string }
          end?: { dateTime?: string; date?: string }
        }>
      }

      const intervals: BusyInterval[] = []
      for (const item of data.items ?? []) {
        if (item.status === 'cancelled' || item.transparency === 'transparent') {
          continue
        }
        const startStr = item.start?.dateTime ?? item.start?.date
        const endStr = item.end?.dateTime ?? item.end?.date
        if (!startStr || !endStr) continue
        const startMs = Date.parse(startStr)
        const endMs = Date.parse(endStr)
        if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
          intervals.push({ startMs, endMs })
        }
      }

      return intervals
    },

    async listUpcomingEvents({ refreshToken, timeMinIso, timeMaxIso, maxResults = 20 }) {
      const { clientId, clientSecret } = getCredentials()
      const accessToken = await refreshGoogleAccessToken({
        refreshToken,
        clientId,
        clientSecret,
        fetchImpl,
      })

      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
      url.searchParams.set('singleEvents', 'true')
      url.searchParams.set('orderBy', 'startTime')
      url.searchParams.set('timeMin', timeMinIso)
      url.searchParams.set('timeMax', timeMaxIso)
      url.searchParams.set('maxResults', String(maxResults))

      const res = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(3500),
      })

      if (!res.ok) {
        throw new Error(`Google Calendar events list failed (${res.status})`)
      }

      const data = (await res.json()) as {
        items?: Array<{
          id?: string
          status?: string
          summary?: string
          start?: { dateTime?: string; date?: string }
          end?: { dateTime?: string; date?: string }
        }>
      }

      const events: CalendarEventItem[] = []
      for (const item of data.items ?? []) {
        if (item.status === 'cancelled') continue
        const allDay = Boolean(!item.start?.dateTime && item.start?.date)
        const startStr = item.start?.dateTime ?? item.start?.date
        const endStr = item.end?.dateTime ?? item.end?.date
        if (!startStr || !endStr) continue
        const startMs = Date.parse(startStr)
        const endMs = Date.parse(endStr)
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue
        events.push({
          id: item.id || `${startMs}`,
          summary: (item.summary ?? '').trim() || 'Встреча',
          startMs,
          endMs,
          allDay,
        })
      }

      return events
    },

    async createEvent({ refreshToken, summary, startIso, endIso, timeZone }) {
      const { clientId, clientSecret } = getCredentials()
      const accessToken = await refreshGoogleAccessToken({
        refreshToken,
        clientId,
        clientSecret,
        fetchImpl,
      })

      const res = await fetchImpl(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            summary,
            start: { dateTime: startIso, timeZone },
            end: { dateTime: endIso, timeZone },
          }),
          signal: AbortSignal.timeout(5000),
        },
      )

      if (!res.ok) {
        throw new Error(`Google Calendar createEvent failed (${res.status})`)
      }

      const data = (await res.json()) as { id?: string }
      if (!data.id) {
        throw new Error('Google Calendar createEvent missing id')
      }
      return { eventId: data.id }
    },
  }
}

function getTzParts(
  ms: number,
  tz: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: string } {
  const safeTz = tz || 'UTC'
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(new Date(ms))
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(new Date(ms))
  }

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '0'

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: get('weekday'),
  }
}

export function computeFreeSlots(params: {
  busyIntervals: BusyInterval[]
  nowMs?: number
  tz?: string
  days?: number
  workStartHour?: number
  workEndHour?: number
  slotMinutes?: number
  limit?: number
}): CalendarSlot[] {
  const nowMs = params.nowMs ?? Date.now()
  const tz = params.tz || 'UTC'
  const days = params.days ?? 3
  const workStartHour = params.workStartHour ?? 10
  const workEndHour = params.workEndHour ?? 18
  const slotMinutes = params.slotMinutes ?? 30
  const limit = params.limit ?? 3
  const minStartMs = nowMs + 30 * 60_000

  const startDay = getTzParts(nowMs, tz)
  const slots: CalendarSlot[] = []

  // Step in 30-minute increments so half-hour timezones (e.g. +05:30) also hit local hour boundaries
  const firstStepMs = Math.ceil(nowMs / 1_800_000) * 1_800_000
  const totalSteps = days * 48

  for (let s = 0; s < totalSteps && slots.length < limit; s++) {
    const candidateStartMs = firstStepMs + s * 1_800_000
    if (candidateStartMs < minStartMs) continue

    const local = getTzParts(candidateStartMs, tz)
    if (local.minute !== 0) continue
    if (local.hour < workStartHour || local.hour >= workEndHour) continue

    const candidateEndMs = candidateStartMs + slotMinutes * 60_000
    const overlaps = params.busyIntervals.some(
      (b) => candidateStartMs < b.endMs && candidateEndMs > b.startMs,
    )
    if (overlaps) continue

    const dayOffset = Math.round(
      (Date.UTC(local.year, local.month - 1, local.day) -
        Date.UTC(startDay.year, startDay.month - 1, startDay.day)) /
        86_400_000,
    )
    if (dayOffset >= days) break

    const dayLabel =
      dayOffset === 0 ? 'Today' : dayOffset === 1 ? 'Tomorrow' : local.weekday
    const hh = String(local.hour).padStart(2, '0')
    const mm = String(local.minute).padStart(2, '0')

    slots.push({
      startIso: new Date(candidateStartMs).toISOString(),
      endIso: new Date(candidateEndMs).toISOString(),
      label: `${dayLabel} ${hh}:${mm}`,
    })
  }

  return slots
}
