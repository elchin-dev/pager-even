import { and, desc, eq, gt, gte, lt } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getProviderForUser, type LlmProvider } from '../ai/provider.js'
import { getDb, type AppDb } from '../db/index.js'
import { channels, digestPosts, users } from '../db/schema.js'
import { resolveUserTimeZone } from './google-calendar.js'
import { logger } from './logger.js'
import { formatTimeHHMM } from './meetings-service.js'
import { localClockToEpochMs } from './time-parser.js'
import { toOriginalLens } from './translit.js'
import type { AuthEnv } from '../middleware/auth.js'

export const MAX_CHANNELS_PER_USER = 20
export const CHANNEL_CHECK_INTERVAL_MS = 30 * 60 * 1000

export interface ScrapedChannelPost {
  postId: number
  text: string
  publishedAt: number
}

export interface ScrapedChannelPage {
  isPublic: boolean
  title: string
  posts: ScrapedChannelPost[]
}

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code)
      return Number.isFinite(n) ? String.fromCodePoint(n) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = parseInt(hex, 16)
      return Number.isFinite(n) ? String.fromCodePoint(n) : ''
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeChannelUsername(raw: string): string | null {
  const trimmed = raw.trim()
  const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?t\.me\/(?:s\/)?([a-zA-Z0-9_]{4,32})/i)
  if (urlMatch?.[1]) {
    const candidate = urlMatch[1].toLowerCase()
    if (candidate === 'joinchat' || candidate === 'addstickers') return null
    return candidate
  }
  const handleMatch = trimmed.match(/^@?([a-zA-Z][a-zA-Z0-9_]{3,31})$/)
  if (handleMatch?.[1]) {
    return handleMatch[1].toLowerCase()
  }
  return null
}

/**
 * Parses HTML from https://t.me/s/<channel> without login or MTProto.
 */
export function parseTelegramPublicChannelHtml(html: string, fallbackUsername: string): ScrapedChannelPage {
  const hasPublicFeed =
    html.includes('tgme_channel_info') || html.includes('tgme_widget_message_wrap')
  if (!hasPublicFeed) {
    return { isPublic: false, title: fallbackUsername, posts: [] }
  }

  const titleMatch =
    html.match(/<div class="tgme_channel_info_header_title"[^>]*>([\s\S]*?)<\/div>/i) ??
    html.match(/<meta property="og:title" content="([^"]+)"/i)
  const title = titleMatch?.[1]
    ? decodeHtmlEntities(titleMatch[1]).slice(0, 60) || fallbackUsername
    : fallbackUsername

  const posts: ScrapedChannelPost[] = []
  const blocks = html.split(/<div class="tgme_widget_message_wrap/i).slice(1)

  for (const block of blocks) {
    const idMatch = block.match(/data-post="[a-zA-Z0-9_]+\/(\d+)"/i)
    if (!idMatch?.[1]) continue
    const postId = Number(idMatch[1])
    if (!Number.isFinite(postId) || postId <= 0) continue

    const textMatch = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    )
    const rawText = textMatch?.[1] ? decodeHtmlEntities(textMatch[1]) : ''
    if (!rawText) continue

    const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/i)
    const parsedTime = timeMatch?.[1] ? Date.parse(timeMatch[1]) : NaN
    const publishedAt = Number.isNaN(parsedTime) ? Date.now() : parsedTime

    posts.push({
      postId,
      text: rawText.slice(0, 3500),
      publishedAt,
    })
  }

  posts.sort((a, b) => a.postId - b.postId)
  return { isPublic: true, title, posts }
}

export async function fetchPublicChannelPage(
  username: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ScrapedChannelPage> {
  const url = `https://t.me/s/${encodeURIComponent(username)}`
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PagerBot/1.0)',
      Accept: 'text/html',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) {
    return { isPublic: false, title: username, posts: [] }
  }
  const html = await res.text()
  return parseTelegramPublicChannelHtml(html, username)
}

const POST_GIST_SCHEMA = z.object({
  gist: z.string().min(1).max(80),
})

export async function summarizeChannelPostOneLine(
  text: string,
  provider?: LlmProvider | null,
): Promise<string> {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? text
  const fallback = toOriginalLens(firstLine, 42) || 'Новый пост'
  if (!provider) return fallback

  try {
    const out = await provider.completeJson({
      system: `Summarize the essence of this Telegram channel post in ONE very concise line (<= 42 chars) in the post's original language.
Output ONLY raw JSON: {"gist": string}. No quotes, no emojis at the start, no markdown.`,
      user: text.slice(0, 1200),
      schema: POST_GIST_SCHEMA,
      maxTokens: 80,
    })
    return toOriginalLens(out.gist, 42) || fallback
  } catch {
    return fallback
  }
}

export async function syncSingleChannel(params: {
  db: AppDb
  channelRow: typeof channels.$inferSelect
  fetchChannel?: typeof fetchPublicChannelPage
  provider?: LlmProvider | null
  nowMs?: number
  force?: boolean
}): Promise<{ addedPosts: number; skippedRateLimit: boolean }> {
  const now = params.nowMs ?? Date.now()
  if (
    !params.force &&
    params.channelRow.lastCheckedAt !== null &&
    now - params.channelRow.lastCheckedAt < CHANNEL_CHECK_INTERVAL_MS
  ) {
    return { addedPosts: 0, skippedRateLimit: true }
  }

  const fetchFn = params.fetchChannel ?? fetchPublicChannelPage
  const page = await fetchFn(params.channelRow.username)
  if (!page.isPublic) {
    params.db
      .update(channels)
      .set({ lastCheckedAt: now })
      .where(eq(channels.id, params.channelRow.id))
      .run()
    return { addedPosts: 0, skippedRateLimit: false }
  }

  const userRow = params.db
    .select({ tz: users.tz })
    .from(users)
    .where(eq(users.id, params.channelRow.userId))
    .get()
  const tz = resolveUserTimeZone(userRow?.tz)
  const todayStartMs = localClockToEpochMs(now, tz, 0, 0, 0)
  const tomorrowStartMs = localClockToEpochMs(now, tz, 1, 0, 0)

  const lastId = params.channelRow.lastPostId ?? 0
  const candidates = (
    lastId > 0
      ? page.posts.filter((p) => p.postId > lastId).slice(-6)
      : page.posts.slice(-3)
  ).filter((p) => p.publishedAt >= todayStartMs)

  const provider =
    params.provider !== undefined
      ? params.provider
      : getProviderForUser(params.channelRow.userId, { db: params.db })

  let addedPosts = 0
  let maxPostId = lastId

  for (const post of candidates) {
    if (post.postId > maxPostId) maxPostId = post.postId
    const gist = await summarizeChannelPostOneLine(post.text, provider)
    const res = params.db
      .insert(digestPosts)
      .values({
        userId: params.channelRow.userId,
        channelId: params.channelRow.id,
        channelTitle: page.title || params.channelRow.title,
        channelUsername: params.channelRow.username,
        postId: post.postId,
        text: post.text,
        gist,
        publishedAt: post.publishedAt,
        expiresAt: tomorrowStartMs,
      })
      .onConflictDoNothing()
      .run()
    if (res.changes > 0) {
      addedPosts += 1
    }
  }

  params.db
    .update(channels)
    .set({
      title: page.title || params.channelRow.title,
      lastCheckedAt: now,
      ...(maxPostId > 0 ? { lastPostId: maxPostId } : {}),
    })
    .where(eq(channels.id, params.channelRow.id))
    .run()

  // Prune digest posts from previous days
  params.db.delete(digestPosts).where(lt(digestPosts.publishedAt, todayStartMs)).run()

  return { addedPosts, skippedRateLimit: false }
}

export async function runChannelsDigestTick(options: {
  db: AppDb
  fetchChannel?: typeof fetchPublicChannelPage
  getProvider?: (userId: number) => LlmProvider | null
  nowMs?: number
}): Promise<number> {
  const now = options.nowMs ?? Date.now()
  const allChannels = options.db.select().from(channels).all()
  let totalAdded = 0

  for (const ch of allChannels) {
    if (ch.lastCheckedAt !== null && now - ch.lastCheckedAt < CHANNEL_CHECK_INTERVAL_MS) {
      continue
    }
    try {
      const provider = options.getProvider ? options.getProvider(ch.userId) : undefined
      const res = await syncSingleChannel({
        db: options.db,
        channelRow: ch,
        fetchChannel: options.fetchChannel,
        provider,
        nowMs: now,
      })
      totalAdded += res.addedPosts
    } catch (err) {
      logger.warn('channel_digest_sync_failed', {
        channelId: ch.id,
        errorName: err instanceof Error ? err.name : 'unknown',
      })
    }
  }

  return totalAdded
}

export function createDigestRouter(options?: {
  db?: AppDb
  nowProvider?: () => number
}): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()
  const nowFn = options?.nowProvider ?? (() => Date.now())
  const idParam = z.coerce.number().int().positive()

  router.get('/', (c) => {
    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()

    const userRow = db
      .select({ tz: users.tz })
      .from(users)
      .where(eq(users.id, authUser.id))
      .get()
    const tz = resolveUserTimeZone(userRow?.tz)
    const todayStartMs = localClockToEpochMs(now, tz, 0, 0, 0)

    const rows = db
      .select()
      .from(digestPosts)
      .where(
        and(
          eq(digestPosts.userId, authUser.id),
          gte(digestPosts.publishedAt, todayStartMs),
          gt(digestPosts.expiresAt, now),
        ),
      )
      .orderBy(desc(digestPosts.publishedAt), desc(digestPosts.id))
      .limit(20)
      .all()

    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        channel: toOriginalLens(r.channelTitle, 18) || r.channelUsername,
        gist: toOriginalLens(r.gist, 44),
        time: formatTimeHHMM(r.publishedAt, tz),
      })),
    })
  })

  router.get('/:id', (c) => {
    const parsed = idParam.safeParse(c.req.param('id'))
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400)

    const authUser = c.get('authUser')
    const db = options?.db ?? getDb()
    const now = nowFn()

    const userRow = db
      .select({ tz: users.tz })
      .from(users)
      .where(eq(users.id, authUser.id))
      .get()
    const tz = resolveUserTimeZone(userRow?.tz)
    const todayStartMs = localClockToEpochMs(now, tz, 0, 0, 0)

    const row = db
      .select()
      .from(digestPosts)
      .where(
        and(
          eq(digestPosts.id, parsed.data),
          eq(digestPosts.userId, authUser.id),
          gte(digestPosts.publishedAt, todayStartMs),
          gt(digestPosts.expiresAt, now),
        ),
      )
      .get()
    if (!row) return c.json({ error: 'not_found' }, 404)

    return c.json({
      id: row.id,
      channel: toOriginalLens(row.channelTitle, 22) || row.channelUsername,
      time: formatTimeHHMM(row.publishedAt, tz),
      gist: toOriginalLens(row.gist, 60),
      text: toOriginalLens(row.text, 2400),
    })
  })

  return router
}
