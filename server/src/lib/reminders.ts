import { Api } from 'grammy'
import type { AppDb } from '../db/index.js'
import { sentReminders } from '../db/schema.js'
import { hasActiveUserListeners, publishUserEvent, type GlassesReminderEvent } from './events.js'
import { logger } from './logger.js'

export interface ReminderButton {
  text: string
  callbackData: string
}

export interface ReminderDispatchPayload {
  kind: 'meeting' | 'task' | 'promise'
  sourceKey: string
  telegramText: string
  buttons?: ReminderButton[]
  glasses: GlassesReminderEvent
}

export type SendBotReminderFn = (params: {
  tgUserId: number
  text: string
  buttons?: ReminderButton[]
}) => Promise<void>

function createDefaultBotReminderSender(): SendBotReminderFn {
  return async ({ tgUserId, text, buttons }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    }
    const api = new Api(token)
    const replyMarkup =
      buttons && buttons.length > 0
        ? {
            inline_keyboard: [
              buttons.map((b) => ({
                text: b.text,
                callback_data: b.callbackData,
              })),
            ],
          }
        : undefined
    await api.sendMessage(tgUserId, text, {
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    })
  }
}

/**
 * Shared reminder dispatcher for meetings, note tasks, and chat promises.
 * Guarantees at-most-once delivery per (userId, kind, sourceKey) across server restarts,
 * sends via Telegram bot, and pushes an overlay event to the glasses if the plugin is open.
 */
export async function dispatchReminderOnce(params: {
  db: AppDb
  userId: number
  tgUserId: number
  payload: ReminderDispatchPayload
  nowMs?: number
  sendBotReminder?: SendBotReminderFn
}): Promise<boolean> {
  const now = params.nowMs ?? Date.now()
  const insertRes = params.db
    .insert(sentReminders)
    .values({
      userId: params.userId,
      kind: params.payload.kind,
      sourceKey: params.payload.sourceKey,
      sentAt: now,
    })
    .onConflictDoNothing()
    .run()

  if (insertRes.changes === 0) {
    return false
  }

  const sendBot = params.sendBotReminder ?? createDefaultBotReminderSender()
  let deliveredBot = false
  try {
    await sendBot({
      tgUserId: params.tgUserId,
      text: params.payload.telegramText,
      buttons: params.payload.buttons,
    })
    deliveredBot = true
  } catch (err) {
    logger.warn('reminder_bot_send_failed', {
      userId: params.userId,
      kind: params.payload.kind,
      errorName: err instanceof Error ? err.name : 'unknown',
    })
  }

  const deliveredGlasses = hasActiveUserListeners(params.userId)
  if (deliveredGlasses) {
    publishUserEvent(params.userId, {
      type: 'reminder',
      reminder: params.payload.glasses,
    })
  }

  logger.info('reminder_dispatched', {
    userId: params.userId,
    kind: params.payload.kind,
    deliveredBot,
    deliveredGlasses,
  })

  return true
}
