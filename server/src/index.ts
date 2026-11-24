import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { runMigrations } from './db/migrate.js'
import { loadEnv } from './lib/env.js'
import { logger } from './lib/logger.js'

loadEnv()
runMigrations()

const app = createApp()
const port = Number(process.env.PORT ?? 8787)

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    logger.info('server_listening', { port: info.port })
  },
)

export { app }
