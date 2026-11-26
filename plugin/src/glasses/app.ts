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
  fetchHome,
  fetchInbox,
  fetchMeetingBrief,
  fetchMeetings,
  fetchMessageCard,
  getPairingStatus,
  getStoredDeviceToken,
  rescheduleMeeting,
  saveDeviceToken,
  sendMeetingLate,
  sendMessageReply,
  sendVoiceReply,
  skipMessage,
  startPairing,
  subscribeInboxStream,
  type FeedMode,
  type GlassesReminderEvent,
  type HomeResponse,
  type InboxCounts,
  type InboxItem,
  type MeetingBrief,
  type MeetingsListResponse,
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

const HOME_HEADER_ID = 50
const HOME_HEADER_NAME = 'home-header'
const HOME_SUMMARY_ID = 51
const HOME_SUMMARY_NAME = 'home-summary'
const HOME_LIST_ID = 52
const HOME_LIST_NAME = 'home-list'

const MEETINGS_HEADER_ID = 55
const MEETINGS_HEADER_NAME = 'meet-header'
const MEETINGS_LIST_ID = 56
const MEETINGS_LIST_NAME = 'meet-list'
const MEETINGS_EMPTY_ID = 57
const MEETINGS_EMPTY_NAME = 'meet-empty'
const MEETING_BRIEF_BODY_ID = 58
const MEETING_BRIEF_BODY_NAME = 'meet-brief'
const MEETING_ACTIONS_ID = 59
const MEETING_ACTIONS_NAME = 'meet-actions'

const SOON_HEADER_ID = 60
const SOON_HEADER_NAME = 'soon-header'
const SOON_BODY_ID = 61
const SOON_BODY_NAME = 'soon-body'

const REMINDER_HEADER_ID = 62
const REMINDER_HEADER_NAME = 'rem-header'
const REMINDER_BODY_ID = 63
const REMINDER_BODY_NAME = 'rem-body'
const REMINDER_LIST_ID = 64
const REMINDER_LIST_NAME = 'rem-list'

const SEND_UNDO_SECONDS = 1
const CALENDAR_UNDO_SECONDS = 3

const MENU_REFRESH_ID = 1
const MENU_HOME_ID = 2
const MENU_NEW_NOTE_ID = 3
const MENU_MY_NOTES_ID = 4
const MENU_RECORD_VOICE_ID = 7

type HomeAction = 'messages' | 'meetings' | 'digest'

type AppScreen =
  | 'pairing'
  | 'pairing-expired'
  | 'pairing-error'
  | 'home'
  | 'home-error'
  | 'meetings'
  | 'meeting-card'
  | 'meeting-action-undo'
  | 'reminder-overlay'
  | 'coming-soon'
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

function buildMenuObject(includeVoiceReply = false, includeVoiceToggle = false): MenuContainerProperty {
  const menuItems: MenuItemProperty[] = []
  if (includeVoiceReply || includeVoiceToggle) {
    menuItems.push(
      new MenuItemProperty({ itemName: 'Ответить голосом', itemID: MENU_RECORD_VOICE_ID }),
    )
  }
  menuItems.push(
    new MenuItemProperty({ itemName: 'Новая заметка', itemID: MENU_NEW_NOTE_ID }),
    new MenuItemProperty({ itemName: 'Мои заметки', itemID: MENU_MY_NOTES_ID }),
    new MenuItemProperty({ itemName: 'Главная', itemID: MENU_HOME_ID }),
    new MenuItemProperty({ itemName: 'Обновить', itemID: MENU_REFRESH_ID }),
  )
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

function formatSplitListLine(left: string, right: string): string {
  const rightClean = clampUtf8(right, 30)
  const rightBytes = utf8Encoder.encode(rightClean).length
  const maxLeftBytes = Math.max(8, 63 - rightBytes - 2)
  const leftClean = clampUtf8(left, maxLeftBytes)
  const leftBytes = utf8Encoder.encode(leftClean).length
  const targetUnits = 62
  const desiredSpaces = Math.max(
    2,
    Math.round(targetUnits - visualWidthUnits(leftClean) - visualWidthUnits(rightClean)),
  )
  const maxSpacesByBytes = Math.max(1, 63 - leftBytes - rightBytes)
  const padCount = Math.min(desiredSpaces, maxSpacesByBytes)
  return clampUtf8(`${leftClean}${' '.repeat(padCount)}${rightClean}`, 63)
}

function formatSplitHeaderLine(left: string, right: string): string {
  const targetUnits = 64
  const desiredSpaces = Math.max(
    2,
    Math.round(targetUnits - visualWidthUnits(left) - visualWidthUnits(right)),
  )
  return `${left}${' '.repeat(Math.min(desiredSpaces, 36))}${right}`
}

function getHomeActions(home: HomeResponse): Array<{ action: HomeAction; label: string }> {
  const msgRight =
    home.messages.total > 0
      ? home.messages.urgent > 0
        ? `${home.messages.total} · ${home.messages.urgent} срочное`
        : `${home.messages.total}`
      : 'нет'
  const meetRight =
    home.meetings.todayCount > 0 ? `${home.meetings.todayCount} сегодня` : 'нет'

  const items: Array<{ action: HomeAction; label: string }> = [
    { action: 'messages', label: formatSplitListLine('Сообщения', msgRight) },
    { action: 'meetings', label: formatSplitListLine('Встречи', meetRight) },
  ]
  if (home.digest.enabled) {
    items.push({
      action: 'digest',
      label: formatSplitListLine('Дайджест', String(home.digest.count)),
    })
  }
  return items
}

function buildHomePayload(
  home: HomeResponse | null,
  overrideStatusText?: string,
): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
  menuObject: MenuContainerProperty
} {
  if (!home) {
    const header = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 44,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: HOME_HEADER_ID,
      containerName: HOME_HEADER_NAME,
      content: 'Главная',
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
      containerID: HOME_SUMMARY_ID,
      containerName: HOME_SUMMARY_NAME,
      content: overrideStatusText ?? 'Загрузка…',
      isEventCapture: 1,
    })
    return {
      containerTotalNum: 2,
      textObject: [header, body],
      menuObject: buildMenuObject(false),
    }
  }

  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 44,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: HOME_HEADER_ID,
    containerName: HOME_HEADER_NAME,
    content: formatSplitHeaderLine(home.nowTime, home.headerMeeting),
    isEventCapture: 0,
  })

  const hasNewMessages = home.messages.total > 0
  const summaryText = hasNewMessages
    ? home.messages.senders.map((s) => `${s.name} ${s.count}`).join(' · ')
    : `Всё тихо\n${home.nextMeetingLine ?? 'встреч нет'}`

  const summary = new TextContainerProperty({
    xPosition: 0,
    yPosition: 46,
    width: 576,
    height: hasNewMessages ? 44 : 74,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: HOME_SUMMARY_ID,
    containerName: HOME_SUMMARY_NAME,
    content: summaryText,
    isEventCapture: 0,
  })

  const actions = getHomeActions(home)
  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: hasNewMessages ? 94 : 124,
    width: 576,
    height: hasNewMessages ? 194 : 164,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: HOME_LIST_ID,
    containerName: HOME_LIST_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: actions.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: actions.map((a) => a.label),
    }),
  })

  return {
    containerTotalNum: 3,
    textObject: [header, summary],
    listObject: [list],
    menuObject: buildMenuObject(false),
  }
}

function buildMeetingsPayload(
  data: MeetingsListResponse | null,
  overrideText?: string,
): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
  menuObject: MenuContainerProperty
} {
  const count = data?.todayCount ?? 0
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 44,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: MEETINGS_HEADER_ID,
    containerName: MEETINGS_HEADER_NAME,
    content: count > 0 ? `Встречи · сегодня ${count}` : 'Встречи · сегодня',
    isEventCapture: 0,
  })

  if (overrideText) {
    const empty = new TextContainerProperty({
      xPosition: 0,
      yPosition: 46,
      width: 576,
      height: 242,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: MEETINGS_EMPTY_ID,
      containerName: MEETINGS_EMPTY_NAME,
      content: overrideText,
      isEventCapture: 1,
    })
    return {
      containerTotalNum: 2,
      textObject: [header, empty],
      menuObject: buildMenuObject(false),
    }
  }

  if (!data || !data.connected) {
    const empty = new TextContainerProperty({
      xPosition: 0,
      yPosition: 46,
      width: 576,
      height: 242,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: MEETINGS_EMPTY_ID,
      containerName: MEETINGS_EMPTY_NAME,
      content: 'Календарь не подключён\nОтправьте /google боту\n\n2x тап — Главная',
      isEventCapture: 1,
    })
    return {
      containerTotalNum: 2,
      textObject: [header, empty],
      menuObject: buildMenuObject(false),
    }
  }

  const items = data.items
  if (items.length === 0) {
    const empty = new TextContainerProperty({
      xPosition: 0,
      yPosition: 46,
      width: 576,
      height: 242,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: MEETINGS_EMPTY_ID,
      containerName: MEETINGS_EMPTY_NAME,
      content: 'Встреч сегодня и завтра нет\n\n2x тап — Главная',
      isEventCapture: 1,
    })
    return {
      containerTotalNum: 2,
      textObject: [header, empty],
      menuObject: buildMenuObject(false),
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
    containerID: MEETINGS_LIST_ID,
    containerName: MEETINGS_LIST_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: items.map((ev) => {
        const left = `${ev.startTime}  ${ev.title}`
        if (ev.isTomorrow) {
          return formatSplitListLine(left, 'завтра')
        }
        if (ev.minutesUntil !== null && ev.minutesUntil < 60) {
          return formatSplitListLine(left, `через ${ev.minutesUntil} мин`)
        }
        return clampUtf8(left, 63)
      }),
    }),
  })

  return {
    containerTotalNum: 2,
    textObject: [header],
    listObject: [list],
    menuObject: buildMenuObject(false),
  }
}

type MeetingBriefAction = 'late' | 'reschedule'

function getMeetingBriefActions(brief: MeetingBrief): Array<{ action: MeetingBriefAction; label: string }> {
  const actions: Array<{ action: MeetingBriefAction; label: string }> = []
  if (brief.canSendLate) {
    actions.push({ action: 'late', label: clampUtf8('Опаздываю на 5 мин', 63) })
  }
  actions.push({ action: 'reschedule', label: clampUtf8('Перенести +30 мин', 63) })
  return actions
}

function buildMeetingCardPayload(brief: MeetingBrief): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject: ListContainerProperty[]
  menuObject: MenuContainerProperty
} {
  const timeSuffix = brief.isTomorrow
    ? ' · завтра'
    : brief.minutesUntil !== null && brief.minutesUntil < 60
      ? ` · через ${brief.minutesUntil} мин`
      : ''
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 44,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: MEETINGS_HEADER_ID,
    containerName: MEETINGS_HEADER_NAME,
    content: clampUtf8(brief.title, 63),
    isEventCapture: 0,
  })
  const body = new TextContainerProperty({
    xPosition: 0,
    yPosition: 44,
    width: 576,
    height: 102,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: MEETING_BRIEF_BODY_ID,
    containerName: MEETING_BRIEF_BODY_NAME,
    content: `${brief.startTime}-${brief.endTime}${timeSuffix}\n${brief.summary}`,
    isEventCapture: 0,
  })
  const actions = getMeetingBriefActions(brief)
  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: 148,
    width: 576,
    height: 140,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: MEETING_ACTIONS_ID,
    containerName: MEETING_ACTIONS_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: actions.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: actions.map((a) => a.label),
    }),
  })
  return {
    containerTotalNum: 3,
    textObject: [header, body],
    listObject: [list],
    menuObject: buildMenuObject(false),
  }
}

function buildReminderOverlayPayload(reminder: GlassesReminderEvent): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject: ListContainerProperty[]
  menuObject: MenuContainerProperty
} {
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 40,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: REMINDER_HEADER_ID,
    containerName: REMINDER_HEADER_NAME,
    content: clampUtf8(reminder.header, 63),
    isEventCapture: 0,
  })
  const body = new TextContainerProperty({
    xPosition: 0,
    yPosition: 42,
    width: 576,
    height: 112,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: REMINDER_BODY_ID,
    containerName: REMINDER_BODY_NAME,
    content: `${reminder.title}\n${reminder.subtitle}`,
    isEventCapture: 0,
  })
  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: 156,
    width: 576,
    height: 132,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: REMINDER_LIST_ID,
    containerName: REMINDER_LIST_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: 2,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: ['Открыть бриф', 'Позже'],
    }),
  })
  return {
    containerTotalNum: 3,
    textObject: [header, body],
    listObject: [list],
    menuObject: buildMenuObject(false),
  }
}

function buildComingSoonPayload(title: string): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  menuObject: MenuContainerProperty
} {
  return {
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
        containerID: SOON_HEADER_ID,
        containerName: SOON_HEADER_NAME,
        content: title,
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
        containerID: SOON_BODY_ID,
        containerName: SOON_BODY_NAME,
        content: 'Скоро\n\n2x тап — назад',
        isEventCapture: 1,
      }),
    ],
    menuObject: buildMenuObject(false),
  }
}

function formatInboxListLine(item: InboxItem): string {
  const isUrgent = Boolean(item.urgent || item.priority === 'urgent')
  const raw = `${item.from}  ${item.preview}`
  if (isUrgent) {
    const trimmed = clampVisualAndUtf8(raw, 56, 56)
    const targetUnits = 62
    const desiredSpaces = Math.max(2, Math.round(targetUnits - visualWidthUnits(trimmed)))
    const maxSpacesByBytes = Math.max(1, 62 - utf8Encoder.encode(trimmed).length)
    const padCount = Math.min(desiredSpaces, maxSpacesByBytes)
    return clampUtf8(`${trimmed}${' '.repeat(padCount)}!`, 63)
  }
  return clampUtf8(raw, 63)
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
      content: overrideEmptyText ?? 'Всё тихо',
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

  const draftItems = card.drafts.slice(0, 4).map((draft) => clampUtf8(draft.lens, 63))
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

  let homeData: HomeResponse | null = null
  let homeSelectedIndex = 0
  let lastHomeSignature = ''
  let isRefreshingHome = false
  let meetingsData: MeetingsListResponse | null = null
  let meetingSelectedIndex = 0
  let activeMeetingBrief: MeetingBrief | null = null
  let meetingActionIndex = 0
  let activeReminder: GlassesReminderEvent | null = null
  let reminderSelectedIndex = 0
  let preReminderScreen: AppScreen = 'home'
  let preSoonScreen: AppScreen = 'home'

  let inboxItems: InboxItem[] = []
  let feedMode: FeedMode = 'urgent'
  let inboxCounts: InboxCounts = { urgent: 0, all: 0 }
  let selectedIndex = 0
  let lastInboxRebuildAt = 0
  let lastInboxSignature = ''
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

  async function refreshInboxNow(
    prefetched?: Promise<import('../lib/api').InboxResponse>,
    forceRebuild = false,
  ): Promise<void> {
    if (disposed || (screen !== 'inbox' && screen !== 'inbox-error') || isRefreshingInbox) {
      return
    }
    isRefreshingInbox = true
    try {
      const data = await (prefetched ?? fetchInbox(bridge))
      if (disposed || (screen !== 'inbox' && screen !== 'inbox-error')) return
      const nextSig = JSON.stringify({
        counts: data.counts,
        items: data.items.map((it) => [it.id, it.preview, it.urgent, it.count]),
      })
      const shouldRebuild =
        forceRebuild || screen === 'inbox-error' || nextSig !== lastInboxSignature
      screen = 'inbox'
      feedMode = data.mode
      inboxCounts = data.counts
      inboxItems = data.items
      if (selectedIndex >= inboxItems.length) {
        selectedIndex = 0
      }
      lastInboxRebuildAt = Date.now()
      renderPhoneInbox(inboxItems.length)
      if (shouldRebuild) {
        lastInboxSignature = nextSig
        const rebuilt = await bridge.rebuildPageContainer(
          new RebuildPageContainer(buildInboxPayload(inboxItems, feedMode, inboxCounts)),
        )
        if (!rebuilt) {
          lastInboxSignature = ''
          console.warn('[inbox] rebuildPageContainer returned false', { count: inboxItems.length })
        }
      }
    } catch (err) {
      lastInboxSignature = ''
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

  async function refreshHomeNow(
    prefetched?: Promise<HomeResponse>,
    forceRebuild = false,
  ): Promise<void> {
    if (disposed || (screen !== 'home' && screen !== 'home-error') || isRefreshingHome) {
      return
    }
    isRefreshingHome = true
    try {
      const data = await (prefetched ?? fetchHome(bridge))
      if (disposed || (screen !== 'home' && screen !== 'home-error')) return
      const nextSig = JSON.stringify({
        nowTime: data.nowTime,
        headerMeeting: data.headerMeeting,
        nextMeetingLine: data.nextMeetingLine,
        messages: data.messages,
        meetingsToday: data.meetings.todayCount,
        digest: data.digest,
      })
      const shouldRebuild =
        forceRebuild || screen === 'home-error' || nextSig !== lastHomeSignature
      screen = 'home'
      homeData = data
      const actions = getHomeActions(data)
      if (homeSelectedIndex >= actions.length) {
        homeSelectedIndex = 0
      }
      lastInboxRebuildAt = Date.now()
      renderPhoneInbox(data.messages.total)
      if (shouldRebuild) {
        lastHomeSignature = nextSig
        const rebuilt = await bridge.rebuildPageContainer(
          new RebuildPageContainer(buildHomePayload(data)),
        )
        if (!rebuilt) {
          lastHomeSignature = ''
          console.warn('[home] rebuildPageContainer returned false')
        }
      }
    } catch (err) {
      lastHomeSignature = ''
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        const msg = err instanceof Error ? err.message : 'Load failed'
        console.warn('[home] refresh failed:', msg)
        screen = 'home-error'
        renderPhoneError(msg, () => {
          void refreshHomeNow(undefined, true)
        })
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(buildHomePayload(null, `Ошибка: ${msg}\nТап — повторить`)),
        )
      }
    } finally {
      isRefreshingHome = false
    }
  }

  function scheduleHomeRefresh(immediate = false): void {
    if (disposed || (screen !== 'home' && screen !== 'home-error')) return

    if (immediate) {
      if (pendingInboxTimer !== null) {
        window.clearTimeout(pendingInboxTimer)
        pendingInboxTimer = null
      }
      void refreshHomeNow(undefined, true)
      return
    }

    const elapsed = Date.now() - lastInboxRebuildAt
    if (elapsed >= INBOX_REBUILD_THROTTLE_MS && pendingInboxTimer === null && !isRefreshingHome) {
      void refreshHomeNow()
      return
    }

    if (pendingInboxTimer === null) {
      const delay = Math.max(0, INBOX_REBUILD_THROTTLE_MS - elapsed)
      pendingInboxTimer = window.setTimeout(() => {
        pendingInboxTimer = null
        void refreshHomeNow()
      }, delay)
    }
  }

  async function enterHome(isStartup: boolean): Promise<void> {
    stopPolling()
    stopSendTimer()
    resetVoiceState(true)
    activeCard = null
    cardDraftIndex = 0
    screen = 'home'
    lastHomeSignature = ''
    renderPhoneInbox(0)

    const initialFetch = fetchHome(bridge)
    if (isStartup) {
      await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer(buildHomePayload(null, 'Загрузка…')),
      )
    }

    lastInboxRebuildAt = Date.now()
    await refreshHomeNow(initialFetch, true)
    if (!disposed && screen === 'home') {
      startSseSubscription()
    }
  }

  async function returnToHome(): Promise<void> {
    stopSendTimer()
    resetVoiceState(true)
    activeCard = null
    cardDraftIndex = 0
    screen = 'home'
    lastHomeSignature = ''
    await refreshHomeNow(undefined, true)
  }

  async function openMeetingsFromHome(): Promise<void> {
    if (disposed) return
    stopSendTimer()
    activeMeetingBrief = null
    meetingActionIndex = 0
    screen = 'meetings'
    meetingSelectedIndex = 0
    try {
      const data = await fetchMeetings(bridge)
      if (disposed || screen !== 'meetings') return
      meetingsData = data
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildMeetingsPayload(data)),
      )
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        const msg = err instanceof Error ? err.message : 'Ошибка загрузки'
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(
            buildMeetingsPayload(null, `Ошибка: ${msg}\n\n2x тап — Главная`),
          ),
        )
      }
    }
  }

  async function openMeetingBriefById(eventId: string): Promise<void> {
    if (disposed || isActionInFlight) return
    isActionInFlight = true
    try {
      const brief = await fetchMeetingBrief(bridge, eventId)
      if (disposed) return
      activeMeetingBrief = brief
      meetingActionIndex = 0
      screen = 'meeting-card'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildMeetingCardPayload(brief)),
      )
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        console.warn('[meetings] brief load failed:', err instanceof Error ? err.message : err)
        await openMeetingsFromHome()
      }
    } finally {
      isActionInFlight = false
    }
  }

  async function executeMeetingAction(
    eventId: string,
    action: MeetingBriefAction,
  ): Promise<void> {
    if (disposed || isActionInFlight) return
    isActionInFlight = true
    try {
      if (action === 'late') {
        await sendMeetingLate(bridge, eventId)
      } else {
        await rescheduleMeeting(bridge, eventId)
      }
      await openMeetingsFromHome()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        console.warn('[meetings] action failed:', err instanceof Error ? err.message : err)
        if (activeMeetingBrief && !disposed) {
          screen = 'meeting-card'
          await bridge.rebuildPageContainer(
            new RebuildPageContainer(buildMeetingCardPayload(activeMeetingBrief)),
          )
        } else {
          await openMeetingsFromHome()
        }
      }
    } finally {
      isActionInFlight = false
    }
  }

  async function startMeetingActionUndo(action: MeetingBriefAction): Promise<void> {
    if (disposed || !activeMeetingBrief || isActionInFlight) return
    stopSendTimer()
    sendCancelled = false
    screen = 'meeting-action-undo'
    let secondsLeft = CALENDAR_UNDO_SECONDS
    const brief = activeMeetingBrief
    const previewLine =
      action === 'reschedule'
        ? `${brief.title}\n${brief.reschedulePreview}`
        : `${brief.lateRecipientName ?? 'Участнику'}:\nОпаздываю на 5 мин`

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
            content: `Выполняю через ${secondsLeft}с…`,
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
            content: `${previewLine}\n\n2x тап — отмена`,
            isEventCapture: 1,
          }),
        ],
        menuObject: buildMenuObject(false),
      }),
    )

    if (disposed || sendCancelled || screen !== 'meeting-action-undo') return

    sendTimer = window.setInterval(() => {
      if (disposed || sendCancelled || screen !== 'meeting-action-undo') {
        stopSendTimer()
        return
      }
      secondsLeft -= 1
      if (secondsLeft > 0) {
        void bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: SENDING_HEADER_ID,
            containerName: SENDING_HEADER_NAME,
            content: `Выполняю через ${secondsLeft}с…`,
          }),
        )
        return
      }
      stopSendTimer()
      void executeMeetingAction(brief.id, action)
    }, 1000)
  }

  async function cancelMeetingActionUndo(): Promise<void> {
    sendCancelled = true
    stopSendTimer()
    if (!disposed && activeMeetingBrief) {
      screen = 'meeting-card'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildMeetingCardPayload(activeMeetingBrief)),
      )
    } else {
      await openMeetingsFromHome()
    }
  }

  async function showReminderOverlay(reminder: GlassesReminderEvent): Promise<void> {
    if (disposed || isRecordingActive) return
    if (screen !== 'reminder-overlay') {
      preReminderScreen = screen
    }
    activeReminder = reminder
    reminderSelectedIndex = 0
    screen = 'reminder-overlay'
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(buildReminderOverlayPayload(reminder)),
    )
  }

  async function dismissReminderOverlay(): Promise<void> {
    if (disposed) return
    activeReminder = null
    if (preReminderScreen === 'inbox' || preReminderScreen === 'inbox-error') {
      await returnToInbox()
    } else if (preReminderScreen === 'meetings') {
      await openMeetingsFromHome()
    } else if (preReminderScreen === 'meeting-card' && activeMeetingBrief) {
      screen = 'meeting-card'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildMeetingCardPayload(activeMeetingBrief)),
      )
    } else if (
      (preReminderScreen === 'card' ||
        preReminderScreen === 'card-full' ||
        preReminderScreen === 'transcript-pages') &&
      activeCard
    ) {
      if (preReminderScreen === 'transcript-pages') {
        await openTranscriptPages()
      } else if (preReminderScreen === 'card-full') {
        await openCardFull()
      } else {
        await backFromCardFull()
      }
    } else {
      await returnToHome()
    }
  }

  async function openComingSoon(title: string): Promise<void> {
    if (disposed) return
    if (screen !== 'coming-soon') {
      preSoonScreen = screen
    }
    screen = 'coming-soon'
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(buildComingSoonPayload(title)),
    )
  }

  async function returnFromComingSoon(): Promise<void> {
    if (disposed) return
    if (preSoonScreen === 'inbox' || preSoonScreen === 'inbox-error') {
      await returnToInbox()
    } else if (preSoonScreen === 'meetings') {
      await openMeetingsFromHome()
    } else if (
      (preSoonScreen === 'card' ||
        preSoonScreen === 'card-full' ||
        preSoonScreen === 'transcript-pages') &&
      activeCard
    ) {
      if (preSoonScreen === 'transcript-pages') {
        await openTranscriptPages()
      } else if (preSoonScreen === 'card-full') {
        await openCardFull()
      } else {
        await backFromCardFull()
      }
    } else {
      await returnToHome()
    }
  }

  function startSseSubscription(): void {
    stopInboxSync()
    stopSse = subscribeInboxStream(bridge, {
      onInbox: (evt) => {
        if (screen === 'home' || screen === 'home-error') {
          scheduleHomeRefresh(false)
          return
        }
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
      onReminder: (reminder) => {
        void showReminderOverlay(reminder)
      },
      onUnauthorized: () => {
        void handleUnauthorized()
      },
    })
    fallbackPollTimer = window.setInterval(() => {
      if (disposed) return
      if (screen === 'home' || screen === 'home-error') {
        scheduleHomeRefresh(false)
      } else if (screen === 'inbox') {
        scheduleInboxRefresh(false)
      } else if (
        (screen === 'card-full' || screen === 'card' || screen === 'transcript-pages') &&
        activeCard
      ) {
        void refreshActiveCardInPlace()
      }
    }, 10_000)
  }

  async function returnToInbox(): Promise<void> {
    stopSendTimer()
    resetVoiceState(true)
    activeCard = null
    cardDraftIndex = 0
    screen = 'inbox'
    lastInboxSignature = ''
    await refreshInboxNow(undefined, true)
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
          await enterHome(false)
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
    await enterHome(true)
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
      if (screen === 'meeting-action-undo') {
        void cancelMeetingActionUndo()
        return
      }
      if (screen === 'reminder-overlay') {
        void dismissReminderOverlay()
        return
      }
      if (screen === 'coming-soon') {
        void returnFromComingSoon()
        return
      }
      if (screen === 'meeting-card') {
        void openMeetingsFromHome()
        return
      }
      if (screen === 'meetings' || screen === 'inbox' || screen === 'inbox-error') {
        void returnToHome()
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
      if (itemId === MENU_NEW_NOTE_ID) {
        void openComingSoon('Новая заметка')
      } else if (itemId === MENU_MY_NOTES_ID) {
        void openComingSoon('Мои заметки')
      } else if (itemId === MENU_HOME_ID) {
        void returnToHome()
      } else if (itemId === MENU_REFRESH_ID) {
        if (screen === 'home' || screen === 'home-error') {
          scheduleHomeRefresh(true)
        } else if (screen === 'meetings') {
          void openMeetingsFromHome()
        } else if (screen === 'meeting-card' && activeMeetingBrief) {
          void openMeetingBriefById(activeMeetingBrief.id)
        } else if (screen === 'inbox' || screen === 'inbox-error') {
          scheduleInboxRefresh(true)
        } else if (
          (screen === 'card' || screen === 'card-full' || screen === 'transcript-pages') &&
          activeCard
        ) {
          void openCard(activeCard.id)
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
      if (screen === 'home') {
        homeSelectedIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'meetings') {
        meetingSelectedIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'meeting-card') {
        meetingActionIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'reminder-overlay') {
        reminderSelectedIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'inbox') {
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

      if (screen === 'coming-soon') {
        void returnFromComingSoon()
        return
      }

      if (screen === 'home-error') {
        void refreshHomeNow(undefined, true)
        return
      }

      if (screen === 'home' && homeData) {
        const actions = getHomeActions(homeData)
        const idx = event.listEvent?.currentSelectItemIndex ?? homeSelectedIndex
        const chosen = actions[idx]
        if (chosen?.action === 'messages') {
          void returnToInbox()
        } else if (chosen?.action === 'meetings') {
          void openMeetingsFromHome()
        } else if (chosen?.action === 'digest') {
          void openComingSoon('Дайджест')
        }
        return
      }

      if (screen === 'reminder-overlay' && activeReminder) {
        const idx = event.listEvent?.currentSelectItemIndex ?? reminderSelectedIndex
        if (idx === 0 && activeReminder.eventId) {
          const eventId = activeReminder.eventId
          activeReminder = null
          void openMeetingBriefById(eventId)
        } else {
          void dismissReminderOverlay()
        }
        return
      }

      if (screen === 'meetings' && meetingsData && meetingsData.items.length > 0) {
        const idx = event.listEvent?.currentSelectItemIndex ?? meetingSelectedIndex
        const ev = meetingsData.items[idx]
        if (ev) {
          void openMeetingBriefById(ev.id)
        }
        return
      }

      if (screen === 'meeting-card' && activeMeetingBrief) {
        const actions = getMeetingBriefActions(activeMeetingBrief)
        const idx = event.listEvent?.currentSelectItemIndex ?? meetingActionIndex
        const chosen = actions[idx]
        if (chosen) {
          void startMeetingActionUndo(chosen.action)
        }
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
