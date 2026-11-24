import { eq } from 'drizzle-orm'
import { Bot, type BotConfig, type Context } from 'grammy'
import type { BusinessConnection, Update, User } from 'grammy/types'
import { getDb, type AppDb } from '../db/index.js'
import { messages, users } from '../db/schema.js'
import { logger } from '../lib/logger.js'

export const ALLOWED_WEBHOOK_UPDATES: ReadonlyArray<Exclude<keyof Update, 'update_id'>> = [
  'message',
  'business_connection',
  'business_message',
  'edited_business_message',
  'my_chat_member',
  'chat_join_request',
]

const MESSAGE_TTL_MS = 48 * 60 * 60 * 1000

const START_MESSAGE = [
  'Привет! Это Pager — AI-пейджер для Telegram на очках Even Realities G2.',
  '',
  'Чтобы подключить бота к личным чатам:',
  '• Без Premium: Профиль → Изменить → Автоматизация чатов → @pager_even_bot (выберите чаты и включите право ответа).',
  '• Telegram Premium: Settings → Telegram Business → Chatbots → @pager_even_bot.',
].join('\n')

function formatDisplayName(user: User): string {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return fullName || user.username || String(user.id)
}

function extractCanReply(conn: BusinessConnection): boolean {
  const legacyCanReply = (conn as { can_reply?: boolean }).can_reply
  return Boolean(conn.rights?.can_reply ?? legacyCanReply)
}

function upsertBusinessConnection(db: AppDb, conn: BusinessConnection) {
  const tgName = formatDisplayName(conn.user)
  const canReply = extractCanReply(conn)
  const rightsJson = conn.rights ? JSON.stringify(conn.rights) : null
  const now = Date.now()

  db.insert(users)
    .values({
      tgUserId: conn.user.id,
      tgName,
      businessConnectionId: conn.id,
      canReply,
      isEnabled: conn.is_enabled,
      businessRightsJson: rightsJson,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: users.tgUserId,
      set: {
        tgName,
        businessConnectionId: conn.id,
        canReply,
        isEnabled: conn.is_enabled,
        businessRightsJson: rightsJson,
      },
    })
    .run()

  return db.select().from(users).where(eq(users.tgUserId, conn.user.id)).get()
}

export function createBot(
  token: string,
  options?: { db?: AppDb; botConfig?: BotConfig<Context> },
): Bot {
  const db = options?.db ?? getDb()
  const bot = new Bot(token, options?.botConfig)

  bot.command('start', async (ctx) => {
    const from = ctx.from
    if (from) {
      const tgName = formatDisplayName(from)
      db.insert(users)
        .values({
          tgUserId: from.id,
          tgName,
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: users.tgUserId,
          set: { tgName },
        })
        .run()

      logger.info('bot_start_command', {
        updateId: ctx.update.update_id,
        tgUserId: from.id,
      })
    }

    await ctx.reply(START_MESSAGE)
  })

  bot.on('business_connection', (ctx) => {
    const conn = ctx.businessConnection
    const user = upsertBusinessConnection(db, conn)

    logger.info('business_connection_updated', {
      updateId: ctx.update.update_id,
      userId: user?.id ?? null,
      tgUserId: conn.user.id,
      connectionId: conn.id,
      canReply: extractCanReply(conn),
      isEnabled: conn.is_enabled,
    })
  })

  bot.on('business_message', async (ctx) => {
    const msg = ctx.businessMessage
    const connectionId = msg.business_connection_id
    if (!connectionId) {
      logger.warn('business_message_missing_connection_id', {
        updateId: ctx.update.update_id,
        tgMessageId: msg.message_id,
      })
      return
    }

    let owner = db
      .select()
      .from(users)
      .where(eq(users.businessConnectionId, connectionId))
      .get()

    if (!owner) {
      try {
        const remoteConn = await ctx.api.getBusinessConnection(connectionId)
        owner = upsertBusinessConnection(db, remoteConn)
      } catch {
        logger.error('business_connection_lookup_failed', {
          updateId: ctx.update.update_id,
          connectionId,
        })
        return
      }
    }

    if (!owner) {
      logger.warn('business_message_owner_not_found', {
        updateId: ctx.update.update_id,
        connectionId,
      })
      return
    }

    if (!msg.from || msg.from.id === owner.tgUserId) {
      logger.info('business_message_skipped_from_owner', {
        updateId: ctx.update.update_id,
        userId: owner.id,
        chatId: msg.chat.id,
        tgMessageId: msg.message_id,
      })
      return
    }

    const now = Date.now()
    const receivedAt = msg.date ? msg.date * 1000 : now
    const expiresAt = now + MESSAGE_TTL_MS
    const messageText = msg.text ?? msg.caption ?? ''

    const insertResult = db
      .insert(messages)
      .values({
        userId: owner.id,
        chatId: msg.chat.id,
        tgMessageId: msg.message_id,
        fromTgUserId: msg.from.id,
        fromName: formatDisplayName(msg.from),
        businessConnectionId: connectionId,
        text: messageText,
        receivedAt,
        status: 'new',
        expiresAt,
      })
      .onConflictDoNothing()
      .run()

    const isDuplicate = insertResult.changes === 0

    logger.info('business_message_stored', {
      updateId: ctx.update.update_id,
      userId: owner.id,
      chatId: msg.chat.id,
      tgMessageId: msg.message_id,
      status: isDuplicate ? 'duplicate' : 'new',
    })

    if (!isDuplicate && msg.text?.trim().toLowerCase() === 'ping') {
      try {
        const sent = await ctx.api.sendMessage(msg.chat.id, 'pong', {
          business_connection_id: connectionId,
        })
        logger.info('business_ping_replied', {
          updateId: ctx.update.update_id,
          userId: owner.id,
          chatId: msg.chat.id,
          replyTgMessageId: sent.message_id,
        })
      } catch {
        logger.error('business_ping_reply_failed', {
          updateId: ctx.update.update_id,
          userId: owner.id,
          chatId: msg.chat.id,
          canReply: owner.canReply,
        })
      }
    }
  })

  bot.catch((err) => {
    logger.error('bot_handler_error', {
      updateId: err.ctx.update.update_id,
      errorName: err.error instanceof Error ? err.error.name : 'unknown',
    })
  })

  return bot
}
