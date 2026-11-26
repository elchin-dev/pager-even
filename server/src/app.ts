import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppDb } from './db/index.js'
import { logger } from './lib/logger.js'
import { createBearerAuthMiddleware, type AuthEnv } from './middleware/auth.js'
import { createDigestRouter } from './lib/digest-service.js'
import { createGoogleAuthRouter, type GoogleAuthRouterOptions } from './routes/auth-google.js'
import { createHomeRouter } from './routes/home.js'
import { createInboxRouter } from './routes/inbox.js'
import { createMeetingsRouter } from './routes/meetings.js'
import {
  createMsgRouter,
  type SendTelegramMessageFn,
  type SendTelegramVoiceFn,
} from './routes/msg.js'
import { createNotesRouter, createPromisesRouter } from './routes/notes.js'
import { createPairRouter, type PairRouterOptions } from './routes/pair.js'
import { createSettingsRouter } from './routes/settings.js'
import { createStreamRouter } from './routes/stream.js'
import { createTgRouter, type TgRouterOptions } from './routes/tg.js'
import type { GoogleCalendarClient } from './lib/google-calendar.js'
import { getCachedFfmpegStatus, type TranscodeWavFn } from './voice/transcode.js'

export interface AppOptions {
  corsOrigins?: string[]
  db?: AppDb
  tg?: TgRouterOptions
  pair?: PairRouterOptions
  googleAuth?: GoogleAuthRouterOptions
  sendTelegramMessage?: SendTelegramMessageFn
  sendTelegramVoice?: SendTelegramVoiceFn
  transcodeWav?: TranscodeWavFn
  calendarClient?: GoogleCalendarClient
}

export function createApp(options?: AppOptions): Hono<AuthEnv> {
  const allowedOrigins =
    options?.corsOrigins ??
    (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)

  const app = new Hono<AuthEnv>()

  app.use(
    '*',
    cors({
      origin: allowedOrigins,
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    }),
  )

  app.get('/health', (c) => {
    const ffmpeg = getCachedFfmpegStatus()
    return c.json({ ok: true, ...(ffmpeg !== null ? { ffmpeg } : {}) })
  })

  app.route('/tg', createTgRouter({ db: options?.db, ...options?.tg }))
  app.route('/auth/google', createGoogleAuthRouter({ db: options?.db, ...options?.googleAuth }))

  app.use('/api/*', createBearerAuthMiddleware(options?.db))
  app.route('/api/pair', createPairRouter({ db: options?.db, ...options?.pair }))
  app.route(
    '/api/home',
    createHomeRouter({ db: options?.db, calendarClient: options?.calendarClient }),
  )
  app.route(
    '/api/meetings',
    createMeetingsRouter({
      db: options?.db,
      calendarClient: options?.calendarClient,
      sendTelegramMessage: options?.sendTelegramMessage,
    }),
  )
  app.route(
    '/api/notes',
    createNotesRouter({
      db: options?.db,
      calendarClient: options?.calendarClient,
    }),
  )
  app.route('/api/promises', createPromisesRouter({ db: options?.db }))
  app.route('/api/digest', createDigestRouter({ db: options?.db }))
  app.route('/api/settings', createSettingsRouter({ db: options?.db }))
  app.route('/api/inbox', createInboxRouter({ db: options?.db }))
  app.route(
    '/api/msg',
    createMsgRouter({
      db: options?.db,
      sendTelegramMessage: options?.sendTelegramMessage,
      sendTelegramVoice: options?.sendTelegramVoice,
      transcodeWav: options?.transcodeWav,
      calendarClient: options?.calendarClient,
    }),
  )
  app.route('/api/stream', createStreamRouter())

  app.notFound((c) => {
    return c.json({ error: 'not_found' }, 404)
  })

  app.onError((err, c) => {
    logger.error('unhandled_http_error', {
      method: c.req.method,
      path: c.req.path,
      errorName: err.name,
    })
    return c.json({ error: 'internal_error' }, 500)
  })

  return app
}
