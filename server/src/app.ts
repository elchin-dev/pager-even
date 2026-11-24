import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppDb } from './db/index.js'
import { logger } from './lib/logger.js'
import { createBearerAuthMiddleware, type AuthEnv } from './middleware/auth.js'
import { createInboxRouter } from './routes/inbox.js'
import { createMsgRouter, type SendTelegramMessageFn } from './routes/msg.js'
import { createPairRouter, type PairRouterOptions } from './routes/pair.js'
import { createStreamRouter } from './routes/stream.js'
import { createTgRouter, type TgRouterOptions } from './routes/tg.js'

export interface AppOptions {
  corsOrigins?: string[]
  db?: AppDb
  tg?: TgRouterOptions
  pair?: PairRouterOptions
  sendTelegramMessage?: SendTelegramMessageFn
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
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    }),
  )

  app.get('/health', (c) => {
    return c.json({ ok: true })
  })

  app.route('/tg', createTgRouter({ db: options?.db, ...options?.tg }))

  app.use('/api/*', createBearerAuthMiddleware(options?.db))
  app.route('/api/pair', createPairRouter({ db: options?.db, ...options?.pair }))
  app.route('/api/inbox', createInboxRouter({ db: options?.db }))
  app.route(
    '/api/msg',
    createMsgRouter({
      db: options?.db,
      sendTelegramMessage: options?.sendTelegramMessage,
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
