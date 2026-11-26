import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Bot, Context } from 'grammy'
import type { User } from 'grammy/types'
import type { LlmProvider } from '../ai/provider.js'
import type { AppDb } from '../db/index.js'
import {
  aiSettings,
  channels,
  devices,
  googleAccounts,
  linkTokens,
  messages,
  notes,
  promises,
  users,
} from '../db/schema.js'
import { generateLinkToken, sha256Hex } from '../lib/crypto.js'
import {
  MAX_CHANNELS_PER_USER,
  fetchPublicChannelPage,
  normalizeChannelUsername,
  syncSingleChannel,
} from '../lib/digest-service.js'
import {
  hasCalendarWriteScope,
  resolveUserTimeZone,
  type GoogleCalendarClient,
} from '../lib/google-calendar.js'
import { logger } from '../lib/logger.js'
import { fetchUserUpcomingMeetings, formatTimeHHMM } from '../lib/meetings-service.js'
import { analyzeNoteText } from '../lib/notes-service.js'
import { toOriginalLens } from '../lib/translit.js'
import type { TranscodeMediaToWavFn } from '../voice/transcode.js'
import { getUserSettings, patchUserSettings } from '../routes/settings.js'

const LINK_TOKEN_TTL_MS = 10 * 60 * 1000

// Ephemeral per-Telegram-user prompt state in private bot chat
type PendingBotState =
  | { kind: 'edit_note'; noteId: number; expiresAt: number }
  | { kind: 'add_channel'; expiresAt: number }

const pendingBotStates = new Map<number, PendingBotState>()

function setPendingState(tgUserId: number, state: PendingBotState): void {
  pendingBotStates.set(tgUserId, state)
}

function getPendingState(tgUserId: number): PendingBotState | null {
  const st = pendingBotStates.get(tgUserId)
  if (!st) return null
  if (st.expiresAt <= Date.now()) {
    pendingBotStates.delete(tgUserId)
    return null
  }
  return st
}

function clearPendingState(tgUserId: number): void {
  pendingBotStates.delete(tgUserId)
}

function formatDisplayName(user: User): string {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return fullName || user.username || String(user.id)
}

function upsertTgUserLocal(db: AppDb, tgUser: User) {
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

function issueGoogleLink(db: AppDb, userId: number, publicBaseUrl: string): string {
  const rawToken = generateLinkToken()
  db.insert(linkTokens)
    .values({
      tokenHash: sha256Hex(rawToken),
      userId,
      purpose: 'google',
      expiresAt: Date.now() + LINK_TOKEN_TTL_MS,
      usedAt: null,
    })
    .run()
  return `${publicBaseUrl}/auth/google/start?t=${encodeURIComponent(rawToken)}`
}

export function buildSettingsView(db: AppDb, userId: number): {
  text: string
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
} {
  const user = db.select().from(users).where(eq(users.id, userId)).get()
  const activeDevices = db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
    .all()
  const chatIds = db
    .select({ chatId: messages.chatId })
    .from(messages)
    .where(eq(messages.userId, userId))
    .all()
  const uniqueChats = new Set(chatIds.map((r) => r.chatId)).size
  const gAcc = db.select().from(googleAccounts).where(eq(googleAccounts.userId, userId)).get()
  const cfg = getUserSettings(db, userId)

  const glassesLine =
    activeDevices.length > 0
      ? `Очки: подключены (${activeDevices.length})`
      : 'Очки: не подключены'
  const bizLine =
    user?.businessConnectionId && user.isEnabled
      ? `Автоматизация чатов: включена (${uniqueChats} чатов)`
      : 'Автоматизация чатов: не подключена'
  const calLine = gAcc
    ? `Google Calendar: ${gAcc.email ?? 'подключён'}${hasCalendarWriteScope(gAcc.scope) ? '' : ' (только чтение — переподключите)'}`
    : 'Google Calendar: не подключён'

  const flag = (on: boolean) => (on ? '[Вкл]' : '[Выкл]')
  const text = [
    'Настройки Pager',
    '',
    glassesLine,
    bizLine,
    calLine,
    '',
    'Уведомления:',
    `• Встречи: ${flag(cfg.meetingReminders)}`,
    `• Бриф в напоминаниях: ${flag(cfg.briefAlerts)}`,
    `• «Ты занят»: ${flag(cfg.conflictAlerts)}`,
    `• Задачи и обещания: ${flag(cfg.taskReminders)}`,
  ].join('\n')

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
    [
      {
        text: `Встречи: ${cfg.meetingReminders ? 'Вкл' : 'Выкл'}`,
        callback_data: 'st:toggle:meetingReminders',
      },
      {
        text: `Бриф: ${cfg.briefAlerts ? 'Вкл' : 'Выкл'}`,
        callback_data: 'st:toggle:briefAlerts',
      },
    ],
    [
      {
        text: `Ты занят: ${cfg.conflictAlerts ? 'Вкл' : 'Выкл'}`,
        callback_data: 'st:toggle:conflictAlerts',
      },
      {
        text: `Задачи: ${cfg.taskReminders ? 'Вкл' : 'Выкл'}`,
        callback_data: 'st:toggle:taskReminders',
      },
    ],
    [
      gAcc
        ? { text: 'Отключить Google', callback_data: 'st:google:disconnect' }
        : { text: 'Подключить календарь', callback_data: 'st:google:connect' },
      { text: 'Отвязать очки', callback_data: 'st:glasses:unpair' },
    ],
  ]

  return { text, replyMarkup: { inline_keyboard: keyboard } }
}

export function buildNotesListView(db: AppDb, userId: number): {
  text: string
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
} {
  const userRow = db.select({ tz: users.tz }).from(users).where(eq(users.id, userId)).get()
  const tz = resolveUserTimeZone(userRow?.tz)
  const rows = db
    .select()
    .from(notes)
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(10)
    .all()

  if (rows.length === 0) {
    return {
      text: 'Заметок пока нет.\nПришлите боту любой текст или голосовое сообщение — я сохраню его как заметку.',
      replyMarkup: { inline_keyboard: [] },
    }
  }

  const lines = ['Мои заметки (новые сверху):', '']
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = []

  rows.forEach((n, idx) => {
    const num = idx + 1
    const snippet = toOriginalLens(n.text, 55)
    const meetTag = n.meetingTitle ? ` [${n.meetingTitle}]` : ''
    const remTag =
      n.remindAt && !n.taskCompletedAt ? ` (напомн. ${formatTimeHHMM(n.remindAt, tz)})` : ''
    lines.push(`${num}. ${snippet}${meetTag}${remTag}`)
    keyboard.push([
      { text: `#${num} Изменить`, callback_data: `nt:edit:${n.id}` },
      { text: `#${num} Встреча`, callback_data: `nt:pickm:${n.id}` },
      { text: `#${num} Без встречи`, callback_data: `nt:unm:${n.id}` },
      { text: `#${num} Удалить`, callback_data: `nt:del:${n.id}` },
    ])
  })

  return { text: lines.join('\n'), replyMarkup: { inline_keyboard: keyboard } }
}

export function buildChannelsView(db: AppDb, userId: number): {
  text: string
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
} {
  const rows = db
    .select()
    .from(channels)
    .where(eq(channels.userId, userId))
    .orderBy(desc(channels.createdAt), desc(channels.id))
    .all()

  const lines = [`Дайджест каналов (${rows.length}/${MAX_CHANNELS_PER_USER}):`, '']
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = []

  if (rows.length === 0) {
    lines.push(
      'Подписок пока нет.',
      'Пришлите ссылку вида t.me/durov или перешлите сюда пост из публичного канала.',
    )
  } else {
    rows.forEach((ch, idx) => {
      lines.push(`${idx + 1}. ${ch.title} (@${ch.username})`)
      keyboard.push([
        {
          text: `Убрать: ${toOriginalLens(ch.title, 18)}`,
          callback_data: `ch:del:${ch.id}`,
        },
      ])
    })
  }

  keyboard.push([{ text: 'Добавить канал', callback_data: 'ch:add' }])
  return { text: lines.join('\n'), replyMarkup: { inline_keyboard: keyboard } }
}

export function registerBotManagement(params: {
  bot: Bot
  db: AppDb
  calendarClient: GoogleCalendarClient
  resolveProvider: (userId: number) => LlmProvider | null
  downloadFile: (fileId: string) => Promise<Buffer>
  transcodeMedia: TranscodeMediaToWavFn
  resolvePublicBaseUrl: () => string
  fetchChannel?: typeof fetchPublicChannelPage
}): void {
  const { bot, db, calendarClient, resolveProvider, downloadFile, transcodeMedia } = params

  async function trySubscribeChannel(ctx: Context, userId: number, rawUsername: string): Promise<void> {
    const username = normalizeChannelUsername(rawUsername)
    if (!username) {
      await ctx.reply('Не удалось распознать канал. Пришлите ссылку t.me/<канал> или перешлите пост из публичного канала.')
      return
    }

    const existingAll = db
      .select()
      .from(channels)
      .where(eq(channels.userId, userId))
      .all()

    if (existingAll.some((c) => c.username === username)) {
      const view = buildChannelsView(db, userId)
      await ctx.reply(`Канал @${username} уже добавлен.\n\n${view.text}`, {
        reply_markup: view.replyMarkup,
      })
      return
    }

    if (existingAll.length >= MAX_CHANNELS_PER_USER) {
      await ctx.reply(`Достигнут лимит: не более ${MAX_CHANNELS_PER_USER} каналов на пользователя.`)
      return
    }

    const fetchFn = params.fetchChannel ?? fetchPublicChannelPage
    const page = await fetchFn(username)
    if (!page.isPublic) {
      await ctx.reply(
        `У канала @${username} нет публичной страницы https://t.me/s/${username}. Дайджест работает только с публичными каналами.`,
      )
      return
    }

    const now = Date.now()
    const ins = db
      .insert(channels)
      .values({
        userId,
        username,
        title: page.title || username,
        lastCheckedAt: null,
        lastPostId: null,
        createdAt: now,
      })
      .run()

    const channelRow = db
      .select()
      .from(channels)
      .where(eq(channels.id, Number(ins.lastInsertRowid)))
      .get()!

    const synced = await syncSingleChannel({
      db,
      channelRow,
      fetchChannel: () => Promise.resolve(page),
      provider: resolveProvider(userId),
      nowMs: now,
      force: true,
    })

    logger.info('channel_subscribed', {
      userId,
      channelId: channelRow.id,
      initialPosts: synced.addedPosts,
    })

    const view = buildChannelsView(db, userId)
    await ctx.reply(
      `Канал «${page.title}» (@${username}) добавлен. Загружено постов: ${synced.addedPosts}.\n\n${view.text}`,
      { reply_markup: view.replyMarkup },
    )
  }

  async function saveIncomingBotNote(ctx: Context, userId: number, noteText: string): Promise<void> {
    const cleaned = noteText.trim()
    if (!cleaned) return

    const pending = ctx.from ? getPendingState(ctx.from.id) : null
    if (pending?.kind === 'edit_note' && ctx.from) {
      clearPendingState(ctx.from.id)
      const existing = db
        .select()
        .from(notes)
        .where(and(eq(notes.id, pending.noteId), eq(notes.userId, userId)))
        .get()
      if (existing) {
        const analysis = await analyzeNoteText({
          db,
          userId,
          text: cleaned,
          calendarClient,
        })
        db.update(notes)
          .set({
            text: cleaned,
            remindAt: analysis.taskReminder?.remindAt ?? existing.remindAt,
            updatedAt: Date.now(),
          })
          .where(eq(notes.id, existing.id))
          .run()
        const view = buildNotesListView(db, userId)
        await ctx.reply(`Заметка обновлена.\n\n${view.text}`, {
          reply_markup: view.replyMarkup,
        })
        return
      }
    }

    const analysis = await analyzeNoteText({
      db,
      userId,
      text: cleaned,
      calendarClient,
    })
    const now = Date.now()
    const ins = db
      .insert(notes)
      .values({
        userId,
        text: cleaned,
        meetingEventId: analysis.matchedMeeting?.eventId ?? null,
        meetingTitle: analysis.matchedMeeting?.label ?? null,
        remindAt: analysis.taskReminder?.remindAt ?? null,
        taskCompletedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const noteId = Number(ins.lastInsertRowid)

    let upcomingButtons: Array<Array<{ text: string; callback_data: string }>> = []
    try {
      const { events, tz } = await fetchUserUpcomingMeetings({
        db,
        userId,
        calendarClient,
        nowMs: now,
        horizonHours: 48,
      })
      upcomingButtons = events.slice(0, 3).map((ev) => {
        const label = `${toOriginalLens(ev.summary, 16)} ${formatTimeHHMM(ev.startMs, tz)}`
        return [
          {
            text: `Привязать: ${label}`,
            callback_data: `nt:bind:${noteId}:${ev.id.slice(0, 40)}`,
          },
        ]
      })
    } catch {
      upcomingButtons = []
    }

    upcomingButtons.push([
      { text: 'Без встречи', callback_data: `nt:unm:${noteId}` },
      { text: 'Удалить', callback_data: `nt:del:${noteId}` },
    ])

    const remInfo = analysis.taskReminder ? `\nНапоминание: ${analysis.taskReminder.label}` : ''
    const meetInfo = analysis.matchedMeeting
      ? `\nПривязана ко встрече: ${analysis.matchedMeeting.label}`
      : ''

    await ctx.reply(`Заметка сохранена.${remInfo}${meetInfo}\nПривязать к встрече?`, {
      reply_markup: { inline_keyboard: upcomingButtons },
    })
  }

  bot.command('settings', async (ctx) => {
    if (!ctx.from) return
    const user = upsertTgUserLocal(db, ctx.from)
    const view = buildSettingsView(db, user.id)
    await ctx.reply(view.text, { reply_markup: view.replyMarkup })
  })

  bot.command('notes', async (ctx) => {
    if (!ctx.from) return
    const user = upsertTgUserLocal(db, ctx.from)
    const view = buildNotesListView(db, user.id)
    await ctx.reply(view.text, {
      ...(view.replyMarkup.inline_keyboard.length > 0 ? { reply_markup: view.replyMarkup } : {}),
    })
  })

  bot.command('channels', async (ctx) => {
    if (!ctx.from) return
    const user = upsertTgUserLocal(db, ctx.from)
    const arg = ctx.match.trim()
    if (arg) {
      await trySubscribeChannel(ctx, user.id, arg)
      return
    }
    const view = buildChannelsView(db, user.id)
    await ctx.reply(view.text, { reply_markup: view.replyMarkup })
  })

  // Voice or audio sent directly to the bot in private chat -> transcribe & save as note
  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    if (ctx.chat.type !== 'private' || !ctx.from) return
    const user = upsertTgUserLocal(db, ctx.from)
    const media = ctx.message.voice ?? ctx.message.audio
    if (!media) return

    if ((media.duration ?? 0) > 300 || (media.file_size ?? 0) > 20 * 1024 * 1024) {
      await ctx.reply('Голосовое слишком длинное (лимит 5 мин / 20 МБ).')
      return
    }

    const provider = resolveProvider(user.id)
    if (!provider?.transcribeAudio) {
      await ctx.reply('Расшифровка голоса сейчас недоступна.')
      return
    }

    try {
      const rawBuf = await downloadFile(media.file_id)
      const wavBuf = await transcodeMedia(rawBuf)
      const { transcript } = await provider.transcribeAudio(wavBuf, 'audio/wav')
      if (!transcript.trim()) {
        await ctx.reply('Не удалось разобрать речь в голосовом сообщении.')
        return
      }
      logger.info('bot_voice_note_transcribed', {
        userId: user.id,
        duration: media.duration ?? 0,
        textLen: transcript.trim().length,
      })
      await saveIncomingBotNote(ctx, user.id, transcript.trim())
    } catch {
      await ctx.reply('Ошибка при расшифровке голосовой заметки.')
    }
  })

  // Forwarded post from channel or text message in private bot chat
  bot.on('message', async (ctx, next) => {
    if (ctx.chat.type !== 'private' || !ctx.from) {
      await next()
      return
    }

    // Ignore commands or 6-digit pairing codes (handled by core bot handlers)
    const rawText = ctx.message.text?.trim() ?? ''
    if (rawText.startsWith('/') || /^\d{6}$/.test(rawText)) {
      await next()
      return
    }
    if (ctx.message.voice || ctx.message.audio) {
      return
    }

    const user = upsertTgUserLocal(db, ctx.from)

    // 1) Forwarded from a channel -> subscribe channel
    const fwdOrigin = (ctx.message as { forward_origin?: { type?: string; chat?: { username?: string } } }).forward_origin
    const legacyFwdChat = (ctx.message as { forward_from_chat?: { type?: string; username?: string } }).forward_from_chat
    const forwardedUsername =
      (fwdOrigin?.type === 'channel' ? fwdOrigin.chat?.username : undefined) ??
      (legacyFwdChat?.type === 'channel' ? legacyFwdChat.username : undefined)

    if (forwardedUsername) {
      clearPendingState(ctx.from.id)
      await trySubscribeChannel(ctx, user.id, forwardedUsername)
      return
    }

    if ((fwdOrigin?.type === 'channel' || legacyFwdChat?.type === 'channel') && !forwardedUsername) {
      await ctx.reply('У этого канала нет публичного @username и публичной страницы t.me/s/…')
      return
    }

    // 2) Pending add_channel state OR standalone t.me/<channel> link
    const pending = getPendingState(ctx.from.id)
    const looksLikeChannelLink = /^(?:https?:\/\/)?(?:www\.)?t\.me\/(?:s\/)?[a-zA-Z0-9_]{4,32}\/?$/i.test(
      rawText,
    )
    if (pending?.kind === 'add_channel' || looksLikeChannelLink) {
      clearPendingState(ctx.from.id)
      await trySubscribeChannel(ctx, user.id, rawText)
      return
    }

    // 3) Otherwise save text as a note!
    if (rawText.length > 0) {
      await saveIncomingBotNote(ctx, user.id, rawText)
      return
    }

    await next()
  })

  // Callback buttons for /settings, /notes, /channels, and task/promise reminders
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data
    const from = ctx.from
    if (!from) {
      await next()
      return
    }

    if (
      !data.startsWith('st:') &&
      !data.startsWith('nt:') &&
      !data.startsWith('ch:') &&
      !data.startsWith('tk:') &&
      !data.startsWith('pr:')
    ) {
      await next()
      return
    }

    const user = upsertTgUserLocal(db, from)

    // Settings callbacks
    if (data.startsWith('st:toggle:')) {
      const field = data.slice('st:toggle:'.length) as
        | 'meetingReminders'
        | 'briefAlerts'
        | 'conflictAlerts'
        | 'taskReminders'
      const cur = getUserSettings(db, user.id)
      if (field in cur) {
        patchUserSettings(db, user.id, { [field]: !cur[field] })
      }
      const view = buildSettingsView(db, user.id)
      await ctx.answerCallbackQuery({ text: 'Обновлено' })
      try {
        await ctx.editMessageText(view.text, { reply_markup: view.replyMarkup })
      } catch {
        await ctx.reply(view.text, { reply_markup: view.replyMarkup })
      }
      return
    }

    if (data === 'st:google:connect') {
      const url = issueGoogleLink(db, user.id, params.resolvePublicBaseUrl())
      await ctx.answerCallbackQuery()
      await ctx.reply(
        `Откройте ссылку в браузере, чтобы подключить Google Calendar (чтение и запись):\n${url}`,
        { link_preview_options: { is_disabled: true } },
      )
      return
    }

    if (data === 'st:google:disconnect') {
      db.delete(googleAccounts).where(eq(googleAccounts.userId, user.id)).run()
      const view = buildSettingsView(db, user.id)
      await ctx.answerCallbackQuery({ text: 'Google Calendar отключён' })
      try {
        await ctx.editMessageText(view.text, { reply_markup: view.replyMarkup })
      } catch {
        await ctx.reply(view.text, { reply_markup: view.replyMarkup })
      }
      return
    }

    if (data === 'st:glasses:unpair') {
      db.update(devices)
        .set({ revokedAt: Date.now() })
        .where(and(eq(devices.userId, user.id), isNull(devices.revokedAt)))
        .run()
      db.delete(aiSettings).where(eq(aiSettings.userId, user.id)).run()
      const view = buildSettingsView(db, user.id)
      await ctx.answerCallbackQuery({ text: 'Очки отвязаны' })
      try {
        await ctx.editMessageText(view.text, { reply_markup: view.replyMarkup })
      } catch {
        await ctx.reply(view.text, { reply_markup: view.replyMarkup })
      }
      return
    }

    // Notes callbacks
    if (data.startsWith('nt:')) {
      const parts = data.split(':')
      const action = parts[1]
      const noteId = Number(parts[2])

      if (action === 'del' && noteId) {
        db.delete(notes)
          .where(and(eq(notes.id, noteId), eq(notes.userId, user.id)))
          .run()
        await ctx.answerCallbackQuery({ text: 'Заметка удалена' })
        const view = buildNotesListView(db, user.id)
        await ctx.reply(view.text, {
          ...(view.replyMarkup.inline_keyboard.length > 0 ? { reply_markup: view.replyMarkup } : {}),
        })
        return
      }

      if (action === 'unm' && noteId) {
        db.update(notes)
          .set({ meetingEventId: null, meetingTitle: null, updatedAt: Date.now() })
          .where(and(eq(notes.id, noteId), eq(notes.userId, user.id)))
          .run()
        await ctx.answerCallbackQuery({ text: 'Сохранено без встречи' })
        return
      }

      if (action === 'edit' && noteId) {
        setPendingState(from.id, {
          kind: 'edit_note',
          noteId,
          expiresAt: Date.now() + 5 * 60_000,
        })
        await ctx.answerCallbackQuery()
        await ctx.reply('Пришлите новый текст или голосовое для этой заметки:')
        return
      }

      if (action === 'pickm' && noteId) {
        await ctx.answerCallbackQuery()
        try {
          const { events, tz } = await fetchUserUpcomingMeetings({
            db,
            userId: user.id,
            calendarClient,
            nowMs: Date.now(),
            horizonHours: 72,
          })
          if (events.length === 0) {
            await ctx.reply('Ближайших встреч в календаре не найдено.')
            return
          }
          const kb = events.slice(0, 5).map((ev) => [
            {
              text: `${toOriginalLens(ev.summary, 18)} ${formatTimeHHMM(ev.startMs, tz)}`,
              callback_data: `nt:bind:${noteId}:${ev.id.slice(0, 40)}`,
            },
          ])
          kb.push([{ text: 'Без встречи', callback_data: `nt:unm:${noteId}` }])
          await ctx.reply('Выберите встречу для заметки:', {
            reply_markup: { inline_keyboard: kb },
          })
        } catch {
          await ctx.reply('Не удалось загрузить встречи из Google Calendar.')
        }
        return
      }

      if (action === 'bind' && noteId) {
        const evPrefix = parts.slice(3).join(':')
        try {
          const { events, tz } = await fetchUserUpcomingMeetings({
            db,
            userId: user.id,
            calendarClient,
            nowMs: Date.now(),
            horizonHours: 72,
          })
          const ev = events.find((e) => e.id === evPrefix || e.id.startsWith(evPrefix))
          if (ev) {
            const label = `${toOriginalLens(ev.summary, 18)} ${formatTimeHHMM(ev.startMs, tz)}`
            db.update(notes)
              .set({
                meetingEventId: ev.id,
                meetingTitle: label,
                updatedAt: Date.now(),
              })
              .where(and(eq(notes.id, noteId), eq(notes.userId, user.id)))
              .run()
            await ctx.answerCallbackQuery({ text: `Привязано: ${label}` })
            await ctx.reply(`Заметка привязана ко встрече «${label}».`)
            return
          }
        } catch {
          // ignore
        }
        await ctx.answerCallbackQuery({ text: 'Встреча не найдена' })
        return
      }
    }

    // Channels callbacks
    if (data === 'ch:add') {
      setPendingState(from.id, { kind: 'add_channel', expiresAt: Date.now() + 5 * 60_000 })
      await ctx.answerCallbackQuery()
      await ctx.reply('Пришлите ссылку t.me/<канал>, @username или перешлите пост из публичного канала:')
      return
    }

    if (data.startsWith('ch:del:')) {
      const chId = Number(data.slice('ch:del:'.length))
      db.delete(channels)
        .where(and(eq(channels.id, chId), eq(channels.userId, user.id)))
        .run()
      const view = buildChannelsView(db, user.id)
      await ctx.answerCallbackQuery({ text: 'Канал удалён' })
      try {
        await ctx.editMessageText(view.text, { reply_markup: view.replyMarkup })
      } catch {
        await ctx.reply(view.text, { reply_markup: view.replyMarkup })
      }
      return
    }

    // Task reminder callbacks
    if (data.startsWith('tk:done:')) {
      const noteId = Number(data.slice('tk:done:'.length))
      db.update(notes)
        .set({ taskCompletedAt: Date.now(), updatedAt: Date.now() })
        .where(and(eq(notes.id, noteId), eq(notes.userId, user.id)))
        .run()
      await ctx.answerCallbackQuery({ text: 'Отмечено как готово' })
      return
    }
    if (data.startsWith('tk:snooze:')) {
      const noteId = Number(data.slice('tk:snooze:'.length))
      db.update(notes)
        .set({ remindAt: Date.now() + 3600_000, taskCompletedAt: null, updatedAt: Date.now() })
        .where(and(eq(notes.id, noteId), eq(notes.userId, user.id)))
        .run()
      await ctx.answerCallbackQuery({ text: 'Отложено на +1 час' })
      return
    }

    // Promise reminder callbacks
    if (data.startsWith('pr:done:')) {
      const pid = Number(data.slice('pr:done:'.length))
      db.update(promises)
        .set({ completedAt: Date.now() })
        .where(and(eq(promises.id, pid), eq(promises.userId, user.id)))
        .run()
      await ctx.answerCallbackQuery({ text: 'Отмечено как готово' })
      return
    }
    if (data.startsWith('pr:snooze:')) {
      const pid = Number(data.slice('pr:snooze:'.length))
      db.update(promises)
        .set({ remindAt: Date.now() + 3600_000, completedAt: null })
        .where(and(eq(promises.id, pid), eq(promises.userId, user.id)))
        .run()
      await ctx.answerCallbackQuery({ text: 'Отложено на +1 час' })
      return
    }

    await next()
  })
}
