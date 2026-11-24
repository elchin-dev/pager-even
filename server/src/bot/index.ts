import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { Api, Bot, type BotConfig, type Context } from 'grammy'
import type { BusinessConnection, Update, User } from 'grammy/types'
import { getProviderForUser, type LlmProvider } from '../ai/provider.js'
import { triageMessage } from '../ai/triage.js'
import { getDb, type AppDb } from '../db/index.js'
import { aiSettings, devices, googleAccounts, linkTokens, messages, pairCodes, users } from '../db/schema.js'
import { decryptSecret, generateLinkToken, sha256Hex } from '../lib/crypto.js'
import { publishUserEvent } from '../lib/events.js'
import {
  computeFreeSlots,
  createDefaultGoogleCalendarClient,
  resolveUserTimeZone,
  type CalendarSlot,
  type GoogleCalendarClient,
} from '../lib/google-calendar.js'
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
const LINK_TOKEN_TTL_MS = 10 * 60 * 1000
const DEFAULT_BOT_USERNAME = 'pager_even_bot'

function resolvePublicBaseUrl(): string {
  const fromEnv = process.env.PUBLIC_BASE_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  const port = process.env.PORT?.trim() || '8787'
  return `http://localhost:${port}`
}

let cachedBotUsername: string | null = null

export async function getBotUsername(): Promise<string> {
  const fromEnv = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '')
  if (fromEnv) return fromEnv
  if (cachedBotUsername) return cachedBotUsername

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (token) {
    try {
      const me = await new Api(token).getMe()
      if (me.username) {
        cachedBotUsername = me.username
        return cachedBotUsername
      }
    } catch {
      logger.warn('bot_username_lookup_failed')
    }
  }

  return DEFAULT_BOT_USERNAME
}

function buildConnectInstructions(botUsername: string): string {
  return [
    'Чтобы подключить бота к личным чатам:',
    `• Без Premium: Профиль → Изменить → Автоматизация чатов → @${botUsername} (выберите чаты и включите право ответа).`,
    `• Telegram Premium: Settings → Telegram Business → Chatbots → @${botUsername}.`,
  ].join('\n')
}

function formatDisplayName(user: User): string {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return fullName || user.username || String(user.id)
}

function extractCanReply(conn: BusinessConnection): boolean {
  const legacyCanReply = (conn as { can_reply?: boolean }).can_reply
  return Boolean(conn.rights?.can_reply ?? legacyCanReply)
}

function upsertTgUser(db: AppDb, tgUser: User) {
  const tgName = formatDisplayName(tgUser)
  db.insert(users)
    .values({
      tgUserId: tgUser.id,
      tgName,
      tz: resolveUserTimeZone(),
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: users.tgUserId,
      set: { tgName },
    })
    .run()

  return db.select().from(users).where(eq(users.tgUserId, tgUser.id)).get()!
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
      tz: resolveUserTimeZone(),
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

async function claimPairCode(
  db: AppDb,
  ctx: Context,
  code: string,
  botUsername: string,
): Promise<void> {
  const from = ctx.from
  if (!from) return

  const user = upsertTgUser(db, from)
  const now = Date.now()

  const existing = db.select().from(pairCodes).where(eq(pairCodes.code, code)).get()

  if (
    !existing ||
    existing.usedAt !== null ||
    existing.userId !== null ||
    existing.expiresAt <= now
  ) {
    logger.warn('pair_code_rejected', {
      updateId: ctx.update.update_id,
      userId: user.id,
      tgUserId: from.id,
    })
    await ctx.reply('Код недействителен или истёк. Запросите новый код на очках.')
    return
  }

  const updateRes = db
    .update(pairCodes)
    .set({ userId: user.id })
    .where(
      and(
        eq(pairCodes.code, code),
        isNull(pairCodes.userId),
        isNull(pairCodes.usedAt),
        gt(pairCodes.expiresAt, now),
      ),
    )
    .run()

  if (updateRes.changes !== 1) {
    await ctx.reply('Код недействителен или уже использован. Запросите новый код на очках.')
    return
  }

  logger.info('pair_code_claimed', {
    updateId: ctx.update.update_id,
    pairId: existing.pairId,
    userId: user.id,
    tgUserId: from.id,
  })

  const hasBusinessConnection = Boolean(user.businessConnectionId && user.isEnabled)
  if (hasBusinessConnection) {
    await ctx.reply('Glasses connected ✓')
    return
  }

  await ctx.reply(`Glasses connected ✓\n\n${buildConnectInstructions(botUsername)}`)
}

export function createBot(
  token: string,
  options?: {
    db?: AppDb
    botConfig?: BotConfig<Context>
    getProvider?: (userId: number) => LlmProvider | null
    calendarClient?: GoogleCalendarClient
  },
): Bot {
  const db = options?.db ?? getDb()
  const resolveProvider =
    options?.getProvider ?? ((userId: number) => getProviderForUser(userId, { db }))
  const calendarClient = options?.calendarClient ?? createDefaultGoogleCalendarClient()
  const bot = new Bot(token, options?.botConfig)

  async function resolveBotUsername(ctx: Context): Promise<string> {
    if (ctx.me?.username) {
      cachedBotUsername = ctx.me.username
      return ctx.me.username
    }
    return getBotUsername()
  }

  bot.command('start', async (ctx) => {
    const botUsername = await resolveBotUsername(ctx)
    const payload = ctx.match.trim()

    if (payload.length > 0) {
      if (/^\d{6}$/.test(payload)) {
        await claimPairCode(db, ctx, payload, botUsername)
        return
      }
      await ctx.reply('Неверный формат кода. Отправьте 6 цифр с экрана очков.')
      return
    }

    if (ctx.from) {
      const user = upsertTgUser(db, ctx.from)
      logger.info('bot_start_command', {
        updateId: ctx.update.update_id,
        userId: user.id,
        tgUserId: ctx.from.id,
      })
    }

    await ctx.reply(
      [
        'Привет! Это Pager — AI-пейджер для Telegram на очках Even Realities G2.',
        '',
        buildConnectInstructions(botUsername),
      ].join('\n'),
    )
  })

  bot.command('unpair', async (ctx) => {
    const from = ctx.from
    if (!from) return

    const user = db.select().from(users).where(eq(users.tgUserId, from.id)).get()
    if (!user) {
      await ctx.reply('Устройства не найдены.')
      return
    }

    const now = Date.now()
    const revokeRes = db
      .update(devices)
      .set({ revokedAt: now })
      .where(and(eq(devices.userId, user.id), isNull(devices.revokedAt)))
      .run()

    db.delete(googleAccounts).where(eq(googleAccounts.userId, user.id)).run()
    db.delete(aiSettings).where(eq(aiSettings.userId, user.id)).run()

    logger.info('devices_unpaired', {
      updateId: ctx.update.update_id,
      userId: user.id,
      tgUserId: from.id,
      revokedCount: revokeRes.changes,
    })

    await ctx.reply('Все устройства отвязаны ✓')
  })

  bot.command('google', async (ctx) => {
    const from = ctx.from
    if (!from) return

    const user = upsertTgUser(db, from)
    const rawToken = generateLinkToken()
    const now = Date.now()

    db.insert(linkTokens)
      .values({
        tokenHash: sha256Hex(rawToken),
        userId: user.id,
        purpose: 'google',
        expiresAt: now + LINK_TOKEN_TTL_MS,
        usedAt: null,
      })
      .run()

    const url = `${resolvePublicBaseUrl()}/auth/google/start?t=${encodeURIComponent(rawToken)}`
    logger.info('google_link_issued', {
      updateId: ctx.update.update_id,
      userId: user.id,
    })

    await ctx.reply(
      `Откройте ссылку в обычном браузере, чтобы подключить Google Calendar (действует 10 минут):\n${url}`,
      { link_preview_options: { is_disabled: true } },
    )
  })

  bot.on('message:text', async (ctx) => {
    if (ctx.chat.type !== 'private') return
    const text = ctx.message.text.trim()
    if (!/^\d{6}$/.test(text)) return

    const botUsername = await resolveBotUsername(ctx)
    await claimPairCode(db, ctx, text, botUsername)
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

    if (!isDuplicate) {
      const insertedId = Number(insertResult.lastInsertRowid)
      const recentRows = db
        .select({
          fromName: messages.fromName,
          text: messages.text,
          receivedAt: messages.receivedAt,
        })
        .from(messages)
        .where(and(eq(messages.userId, owner.id), eq(messages.chatId, msg.chat.id)))
        .orderBy(desc(messages.receivedAt), desc(messages.id))
        .limit(5)
        .all()
        .reverse()

      const userTz = resolveUserTimeZone(owner.tz)

      const { result: triage, usedFallback, providerId } = await triageMessage(
        {
          fromName: formatDisplayName(msg.from),
          text: messageText,
          recentMessages: recentRows.slice(0, -1),
          tz: userTz,
          nowMs: now,
        },
        resolveProvider(owner.id),
      )

      db.update(messages)
        .set({ aiJson: JSON.stringify(triage) })
        .where(eq(messages.id, insertedId))
        .run()

      logger.info('business_message_triaged', {
        updateId: ctx.update.update_id,
        userId: owner.id,
        messageId: insertedId,
        priority: triage.priority,
        intent: triage.intent,
        provider: providerId,
        usedFallback,
      })

      publishUserEvent(owner.id, {
        type: 'inbox',
        messageId: insertedId,
        chatId: msg.chat.id,
      })
    }

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
