import { Api } from 'grammy'
import { loadEnv } from '../lib/env.js'
import { logger } from '../lib/logger.js'
import { ALLOWED_WEBHOOK_UPDATES } from './index.js'

loadEnv()

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '')

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required')
  }
  if (!secretToken) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET is required')
  }
  if (!publicBaseUrl || !publicBaseUrl.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL must be a valid https:// URL')
  }

  const webhookUrl = `${publicBaseUrl}/tg/webhook`
  const api = new Api(token)

  await api.setWebhook(webhookUrl, {
    secret_token: secretToken,
    allowed_updates: ALLOWED_WEBHOOK_UPDATES,
  })

  const info = await api.getWebhookInfo()
  logger.info('telegram_webhook_configured', {
    url: info.url,
    pendingUpdateCount: info.pending_update_count,
    allowedUpdates: (info.allowed_updates ?? ALLOWED_WEBHOOK_UPDATES).join(','),
  })
}

main().catch((err) => {
  logger.error('telegram_webhook_setup_failed', {
    reason: err instanceof Error ? err.message : 'unknown_error',
  })
  process.exit(1)
})
