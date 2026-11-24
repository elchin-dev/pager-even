import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Bot } from 'grammy'
import type { Update } from 'grammy/types'
import { z } from 'zod'
import { createBot } from '../bot/index.js'
import type { AppDb } from '../db/index.js'
import { logger } from '../lib/logger.js'

const updateEnvelopeSchema = z
  .object({
    update_id: z.number().int(),
  })
  .passthrough()

function verifySecretToken(received: string | undefined, expected: string): boolean {
  if (!received) return false
  const a = Buffer.from(received, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export interface TgRouterOptions {
  bot?: Bot
  webhookSecret?: string
  db?: AppDb
}

export function createTgRouter(options?: TgRouterOptions): Hono {
  const router = new Hono()

  let botInstance: Bot | null = options?.bot ?? null
  let initPromise: Promise<void> | null = null

  function getOrCreateBot(): Bot | null {
    if (botInstance) return botInstance
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    if (!token) return null
    botInstance = createBot(token, { db: options?.db })
    return botInstance
  }

  async function ensureInitialized(bot: Bot): Promise<void> {
    if (bot.isInited()) return
    if (!initPromise) {
      initPromise = bot.init().catch((err) => {
        initPromise = null
        throw err
      })
    }
    await initPromise
  }

  router.post('/webhook', async (c) => {
    const secret = options?.webhookSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
    if (!secret) {
      logger.error('tg_webhook_secret_missing')
      return c.json({ error: 'webhook_not_configured' }, 503)
    }

    const headerSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token')
    if (!verifySecretToken(headerSecret, secret)) {
      logger.warn('tg_webhook_unauthorized')
      return c.json({ error: 'unauthorized' }, 401)
    }

    const bot = getOrCreateBot()
    if (!bot) {
      logger.error('tg_bot_token_missing')
      return c.json({ error: 'bot_not_configured' }, 503)
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }

    const parsed = updateEnvelopeSchema.safeParse(rawBody)
    if (!parsed.success) {
      return c.json({ error: 'invalid_update' }, 400)
    }

    await ensureInitialized(bot)
    await bot.handleUpdate(parsed.data as unknown as Update)

    return c.json({ ok: true })
  })

  return router
}
