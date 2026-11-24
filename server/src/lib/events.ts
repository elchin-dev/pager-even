export type UserEvent = {
  type: 'inbox'
  messageId: number
  chatId: number
}

type Listener = (event: UserEvent) => void

const listenersByUser = new Map<number, Set<Listener>>()

export function subscribeUserEvents(userId: number, listener: Listener): () => void {
  let set = listenersByUser.get(userId)
  if (!set) {
    set = new Set<Listener>()
    listenersByUser.set(userId, set)
  }
  set.add(listener)

  return () => {
    const current = listenersByUser.get(userId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      listenersByUser.delete(userId)
    }
  }
}

export function publishUserEvent(userId: number, event: UserEvent): void {
  const set = listenersByUser.get(userId)
  if (!set || set.size === 0) return

  for (const listener of [...set]) {
    listener(event)
  }
}
