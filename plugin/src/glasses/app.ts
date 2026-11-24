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
  getPairingStatus,
  getStoredDeviceToken,
  saveDeviceToken,
  startPairing,
  subscribeInboxStream,
  type InboxItem,
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

const MENU_REFRESH_ID = 1

type AppScreen = 'pairing' | 'pairing-expired' | 'pairing-error' | 'inbox'

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function buildMenuObject(): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: [new MenuItemProperty({ itemName: 'Refresh', itemID: MENU_REFRESH_ID })],
  })
}

function formatInboxListLine(item: InboxItem): string {
  return `${item.from}  ${item.preview}`.slice(0, 64)
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

function buildInboxPayload(items: InboxItem[], overrideEmptyText?: string): {
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
    content: `PAGER · ${items.length} need reply`,
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
      itemName: items.map(formatInboxListLine),
    }),
  })

  return {
    containerTotalNum: 2,
    textObject: [header],
    listObject: [list],
    menuObject: buildMenuObject(),
  }
}

export async function startGlassesApp(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge()

  let screen: AppScreen = 'pairing'
  let pollTimer: number | null = null
  let activePairRunId = 0
  let disposed = false

  let inboxItems: InboxItem[] = []
  let selectedIndex = 0
  let lastInboxRebuildAt = 0
  let pendingInboxTimer: number | null = null
  let isRefreshingInbox = false
  let stopSse: (() => void) | null = null

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
    if (stopSse) {
      stopSse()
      stopSse = null
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
    inboxItems = []
    selectedIndex = 0
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
    if (disposed || screen !== 'inbox' || isRefreshingInbox) return
    isRefreshingInbox = true
    try {
      const items = await fetchInbox(bridge)
      if (disposed || screen !== 'inbox') return
      inboxItems = items
      if (selectedIndex >= inboxItems.length) {
        selectedIndex = 0
      }
      lastInboxRebuildAt = Date.now()
      renderPhoneInbox(inboxItems.length)
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildInboxPayload(inboxItems)),
      )
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        console.warn('[inbox] refresh failed:', err)
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
  }

  async function enterInbox(isStartup: boolean): Promise<void> {
    stopPolling()
    screen = 'inbox'
    renderPhoneInbox(0)

    if (isStartup) {
      await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer(buildInboxPayload([], 'Loading…')),
      )
    } else {
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildInboxPayload([], 'Loading…')),
      )
    }

    lastInboxRebuildAt = Date.now()
    await refreshInboxNow()
    if (!disposed && screen === 'inbox') {
      startSseSubscription()
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
      unsubscribe()
      return
    }

    if (
      sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      listType === OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      disposed = true
      stopPolling()
      stopInboxSync()
      void bridge.shutDownPageContainer(1)
      return
    }

    if (event.menuItemClickEvent) {
      console.log('[menu] clicked:', event.menuItemClickEvent.itemID)
      if (event.menuItemClickEvent.itemID === MENU_REFRESH_ID && screen === 'inbox') {
        scheduleInboxRefresh(true)
      }
      return
    }

    if (event.listEvent?.currentSelectItemIndex !== undefined) {
      selectedIndex = event.listEvent.currentSelectItemIndex
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

      if (screen === 'inbox' && inboxItems.length > 0) {
        const idx = event.listEvent?.currentSelectItemIndex ?? selectedIndex
        const selected = inboxItems[idx]
        console.log('[inbox] item tapped:', {
          index: idx,
          item: selected ?? null,
        })
      }
    }
  })
}
