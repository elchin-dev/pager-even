import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { Api, Bot, type BotConfig, type Context } from 'grammy'
import type { BusinessConnection, Update, User } from 'grammy/types'
import { getProviderForUser, type LlmProvider } from '../ai/provider.js'
import { buildMediaFallbackTriage, triageMessage, type MessageMedia } from '../ai/triage.js'
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
import { formatGifText, formatStickerText } from '../lib/media-label.js'
import {
  fetchUserUpcomingMeetings,
  rescheduleMeetingByMinutes,
  sendLateNoticeForMeeting,
} from '../lib/meetings-service.js'
import { transcodeMediaToWav16k, type TranscodeMediaToWavFn } from '../voice/transcode.js'

const MAX_INCOMING_MEDIA_BYTES = 20 * 1024 * 1024
const MAX_INCOMING_MEDIA_DURATION_SEC = 5 * 60

export const ALLOWED_WEBHOOK_UPDATES: ReadonlyArray<Exclude<keyof Update, 'update_id'>> = [
  'message',
  'callback_query',
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
    downloadTelegramFile?: (fileId: string) => Promise<Buffer>
    transcodeMediaToWav?: TranscodeMediaToWavFn
  },
): Bot {
  const db = options?.db ?? getDb()
  const resolveProvider =
    options?.getProvider ?? ((userId: number) => getProviderForUser(userId, { db }))
  const calendarClient = options?.calendarClient ?? createDefaultGoogleCalendarClient()
  const transcodeMedia = options?.transcodeMediaToWav ?? transcodeMediaToWav16k
  const bot = new Bot(token, options?.botConfig)

  const downloadFile =
    options?.downloadTelegramFile ??
    (async (fileId: string): Promise<Buffer> => {
      const file = await bot.api.getFile(fileId)
      if (!file.file_path) {
        throw new Error('telegram_file_path_missing')
      }
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok || !res.body) {
        throw new Error(`telegram_file_download_http_${res.status}`)
      }
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > MAX_INCOMING_MEDIA_BYTES) {
            await reader.cancel()
            throw new Error('telegram_file_too_large')
          }
          chunks.push(value)
        }
      }
      return Buffer.concat(chunks)
    })

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

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data
    const from = ctx.from
    if (!from || (!data.startsWith('mt:late:') && !data.startsWith('mt:shift:'))) {
      await ctx.answerCallbackQuery()
      return
    }

    const user = db.select().from(users).where(eq(users.tgUserId, from.id)).get()
    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Пользователь не найден' })
      return
    }

    const isLate = data.startsWith('mt:late:')
    const eventIdPrefix = isLate ? data.slice('mt:late:'.length) : data.slice('mt:shift:'.length)

    try {
      const { events, tz } = await fetchUserUpcomingMeetings({
        db,
        userId: user.id,
        calendarClient,
        nowMs: Date.now(),
        horizonHours: 48,
      })
      const ev = events.find((item) => item.id === eventIdPrefix || item.id.startsWith(eventIdPrefix))
      if (!ev) {
        await ctx.answerCallbackQuery({ text: 'Встреча не найдена' })
        return
      }

      if (isLate) {
        const res = await sendLateNoticeForMeeting({
          db,
          userId: user.id,
          event: ev,
        })
        if (res.sentCount === 0) {
          await ctx.answerCallbackQuery({ text: 'Участник не найден в чатах Telegram' })
          return
        }
        await ctx.answerCallbackQuery({ text: 'Отправлено: Опаздываю на 5 мин' })
        await ctx.reply('Отправил участнику: «Опаздываю на 5 мин».')
      } else {
        const res = await rescheduleMeetingByMinutes({
          db,
          userId: user.id,
          event: ev,
          shiftMinutes: 30,
          calendarClient,
          tz,
        })
        if (!res.ok) {
          const msg =
            res.error === 'calendar_readonly'
              ? 'Нет прав на запись календаря. Переподключите: /google'
              : 'Календарь не подключён. Выполните /google'
          await ctx.answerCallbackQuery({ text: 'Нужно переподключить /google' })
          await ctx.reply(msg)
          return
        }
        await ctx.answerCallbackQuery({ text: `Перенесено на ${res.newRange}` })
        await ctx.reply(`Встреча перенесена на +30 мин (${res.newRange}).`)
      }
    } catch {
      await ctx.answerCallbackQuery({ text: 'Ошибка выполнения' })
    }
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
    const fromDisplayName = formatDisplayName(msg.from)

    const rawMedia: {
      kind: MessageMedia['kind']
      fileId: string
      duration: number
      fileSize: number
    } | null = msg.voice
      ? {
          kind: 'voice',
          fileId: msg.voice.file_id,
          duration: msg.voice.duration ?? 0,
          fileSize: msg.voice.file_size ?? 0,
        }
      : msg.video_note
        ? {
            kind: 'video_note',
            fileId: msg.video_note.file_id,
            duration: msg.video_note.duration ?? 0,
            fileSize: msg.video_note.file_size ?? 0,
          }
        : msg.audio
          ? {
              kind: 'audio',
              fileId: msg.audio.file_id,
              duration: msg.audio.duration ?? 0,
              fileSize: msg.audio.file_size ?? 0,
            }
          : null

    if (rawMedia) {
      const isTooLong =
        rawMedia.fileSize > MAX_INCOMING_MEDIA_BYTES ||
        rawMedia.duration > MAX_INCOMING_MEDIA_DURATION_SEC

      const initialMedia: MessageMedia = isTooLong
        ? { kind: rawMedia.kind, duration: rawMedia.duration, tooLong: true }
        : { kind: rawMedia.kind, duration: rawMedia.duration }

      const insertResult = db
        .insert(messages)
        .values({
          userId: owner.id,
          chatId: msg.chat.id,
          tgMessageId: msg.message_id,
          fromTgUserId: msg.from.id,
          fromName: fromDisplayName,
          businessConnectionId: connectionId,
          text: '',
          mediaJson: JSON.stringify(initialMedia),
          receivedAt,
          status: 'new',
          expiresAt,
        })
        .onConflictDoNothing()
        .run()

      const isDuplicate = insertResult.changes === 0

      logger.info('business_media_received', {
        updateId: ctx.update.update_id,
        userId: owner.id,
        chatId: msg.chat.id,
        tgMessageId: msg.message_id,
        kind: rawMedia.kind,
        duration: rawMedia.duration,
        status: isDuplicate ? 'duplicate' : isTooLong ? 'too_long' : 'queued',
      })

      if (isDuplicate) {
        return
      }

      const insertedId = Number(insertResult.lastInsertRowid)
      const ownerId = owner.id
      const ownerTz = resolveUserTimeZone(owner.tz)
      const chatId = msg.chat.id
      const updateId = ctx.update.update_id

      if (isTooLong) {
        const fallbackTriage = buildMediaFallbackTriage(initialMedia)
        db.update(messages)
          .set({
            aiJson: JSON.stringify(fallbackTriage),
            mediaJson: JSON.stringify(initialMedia),
          })
          .where(eq(messages.id, insertedId))
          .run()

        publishUserEvent(ownerId, {
          type: 'inbox',
          messageId: insertedId,
          chatId,
        })
        return
      }

      void (async () => {
        try {
          const mediaBytes = await downloadFile(rawMedia.fileId)
          if (mediaBytes.byteLength > MAX_INCOMING_MEDIA_BYTES) {
            throw new Error('telegram_file_too_large')
          }

          const wavBuffer = await transcodeMedia(mediaBytes)
          const provider = resolveProvider(ownerId)
          if (!provider?.transcribeAudio) {
            throw new Error('transcribe_provider_unavailable')
          }

          const { transcript } = await provider.transcribeAudio(wavBuffer, 'audio/wav')
          const cleanedTranscript = transcript.trim()
          if (!cleanedTranscript) {
            throw new Error('empty_transcript')
          }

          const transcribedMedia: MessageMedia = {
            kind: rawMedia.kind,
            duration: rawMedia.duration,
            transcribed: true,
          }

          const recentRows = db
            .select({
              fromName: messages.fromName,
              text: messages.text,
              receivedAt: messages.receivedAt,
            })
            .from(messages)
            .where(and(eq(messages.userId, ownerId), eq(messages.chatId, chatId)))
            .orderBy(desc(messages.receivedAt), desc(messages.id))
            .limit(5)
            .all()
            .reverse()

          const { result: triage, usedFallback, providerId } = await triageMessage(
            {
              fromName: fromDisplayName,
              text: cleanedTranscript,
              recentMessages: recentRows.filter((_, idx) => idx < recentRows.length - 1),
              tz: ownerTz,
              nowMs: Date.now(),
            },
            provider,
          )

          db.update(messages)
            .set({
              text: cleanedTranscript,
              mediaJson: JSON.stringify(transcribedMedia),
              aiJson: JSON.stringify(triage),
            })
            .where(eq(messages.id, insertedId))
            .run()

          logger.info('business_media_transcribed', {
            updateId,
            userId: ownerId,
            messageId: insertedId,
            kind: rawMedia.kind,
            duration: rawMedia.duration,
            status: 'transcribed',
            priority: triage.priority,
            provider: providerId,
            usedFallback,
          })

          publishUserEvent(ownerId, {
            type: 'inbox',
            messageId: insertedId,
            chatId,
          })
        } catch (err) {
          const isOversize =
            err instanceof Error && err.message === 'telegram_file_too_large'
          const failedMedia: MessageMedia = isOversize
            ? { kind: rawMedia.kind, duration: rawMedia.duration, tooLong: true }
            : { kind: rawMedia.kind, duration: rawMedia.duration, transcribed: false }
          const fallbackTriage = buildMediaFallbackTriage(failedMedia)

          db.update(messages)
            .set({
              text: '',
              mediaJson: JSON.stringify(failedMedia),
              aiJson: JSON.stringify(fallbackTriage),
            })
            .where(eq(messages.id, insertedId))
            .run()

          logger.warn('business_media_transcribe_failed', {
            updateId,
            userId: ownerId,
            messageId: insertedId,
            kind: rawMedia.kind,
            duration: rawMedia.duration,
            status: isOversize ? 'too_long' : 'failed',
          })

          publishUserEvent(ownerId, {
            type: 'inbox',
            messageId: insertedId,
            chatId,
          })
        }
      })()

      return
    }

    let messageText = msg.sticker
      ? formatStickerText(msg.sticker)
      : msg.animation
        ? formatGifText(msg.animation, msg.caption)
        : (msg.text ?? msg.caption ?? '')

    const provider = resolveProvider(owner.id)
    if ((msg.sticker || msg.animation) && provider?.describeImage) {
      const visualTarget: { fileId: string; mime: string; kind: 'sticker' | 'gif' } | null =
        msg.sticker
          ? !msg.sticker.is_animated && !msg.sticker.is_video
            ? { fileId: msg.sticker.file_id, mime: 'image/webp', kind: 'sticker' }
            : msg.sticker.thumbnail?.file_id
              ? { fileId: msg.sticker.thumbnail.file_id, mime: 'image/jpeg', kind: 'sticker' }
              : null
          : msg.animation?.thumbnail?.file_id
            ? { fileId: msg.animation.thumbnail.file_id, mime: 'image/jpeg', kind: 'gif' }
            : msg.animation && (msg.animation.file_size ?? 0) <= 4 * 1024 * 1024
              ? { fileId: msg.animation.file_id, mime: 'video/mp4', kind: 'gif' }
              : null

      if (visualTarget) {
        try {
          const imgBuf = await downloadFile(visualTarget.fileId)
          const desc = await provider.describeImage(
            imgBuf,
            visualTarget.mime,
            visualTarget.kind,
          )
          if (desc) {
            if (msg.sticker) {
              const emoji = msg.sticker.emoji?.trim()
              messageText = emoji ? `[Стикер ${emoji}: ${desc}]` : `[Стикер: ${desc}]`
            } else {
              const cleanCaption = msg.caption?.trim()
              messageText = cleanCaption
                ? `[GIF: ${desc}] ${cleanCaption}`
                : `[GIF: ${desc}]`
            }
          }
        } catch {
          // Keep deterministic sticker/GIF fallback label if download or vision fails
        }
      }
    }

    const insertResult = db
      .insert(messages)
      .values({
        userId: owner.id,
        chatId: msg.chat.id,
        tgMessageId: msg.message_id,
        fromTgUserId: msg.from.id,
        fromName: fromDisplayName,
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
          fromName: fromDisplayName,
          text: messageText,
          recentMessages: recentRows.slice(0, -1),
          tz: userTz,
          nowMs: now,
        },
        provider,
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
