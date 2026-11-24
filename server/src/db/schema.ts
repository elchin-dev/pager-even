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
    text: text('text').notNull(),
    receivedAt: integer('received_at').notNull(),
    status: text('status', {
      enum: ['new', 'seen', 'replied', 'skipped'],
    })
      .notNull()
      .default('new'),
    aiJson: text('ai_json'),
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
  type: text('type', { enum: ['reply', 'event'] }).notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
})
