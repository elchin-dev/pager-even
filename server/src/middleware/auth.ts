import { and, eq, isNull } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { getDb, type AppDb } from '../db/index.js'
import { devices, users } from '../db/schema.js'
import { sha256Hex } from '../lib/crypto.js'
import { logger } from '../lib/logger.js'

export interface AuthUser {
  id: number
  tgUserId: number
  tgName: string | null
  businessConnectionId: string | null
  canReply: boolean
  isEnabled: boolean
  tz: string
}

export interface AuthEnv {
  Variables: {
    authUser: AuthUser
    authDeviceId: number
  }
}

export function createBearerAuthMiddleware(db?: AppDb): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (c.req.path.startsWith('/api/pair/')) {
      return next()
    }

    const authHeader = c.req.header('Authorization')
    const match = authHeader?.match(/^Bearer\s+(\S+)$/i)
    if (!match) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const tokenHash = sha256Hex(match[1])
    const database = db ?? getDb()

    const row = database
      .select({
        deviceId: devices.id,
        user: {
          id: users.id,
          tgUserId: users.tgUserId,
          tgName: users.tgName,
          businessConnectionId: users.businessConnectionId,
          canReply: users.canReply,
          isEnabled: users.isEnabled,
          tz: users.tz,
        },
      })
      .from(devices)
      .innerJoin(users, eq(devices.userId, users.id))
      .where(and(eq(devices.tokenHash, tokenHash), isNull(devices.revokedAt)))
      .get()

    if (!row) {
      logger.warn('api_auth_rejected', { path: c.req.path })
      return c.json({ error: 'unauthorized' }, 401)
    }

    c.set('authUser', row.user)
    c.set('authDeviceId', row.deviceId)
    return next()
  }
}
