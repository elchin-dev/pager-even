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

export function renderPhoneInbox(count = 0): void {
  const root = getRoot()
  const subtitle =
    count === 0
      ? 'All clear ✓'
      : `${count} ${count === 1 ? 'chat needs' : 'chats need'} reply on your G2 glasses.`
  root.innerHTML = `
    <div class="card">
      <h1>Pager connected ✓</h1>
      <p class="muted">${escapeHtml(subtitle)}</p>
    </div>
  `
}
