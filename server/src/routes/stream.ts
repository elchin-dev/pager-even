import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { subscribeUserEvents } from '../lib/events.js'
import type { AuthEnv } from '../middleware/auth.js'

const HEARTBEAT_INTERVAL_MS = 25_000

export function createStreamRouter(): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>()

  router.get('/', (c) => {
    const authUser = c.get('authUser')

    return streamSSE(c, async (stream) => {
      let closed = false

      const unsubscribe = subscribeUserEvents(authUser.id, (event) => {
        if (closed) return
        const data =
          event.type === 'reminder'
            ? JSON.stringify(event.reminder)
            : JSON.stringify({
                messageId: event.messageId,
                chatId: event.chatId,
              })
        void stream.writeSSE({
          event: event.type,
          data,
        })
      })

      const heartbeat = setInterval(() => {
        if (closed) return
        void stream.writeSSE({
          event: 'ping',
          data: '{}',
        })
      }, HEARTBEAT_INTERVAL_MS)
      heartbeat.unref?.()

      await stream.writeSSE({
        event: 'ready',
        data: '{}',
      })

      await new Promise<void>((resolve) => {
        const cleanup = () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          unsubscribe()
          resolve()
        }

        stream.onAbort(cleanup)
        if (c.req.raw.signal.aborted) {
          cleanup()
        } else {
          c.req.raw.signal.addEventListener('abort', cleanup, { once: true })
        }
      })
    })
  })

  return router
}
