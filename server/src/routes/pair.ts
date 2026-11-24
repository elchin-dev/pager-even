import { randomInt, randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getBotUsername } from '../bot/index.js'
import { getDb, type AppDb } from '../db/index.js'
import { devices, pairCodes } from '../db/schema.js'
import { generateDeviceToken, sha256Hex } from '../lib/crypto.js'
import { logger } from '../lib/logger.js'

const PAIR_TTL_MS = 10 * 60 * 1000

const statusQuerySchema = z.object({
  pairId: z.string().uuid(),
})

export interface PairRouterOptions {
  db?: AppDb
  botUsername?: string
}

export function createPairRouter(options?: PairRouterOptions): Hono {
  const router = new Hono()

  router.post('/start', async (c) => {
    const db = options?.db ?? getDb()
    const now = Date.now()
    const pairId = randomUUID()
    const expiresAt = now + PAIR_TTL_MS

    let code = ''
    let inserted = false
    for (let attempt = 0; attempt < 5; attempt += 1) {
      code = String(randomInt(100_000, 1_000_000))
      const res = db
        .insert(pairCodes)
        .values({
          code,
          pairId,
          userId: null,
          expiresAt,
          usedAt: null,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run()
      if (res.changes === 1) {
        inserted = true
        break
      }
    }

    if (!inserted) {
      logger.error('pair_code_generation_failed')
      return c.json({ error: 'pair_start_failed' }, 500)
    }

    const botUsername = options?.botUsername ?? (await getBotUsername())

    logger.info('pair_started', { pairId })
    return c.json({
      pairId,
      code,
      botUsername,
    })
  })

  router.get('/status', (c) => {
    const parsed = statusQuerySchema.safeParse({
      pairId: c.req.query('pairId'),
    })
    if (!parsed.success) {
      return c.json({ error: 'invalid_pair_id' }, 400)
    }

    const db = options?.db ?? getDb()
    const { pairId } = parsed.data
    const now = Date.now()

    const row = db.select().from(pairCodes).where(eq(pairCodes.pairId, pairId)).get()

    if (!row || row.usedAt !== null || row.expiresAt <= now) {
      return c.json({ status: 'expired' as const })
    }

    if (row.userId === null) {
      return c.json({ status: 'pending' as const })
    }

    const claimedUserId = row.userId

    const deviceToken = db.transaction((tx) => {
      const updateRes = tx
        .update(pairCodes)
        .set({ usedAt: now })
        .where(and(eq(pairCodes.pairId, pairId), isNull(pairCodes.usedAt)))
        .run()

      if (updateRes.changes !== 1) {
        return null
      }

      const rawToken = generateDeviceToken()
      const tokenHash = sha256Hex(rawToken)

      tx.insert(devices)
        .values({
          userId: claimedUserId,
          tokenHash,
          createdAt: now,
          revokedAt: null,
        })
        .run()

      return rawToken
    })

    if (!deviceToken) {
      return c.json({ status: 'expired' as const })
    }

    logger.info('pair_completed', {
      pairId,
      userId: claimedUserId,
    })

    return c.json({
      status: 'paired' as const,
      deviceToken,
    })
  })

  return router
}
