import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  UnauthorizedError,
  clearDeviceToken,
  fetchInbox,
  fetchMessageCard,
  getPairingStatus,
  getStoredDeviceToken,
  saveDeviceToken,
  sendMessageReply,
  skipMessage,
  startPairing,
  subscribeInboxStream,
  updateSettings,
  type ChatView,
  type FeedMode,
  type InboxCounts,
  type InboxItem,
  type MessageCard,
} from '../lib/api'
import {
  renderPhoneError,
  renderPhoneExpired,
  renderPhoneInbox,
  renderPhoneLoading,
  renderPhonePairing,
} from '../phone/view'

const POLL_INTERVAL_MS = 2000
const INBOX_REBUILD_THROTTLE_MS = 1000

const PAIR_HEADER_ID = 1
const PAIR_HEADER_NAME = 'pair-header'
const PAIR_BODY_ID = 2
const PAIR_BODY_NAME = 'pair-body'

const INBOX_HEADER_ID = 10
const INBOX_HEADER_NAME = 'inbox-header'
const INBOX_LIST_ID = 11
const INBOX_LIST_NAME = 'inbox-list'
const INBOX_EMPTY_ID = 12
const INBOX_EMPTY_NAME = 'inbox-empty'

const CARD_HEADER_ID = 20
const CARD_HEADER_NAME = 'card-header'
const CARD_GIST_ID = 21
const CARD_GIST_NAME = 'card-gist'
const CARD_DRAFTS_ID = 22
const CARD_DRAFTS_NAME = 'card-drafts'
const CARD_FULL_HEADER_ID = 23
const CARD_FULL_HEADER_NAME = 'card-full-hdr'
const CARD_FULL_BODY_ID = 24
const CARD_FULL_BODY_NAME = 'card-full-body'

const SENDING_HEADER_ID = 30
const SENDING_HEADER_NAME = 'sending-header'
const SENDING_BODY_ID = 31
const SENDING_BODY_NAME = 'sending-body'

const SEND_UNDO_SECONDS = 3

const MENU_REFRESH_ID = 1
const MENU_SKIP_ID = 2
const MENU_BACK_ID = 3
const MENU_MODE_ID = 4
const MENU_CHAT_VIEW_ID = 5
const MENU_READ_FULL_ID = 6

type AppScreen =
  | 'pairing'
  | 'pairing-expired'
  | 'pairing-error'
  | 'inbox'
  | 'inbox-error'
  | 'card'
  | 'card-full'
  | 'sending'

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function buildMenuObject(includeCardActions = false): MenuContainerProperty {
  const menuItems = [
    new MenuItemProperty({ itemName: 'Refresh', itemID: MENU_REFRESH_ID }),
  ]
  if (includeCardActions) {
    menuItems.push(
      new MenuItemProperty({ itemName: 'Read full', itemID: MENU_READ_FULL_ID }),
      new MenuItemProperty({ itemName: 'Skip', itemID: MENU_SKIP_ID }),
      new MenuItemProperty({ itemName: 'Back', itemID: MENU_BACK_ID }),
    )
  }
  return new MenuContainerProperty({ menuItems })
}

function formatInboxListLine(item: InboxItem): string {
  const isUrgent = Boolean(item.urgent || item.priority === 'urgent')
  const raw = `${item.from}  ${item.preview}`
  if (isUrgent) {
    const trimmed = raw.length > 40 ? `${raw.slice(0, 39)}…` : raw
    const pad = ' '.repeat(Math.max(2, 42 - trimmed.length))
    return `${trimmed}${pad}!`.slice(0, 64)
  }
  return raw.slice(0, 64)
}

function buildPairingTextContainers(bodyContent: string): TextContainerProperty[] {
  return [
    new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 44,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: PAIR_HEADER_ID,
      containerName: PAIR_HEADER_NAME,
      content: 'Pair with Telegram',
      isEventCapture: 0,
    }),
    new TextContainerProperty({
      xPosition: 0,
      yPosition: 46,
      width: 576,
      height: 242,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: PAIR_BODY_ID,
      containerName: PAIR_BODY_NAME,
      content: bodyContent,
      isEventCapture: 1,
    }),
  ]
}

function formatInboxHeader(counts: InboxCounts): string {
  if (counts.urgent > 0) {
    return `PAGER · ${counts.all} (${counts.urgent}!)`
  }
  return `PAGER · ${counts.all} new`
}

function buildInboxPayload(
  items: InboxItem[],
  _mode: FeedMode,
  counts: InboxCounts,
  overrideEmptyText?: string,
): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
  menuObject: MenuContainerProperty
} {
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 44,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: INBOX_HEADER_ID,
    containerName: INBOX_HEADER_NAME,
    content: formatInboxHeader(counts),
    isEventCapture: 0,
  })

  if (items.length === 0) {
    const emptyText = new TextContainerProperty({
      xPosition: 0,
      yPosition: 46,
      width: 576,
      height: 242,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: INBOX_EMPTY_ID,
      containerName: INBOX_EMPTY_NAME,
      content: overrideEmptyText ?? 'All clear ✓',
      isEventCapture: 1,
    })

    return {
      containerTotalNum: 2,
      textObject: [header, emptyText],
      menuObject: buildMenuObject(),
    }
  }

  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: 46,
    width: 576,
    height: 242,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: INBOX_LIST_ID,
    containerName: INBOX_LIST_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: items.map((item) => formatInboxListLine(item)),
    }),
  })

  return {
    containerTotalNum: 2,
    textObject: [header],
    listObject: [list],
    menuObject: buildMenuObject(),
  }
}

function buildCardPayload(card: MessageCard): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject: ListContainerProperty[]
  menuObject: MenuContainerProperty
} {
  const prefix = card.priority === 'urgent' ? '! ' : ''
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 44,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: CARD_HEADER_ID,
    containerName: CARD_HEADER_NAME,
    content: `${prefix}${card.from}  [${card.intent}]`.slice(0, 64),
    isEventCapture: 0,
  })

  const gist = new TextContainerProperty({
    xPosition: 0,
    yPosition: 44,
    width: 576,
    height: 68,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: CARD_GIST_ID,
    containerName: CARD_GIST_NAME,
    content: card.gist,
    isEventCapture: 0,
  })

  const draftItems = card.drafts.slice(0, 3).map((draft) => draft.lens.slice(0, 64))
  draftItems.push('Пропустить')
  const drafts = new ListContainerProperty({
    xPosition: 0,
    yPosition: 114,
    width: 576,
    height: 174,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: CARD_DRAFTS_ID,
    containerName: CARD_DRAFTS_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: draftItems.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: draftItems,
    }),
  })

  return {
    containerTotalNum: 3,
    textObject: [header, gist],
    listObject: [drafts],
    menuObject: buildMenuObject(true),
  }
}

function buildCardFullPayload(card: MessageCard): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  menuObject: MenuContainerProperty
} {
  const prefix = card.priority === 'urgent' ? '! ' : ''
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 44,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: CARD_FULL_HEADER_ID,
    containerName: CARD_FULL_HEADER_NAME,
    content: `${prefix}${card.from} · tap: replies · 2x: back`.slice(0, 64),
    isEventCapture: 0,
  })

  const body = new TextContainerProperty({
    xPosition: 0,
    yPosition: 46,
    width: 576,
    height: 242,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: CARD_FULL_BODY_ID,
    containerName: CARD_FULL_BODY_NAME,
    content: card.fullText || card.gist,
    isEventCapture: 1,
  })

  return {
    containerTotalNum: 2,
    textObject: [header, body],
    menuObject: buildMenuObject(false),
  }
}

function buildSendingPayload(
  draftLens: string,
  secondsLeft: number,
  hasCal = false,
): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  menuObject: MenuContainerProperty
} {
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 44,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: SENDING_HEADER_ID,
    containerName: SENDING_HEADER_NAME,
    content: `Sending in ${secondsLeft}s…`,
    isEventCapture: 0,
  })

  const calLine = hasCal ? '\n+ Calendar event' : ''
  const body = new TextContainerProperty({
    xPosition: 0,
    yPosition: 46,
    width: 576,
    height: 242,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: SENDING_BODY_ID,
    containerName: SENDING_BODY_NAME,
    content: `${draftLens}${calLine}\n\n2x tap to cancel`,
    isEventCapture: 1,
  })

  return {
    containerTotalNum: 2,
    textObject: [header, body],
    menuObject: buildMenuObject(false),
  }
}

export async function startGlassesApp(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge()

  let screen: AppScreen = 'pairing'
  let pollTimer: number | null = null
  let activePairRunId = 0
  let disposed = false

  let inboxItems: InboxItem[] = []
  let feedMode: FeedMode = 'urgent'
  let chatView: ChatView = 'new_only'
  let inboxCounts: InboxCounts = { urgent: 0, all: 0 }
  let selectedIndex = 0
  let lastInboxRebuildAt = 0
  let pendingInboxTimer: number | null = null
  let fallbackPollTimer: number | null = null
  let isRefreshingInbox = false
  let stopSse: (() => void) | null = null

  let activeCard: MessageCard | null = null
  let cardDraftIndex = 0
  let sendTimer: number | null = null
  let sendCancelled = false
  let isActionInFlight = false

  function stopPolling(): void {
    activePairRunId += 1
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  function stopInboxSync(): void {
    if (pendingInboxTimer !== null) {
      window.clearTimeout(pendingInboxTimer)
      pendingInboxTimer = null
    }
    if (fallbackPollTimer !== null) {
      window.clearInterval(fallbackPollTimer)
      fallbackPollTimer = null
    }
    if (stopSse) {
      stopSse()
      stopSse = null
    }
  }

  function stopSendTimer(): void {
    if (sendTimer !== null) {
      window.clearInterval(sendTimer)
      sendTimer = null
    }
  }

  async function updatePairBody(content: string): Promise<void> {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: PAIR_BODY_ID,
        containerName: PAIR_BODY_NAME,
        content,
      }),
    )
  }

  async function handleUnauthorized(): Promise<void> {
    stopInboxSync()
    stopSendTimer()
    inboxItems = []
    selectedIndex = 0
    activeCard = null
    cardDraftIndex = 0
    isActionInFlight = false
    await clearDeviceToken(bridge)
    screen = 'pairing'
    renderPhoneLoading('Session expired. Re-pairing…')
    await bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: buildPairingTextContainers('Connecting…'),
        menuObject: buildMenuObject(),
      }),
    )
    void beginPairingFlow()
  }

  async function refreshInboxNow(): Promise<void> {
    if (disposed || (screen !== 'inbox' && screen !== 'inbox-error') || isRefreshingInbox) {
      return
    }
    isRefreshingInbox = true
    try {
      const data = await fetchInbox(bridge)
      if (disposed || (screen !== 'inbox' && screen !== 'inbox-error')) return
      screen = 'inbox'
      feedMode = data.mode
      chatView = data.chatView
      inboxCounts = data.counts
      inboxItems = data.items
      if (selectedIndex >= inboxItems.length) {
        selectedIndex = 0
      }
      lastInboxRebuildAt = Date.now()
      renderPhoneInbox(inboxItems.length)
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildInboxPayload(inboxItems, feedMode, inboxCounts)),
      )
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        const msg = err instanceof Error ? err.message : 'Load failed'
        console.warn('[inbox] refresh failed:', msg)
        screen = 'inbox-error'
        renderPhoneError(msg, () => {
          void refreshInboxNow()
        })
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(
            buildInboxPayload([], feedMode, inboxCounts, `Error: ${msg}\nTap to retry`),
          ),
        )
      }
    } finally {
      isRefreshingInbox = false
    }
  }

  function scheduleInboxRefresh(immediate = false): void {
    if (disposed || screen !== 'inbox') return

    if (immediate) {
      if (pendingInboxTimer !== null) {
        window.clearTimeout(pendingInboxTimer)
        pendingInboxTimer = null
      }
      void refreshInboxNow()
      return
    }

    const elapsed = Date.now() - lastInboxRebuildAt
    if (elapsed >= INBOX_REBUILD_THROTTLE_MS && pendingInboxTimer === null && !isRefreshingInbox) {
      void refreshInboxNow()
      return
    }

    if (pendingInboxTimer === null) {
      const delay = Math.max(0, INBOX_REBUILD_THROTTLE_MS - elapsed)
      pendingInboxTimer = window.setTimeout(() => {
        pendingInboxTimer = null
        void refreshInboxNow()
      }, delay)
    }
  }

  function startSseSubscription(): void {
    stopInboxSync()
    stopSse = subscribeInboxStream(bridge, {
      onInbox: () => {
        scheduleInboxRefresh(false)
      },
      onUnauthorized: () => {
        void handleUnauthorized()
      },
    })
    fallbackPollTimer = window.setInterval(() => {
      if (!disposed && screen === 'inbox') {
        scheduleInboxRefresh(false)
      }
    }, 10_000)
  }

  async function enterInbox(isStartup: boolean): Promise<void> {
    stopPolling()
    screen = 'inbox'
    renderPhoneInbox(0)

    if (isStartup) {
      await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer(
          buildInboxPayload([], feedMode, inboxCounts, 'Loading…'),
        ),
      )
    } else {
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(
          buildInboxPayload([], feedMode, inboxCounts, 'Loading…'),
        ),
      )
    }

    lastInboxRebuildAt = Date.now()
    await refreshInboxNow()
    if (!disposed && screen === 'inbox') {
      startSseSubscription()
    }
  }

  async function returnToInbox(): Promise<void> {
    stopSendTimer()
    activeCard = null
    cardDraftIndex = 0
    screen = 'inbox'
    await refreshInboxNow()
  }

  async function applySettingsPatch(patch: {
    feedMode?: FeedMode
    chatView?: ChatView
  }): Promise<void> {
    if (disposed || isActionInFlight) return
    isActionInFlight = true
    try {
      const updated = await updateSettings(bridge, patch)
      if (disposed) return
      feedMode = updated.feedMode
      chatView = updated.chatView
      selectedIndex = 0
      stopSendTimer()
      activeCard = null
      cardDraftIndex = 0
      screen = 'inbox'
      await refreshInboxNow()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        console.warn('[settings] update failed:', err instanceof Error ? err.message : err)
      }
    } finally {
      isActionInFlight = false
    }
  }

  async function toggleFeedMode(): Promise<void> {
    const nextMode: FeedMode = feedMode === 'urgent' ? 'all' : 'urgent'
    await applySettingsPatch({ feedMode: nextMode })
  }

  async function toggleChatView(): Promise<void> {
    const nextView: ChatView = chatView === 'new_only' ? 'with_history' : 'new_only'
    await applySettingsPatch({ chatView: nextView })
  }

  async function openCard(id: number): Promise<void> {
    if (disposed || isActionInFlight) return
    isActionInFlight = true
    try {
      const card = await fetchMessageCard(bridge, id)
      if (disposed) return
      activeCard = card
      cardDraftIndex = 0
      screen = 'card-full'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildCardFullPayload(card)),
      )
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        console.warn('[card] load failed:', err instanceof Error ? err.message : err)
        await returnToInbox()
      }
    } finally {
      isActionInFlight = false
    }
  }

  async function openCardFull(): Promise<void> {
    if (disposed || !activeCard) return
    screen = 'card-full'
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(buildCardFullPayload(activeCard)),
    )
  }

  async function backFromCardFull(): Promise<void> {
    if (disposed || !activeCard) return
    screen = 'card'
    cardDraftIndex = 0
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(buildCardPayload(activeCard)),
    )
  }

  async function skipActiveCard(): Promise<void> {
    if (disposed || !activeCard || isActionInFlight) return
    isActionInFlight = true
    const cardId = activeCard.id
    try {
      await skipMessage(bridge, cardId)
      await returnToInbox()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        console.warn('[card] skip failed:', err instanceof Error ? err.message : err)
        await returnToInbox()
      }
    } finally {
      isActionInFlight = false
    }
  }

  async function executeSend(cardId: number, draftIndex: number): Promise<void> {
    if (disposed || isActionInFlight) return
    isActionInFlight = true
    try {
      await sendMessageReply(bridge, cardId, draftIndex)
      await returnToInbox()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        console.warn('[send] failed:', err instanceof Error ? err.message : err)
        if (activeCard && !disposed) {
          screen = 'card'
          await bridge.rebuildPageContainer(
            new RebuildPageContainer(buildCardPayload(activeCard)),
          )
        } else {
          await returnToInbox()
        }
      }
    } finally {
      isActionInFlight = false
    }
  }

  async function startSendCountdown(): Promise<void> {
    if (disposed || !activeCard || isActionInFlight) return
    const draft = activeCard.drafts[cardDraftIndex] ?? activeCard.drafts[0]
    if (!draft) return

    stopSendTimer()
    sendCancelled = false
    screen = 'sending'
    let secondsLeft = SEND_UNDO_SECONDS

    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildSendingPayload(draft.lens, secondsLeft, Boolean(draft.hasCal)),
      ),
    )
    if (disposed || sendCancelled || screen !== 'sending') return

    const cardId = activeCard.id
    sendTimer = window.setInterval(() => {
      if (disposed || sendCancelled || screen !== 'sending') {
        stopSendTimer()
        return
      }
      secondsLeft -= 1
      if (secondsLeft > 0) {
        void bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: SENDING_HEADER_ID,
            containerName: SENDING_HEADER_NAME,
            content: `Sending in ${secondsLeft}s…`,
          }),
        )
        return
      }

      stopSendTimer()
      void executeSend(cardId, draft.index)
    }, 1000)
  }

  async function cancelSendCountdown(): Promise<void> {
    sendCancelled = true
    stopSendTimer()
    if (!disposed && activeCard) {
      screen = 'card'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildCardPayload(activeCard)),
      )
    }
  }

  async function beginPairingFlow(): Promise<void> {
    stopPolling()
    stopInboxSync()
    const runId = activePairRunId
    screen = 'pairing'
    renderPhoneLoading('Generating pairing code…')
    await updatePairBody('Requesting code…')

    let pairData: { pairId: string; code: string; botUsername: string }
    try {
      pairData = await startPairing()
    } catch (err) {
      if (disposed || runId !== activePairRunId) return
      screen = 'pairing-error'
      const msg = err instanceof Error ? err.message : 'Server unreachable'
      renderPhoneError(msg, () => {
        void beginPairingFlow()
      })
      await updatePairBody('Server unreachable\nTap to retry · 2x tap exit')
      return
    }

    if (disposed || runId !== activePairRunId) return

    renderPhonePairing({ code: pairData.code, botUsername: pairData.botUsername })
    await updatePairBody(`Send ${pairData.code} to @${pairData.botUsername}\nwaiting…`)

    const pollOnce = async (): Promise<void> => {
      if (disposed || runId !== activePairRunId) return
      try {
        const res = await getPairingStatus(pairData.pairId)
        if (disposed || runId !== activePairRunId) return

        if (res.status === 'paired') {
          await saveDeviceToken(bridge, res.deviceToken)
          await enterInbox(false)
          return
        }

        if (res.status === 'expired') {
          screen = 'pairing-expired'
          renderPhoneExpired(() => {
            void beginPairingFlow()
          })
          await updatePairBody('Code expired\nTap for new code · 2x tap exit')
          return
        }
      } catch {
        // Keep polling on transient network errors
      }

      if (!disposed && runId === activePairRunId) {
        pollTimer = window.setTimeout(() => {
          void pollOnce()
        }, POLL_INTERVAL_MS)
      }
    }

    pollTimer = window.setTimeout(() => {
      void pollOnce()
    }, POLL_INTERVAL_MS)
  }

  const storedToken = await getStoredDeviceToken(bridge)

  if (storedToken) {
    await enterInbox(true)
  } else {
    screen = 'pairing'
    renderPhoneLoading('Connecting to Pager…')
    await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 2,
        textObject: buildPairingTextContainers('Connecting…'),
        menuObject: buildMenuObject(),
      }),
    )
    void beginPairingFlow()
  }

  const unsubscribe = bridge.onEvenHubEvent((event) => {
    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)
    const listType = eventTypeOf(event.listEvent)

    if (
      sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
      sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
    ) {
      disposed = true
      stopPolling()
      stopInboxSync()
      stopSendTimer()
      unsubscribe()
      return
    }

    if (
      sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      listType === OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      if (screen === 'sending') {
        void cancelSendCountdown()
        return
      }
      if (screen === 'card-full') {
        void returnToInbox()
        return
      }
      if (screen === 'card') {
        if (activeCard) {
          void openCardFull()
        } else {
          void returnToInbox()
        }
        return
      }
      disposed = true
      stopPolling()
      stopInboxSync()
      stopSendTimer()
      void bridge.shutDownPageContainer(1)
      return
    }

    if (event.menuItemClickEvent) {
      const itemId = event.menuItemClickEvent.itemID
      console.log('[menu] clicked:', itemId)
      if (itemId === MENU_MODE_ID) {
        if (screen === 'inbox' || screen === 'inbox-error' || screen === 'card') {
          void toggleFeedMode()
        }
      } else if (itemId === MENU_CHAT_VIEW_ID) {
        if (screen === 'inbox' || screen === 'inbox-error' || screen === 'card') {
          void toggleChatView()
        }
      } else if (itemId === MENU_REFRESH_ID) {
        if (screen === 'inbox') {
          scheduleInboxRefresh(true)
        } else if (screen === 'card' && activeCard) {
          void openCard(activeCard.id)
        }
      } else if (itemId === MENU_READ_FULL_ID && screen === 'card') {
        void openCardFull()
      } else if (itemId === MENU_SKIP_ID && screen === 'card') {
        void skipActiveCard()
      } else if (itemId === MENU_BACK_ID && screen === 'card') {
        void returnToInbox()
      }
      return
    }

    if (event.listEvent?.currentSelectItemIndex !== undefined) {
      if (screen === 'inbox') {
        selectedIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'card') {
        cardDraftIndex = event.listEvent.currentSelectItemIndex
      }
    }

    if (
      listType === OsEventTypeList.CLICK_EVENT ||
      sysType === OsEventTypeList.CLICK_EVENT ||
      textType === OsEventTypeList.CLICK_EVENT
    ) {
      if (screen === 'pairing-error' || screen === 'pairing-expired') {
        void beginPairingFlow()
        return
      }

      if (screen === 'inbox-error') {
        void refreshInboxNow()
        return
      }

      if (screen === 'inbox' && inboxItems.length > 0) {
        const idx = event.listEvent?.currentSelectItemIndex ?? selectedIndex
        const selected = inboxItems[idx]
        if (selected) {
          void openCard(selected.id)
        }
        return
      }

      if (screen === 'card-full') {
        void backFromCardFull()
        return
      }

      if (screen === 'card' && activeCard) {
        if (event.listEvent?.currentSelectItemIndex !== undefined) {
          cardDraftIndex = event.listEvent.currentSelectItemIndex
        }
        if (cardDraftIndex >= activeCard.drafts.length) {
          void skipActiveCard()
          return
        }
        void startSendCountdown()
      }
    }
  })
}
