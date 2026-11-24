import { randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { getDb, type AppDb } from '../db/index.js'
import { googleAccounts, linkTokens } from '../db/schema.js'
import { encryptSecret, sha256Hex } from '../lib/crypto.js'
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  fetchGoogleUserEmail,
} from '../lib/google-calendar.js'
import { logger } from '../lib/logger.js'

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

export interface GoogleAuthRouterOptions {
  db?: AppDb
  clientId?: string
  clientSecret?: string
  publicBaseUrl?: string
  exchangeCode?: typeof exchangeCodeForTokens
  fetchEmail?: typeof fetchGoogleUserEmail
}

function resolvePublicBaseUrl(explicit?: string): string {
  const fromOpt = explicit?.trim()
  if (fromOpt) return fromOpt.replace(/\/+$/, '')
  const fromEnv = process.env.PUBLIC_BASE_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  const port = process.env.PORT?.trim() || '8787'
  return `http://localhost:${port}`
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f1115; color: #f4f4f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
    .card { max-width: 420px; background: #181b22; border: 1px solid #2b303c; border-radius: 14px; padding: 28px; text-align: center; }
    h1 { font-size: 20px; margin: 0 0 10px; }
    p { font-size: 14px; color: #a1a1aa; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`
}

export function createGoogleAuthRouter(options?: GoogleAuthRouterOptions): Hono {
  const router = new Hono()
  const pendingStates = new Map<string, { userId: number; tokenHash: string; expiresAt: number }>()

  function pruneExpiredStates(now: number): void {
    for (const [key, entry] of pendingStates.entries()) {
      if (entry.expiresAt <= now) {
        pendingStates.delete(key)
      }
    }
  }

  function getOAuthConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
    const clientId = options?.clientId ?? process.env.GOOGLE_CLIENT_ID?.trim()
    const clientSecret = options?.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET?.trim()
    if (!clientId || !clientSecret) return null
    const redirectUri = `${resolvePublicBaseUrl(options?.publicBaseUrl)}/auth/google/callback`
    return { clientId, clientSecret, redirectUri }
  }

  router.get('/start', (c) => {
    const rawToken = c.req.query('t')?.trim()
    if (!rawToken) {
      return c.html(htmlPage('Invalid link', 'Missing authorization token.'), 400)
    }

    const oauth = getOAuthConfig()
    if (!oauth) {
      return c.html(htmlPage('Not configured', 'Google OAuth is not configured on the server.'), 503)
    }

    const db = options?.db ?? getDb()
    const now = Date.now()
    const tokenHash = sha256Hex(rawToken)

    const row = db
      .select({ userId: linkTokens.userId })
      .from(linkTokens)
      .where(
        and(
          eq(linkTokens.tokenHash, tokenHash),
          eq(linkTokens.purpose, 'google'),
          isNull(linkTokens.usedAt),
          gt(linkTokens.expiresAt, now),
        ),
      )
      .get()

    if (!row) {
      return c.html(
        htmlPage('Link expired', 'This link is invalid or has already been used. Run /google in Telegram for a new link.'),
        400,
      )
    }

    pruneExpiredStates(now)
    const state = randomBytes(24).toString('base64url')
    pendingStates.set(state, {
      userId: row.userId,
      tokenHash,
      expiresAt: now + OAUTH_STATE_TTL_MS,
    })

    const authUrl = buildGoogleAuthUrl({
      clientId: oauth.clientId,
      redirectUri: oauth.redirectUri,
      state,
    })

    return c.redirect(authUrl, 302)
  })

  router.get('/callback', async (c) => {
    const oauthError = c.req.query('error')?.trim()
    if (oauthError) {
      return c.html(
        htmlPage('Authorization cancelled', 'Google Calendar access was not granted.'),
        400,
      )
    }

    const code = c.req.query('code')?.trim()
    const state = c.req.query('state')?.trim()
    if (!code || !state) {
      return c.html(htmlPage('Invalid callback', 'Missing OAuth code or state.'), 400)
    }

    const now = Date.now()
    const stateEntry = pendingStates.get(state)
    pendingStates.delete(state)

    if (!stateEntry || stateEntry.expiresAt <= now) {
      return c.html(
        htmlPage('Session expired', 'OAuth state expired. Run /google in Telegram to try again.'),
        400,
      )
    }

    const oauth = getOAuthConfig()
    if (!oauth) {
      return c.html(htmlPage('Not configured', 'Google OAuth is not configured on the server.'), 503)
    }

    const exchangeFn = options?.exchangeCode ?? exchangeCodeForTokens
    const fetchEmailFn = options?.fetchEmail ?? fetchGoogleUserEmail

    let tokens: { accessToken: string; refreshToken: string | null; scope: string }
    try {
      tokens = await exchangeFn({
        code,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        redirectUri: oauth.redirectUri,
      })
    } catch (err) {
      logger.error('google_oauth_exchange_failed', {
        userId: stateEntry.userId,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
      return c.html(
        htmlPage('Connection failed', 'Could not exchange Google authorization code. Please try /google again.'),
        502,
      )
    }

    const db = options?.db ?? getDb()
    const tokenClaim = db
      .update(linkTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(linkTokens.tokenHash, stateEntry.tokenHash),
          eq(linkTokens.purpose, 'google'),
          isNull(linkTokens.usedAt),
        ),
      )
      .run()

    if (tokenClaim.changes !== 1) {
      return c.html(
        htmlPage('Link expired', 'This link has already been used. Run /google in Telegram for a new link.'),
        400,
      )
    }

    const existing = db
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, stateEntry.userId))
      .get()

    let refreshTokenEnc: string
    if (tokens.refreshToken) {
      refreshTokenEnc = encryptSecret(tokens.refreshToken)
    } else if (existing?.refreshTokenEnc) {
      refreshTokenEnc = existing.refreshTokenEnc
    } else {
      return c.html(
        htmlPage('Missing refresh token', 'Google did not return a refresh token. Please try /google again.'),
        400,
      )
    }

    const email = await fetchEmailFn(tokens.accessToken)

    db.insert(googleAccounts)
      .values({
        userId: stateEntry.userId,
        email,
        refreshTokenEnc,
        scope: tokens.scope,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: googleAccounts.userId,
        set: {
          email: email ?? existing?.email ?? null,
          refreshTokenEnc,
          scope: tokens.scope,
          updatedAt: now,
        },
      })
      .run()

    logger.info('google_oauth_connected', {
      userId: stateEntry.userId,
    })

    return c.html(
      htmlPage(
        'Google Calendar connected ✓',
        'You can close this tab and return to Telegram and your G2 glasses.',
      ),
    )
  })

  return router
}
