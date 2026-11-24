import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from './lib/logger.js'
import { createTgRouter, type TgRouterOptions } from './routes/tg.js'

export interface AppOptions {
  corsOrigins?: string[]
  tg?: TgRouterOptions
}

export function createApp(options?: AppOptions): Hono {
  const allowedOrigins =
    options?.corsOrigins ??
    (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)

  const app = new Hono()

  app.use(
    '*',
    cors({
      origin: allowedOrigins,
    }),
  )

  app.get('/health', (c) => {
    return c.json({ ok: true })
  })

  app.route('/tg', createTgRouter(options?.tg))

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
