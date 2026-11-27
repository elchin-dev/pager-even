import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tgUserId: integer('tg_user_id').notNull().unique(),
    tgName: text('tg_name'),
    businessConnectionId: text('business_connection_id'),
    canReply: integer('can_reply', { mode: 'boolean' }).notNull().default(false),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(false),
    businessRightsJson: text('business_rights_json'),
    tz: text('tz').notNull().default('UTC'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('users_business_connection_idx').on(table.businessConnectionId)],
)

export const userSettings = sqliteTable('user_settings', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  feedMode: text('feed_mode', { enum: ['urgent', 'all'] })
    .notNull()
    .default('urgent'),
  chatView: text('chat_view', { enum: ['new_only', 'with_history'] })
    .notNull()
    .default('new_only'),
  voiceEnabled: integer('voice_enabled', { mode: 'boolean' })
    .notNull()
    .default(true),
  conflictAlerts: integer('conflict_alerts', { mode: 'boolean' })
    .notNull()
    .default(true),
  meetingReminders: integer('meeting_reminders', { mode: 'boolean' })
    .notNull()
    .default(true),
  briefAlerts: integer('brief_alerts', { mode: 'boolean' })
    .notNull()
    .default(true),
  taskReminders: integer('task_reminders', { mode: 'boolean' })
    .notNull()
    .default(true),
  uiLang: text('ui_lang', { enum: ['ru', 'en'] })
    .notNull()
    .default('ru'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
})

export const pairCodes = sqliteTable('pair_codes', {
  code: text('code').primaryKey(),
  pairId: text('pair_id').notNull().unique(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  createdAt: integer('created_at').notNull(),
})

export const linkTokens = sqliteTable('link_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose', { enum: ['google', 'ai'] }).notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
})

export const googleAccounts = sqliteTable('google_accounts', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  email: text('email'),
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  scope: text('scope').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const aiSettings = sqliteTable('ai_settings', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  mode: text('mode', { enum: ['server', 'byok'] }).notNull().default('server'),
  provider: text('provider', {
    enum: ['anthropic', 'gemini', 'openai', 'openrouter'],
  })
    .notNull()
    .default('anthropic'),
  model: text('model').notNull(),
  keyEnc: text('key_enc'),
  keyLast4: text('key_last4'),
  updatedAt: integer('updated_at').notNull(),
})

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatId: integer('chat_id').notNull(),
    tgMessageId: integer('tg_message_id').notNull(),
    fromTgUserId: integer('from_tg_user_id'),
    fromName: text('from_name').notNull(),
    businessConnectionId: text('business_connection_id'),
    isFromOwner: integer('is_from_owner', { mode: 'boolean' }).notNull().default(false),
    text: text('text').notNull(),
    receivedAt: integer('received_at').notNull(),
    status: text('status', {
      enum: ['new', 'seen', 'replied', 'skipped'],
    })
      .notNull()
      .default('new'),
    aiJson: text('ai_json'),
    mediaJson: text('media_json'),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('messages_user_chat_msg_uidx').on(table.userId, table.chatId, table.tgMessageId),
    index('messages_user_status_idx').on(table.userId, table.status),
    index('messages_expires_at_idx').on(table.expiresAt),
  ],
)

export const actions = sqliteTable('actions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  messageId: integer('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['reply', 'event', 'voice'] }).notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const sentReminders = sqliteTable(
  'sent_reminders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['meeting', 'task', 'promise'] }).notNull(),
    sourceKey: text('source_key').notNull(),
    sentAt: integer('sent_at').notNull(),
  },
  (table) => [
    uniqueIndex('sent_reminders_user_kind_key_uidx').on(
      table.userId,
      table.kind,
      table.sourceKey,
    ),
  ],
)

export const notes = sqliteTable(
  'notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    meetingEventId: text('meeting_event_id'),
    meetingTitle: text('meeting_title'),
    remindAt: integer('remind_at'),
    taskCompletedAt: integer('task_completed_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('notes_user_updated_idx').on(table.userId, table.updatedAt),
    index('notes_remind_at_idx').on(table.remindAt),
  ],
)

export const promises = sqliteTable(
  'promises',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: integer('message_id').references(() => messages.id, { onDelete: 'set null' }),
    chatId: integer('chat_id').notNull(),
    contactName: text('contact_name').notNull(),
    replyText: text('reply_text').notNull(),
    taskText: text('task_text').notNull(),
    promisedAtTime: text('promised_at_time').notNull(),
    remindAt: integer('remind_at').notNull(),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('promises_user_remind_idx').on(table.userId, table.remindAt)],
)

export const channels = sqliteTable(
  'channels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    title: text('title').notNull(),
    lastCheckedAt: integer('last_checked_at'),
    lastPostId: integer('last_post_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('channels_user_username_uidx').on(table.userId, table.username)],
)

export const digestPosts = sqliteTable(
  'digest_posts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    channelTitle: text('channel_title').notNull(),
    channelUsername: text('channel_username').notNull(),
    postId: integer('post_id').notNull(),
    text: text('text').notNull(),
    gist: text('gist').notNull(),
    publishedAt: integer('published_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('digest_posts_user_chan_post_uidx').on(
      table.userId,
      table.channelUsername,
      table.postId,
    ),
    index('digest_posts_user_pub_idx').on(table.userId, table.publishedAt),
    index('digest_posts_expires_idx').on(table.expiresAt),
  ],
)
