import type { ChatView, FeedMode } from '../lib/api'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getRoot(): HTMLElement {
  const el = document.getElementById('app')
  if (!el) {
    throw new Error('Missing #app element')
  }
  return el
}

export function renderPhoneLoading(message = 'Connecting to Pager…'): void {
  const root = getRoot()
  root.innerHTML = `
    <div class="card">
      <h1>Pager</h1>
      <p class="muted">${escapeHtml(message)}</p>
    </div>
  `
}

export function renderPhonePairing(params: { code: string; botUsername: string }): void {
  const root = getRoot()
  const safeCode = escapeHtml(params.code)
  const safeBot = escapeHtml(params.botUsername)
  const deepLink = `https://t.me/${encodeURIComponent(params.botUsername)}?start=${encodeURIComponent(params.code)}`

  root.innerHTML = `
    <div class="card">
      <h1>Pair with Telegram</h1>
      <p class="muted">Send this 6-digit code to <strong>@${safeBot}</strong></p>
      <div class="code">${safeCode}</div>
      <a class="btn" href="${escapeHtml(deepLink)}" target="_blank" rel="noopener noreferrer">
        Open @${safeBot} in Telegram
      </a>
      <p class="status">waiting…</p>
    </div>
  `
}

export function renderPhoneExpired(onRetry: () => void): void {
  const root = getRoot()
  root.innerHTML = `
    <div class="card">
      <h1>Code expired</h1>
      <p class="muted">Request a new pairing code to connect your glasses.</p>
      <button class="btn" id="pager-retry-btn" type="button">Get new code</button>
    </div>
  `
  document.getElementById('pager-retry-btn')?.addEventListener('click', onRetry)
}

export function renderPhoneError(message: string, onRetry: () => void): void {
  const root = getRoot()
  root.innerHTML = `
    <div class="card">
      <h1>Connection error</h1>
      <p class="muted">${escapeHtml(message)}</p>
      <button class="btn" id="pager-retry-btn" type="button">Retry</button>
    </div>
  `
  document.getElementById('pager-retry-btn')?.addEventListener('click', onRetry)
}

export function renderPhoneInbox(
  count = 0,
  settings?: {
    feedMode: FeedMode
    chatView: ChatView
    onUpdate: (patch: { feedMode?: FeedMode; chatView?: ChatView }) => void
  },
): void {
  const root = getRoot()
  const subtitle =
    count === 0
      ? 'All clear ✓'
      : `${count} ${count === 1 ? 'chat' : 'chats'} on your G2 glasses.`

  const settingsHtml = settings
    ? `
      <div style="margin-top:20px;border-top:1px solid #2b303c;padding-top:16px;text-align:left;">
        <div style="font-size:12px;color:#9ca3af;margin-bottom:8px;">Feed mode</div>
        <div style="display:flex;gap:8px;margin-bottom:14px;">
          <button type="button" id="pager-mode-urgent" class="btn" style="flex:1;padding:8px 10px;opacity:${settings.feedMode === 'urgent' ? '1' : '0.45'}">Urgent</button>
          <button type="button" id="pager-mode-all" class="btn" style="flex:1;padding:8px 10px;opacity:${settings.feedMode === 'all' ? '1' : '0.45'}">All</button>
        </div>
        <div style="font-size:12px;color:#9ca3af;margin-bottom:8px;">Chats &amp; History</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button type="button" id="pager-view-new" class="btn" style="padding:8px 10px;opacity:${settings.chatView === 'new_only' ? '1' : '0.45'}">Unread only (hide after reply)</button>
          <button type="button" id="pager-view-history" class="btn" style="padding:8px 10px;opacity:${settings.chatView === 'with_history' ? '1' : '0.45'}">All chats with history</button>
        </div>
      </div>
    `
    : ''

  root.innerHTML = `
    <div class="card">
      <h1>Pager connected ✓</h1>
      <p class="muted">${escapeHtml(subtitle)}</p>
      ${settingsHtml}
    </div>
  `

  if (settings) {
    document.getElementById('pager-mode-urgent')?.addEventListener('click', () => {
      if (settings.feedMode !== 'urgent') settings.onUpdate({ feedMode: 'urgent' })
    })
    document.getElementById('pager-mode-all')?.addEventListener('click', () => {
      if (settings.feedMode !== 'all') settings.onUpdate({ feedMode: 'all' })
    })
    document.getElementById('pager-view-new')?.addEventListener('click', () => {
      if (settings.chatView !== 'new_only') settings.onUpdate({ chatView: 'new_only' })
    })
    document.getElementById('pager-view-history')?.addEventListener('click', () => {
      if (settings.chatView !== 'with_history') settings.onUpdate({ chatView: 'with_history' })
    })
  }
}
