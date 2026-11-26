import {
  AudioInputSource,
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
  sendVoiceReply,
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
  VOICE_CONFIG,
  encodeWavPcm16Mono,
  formatDurationMmSs,
} from '../lib/wav'
import { paginateLensText } from '../lib/paginate'
import {
  renderPhoneError,
  renderPhoneExpired,
  renderPhoneInbox,
  renderPhoneLoading,
  renderPhonePairing,
} from '../phone/view'

const POLL_INTERVAL_MS = 2000
const INBOX_REBUILD_THROTTLE_MS = 300

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
const TRANSCRIPT_HEADER_ID = 25
const TRANSCRIPT_HEADER_NAME = 'tr-header'
const TRANSCRIPT_BODY_ID = 26
const TRANSCRIPT_BODY_NAME = 'tr-body'

const SENDING_HEADER_ID = 30
const SENDING_HEADER_NAME = 'sending-header'
const SENDING_BODY_ID = 31
const SENDING_BODY_NAME = 'sending-body'

const VOICE_HEADER_ID = 40
const VOICE_HEADER_NAME = 'voice-header'
const VOICE_BODY_ID = 41
const VOICE_BODY_NAME = 'voice-body'
const VOICE_CONFIRM_LIST_ID = 42
const VOICE_CONFIRM_LIST_NAME = 'voice-cf-list'

const SEND_UNDO_SECONDS = 1

const MENU_REFRESH_ID = 1
const MENU_SKIP_ID = 2
const MENU_BACK_ID = 3
const MENU_MODE_ID = 4
const MENU_CHAT_VIEW_ID = 5
const MENU_READ_FULL_ID = 6
const MENU_RECORD_VOICE_ID = 7

type AppScreen =
  | 'pairing'
  | 'pairing-expired'
  | 'pairing-error'
  | 'inbox'
  | 'inbox-error'
  | 'card'
  | 'card-full'
  | 'transcript-pages'
  | 'sending'
  | 'recording'
  | 'voice-too-short'
  | 'voice-confirm'
  | 'voice-sending'
  | 'voice-error'

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function buildMenuObject(includeCardActions = false, includeVoiceToggle = false): MenuContainerProperty {
  const menuItems: MenuItemProperty[] = []
  if (includeCardActions || includeVoiceToggle) {
    menuItems.push(
      new MenuItemProperty({ itemName: 'Record voice', itemID: MENU_RECORD_VOICE_ID }),
    )
  }
  menuItems.push(
    new MenuItemProperty({ itemName: 'Refresh', itemID: MENU_REFRESH_ID }),
  )
  if (includeCardActions) {
    menuItems.push(
      new MenuItemProperty({ itemName: 'Full text', itemID: MENU_READ_FULL_ID }),
      new MenuItemProperty({ itemName: 'Skip', itemID: MENU_SKIP_ID }),
      new MenuItemProperty({ itemName: 'Back', itemID: MENU_BACK_ID }),
    )
  }
  return new MenuContainerProperty({ menuItems })
}

const utf8Encoder = new TextEncoder()

function clampUtf8(input: string, maxBytes: number): string {
  if (utf8Encoder.encode(input).length <= maxBytes) {
    return input
  }
  let out = ''
  for (const ch of input) {
    const next = out + ch
    if (utf8Encoder.encode(`${next}…`).length > maxBytes) {
      return `${out}…`
    }
    out = next
  }
  return out
}

function visualWidthUnits(input: string): number {
  let units = 0
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === ' ') {
      units += 1
    } else if (code >= 0x1f000 || (code >= 0x2600 && code <= 0x27bf)) {
      units += 2.3
    } else if (/[\u0400-\u04ff]/.test(ch)) {
      units += 2.2
    } else {
      units += 1.7
    }
  }
  return units
}

function clampVisualAndUtf8(input: string, maxUnits: number, maxBytes: number): string {
  if (visualWidthUnits(input) <= maxUnits && utf8Encoder.encode(input).length <= maxBytes) {
    return input
  }
  let out = ''
  for (const ch of input) {
    const next = `${out}${ch}`
    if (
      visualWidthUnits(`${next}…`) > maxUnits ||
      utf8Encoder.encode(`${next}…`).length > maxBytes
    ) {
      return `${out}…`
    }
    out = next
  }
  return out
}

function formatInboxListLine(item: InboxItem): string {
  const isUrgent = Boolean(item.urgent || item.priority === 'urgent')
  const raw = `${item.from}  ${item.preview}`
  if (isUrgent) {
    const trimmed = clampVisualAndUtf8(raw, 56, 56)
    const targetUnits = 62
    const desiredSpaces = Math.max(2, Math.round(targetUnits - visualWidthUnits(trimmed)))
    const maxSpacesByBytes = Math.max(1, 63 - utf8Encoder.encode(trimmed).length)
    const padCount = Math.min(desiredSpaces, maxSpacesByBytes)
    return clampUtf8(`${trimmed}${' '.repeat(padCount)}!`, 64)
  }
  return clampUtf8(raw, 64)
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

function formatCardHeaderText(card: MessageCard): string {
  const prefix = card.priority === 'urgent' ? '! ' : ''
  if (card.media) {
    const mediaLabel = card.media.kind === 'video_note' ? 'video' : 'voice'
    return clampUtf8(
      `${prefix}${card.from} · ${mediaLabel} ${formatDurationMmSs(card.media.duration)}`,
      64,
    )
  }
  return clampUtf8(`${prefix}${card.from}  [${card.intent}]`, 64)
}

function formatTranscriptPageHeader(
  card: MessageCard,
  pageIndex: number,
  totalPages: number,
): string {
  if (card.media) {
    const label = card.media.kind === 'video_note' ? 'Video' : 'Voice'
    const dur = formatDurationMmSs(card.media.duration)
    if (totalPages > 1) {
      return clampUtf8(`${label} ${dur} · ${pageIndex + 1}/${totalPages} · tap: replies`, 64)
    }
    return clampUtf8(`${card.from} · ${label.toLowerCase()} ${dur} · tap: replies`, 64)
  }
  return clampUtf8(`${card.from} · ${pageIndex + 1}/${totalPages}`, 64)
}

function buildTranscriptPagePayload(
  card: MessageCard,
  pages: string[],
  pageIndex: number,
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
    containerID: TRANSCRIPT_HEADER_ID,
    containerName: TRANSCRIPT_HEADER_NAME,
    content: formatTranscriptPageHeader(card, pageIndex, pages.length),
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
    containerID: TRANSCRIPT_BODY_ID,
    containerName: TRANSCRIPT_BODY_NAME,
    content: pages[pageIndex] ?? '',
    isEventCapture: 1,
  })

  return {
    containerTotalNum: 2,
    textObject: [header, body],
    menuObject: buildMenuObject(true),
  }
}

function buildCardPayload(card: MessageCard): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject: ListContainerProperty[]
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
    containerID: CARD_HEADER_ID,
    containerName: CARD_HEADER_NAME,
    content: formatCardHeaderText(card),
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

  const draftItems = card.drafts.slice(0, 3).map((draft) => clampUtf8(draft.lens, 64))
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
    menuObject: buildMenuObject(true),
  }
}

function buildVoiceStatusPayload(
  headerText: string,
  bodyText: string,
  includeVoiceToggle = false,
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
    containerID: VOICE_HEADER_ID,
    containerName: VOICE_HEADER_NAME,
    content: headerText.slice(0, 64),
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
    containerID: VOICE_BODY_ID,
    containerName: VOICE_BODY_NAME,
    content: bodyText,
    isEventCapture: 1,
  })

  return {
    containerTotalNum: 2,
    textObject: [header, body],
    menuObject: buildMenuObject(false, includeVoiceToggle),
  }
}

function buildVoiceConfirmPayload(
  durationSec: number,
  kind: 'short' | 'long',
): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject: ListContainerProperty[]
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
    containerID: VOICE_HEADER_ID,
    containerName: VOICE_HEADER_NAME,
    content: `Voice ${formatDurationMmSs(durationSec)} · ${kind}`,
    isEventCapture: 0,
  })

  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: 46,
    width: 576,
    height: 242,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: VOICE_CONFIRM_LIST_ID,
    containerName: VOICE_CONFIRM_LIST_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: 2,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: ['Send', 'Discard'],
    }),
  })

  return {
    containerTotalNum: 2,
    textObject: [header],
    listObject: [list],
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
  let transcriptPages: string[] = []
  let transcriptPageIndex = 0
  let sendTimer: number | null = null
  let sendCancelled = false
  let isActionInFlight = false

  let preVoiceScreen: 'card' | 'card-full' | 'transcript-pages' = 'card'
  let recordingMode: 'hold' | 'menu' = 'hold'
  let isRecordingActive = false
  let holdReleasedEarly = false
  let recordStartedAt = 0
  let recordTickTimer: number | null = null
  let voiceShortDismissTimer: number | null = null
  let pcmChunks: Uint8Array[] = []
  let pendingWav: { wavBytes: Uint8Array; durationSec: number } | null = null
  let voiceConfirmIndex = 0

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

  function stopVoiceTimers(): void {
    if (recordTickTimer !== null) {
      window.clearInterval(recordTickTimer)
      recordTickTimer = null
    }
    if (voiceShortDismissTimer !== null) {
      window.clearTimeout(voiceShortDismissTimer)
      voiceShortDismissTimer = null
    }
  }

  function resetVoiceState(closeMic = false): void {
    stopVoiceTimers()
    if (closeMic || isRecordingActive) {
      void bridge.audioControl(false)
    }
    isRecordingActive = false
    holdReleasedEarly = false
    pcmChunks = []
    pendingWav = null
    voiceConfirmIndex = 0
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
    resetVoiceState(true)
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
      const rebuilt = await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildInboxPayload(inboxItems, feedMode, inboxCounts)),
      )
      if (!rebuilt) {
        console.warn('[inbox] rebuildPageContainer returned false', { count: inboxItems.length })
      }
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
      onInbox: (evt) => {
        if (screen === 'inbox' || screen === 'inbox-error') {
          scheduleInboxRefresh(false)
          return
        }
        if (
          (screen === 'card-full' || screen === 'card' || screen === 'transcript-pages') &&
          activeCard &&
          (!evt?.chatId || evt.chatId === activeCard.chatId)
        ) {
          void refreshActiveCardInPlace(evt?.messageId)
        }
      },
      onUnauthorized: () => {
        void handleUnauthorized()
      },
    })
    fallbackPollTimer = window.setInterval(() => {
      if (disposed) return
      if (screen === 'inbox') {
        scheduleInboxRefresh(false)
      } else if (
        (screen === 'card-full' || screen === 'card' || screen === 'transcript-pages') &&
        activeCard
      ) {
        void refreshActiveCardInPlace()
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
    resetVoiceState(true)
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

  async function refreshActiveCardInPlace(targetId?: number): Promise<void> {
    if (
      disposed ||
      isActionInFlight ||
      isRecordingActive ||
      !activeCard ||
      (screen !== 'card-full' && screen !== 'card' && screen !== 'transcript-pages')
    ) {
      return
    }
    const currentScreen = screen
    isActionInFlight = true
    try {
      const card = await fetchMessageCard(bridge, targetId ?? activeCard.id)
      if (disposed || screen !== currentScreen) return
      activeCard = card
      if (currentScreen === 'card') {
        cardDraftIndex = 0
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(buildCardPayload(card)),
        )
      } else if (currentScreen === 'transcript-pages') {
        if (card.media?.transcribed && card.transcript) {
          transcriptPages = paginateLensText(card.transcript, 180)
          transcriptPageIndex = Math.min(transcriptPageIndex, transcriptPages.length - 1)
          await bridge.rebuildPageContainer(
            new RebuildPageContainer(
              buildTranscriptPagePayload(card, transcriptPages, transcriptPageIndex),
            ),
          )
        } else {
          screen = 'card-full'
          await bridge.rebuildPageContainer(
            new RebuildPageContainer(buildCardFullPayload(card)),
          )
        }
      } else {
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(buildCardFullPayload(card)),
        )
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        console.warn('[card] live refresh failed:', err instanceof Error ? err.message : err)
      }
    } finally {
      isActionInFlight = false
    }
  }

  async function openCard(id: number): Promise<void> {
    if (disposed || isActionInFlight) return
    isActionInFlight = true
    try {
      const card = await fetchMessageCard(bridge, id)
      if (disposed) return
      activeCard = card
      cardDraftIndex = 0
      transcriptPages = []
      transcriptPageIndex = 0
      if (card.media) {
        if (card.media.transcribed && card.transcript) {
          transcriptPages = paginateLensText(card.transcript, 180)
          transcriptPageIndex = 0
          screen = 'transcript-pages'
          await bridge.rebuildPageContainer(
            new RebuildPageContainer(
              buildTranscriptPagePayload(card, transcriptPages, transcriptPageIndex),
            ),
          )
        } else {
          screen = 'card'
          await bridge.rebuildPageContainer(
            new RebuildPageContainer(buildCardPayload(card)),
          )
        }
      } else {
        screen = 'card-full'
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(buildCardFullPayload(card)),
        )
      }
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

  async function openTranscriptPages(): Promise<void> {
    if (disposed || !activeCard) return
    const raw = activeCard.transcript || activeCard.gist
    transcriptPages = paginateLensText(raw, 180)
    transcriptPageIndex = 0
    screen = 'transcript-pages'
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildTranscriptPagePayload(activeCard, transcriptPages, transcriptPageIndex),
      ),
    )
  }

  async function stepTranscriptPage(delta: -1 | 1): Promise<void> {
    if (disposed || !activeCard || screen !== 'transcript-pages') return
    const nextIdx = transcriptPageIndex + delta
    if (nextIdx < 0 || nextIdx >= transcriptPages.length) return
    transcriptPageIndex = nextIdx
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: TRANSCRIPT_HEADER_ID,
        containerName: TRANSCRIPT_HEADER_NAME,
        content: formatTranscriptPageHeader(activeCard, transcriptPageIndex, transcriptPages.length),
      }),
    )
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: TRANSCRIPT_BODY_ID,
        containerName: TRANSCRIPT_BODY_NAME,
        content: transcriptPages[transcriptPageIndex] ?? '',
      }),
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

  async function returnToActiveCard(): Promise<void> {
    if (disposed) return
    if (!activeCard) {
      await returnToInbox()
      return
    }
    if (preVoiceScreen === 'transcript-pages') {
      await openTranscriptPages()
    } else if (preVoiceScreen === 'card-full') {
      screen = 'card-full'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildCardFullPayload(activeCard)),
      )
    } else {
      screen = 'card'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildCardPayload(activeCard)),
      )
    }
  }

  function formatRecordingHeader(elapsedSec: number, mode: 'hold' | 'menu'): string {
    const stopHint = mode === 'hold' ? 'release to stop' : 'tap to stop'
    return `● REC ${formatDurationMmSs(elapsedSec)} · ${stopHint}`
  }

  async function executeVoiceSend(): Promise<void> {
    if (disposed || !activeCard || !pendingWav || isActionInFlight) return
    isActionInFlight = true
    const cardId = activeCard.id
    const wavBytes = pendingWav.wavBytes
    try {
      await sendVoiceReply(bridge, cardId, wavBytes)
      pendingWav = null
      await returnToInbox()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        console.warn('[voice] send failed:', err instanceof Error ? err.message : err)
        if (!disposed) {
          screen = 'voice-error'
          await bridge.rebuildPageContainer(
            new RebuildPageContainer(
              buildVoiceStatusPayload(
                'Voice not sent · tap retry',
                'Tap to retry · 2×tap discard',
              ),
            ),
          )
        }
      }
    } finally {
      isActionInFlight = false
    }
  }

  async function startVoiceCountdown(durationSec: number): Promise<void> {
    if (disposed || !activeCard || !pendingWav) return
    stopSendTimer()
    sendCancelled = false
    screen = 'voice-sending'
    let secondsLeft: number = VOICE_CONFIG.undoWindowSec

    const formatVoiceSendingLine = (secLeft: number) =>
      `Voice ${formatDurationMmSs(durationSec)} · sending in ${secLeft} · 2×tap cancel`

    await bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 44,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: 4,
            containerID: SENDING_HEADER_ID,
            containerName: SENDING_HEADER_NAME,
            content: formatVoiceSendingLine(secondsLeft).slice(0, 64),
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
            containerID: SENDING_BODY_ID,
            containerName: SENDING_BODY_NAME,
            content: '2×tap cancel',
            isEventCapture: 1,
          }),
        ],
        menuObject: buildMenuObject(false),
      }),
    )

    if (disposed || sendCancelled || screen !== 'voice-sending') return

    sendTimer = window.setInterval(() => {
      if (disposed || sendCancelled || screen !== 'voice-sending') {
        stopSendTimer()
        return
      }
      secondsLeft -= 1
      if (secondsLeft > 0) {
        void bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: SENDING_HEADER_ID,
            containerName: SENDING_HEADER_NAME,
            content: formatVoiceSendingLine(secondsLeft).slice(0, 64),
          }),
        )
        return
      }
      stopSendTimer()
      void executeVoiceSend()
    }, 1000)
  }

  async function cancelVoiceSendCountdown(): Promise<void> {
    sendCancelled = true
    stopSendTimer()
    pendingWav = null
    await returnToActiveCard()
  }

  async function discardPendingVoice(): Promise<void> {
    stopSendTimer()
    pendingWav = null
    await returnToActiveCard()
  }

  async function startVoiceRecording(mode: 'hold' | 'menu'): Promise<void> {
    if (disposed || !activeCard || isRecordingActive || isActionInFlight) return

    stopSendTimer()
    stopVoiceTimers()
    preVoiceScreen =
      screen === 'transcript-pages'
        ? 'transcript-pages'
        : screen === 'card-full'
          ? 'card-full'
          : 'card'
    recordingMode = mode
    holdReleasedEarly = false
    pcmChunks = []
    pendingWav = null
    isRecordingActive = true
    recordStartedAt = Date.now()
    screen = 'recording'

    const micOpened = await bridge.audioControl(true, AudioInputSource.Glasses)
    if (disposed) {
      void bridge.audioControl(false)
      return
    }
    if (!micOpened) {
      isRecordingActive = false
      screen = 'voice-error'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(
          buildVoiceStatusPayload('Mic unavailable', '2×tap back'),
        ),
      )
      return
    }

    if (mode === 'hold' && holdReleasedEarly) {
      await stopVoiceRecording()
      return
    }

    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildVoiceStatusPayload(
          formatRecordingHeader(0, mode),
          mode === 'hold' ? 'Release to finish recording' : 'Tap to finish recording',
          true,
        ),
      ),
    )

    if (disposed || !isRecordingActive) return
    if (mode === 'hold' && holdReleasedEarly) {
      await stopVoiceRecording()
      return
    }

    recordTickTimer = window.setInterval(() => {
      if (disposed || !isRecordingActive || screen !== 'recording') {
        stopVoiceTimers()
        return
      }
      const elapsedSec = Math.floor((Date.now() - recordStartedAt) / 1000)
      if (elapsedSec >= VOICE_CONFIG.maxRecordSec) {
        void stopVoiceRecording()
        return
      }
      void bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: VOICE_HEADER_ID,
          containerName: VOICE_HEADER_NAME,
          content: formatRecordingHeader(elapsedSec, recordingMode),
        }),
      )
    }, 1000)
  }

  async function stopVoiceRecording(): Promise<void> {
    if (!isRecordingActive) return
    isRecordingActive = false
    holdReleasedEarly = false
    stopVoiceTimers()

    await bridge.audioControl(false)
    if (disposed || !activeCard) return

    const encoded = encodeWavPcm16Mono(pcmChunks)
    pcmChunks = []
    const durationSec = encoded.durationSec

    if (durationSec < VOICE_CONFIG.minDurationSec) {
      pendingWav = null
      screen = 'voice-too-short'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildVoiceStatusPayload('Too short', '')),
      )
      voiceShortDismissTimer = window.setTimeout(() => {
        voiceShortDismissTimer = null
        void returnToActiveCard()
      }, 1000)
      return
    }

    pendingWav = encoded
    voiceConfirmIndex = 0

    if (durationSec < VOICE_CONFIG.shortConfirmMaxSec) {
      screen = 'voice-confirm'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildVoiceConfirmPayload(durationSec, 'short')),
      )
      return
    }

    if (durationSec > VOICE_CONFIG.autoSendMaxSec) {
      screen = 'voice-confirm'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildVoiceConfirmPayload(durationSec, 'long')),
      )
      return
    }

    await startVoiceCountdown(durationSec)
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
    if (event.audioEvent) {
      if (isRecordingActive && event.audioEvent.audioPcm?.byteLength) {
        pcmChunks.push(new Uint8Array(event.audioEvent.audioPcm))
      }
      return
    }

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
      resetVoiceState(true)
      unsubscribe()
      return
    }

    if (
      sysType === OsEventTypeList.LONG_PRESS_EVENT ||
      textType === OsEventTypeList.LONG_PRESS_EVENT ||
      listType === OsEventTypeList.LONG_PRESS_EVENT
    ) {
      if (
        (screen === 'card' || screen === 'card-full' || screen === 'transcript-pages') &&
        activeCard
      ) {
        void startVoiceRecording('hold')
      }
      return
    }

    if (
      sysType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT ||
      textType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT ||
      listType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT
    ) {
      if (isRecordingActive && recordingMode === 'hold') {
        holdReleasedEarly = true
        if (screen === 'recording') {
          void stopVoiceRecording()
        }
      }
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
      if (screen === 'voice-sending') {
        void cancelVoiceSendCountdown()
        return
      }
      if (screen === 'voice-confirm' || screen === 'voice-error') {
        void discardPendingVoice()
        return
      }
      if (screen === 'recording') {
        resetVoiceState(true)
        void returnToActiveCard()
        return
      }
      if (screen === 'transcript-pages') {
        void returnToInbox()
        return
      }
      if (screen === 'card-full') {
        void returnToInbox()
        return
      }
      if (screen === 'card') {
        if (activeCard?.media?.transcribed && activeCard.transcript) {
          void openTranscriptPages()
        } else if (activeCard && !activeCard.media) {
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
      resetVoiceState(true)
      void bridge.shutDownPageContainer(1)
      return
    }

    if (event.menuItemClickEvent) {
      const itemId = event.menuItemClickEvent.itemID
      console.log('[menu] clicked:', itemId)
      if (itemId === MENU_RECORD_VOICE_ID) {
        if (screen === 'recording') {
          void stopVoiceRecording()
        } else if (
          (screen === 'card' || screen === 'card-full' || screen === 'transcript-pages') &&
          activeCard
        ) {
          void startVoiceRecording('menu')
        }
        return
      }
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
        } else if (
          (screen === 'card' || screen === 'card-full' || screen === 'transcript-pages') &&
          activeCard
        ) {
          void openCard(activeCard.id)
        }
      } else if (itemId === MENU_READ_FULL_ID && (screen === 'card' || screen === 'card-full')) {
        if (activeCard?.media) {
          void openTranscriptPages()
        } else {
          void openCardFull()
        }
      } else if (
        itemId === MENU_SKIP_ID &&
        (screen === 'card' || screen === 'card-full' || screen === 'transcript-pages')
      ) {
        void skipActiveCard()
      } else if (itemId === MENU_BACK_ID) {
        if (screen === 'transcript-pages') {
          void backFromCardFull()
        } else if (screen === 'card' || screen === 'card-full') {
          void returnToInbox()
        }
      }
      return
    }

    if (screen === 'transcript-pages') {
      if (
        textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
        sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
        listType === OsEventTypeList.SCROLL_BOTTOM_EVENT
      ) {
        void stepTranscriptPage(1)
        return
      }
      if (
        textType === OsEventTypeList.SCROLL_TOP_EVENT ||
        sysType === OsEventTypeList.SCROLL_TOP_EVENT ||
        listType === OsEventTypeList.SCROLL_TOP_EVENT
      ) {
        void stepTranscriptPage(-1)
        return
      }
    }

    if (event.listEvent?.currentSelectItemIndex !== undefined) {
      if (screen === 'inbox') {
        selectedIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'card') {
        cardDraftIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'voice-confirm') {
        voiceConfirmIndex = event.listEvent.currentSelectItemIndex
      }
    }

    if (
      listType === OsEventTypeList.CLICK_EVENT ||
      sysType === OsEventTypeList.CLICK_EVENT ||
      textType === OsEventTypeList.CLICK_EVENT
    ) {
      if (screen === 'recording' && recordingMode === 'menu') {
        void stopVoiceRecording()
        return
      }

      if (screen === 'voice-confirm') {
        const idx = event.listEvent?.currentSelectItemIndex ?? voiceConfirmIndex
        if (idx === 0) {
          void executeVoiceSend()
        } else {
          void discardPendingVoice()
        }
        return
      }

      if (screen === 'voice-error') {
        if (pendingWav) {
          void executeVoiceSend()
        } else {
          void returnToActiveCard()
        }
        return
      }
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

      if (screen === 'card-full' || screen === 'transcript-pages') {
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
