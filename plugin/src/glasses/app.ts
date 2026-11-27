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
  appendNoteVoice,
  clearDeviceToken,
  completePromiseReminder,
  completeTaskNote,
  createCalendarMeeting,
  createNote,
  createPromiseReminder,
  deleteNote,
  fetchDigestList,
  fetchDigestPost,
  fetchHome,
  fetchInbox,
  fetchMeetingBrief,
  fetchMeetings,
  fetchMessageCard,
  fetchNotes,
  fetchSettings,
  getPairingStatus,
  getStoredDeviceToken,
  prepareMeetingBriefVoice,
  rescheduleMeeting,
  saveDeviceToken,
  sendMeetingLate,
  sendMessageReply,
  sendVoiceReply,
  skipMessage,
  snoozePromiseReminder,
  snoozeTaskNote,
  startPairing,
  subscribeInboxStream,
  transcribeNoteVoice,
  updateNote,
  updateSettings,
  type DigestListItem,
  type DigestPostDetail,
  type FeedMode,
  type GlassesReminderEvent,
  type HomeResponse,
  type InboxCounts,
  type InboxItem,
  type MeetingBrief,
  type MeetingListItem,
  type MeetingsListResponse,
  type MessageCard,
  type NoteDraftAnalysis,
  type NoteItem,
  type PromiseSuggestion,
  type ProposedMeetingInfo,
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

const DIVIDER_ID = 70
const DIVIDER_NAME = 'divider'

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
const MENU_LANGUAGE_ID = 5
const MENU_RECORD_VOICE_ID = 7

const UI_LANG_KEY = 'pager_ui_lang'
type UiLang = 'ru' | 'en'
let uiLang: UiLang = 'ru'

function t(ru: string, en: string): string {
  return uiLang === 'en' ? en : ru
}

type HomeAction = 'messages' | 'meetings' | 'digest'

type AppScreen =
  | 'pairing'
  | 'pairing-expired'
  | 'pairing-error'
  | 'home'
  | 'home-error'
  | 'meetings'
  | 'meeting-brief'
  | 'meeting-card'
  | 'meeting-action-undo'
  | 'new-meeting'
  | 'new-meeting-slots'
  | 'meeting-brief-review'
  | 'calendar-create-undo'
  | 'notes-list'
  | 'note-review'
  | 'note-detail'
  | 'note-bind-meeting'
  | 'note-delete-undo'
  | 'promise-confirm'
  | 'promise-alt-time'
  | 'digest-list'
  | 'digest-post'
  | 'reminder-overlay'
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
      new MenuItemProperty({
        itemName: t('Ответить голосом', 'Voice reply'),
        itemID: MENU_RECORD_VOICE_ID,
      }),
    )
  }
  menuItems.push(
    new MenuItemProperty({ itemName: t('Новая заметка', 'New note'), itemID: MENU_NEW_NOTE_ID }),
    new MenuItemProperty({ itemName: t('Мои заметки', 'My notes'), itemID: MENU_MY_NOTES_ID }),
    new MenuItemProperty({ itemName: t('Главная', 'Home'), itemID: MENU_HOME_ID }),
    new MenuItemProperty({ itemName: t('Обновить', 'Refresh'), itemID: MENU_REFRESH_ID }),
    new MenuItemProperty({
      itemName: uiLang === 'ru' ? 'Language: EN' : 'Язык: RU',
      itemID: MENU_LANGUAGE_ID,
    }),
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
        ? `${home.messages.total} · ${home.messages.urgent} ${t('срочное', 'urgent')}`
        : `${home.messages.total}`
      : t('нет', 'none')
  const meetRight =
    home.meetings.todayCount > 0
      ? `${home.meetings.todayCount} ${t('сегодня', 'today')}`
      : t('нет', 'none')

  const items: Array<{ action: HomeAction; label: string }> = [
    { action: 'messages', label: formatSplitListLine(t('Сообщения', 'Messages'), msgRight) },
    { action: 'meetings', label: formatSplitListLine(t('Встречи', 'Meetings'), meetRight) },
  ]
  if (home.digest.enabled) {
    items.push({
      action: 'digest',
      label: formatSplitListLine(t('Дайджест', 'Digest'), String(home.digest.count)),
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
      content: t('Главная', 'Home'),
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
      content: overrideStatusText ?? t('Загрузка…', 'Loading…'),
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
    : `${t('Всё тихо', 'All quiet')}\n${home.nextMeetingLine ?? t('встреч нет', 'no meetings')}`

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
    content: t('Встречи', 'Meetings'),
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
      content: t(
        'Календарь не подключён\nОтправьте /google боту\n\n2x тап — Главная',
        'Calendar not connected\nSend /google to the bot\n\n2x tap — Home',
      ),
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
      content: t(
        'Встреч сегодня и завтра нет\n\n2x тап — Главная',
        'No meetings today or tomorrow\n\n2x tap — Home',
      ),
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
          return formatSplitListLine(left, t('завтра', 'tomorrow'))
        }
        if (ev.minutesUntil !== null && ev.minutesUntil < 60) {
          return formatSplitListLine(left, t(`через ${ev.minutesUntil} мин`, `in ${ev.minutesUntil} min`))
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
    actions.push({ action: 'late', label: clampUtf8(t('Опаздываю на 5 мин', 'Late 5 min'), 63) })
  }
  actions.push({ action: 'reschedule', label: clampUtf8(t('Перенести +30 мин', 'Move +30 min'), 63) })
  return actions
}

function buildMeetingBriefPayload(brief: MeetingBrief): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  menuObject: MenuContainerProperty
} {
  const timeSuffix = brief.isTomorrow
    ? t(' · завтра', ' · tomorrow')
    : brief.minutesUntil !== null && brief.minutesUntil < 60
      ? t(` · через ${brief.minutesUntil} мин`, ` · in ${brief.minutesUntil} min`)
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
    yPosition: 50,
    width: 576,
    height: 238,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: MEETING_BRIEF_BODY_ID,
    containerName: MEETING_BRIEF_BODY_NAME,
    content: `${brief.startTime}-${brief.endTime}${timeSuffix}\n\n${brief.summary}`,
    isEventCapture: 1,
  })
  return {
    containerTotalNum: 3,
    textObject: [header, buildDividerContainer(44), body],
    menuObject: buildMenuObject(false),
  }
}

function buildMeetingCardPayload(brief: MeetingBrief): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject: ListContainerProperty[]
  menuObject: MenuContainerProperty
} {
  const timeSuffix = brief.isTomorrow
    ? t(' · завтра', ' · tomorrow')
    : brief.minutesUntil !== null && brief.minutesUntil < 60
      ? t(` · через ${brief.minutesUntil} мин`, ` · in ${brief.minutesUntil} min`)
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

function getReminderActions(reminder: GlassesReminderEvent): string[] {
  if (reminder.kind === 'task') {
    return [t('Готово', 'Done'), t('+1 час', '+1 hour')]
  }
  if (reminder.kind === 'promise') {
    return [t('Готово', 'Done'), t('Открыть чат', 'Open chat'), t('+1 час', '+1 hour')]
  }
  return [t('Открыть бриф', 'Open brief'), t('Позже', 'Later')]
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
  const items = getReminderActions(reminder)
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
      itemCount: items.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: items,
    }),
  })
  return {
    containerTotalNum: 3,
    textObject: [header, body],
    listObject: [list],
    menuObject: buildMenuObject(false),
  }
}

function buildGenericThreePartPayload(params: {
  headerText: string
  bodyText: string
  items: string[]
  includeVoice?: boolean
}): {
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
    containerID: SOON_HEADER_ID,
    containerName: SOON_HEADER_NAME,
    content: clampUtf8(params.headerText, 63),
    isEventCapture: 0,
  })
  const body = new TextContainerProperty({
    xPosition: 0,
    yPosition: 42,
    width: 576,
    height: 108,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: SOON_BODY_ID,
    containerName: SOON_BODY_NAME,
    content: params.bodyText,
    isEventCapture: 0,
  })
  const clampedItems = params.items.map((it) => clampUtf8(it, 63))
  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: 152,
    width: 576,
    height: 136,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: REMINDER_LIST_ID,
    containerName: REMINDER_LIST_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: clampedItems.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: clampedItems,
    }),
  })
  return {
    containerTotalNum: 3,
    textObject: [header, body],
    listObject: [list],
    menuObject: buildMenuObject(Boolean(params.includeVoice)),
  }
}

function buildGenericListPagePayload(params: {
  headerText: string
  items: string[]
  emptyText: string
}): {
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
    containerID: SOON_HEADER_ID,
    containerName: SOON_HEADER_NAME,
    content: clampUtf8(params.headerText, 63),
    isEventCapture: 0,
  })
  if (params.items.length === 0) {
    const empty = new TextContainerProperty({
      xPosition: 0,
      yPosition: 46,
      width: 576,
      height: 242,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: SOON_BODY_ID,
      containerName: SOON_BODY_NAME,
      content: params.emptyText,
      isEventCapture: 1,
    })
    return {
      containerTotalNum: 2,
      textObject: [header, empty],
      menuObject: buildMenuObject(false),
    }
  }
  const clamped = params.items.map((it) => clampUtf8(it, 63))
  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: 46,
    width: 576,
    height: 242,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: REMINDER_LIST_ID,
    containerName: REMINDER_LIST_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: clamped.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: clamped,
    }),
  })
  return {
    containerTotalNum: 2,
    textObject: [header],
    listObject: [list],
    menuObject: buildMenuObject(false),
  }
}

function formatInboxListLine(item: InboxItem): string {
  const isUrgent = Boolean(item.urgent || item.priority === 'urgent')
  const conflictPrefix = item.hasConflict ? '!! ' : ''
  const raw = `${conflictPrefix}${item.from}: ${item.preview}`
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
  return t(
    `Сообщения: ${counts.all}, срочные: ${counts.urgent}`,
    `Messages: ${counts.all}, urgent: ${counts.urgent}`,
  )
}

/**
 * Even Hub text containers only support a full-frame border, so a "border-bottom"
 * is a thin (4px) bordered container placed directly under the header.
 */
function buildDividerContainer(y: number): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: y,
    width: 576,
    height: 4,
    borderWidth: 1,
    borderColor: 5,
    paddingLength: 0,
    containerID: DIVIDER_ID,
    containerName: DIVIDER_NAME,
    content: ' ',
    isEventCapture: 0,
  })
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
  const divider = buildDividerContainer(44)

  if (items.length === 0) {
    const emptyText = new TextContainerProperty({
      xPosition: 0,
      yPosition: 50,
      width: 576,
      height: 238,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: INBOX_EMPTY_ID,
      containerName: INBOX_EMPTY_NAME,
      content: overrideEmptyText ?? t('Всё тихо', 'All quiet'),
      isEventCapture: 1,
    })

    return {
      containerTotalNum: 3,
      textObject: [header, divider, emptyText],
      menuObject: buildMenuObject(),
    }
  }

  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: 50,
    width: 576,
    height: 238,
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
    containerTotalNum: 3,
    textObject: [header, divider],
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
  return clampUtf8(`${prefix}${card.from}`, 64)
}

function formatTranscriptPageHeader(
  card: MessageCard,
  pageIndex: number,
  totalPages: number,
): string {
  const pageSuffix = totalPages > 1 ? ` · ${pageIndex + 1}/${totalPages}` : ''
  if (card.media) {
    const label = card.media.kind === 'video_note' ? 'video' : 'voice'
    const dur = formatDurationMmSs(card.media.duration)
    return clampUtf8(`${card.from} · ${label} ${dur}${pageSuffix}`, 64)
  }
  return clampUtf8(`${card.from}${pageSuffix}`, 64)
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
    yPosition: 50,
    width: 576,
    height: 238,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: TRANSCRIPT_BODY_ID,
    containerName: TRANSCRIPT_BODY_NAME,
    content: pages[pageIndex] ?? '',
    isEventCapture: 1,
  })

  return {
    containerTotalNum: 3,
    textObject: [header, buildDividerContainer(44), body],
    menuObject: buildMenuObject(true),
  }
}

function buildCardPayload(card: MessageCard): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject: ListContainerProperty[]
  menuObject: MenuContainerProperty
} {
  // Max 3 containers per page: name + border-bottom line (ASCII) + gist share one text
  // container so the reply list keeps its own container.
  const gistContent = card.conflictLine
    ? `${card.conflictLine}\n${card.gist}`
    : card.gist
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 112,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: CARD_HEADER_ID,
    containerName: CARD_HEADER_NAME,
    content: `${formatCardHeaderText(card)}\n${'-'.repeat(30)}\n${gistContent}`,
    isEventCapture: 0,
  })

  const draftItems = card.drafts.slice(0, 4).map((draft) => clampUtf8(draft.lens, 63))
  draftItems.push(t('Пропустить', 'Skip'))
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
    containerTotalNum: 2,
    textObject: [header],
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
    content: clampUtf8(`${prefix}${card.from}`, 64),
    isEventCapture: 0,
  })

  const body = new TextContainerProperty({
    xPosition: 0,
    yPosition: 50,
    width: 576,
    height: 238,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: CARD_FULL_BODY_ID,
    containerName: CARD_FULL_BODY_NAME,
    content: card.fullText || card.gist,
    isEventCapture: 1,
  })

  return {
    containerTotalNum: 3,
    textObject: [header, buildDividerContainer(44), body],
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
  const kindLabel =
    kind === 'short' ? t('короткое', 'short') : t('длинное', 'long')
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
    content: clampUtf8(
      `${t('Голос', 'Voice')} ${formatDurationMmSs(durationSec)} · ${kindLabel}`,
      63,
    ),
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
      itemName: [t('Отправить', 'Send'), t('Отмена', 'Discard')],
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
    content: t(`Отправка через ${secondsLeft}с…`, `Sending in ${secondsLeft}s…`),
    isEventCapture: 0,
  })

  const calLine = hasCal ? `\n+ ${t('Встреча в календаре', 'Calendar event')}` : ''
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
    content: `${draftLens}${calLine}\n\n${t('2x тап — отмена', '2x tap to cancel')}`,
    isEventCapture: 1,
  })

  return {
    containerTotalNum: 2,
    textObject: [header, body],
    menuObject: buildMenuObject(false),
  }
}

export async function startGlassesApp(overrideBridge?: EvenAppBridge): Promise<void> {
  const bridge: EvenAppBridge = overrideBridge ?? (await waitForEvenAppBridge())

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

  let preVoiceScreen: AppScreen = 'card'
  let recordingPurpose: 'chat-voice' | 'new-note' | 'append-note' | 'meeting-brief' = 'chat-voice'
  let recordingMode: 'hold' | 'menu' = 'hold'
  let isRecordingActive = false
  let holdReleasedEarly = false
  let recordStartedAt = 0
  let recordTickTimer: number | null = null
  let voiceShortDismissTimer: number | null = null
  let pcmChunks: Uint8Array[] = []
  let pendingWav: { wavBytes: Uint8Array; durationSec: number } | null = null
  let voiceConfirmIndex = 0

  // Notes, Promises, New Meeting & Digest state
  let notesList: NoteItem[] = []
  let notesFilterMeetingId: string | undefined
  let noteSelectedIndex = 0
  let activeNote: NoteItem | null = null
  let noteDetailActionIndex = 0
  let noteDraftAnalysis: NoteDraftAnalysis | null = null
  let noteDraftBindMeeting: { eventId: string; label: string } | null = null
  let noteReviewActionIndex = 0
  let bindMeetingChoices: Array<{ eventId: string | null; title: string | null; label: string }> = []
  let bindMeetingIndex = 0
  let preNotesScreen: AppScreen = 'home'

  let activePromiseSuggestion: PromiseSuggestion | null = null
  let promiseActionIndex = 0

  let activeProposedMeeting: ProposedMeetingInfo | null = null
  let proposedMeetingChatId: number | undefined
  let newMeetingActionIndex = 0
  let newMeetingSlotIndex = 0
  let preparedBrief: { userSaid: string; aiAdded: string; combinedDescription: string } | null = null
  let briefReviewActionIndex = 0

  let digestItems: DigestListItem[] = []
  let digestSelectedIndex = 0
  let activeDigestPost: DigestPostDetail | null = null
  let digestPages: string[] = []
  let digestPageIndex = 0

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
      const data = await (prefetched ?? fetchHome(bridge, uiLang))
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
          new RebuildPageContainer(
            buildHomePayload(null, `${t('Ошибка', 'Error')}: ${msg}\n${t('Тап — повторить', 'Tap — retry')}`),
          ),
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

    const initialFetch = fetchHome(bridge, uiLang)
    if (isStartup) {
      await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer(buildHomePayload(null, t('Загрузка…', 'Loading…'))),
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
    homeSelectedIndex = 0
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
        const msg = err instanceof Error ? err.message : t('Ошибка загрузки', 'Load error')
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(
            buildMeetingsPayload(
              null,
              `${t('Ошибка', 'Error')}: ${msg}\n\n${t('2x тап — Главная', '2x tap — Home')}`,
            ),
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
      screen = 'meeting-brief'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildMeetingBriefPayload(brief)),
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
        : `${brief.lateRecipientName ?? t('Участнику', 'Attendee')}:\n${t('Опаздываю на 5 мин', 'Running 5 min late')}`

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
            content: t(`Выполняю через ${secondsLeft}с…`, `Running in ${secondsLeft}s…`),
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
            content: `${previewLine}\n\n${t('2x тап — отмена', '2x tap — cancel')}`,
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
            content: t(`Выполняю через ${secondsLeft}с…`, `Running in ${secondsLeft}s…`),
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

  async function openNotesList(meetingEventId?: string): Promise<void> {
    if (disposed) return
    stopSendTimer()
    if (
      screen !== 'notes-list' &&
      screen !== 'note-detail' &&
      screen !== 'note-review' &&
      screen !== 'note-bind-meeting' &&
      screen !== 'note-delete-undo'
    ) {
      preNotesScreen = screen
    }
    notesFilterMeetingId = meetingEventId
    noteSelectedIndex = 0
    screen = 'notes-list'
    try {
      const res = await fetchNotes(bridge, meetingEventId)
      if (disposed || screen !== 'notes-list') return
      notesList = res.items
      const headerText = meetingEventId
        ? t(`Заметки встречи (${notesList.length})`, `Meeting notes (${notesList.length})`)
        : t(`Мои заметки (${notesList.length})`, `My notes (${notesList.length})`)
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(
          buildGenericListPagePayload({
            headerText,
            items: notesList.map((n) => {
              const prefix = n.remindTime && !n.taskCompleted ? `[${n.remindTime}] ` : ''
              return `${prefix}${n.text}`
            }),
            emptyText: t(
              'Заметок пока нет\n\nМеню -> Новая заметка\n2x тап — назад',
              'No notes yet\n\nMenu -> New note\n2x tap — back',
            ),
          }),
        ),
      )
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(
            buildGenericListPagePayload({
              headerText: t('Мои заметки', 'My notes'),
              items: [],
              emptyText: t('Ошибка загрузки\n\n2x тап — назад', 'Load error\n\n2x tap — back'),
            }),
          ),
        )
      }
    }
  }

  async function returnFromNotes(): Promise<void> {
    if (preNotesScreen === 'meeting-card' && activeMeetingBrief) {
      await openMeetingBriefById(activeMeetingBrief.id)
    } else if (preNotesScreen === 'inbox') {
      await returnToInbox()
    } else if (preNotesScreen === 'meetings') {
      await openMeetingsFromHome()
    } else if (
      (preNotesScreen === 'card' ||
        preNotesScreen === 'card-full' ||
        preNotesScreen === 'transcript-pages') &&
      activeCard
    ) {
      await backFromCardFull()
    } else {
      await returnToHome()
    }
  }

  function getNoteReviewActions(): Array<{ id: string; label: string }> {
    if (!noteDraftAnalysis) return []
    const items: Array<{ id: string; label: string }> = []
    if (noteDraftAnalysis.taskReminder) {
      items.push({ id: 'save_rem', label: t('Сохранить с напоминанием', 'Save + reminder') })
      items.push({ id: 'save_no_rem', label: t('Без напоминания', 'Without reminder') })
    } else {
      items.push({ id: 'save_no_rem', label: t('Сохранить', 'Save') })
    }
    if (noteDraftAnalysis.matchedMeeting && !noteDraftBindMeeting) {
      items.push({
        id: 'bind_matched',
        label: `${t('Привязать', 'Link')}: ${noteDraftAnalysis.matchedMeeting.label}`,
      })
    }
    items.push({ id: 'rerecord', label: t('Записать заново', 'Re-record') })
    items.push({ id: 'discard', label: t('Удалить', 'Delete') })
    return items
  }

  async function renderNoteReviewScreen(): Promise<void> {
    if (disposed || !noteDraftAnalysis) return
    screen = 'note-review'
    noteReviewActionIndex = 0
    const lines = [noteDraftAnalysis.transcript]
    if (noteDraftAnalysis.taskReminder) {
      lines.push(`${t('Напоминание', 'Reminder')}: ${noteDraftAnalysis.taskReminder.label}`)
    }
    if (noteDraftBindMeeting) {
      lines.push(`${t('Встреча', 'Meeting')}: ${noteDraftBindMeeting.label}`)
    }
    const actions = getNoteReviewActions()
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildGenericThreePartPayload({
          headerText: t('Новая заметка', 'New note'),
          bodyText: lines.join('\n'),
          items: actions.map((a) => a.label),
        }),
      ),
    )
  }

  async function openNoteDetail(note: NoteItem): Promise<void> {
    if (disposed) return
    activeNote = note
    noteDetailActionIndex = 0
    screen = 'note-detail'
    const meta: string[] = []
    if (note.meetingTitle) meta.push(`${t('Встреча', 'Meeting')}: ${note.meetingTitle}`)
    if (note.remindTime && !note.taskCompleted) meta.push(`${t('Напоминание', 'Reminder')}: ${note.remindTime}`)
    const bodyText = meta.length > 0 ? `${note.text}\n${meta.join(' · ')}` : note.text
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildGenericThreePartPayload({
          headerText: t('Заметка', 'Note'),
          bodyText,
          items: [
            t('Дописать голосом', 'Append voice'),
            t('Привязать к встрече', 'Link to meeting'),
            t('Удалить', 'Delete'),
          ],
        }),
      ),
    )
  }

  async function openNoteBindMeetingMenu(): Promise<void> {
    if (disposed || !activeNote) return
    screen = 'note-bind-meeting'
    bindMeetingIndex = 0
    let items: MeetingListItem[] = meetingsData?.items ?? []
    try {
      const fetched = await fetchMeetings(bridge)
      meetingsData = fetched
      items = fetched.items
    } catch {
      // ignore
    }
    bindMeetingChoices = items.slice(0, 5).map((ev) => ({
      eventId: ev.id,
      title: `${ev.title} ${ev.startTime}`,
      label: `${ev.startTime} ${ev.title}`,
    }))
    bindMeetingChoices.push({ eventId: null, title: null, label: t('Без встречи', 'No meeting') })
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildGenericListPagePayload({
          headerText: t('Привязать к встрече', 'Link to meeting'),
          items: bindMeetingChoices.map((c) => c.label),
          emptyText: t('Встреч не найдено', 'No meetings found'),
        }),
      ),
    )
  }

  async function startNoteDeleteUndo(): Promise<void> {
    if (disposed || !activeNote || isActionInFlight) return
    stopSendTimer()
    sendCancelled = false
    screen = 'note-delete-undo'
    let secondsLeft = CALENDAR_UNDO_SECONDS
    const targetId = activeNote.id
    const snippet = activeNote.text.slice(0, 60)

    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildVoiceStatusPayload(
          t(`Удаление через ${secondsLeft}с…`, `Deleting in ${secondsLeft}s…`),
          `${snippet}\n\n${t('2x тап — отмена', '2x tap — cancel')}`,
        ),
      ),
    )

    sendTimer = window.setInterval(() => {
      if (disposed || sendCancelled || screen !== 'note-delete-undo') {
        stopSendTimer()
        return
      }
      secondsLeft -= 1
      if (secondsLeft > 0) {
        void bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: VOICE_HEADER_ID,
            containerName: VOICE_HEADER_NAME,
            content: t(`Удаление через ${secondsLeft}с…`, `Deleting in ${secondsLeft}s…`),
          }),
        )
        return
      }
      stopSendTimer()
      void bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: VOICE_HEADER_ID,
          containerName: VOICE_HEADER_NAME,
          content: t('Удаляю…', 'Deleting…'),
        }),
      )
      void deleteNote(bridge, targetId)
        .then(() => {
          activeNote = null
          return openNotesList(notesFilterMeetingId)
        })
        .catch(() => openNotesList(notesFilterMeetingId))
    }, 1000)
  }

  async function openPromiseConfirmScreen(suggestion: PromiseSuggestion): Promise<void> {
    if (disposed) return
    activePromiseSuggestion = suggestion
    promiseActionIndex = 0
    screen = 'promise-confirm'
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildGenericThreePartPayload({
          headerText: suggestion.headerSentTo,
          bodyText: `${suggestion.replyText}\n${suggestion.promptQuestion}`,
          items: [suggestion.defaultOption.label, t('Другое время', 'Other time'), t('Не надо', 'No thanks')],
        }),
      ),
    )
  }

  async function openPromiseAltTimeScreen(): Promise<void> {
    if (disposed || !activePromiseSuggestion) return
    promiseActionIndex = 0
    screen = 'promise-alt-time'
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildGenericListPagePayload({
          headerText: activePromiseSuggestion.promptQuestion,
          items: [
            ...activePromiseSuggestion.altOptions.map((o) => o.label),
            t('Отмена', 'Cancel'),
          ],
          emptyText: t('Отмена', 'Cancel'),
        }),
      ),
    )
  }

  async function savePromiseAt(remindAt: number): Promise<void> {
    if (!activePromiseSuggestion || isActionInFlight) return
    isActionInFlight = true
    const s = activePromiseSuggestion
    activePromiseSuggestion = null
    try {
      await createPromiseReminder(bridge, {
        messageId: s.messageId,
        chatId: s.chatId,
        contactName: s.contactName,
        replyText: s.replyText,
        taskText: s.taskText,
        promisedAtTime: s.promisedAtTime,
        remindAt,
      })
    } catch {
      // ignore
    } finally {
      isActionInFlight = false
    }
    await returnToInbox()
  }

  async function openNewMeetingScreen(
    pm: ProposedMeetingInfo,
    chatId?: number,
  ): Promise<void> {
    if (disposed) return
    activeProposedMeeting = pm
    proposedMeetingChatId = chatId
    preparedBrief = null
    newMeetingActionIndex = 0
    screen = 'new-meeting'
    const statusText = pm.isFree
      ? t('ты свободен', 'you are free')
      : `${t('!! занят', '!! busy')}: ${pm.conflict?.title ?? t('встреча', 'meeting')}`
    const items = [
      t('Создать + бриф голосом', 'Create + voice brief'),
      t('Создать без брифа', 'Create without brief'),
    ]
    if (pm.altSlots.length > 0) {
      items.push(t('Другое время', 'Other time'))
    }
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildGenericThreePartPayload({
          headerText: t('Новая встреча', 'New meeting'),
          bodyText: `${pm.title}\n${pm.displayWhen} · ${statusText}`,
          items,
        }),
      ),
    )
  }

  async function openNewMeetingSlotsScreen(): Promise<void> {
    if (disposed || !activeProposedMeeting) return
    newMeetingSlotIndex = 0
    screen = 'new-meeting-slots'
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildGenericListPagePayload({
          headerText: t('Другое время', 'Other time'),
          items: activeProposedMeeting.altSlots.map((s) => s.displayWhen),
          emptyText: t('Свободных слотов рядом нет', 'No free slots nearby'),
        }),
      ),
    )
  }

  async function openMeetingBriefReviewScreen(): Promise<void> {
    if (disposed || !preparedBrief) return
    briefReviewActionIndex = 0
    screen = 'meeting-brief-review'
    const aiLine = preparedBrief.aiAdded ? `\n${t('ИИ добавил', 'AI added')}: ${preparedBrief.aiAdded}` : ''
    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildGenericThreePartPayload({
          headerText: t('Бриф встречи', 'Meeting brief'),
          bodyText: `${t('Ты', 'You')}: ${preparedBrief.userSaid}${aiLine}`,
          items: [t('Сохранить', 'Save'), t('Дописать голосом', 'Append voice')],
        }),
      ),
    )
  }

  async function startCalendarCreateUndo(description?: string): Promise<void> {
    if (disposed || !activeProposedMeeting || isActionInFlight) return
    stopSendTimer()
    sendCancelled = false
    screen = 'calendar-create-undo'
    let secondsLeft = CALENDAR_UNDO_SECONDS
    const pm = activeProposedMeeting

    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildVoiceStatusPayload(
          t(`Создание через ${secondsLeft}с…`, `Creating in ${secondsLeft}s…`),
          `${pm.title}\n${pm.displayWhen}\n\n${t('2x тап — отмена', '2x tap — cancel')}`,
        ),
      ),
    )

    sendTimer = window.setInterval(() => {
      if (disposed || sendCancelled || screen !== 'calendar-create-undo') {
        stopSendTimer()
        return
      }
      secondsLeft -= 1
      if (secondsLeft > 0) {
        void bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: VOICE_HEADER_ID,
            containerName: VOICE_HEADER_NAME,
            content: t(`Создание через ${secondsLeft}с…`, `Creating in ${secondsLeft}s…`),
          }),
        )
        return
      }
      stopSendTimer()
      void createCalendarMeeting(bridge, {
        title: pm.title,
        startIso: pm.startIso,
        endIso: pm.endIso,
        description,
      })
        .then(() => {
          activeProposedMeeting = null
          preparedBrief = null
          return returnToHome()
        })
        .catch(() => openNewMeetingScreen(pm, proposedMeetingChatId))
    }, 1000)
  }

  async function openDigestListScreen(): Promise<void> {
    if (disposed) return
    digestSelectedIndex = 0
    screen = 'digest-list'
    try {
      const res = await fetchDigestList(bridge)
      if (disposed || screen !== 'digest-list') return
      digestItems = res.items
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(
          buildGenericListPagePayload({
            headerText: `${t('Дайджест', 'Digest')} · ${digestItems.length}`,
            items: digestItems.map((it) => `${it.channel}  ${it.gist}`),
            emptyText: t(
              'Новых постов сегодня нет\n\n2x тап — Главная',
              'No new posts today\n\n2x tap — Home',
            ),
          }),
        ),
      )
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await handleUnauthorized()
      } else {
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(
            buildGenericListPagePayload({
              headerText: t('Дайджест', 'Digest'),
              items: [],
              emptyText: t(
                'Ошибка загрузки дайджеста\n\n2x тап — Главная',
                'Digest load error\n\n2x tap — Home',
              ),
            }),
          ),
        )
      }
    }
  }

  function formatDigestPostHeader(post: DigestPostDetail, idx: number, total: number): string {
    return clampUtf8(`${post.channel} · ${post.time} · ${idx + 1}/${total}`, 63)
  }

  async function openDigestPostScreen(id: number): Promise<void> {
    if (disposed || isActionInFlight) return
    isActionInFlight = true
    try {
      const post = await fetchDigestPost(bridge, id)
      if (disposed) return
      activeDigestPost = post
      digestPages = paginateLensText(post.text, 180)
      digestPageIndex = 0
      screen = 'digest-post'
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
              containerID: TRANSCRIPT_HEADER_ID,
              containerName: TRANSCRIPT_HEADER_NAME,
              content: formatDigestPostHeader(post, 0, digestPages.length),
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
              containerID: TRANSCRIPT_BODY_ID,
              containerName: TRANSCRIPT_BODY_NAME,
              content: digestPages[0] ?? '',
              isEventCapture: 1,
            }),
          ],
          menuObject: buildMenuObject(false),
        }),
      )
    } catch {
      await openDigestListScreen()
    } finally {
      isActionInFlight = false
    }
  }

  async function stepDigestPage(delta: -1 | 1): Promise<void> {
    if (disposed || !activeDigestPost || screen !== 'digest-post') return
    const nextIdx = digestPageIndex + delta
    if (nextIdx < 0 || nextIdx >= digestPages.length) return
    digestPageIndex = nextIdx
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: TRANSCRIPT_HEADER_ID,
        containerName: TRANSCRIPT_HEADER_NAME,
        content: formatDigestPostHeader(activeDigestPost, digestPageIndex, digestPages.length),
      }),
    )
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: TRANSCRIPT_BODY_ID,
        containerName: TRANSCRIPT_BODY_NAME,
        content: digestPages[digestPageIndex] ?? '',
      }),
    )
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
    const currentChatId = activeCard?.chatId
    try {
      const res = await sendMessageReply(bridge, cardId, draftIndex)
      if (res.promiseSuggestion) {
        isActionInFlight = false
        await openPromiseConfirmScreen(res.promiseSuggestion)
        return
      }
      if (res.suggestCreateMeeting && res.proposedMeeting) {
        isActionInFlight = false
        await openNewMeetingScreen(res.proposedMeeting, currentChatId)
        return
      }
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
            content: t(`Отправка через ${secondsLeft}с…`, `Sending in ${secondsLeft}s…`),
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
    if (recordingPurpose === 'new-note') {
      if (noteDraftAnalysis) {
        await renderNoteReviewScreen()
      } else {
        await returnFromNotes()
      }
      return
    }
    if (recordingPurpose === 'append-note' && activeNote) {
      await openNoteDetail(activeNote)
      return
    }
    if (recordingPurpose === 'meeting-brief' && activeProposedMeeting) {
      if (preparedBrief) {
        await openMeetingBriefReviewScreen()
      } else {
        await openNewMeetingScreen(activeProposedMeeting, proposedMeetingChatId)
      }
      return
    }
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
    const dur = formatDurationMmSs(elapsedSec)
    if (recordingPurpose === 'new-note' || recordingPurpose === 'append-note' || recordingPurpose === 'meeting-brief') {
      const hint = mode === 'hold'
        ? t('отпусти — стоп', 'release to stop')
        : t('тап — стоп', 'tap to stop')
      return clampUtf8(`● ${dur} · ${t('Говори…', 'Speak…')} ${hint}`, 63)
    }
    const stopHint = mode === 'hold'
      ? t('отпусти — стоп', 'release to stop')
      : t('тап — стоп', 'tap to stop')
    return clampUtf8(`● ${t('ЗАП', 'REC')} ${dur} · ${stopHint}`, 63)
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
                t('Голос не отправлен · тап', 'Voice not sent · tap retry'),
                t('Тап — повтор · 2×тап отмена', 'Tap retry · 2×tap discard'),
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
      clampUtf8(
        t(
          `Голос ${formatDurationMmSs(durationSec)} · отправка ${secLeft}с`,
          `Voice ${formatDurationMmSs(durationSec)} · sending ${secLeft}s`,
        ),
        63,
      )

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
            content: formatVoiceSendingLine(secondsLeft),
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
            content: t('2×тап — отмена', '2×tap cancel'),
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

  async function startVoiceRecording(
    mode: 'hold' | 'menu',
    purpose: 'chat-voice' | 'new-note' | 'append-note' | 'meeting-brief' = 'chat-voice',
  ): Promise<void> {
    if (disposed || isRecordingActive || isActionInFlight) return
    if (purpose === 'chat-voice' && !activeCard) return

    stopSendTimer()
    stopVoiceTimers()
    if (screen !== 'recording') {
      preVoiceScreen = screen
      if (purpose === 'new-note' && screen !== 'note-review') {
        preNotesScreen = screen
      }
    }
    recordingPurpose = purpose
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
          buildVoiceStatusPayload(
            t('Микрофон недоступен', 'Mic unavailable'),
            t('2×тап — назад', '2×tap — back'),
          ),
        ),
      )
      return
    }

    if (mode === 'hold' && holdReleasedEarly) {
      await stopVoiceRecording()
      return
    }

    const bodyHint =
      mode === 'hold'
        ? t('Говори… отпусти, чтобы закончить', 'Speak… release to finish')
        : t('Говори… тап, чтобы закончить', 'Speak… tap to finish')

    await bridge.rebuildPageContainer(
      new RebuildPageContainer(
        buildVoiceStatusPayload(
          formatRecordingHeader(0, mode),
          bodyHint,
          purpose === 'chat-voice',
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
    if (disposed) return

    const encoded = encodeWavPcm16Mono(pcmChunks)
    pcmChunks = []
    const durationSec = encoded.durationSec

    if (durationSec < VOICE_CONFIG.minDurationSec) {
      pendingWav = null
      screen = 'voice-too-short'
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(buildVoiceStatusPayload(t('Слишком коротко', 'Too short'), '')),
      )
      voiceShortDismissTimer = window.setTimeout(() => {
        voiceShortDismissTimer = null
        void returnToActiveCard()
      }, 1000)
      return
    }

    // STT allowed ONLY for notes and meeting brief (Prompts 4 & 6)
    if (recordingPurpose === 'new-note') {
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(
          buildVoiceStatusPayload(t('Расшифровка…', 'Transcribing…'), t('Подождите…', 'Please wait…')),
        ),
      )
      try {
        noteDraftAnalysis = await transcribeNoteVoice(bridge, encoded.wavBytes)
        noteDraftBindMeeting = null
        await renderNoteReviewScreen()
      } catch {
        screen = 'voice-error'
        await bridge.rebuildPageContainer(
          new RebuildPageContainer(
            buildVoiceStatusPayload(
              t('Не удалось расшифровать', 'Transcription failed'),
              t('2×тап — назад', '2×tap — back'),
            ),
          ),
        )
      }
      return
    }

    if (recordingPurpose === 'append-note' && activeNote) {
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(
          buildVoiceStatusPayload(
            t('Расшифровка…', 'Transcribing…'),
            t('Дописываю заметку…', 'Appending note…'),
          ),
        ),
      )
      try {
        const res = await appendNoteVoice(bridge, activeNote.id, encoded.wavBytes)
        await openNoteDetail(res.note)
      } catch {
        await openNoteDetail(activeNote)
      }
      return
    }

    if (recordingPurpose === 'meeting-brief' && activeProposedMeeting) {
      await bridge.rebuildPageContainer(
        new RebuildPageContainer(
          buildVoiceStatusPayload(
            t('Готовлю бриф…', 'Preparing brief…'),
            t('Расшифровка + чат…', 'Transcribing + chat…'),
          ),
        ),
      )
      try {
        preparedBrief = await prepareMeetingBriefVoice(
          bridge,
          encoded.wavBytes,
          proposedMeetingChatId,
          preparedBrief?.userSaid,
        )
        await openMeetingBriefReviewScreen()
      } catch {
        await openNewMeetingScreen(activeProposedMeeting, proposedMeetingChatId)
      }
      return
    }

    if (!activeCard) return

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

  const savedLang = await bridge.getLocalStorage(UI_LANG_KEY)
  const storedToken = await getStoredDeviceToken(bridge)
  if (savedLang === 'en' || savedLang === 'ru') {
    uiLang = savedLang
    if (storedToken) {
      void updateSettings(bridge, { uiLang }).catch(() => {})
    }
  } else {
    uiLang = 'ru'
    if (storedToken) {
      try {
        const s = await fetchSettings(bridge)
        if (s.uiLang === 'en' || s.uiLang === 'ru') {
          uiLang = s.uiLang
        }
      } catch {
        // default to 'ru'
      }
    }
  }

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
      if (screen === 'calendar-create-undo') {
        sendCancelled = true
        stopSendTimer()
        if (preparedBrief) {
          void openMeetingBriefReviewScreen()
        } else if (activeProposedMeeting) {
          void openNewMeetingScreen(activeProposedMeeting, proposedMeetingChatId)
        } else {
          void returnToHome()
        }
        return
      }
      if (screen === 'note-delete-undo') {
        sendCancelled = true
        stopSendTimer()
        if (activeNote) {
          void openNoteDetail(activeNote)
        } else {
          void openNotesList(notesFilterMeetingId)
        }
        return
      }
      if (screen === 'note-bind-meeting' && activeNote) {
        void openNoteDetail(activeNote)
        return
      }
      if (screen === 'note-detail') {
        void openNotesList(notesFilterMeetingId)
        return
      }
      if (screen === 'note-review' || screen === 'notes-list') {
        noteDraftAnalysis = null
        void returnFromNotes()
        return
      }
      if (screen === 'promise-alt-time' && activePromiseSuggestion) {
        void openPromiseConfirmScreen(activePromiseSuggestion)
        return
      }
      if (screen === 'promise-confirm') {
        activePromiseSuggestion = null
        void returnToInbox()
        return
      }
      if (screen === 'new-meeting-slots' || screen === 'meeting-brief-review') {
        if (activeProposedMeeting) {
          void openNewMeetingScreen(activeProposedMeeting, proposedMeetingChatId)
        } else {
          void returnToInbox()
        }
        return
      }
      if (screen === 'new-meeting') {
        activeProposedMeeting = null
        preparedBrief = null
        if (activeCard) {
          void backFromCardFull()
        } else {
          void returnToInbox()
        }
        return
      }
      if (screen === 'digest-post') {
        void openDigestListScreen()
        return
      }
      if (screen === 'digest-list') {
        void returnToHome()
        return
      }
      if (screen === 'reminder-overlay') {
        void dismissReminderOverlay()
        return
      }
      if (screen === 'meeting-card') {
        if (activeMeetingBrief) {
          screen = 'meeting-brief'
          void bridge.rebuildPageContainer(
            new RebuildPageContainer(buildMeetingBriefPayload(activeMeetingBrief)),
          )
        } else {
          void openMeetingsFromHome()
        }
        return
      }
      if (screen === 'meeting-brief') {
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
      if (itemId === MENU_LANGUAGE_ID) {
        uiLang = uiLang === 'ru' ? 'en' : 'ru'
        void bridge.setLocalStorage(UI_LANG_KEY, uiLang)
        void updateSettings(bridge, { uiLang }).catch(() => {})
        if (screen === 'home' || screen === 'home-error') {
          lastHomeSignature = ''
          scheduleHomeRefresh(true)
        } else if (screen === 'meetings') {
          void openMeetingsFromHome()
        } else if (screen === 'meeting-brief' && activeMeetingBrief) {
          void bridge.rebuildPageContainer(
            new RebuildPageContainer(buildMeetingBriefPayload(activeMeetingBrief)),
          )
        } else if (screen === 'meeting-card' && activeMeetingBrief) {
          void bridge.rebuildPageContainer(
            new RebuildPageContainer(buildMeetingCardPayload(activeMeetingBrief)),
          )
        } else if (screen === 'notes-list') {
          void openNotesList(notesFilterMeetingId)
        } else if (screen === 'note-review') {
          void renderNoteReviewScreen()
        } else if (screen === 'note-detail' && activeNote) {
          void openNoteDetail(activeNote)
        } else if (screen === 'digest-list') {
          void openDigestListScreen()
        } else if (screen === 'new-meeting' && activeProposedMeeting) {
          void openNewMeetingScreen(activeProposedMeeting, proposedMeetingChatId)
        } else if (screen === 'inbox' || screen === 'inbox-error') {
          lastInboxSignature = ''
          scheduleInboxRefresh(true)
        } else if (screen === 'card' && activeCard) {
          void backFromCardFull()
        } else if (screen === 'card-full' && activeCard) {
          void openCardFull()
        } else if (screen === 'transcript-pages' && activeCard) {
          void openTranscriptPages()
        } else {
          void returnToHome()
        }
        return
      }
      if (itemId === MENU_NEW_NOTE_ID) {
        void startVoiceRecording('menu', 'new-note')
      } else if (itemId === MENU_MY_NOTES_ID) {
        void openNotesList()
      } else if (itemId === MENU_HOME_ID) {
        void returnToHome()
      } else if (itemId === MENU_REFRESH_ID) {
        if (screen === 'home' || screen === 'home-error') {
          scheduleHomeRefresh(true)
        } else if (screen === 'meetings') {
          void openMeetingsFromHome()
        } else if (screen === 'meeting-card' && activeMeetingBrief) {
          void openMeetingBriefById(activeMeetingBrief.id)
        } else if (screen === 'notes-list') {
          void openNotesList(notesFilterMeetingId)
        } else if (screen === 'digest-list') {
          void openDigestListScreen()
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

    if (screen === 'digest-post') {
      if (
        textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
        sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
        listType === OsEventTypeList.SCROLL_BOTTOM_EVENT
      ) {
        void stepDigestPage(1)
        return
      }
      if (
        textType === OsEventTypeList.SCROLL_TOP_EVENT ||
        sysType === OsEventTypeList.SCROLL_TOP_EVENT ||
        listType === OsEventTypeList.SCROLL_TOP_EVENT
      ) {
        void stepDigestPage(-1)
        return
      }
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
      } else if (screen === 'notes-list') {
        noteSelectedIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'note-review') {
        noteReviewActionIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'note-detail') {
        noteDetailActionIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'note-bind-meeting') {
        bindMeetingIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'promise-confirm' || screen === 'promise-alt-time') {
        promiseActionIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'new-meeting') {
        newMeetingActionIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'new-meeting-slots') {
        newMeetingSlotIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'meeting-brief-review') {
        briefReviewActionIndex = event.listEvent.currentSelectItemIndex
      } else if (screen === 'digest-list') {
        digestSelectedIndex = event.listEvent.currentSelectItemIndex
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
          void openDigestListScreen()
        }
        return
      }

      if (screen === 'digest-list' && digestItems.length > 0) {
        const idx = event.listEvent?.currentSelectItemIndex ?? digestSelectedIndex
        const post = digestItems[idx]
        if (post) {
          void openDigestPostScreen(post.id)
        }
        return
      }

      if (screen === 'notes-list' && notesList.length > 0) {
        const idx = event.listEvent?.currentSelectItemIndex ?? noteSelectedIndex
        const note = notesList[idx]
        if (note) {
          void openNoteDetail(note)
        }
        return
      }

      if (screen === 'note-review' && noteDraftAnalysis) {
        const actions = getNoteReviewActions()
        const idx = event.listEvent?.currentSelectItemIndex ?? noteReviewActionIndex
        const chosen = actions[idx]
        if (chosen?.id === 'bind_matched' && noteDraftAnalysis.matchedMeeting) {
          noteDraftBindMeeting = {
            eventId: noteDraftAnalysis.matchedMeeting.eventId,
            label: noteDraftAnalysis.matchedMeeting.label,
          }
          void renderNoteReviewScreen()
        } else if (chosen?.id === 'rerecord') {
          void startVoiceRecording('menu', 'new-note')
        } else if (chosen?.id === 'discard') {
          noteDraftAnalysis = null
          noteDraftBindMeeting = null
          void returnFromNotes()
        } else if (chosen?.id === 'save_rem' || chosen?.id === 'save_no_rem') {
          const analysis = noteDraftAnalysis
          const bind = noteDraftBindMeeting
          noteDraftAnalysis = null
          noteDraftBindMeeting = null
          void createNote(bridge, {
            text: analysis.transcript,
            meetingEventId: bind?.eventId ?? null,
            meetingTitle: bind?.label ?? null,
            remindAt: chosen.id === 'save_rem' ? (analysis.taskReminder?.remindAt ?? null) : null,
          }).then(() => openNotesList())
        }
        return
      }

      if (screen === 'note-detail' && activeNote) {
        const idx = event.listEvent?.currentSelectItemIndex ?? noteDetailActionIndex
        if (idx === 0) {
          void startVoiceRecording('menu', 'append-note')
        } else if (idx === 1) {
          void openNoteBindMeetingMenu()
        } else if (idx === 2) {
          void startNoteDeleteUndo()
        }
        return
      }

      if (screen === 'note-bind-meeting' && activeNote) {
        const idx = event.listEvent?.currentSelectItemIndex ?? bindMeetingIndex
        const choice = bindMeetingChoices[idx]
        if (choice) {
          void updateNote(bridge, activeNote.id, {
            meetingEventId: choice.eventId,
            meetingTitle: choice.title,
          }).then((res) => openNoteDetail(res.note))
        }
        return
      }

      if (screen === 'promise-confirm' && activePromiseSuggestion) {
        const idx = event.listEvent?.currentSelectItemIndex ?? promiseActionIndex
        if (idx === 0) {
          void savePromiseAt(activePromiseSuggestion.defaultOption.remindAt)
        } else if (idx === 1) {
          void openPromiseAltTimeScreen()
        } else {
          activePromiseSuggestion = null
          void returnToInbox()
        }
        return
      }

      if (screen === 'promise-alt-time' && activePromiseSuggestion) {
        const idx = event.listEvent?.currentSelectItemIndex ?? promiseActionIndex
        const opt = activePromiseSuggestion.altOptions[idx]
        if (opt) {
          void savePromiseAt(opt.remindAt)
        } else {
          void openPromiseConfirmScreen(activePromiseSuggestion)
        }
        return
      }

      if (screen === 'new-meeting' && activeProposedMeeting) {
        const idx = event.listEvent?.currentSelectItemIndex ?? newMeetingActionIndex
        if (idx === 0) {
          void startVoiceRecording('menu', 'meeting-brief')
        } else if (idx === 1) {
          void startCalendarCreateUndo()
        } else if (idx === 2) {
          void openNewMeetingSlotsScreen()
        }
        return
      }

      if (screen === 'new-meeting-slots' && activeProposedMeeting) {
        const idx = event.listEvent?.currentSelectItemIndex ?? newMeetingSlotIndex
        const slot = activeProposedMeeting.altSlots[idx]
        if (slot) {
          activeProposedMeeting = {
            ...activeProposedMeeting,
            startIso: slot.startIso,
            endIso: slot.endIso,
            displayWhen: slot.displayWhen,
            isFree: true,
            conflict: null,
          }
          void openNewMeetingScreen(activeProposedMeeting, proposedMeetingChatId)
        }
        return
      }

      if (screen === 'meeting-brief-review' && preparedBrief) {
        const idx = event.listEvent?.currentSelectItemIndex ?? briefReviewActionIndex
        if (idx === 0) {
          void startCalendarCreateUndo(preparedBrief.combinedDescription)
        } else {
          void startVoiceRecording('menu', 'meeting-brief')
        }
        return
      }

      if (screen === 'reminder-overlay' && activeReminder) {
        const idx = event.listEvent?.currentSelectItemIndex ?? reminderSelectedIndex
        const rem = activeReminder
        if (rem.kind === 'task' && rem.noteId) {
          activeReminder = null
          const act = idx === 0 ? completeTaskNote(bridge, rem.noteId) : snoozeTaskNote(bridge, rem.noteId)
          void act.finally(() => dismissReminderOverlay())
          return
        }
        if (rem.kind === 'promise' && rem.promiseId) {
          activeReminder = null
          if (idx === 0) {
            void completePromiseReminder(bridge, rem.promiseId).finally(() => dismissReminderOverlay())
          } else if (idx === 1 && rem.chatId) {
            void fetchInbox(bridge)
              .then((inb) => {
                const match = inb.items.find((it) => it.chatId === rem.chatId)
                if (match) return openCard(match.id)
                return returnToInbox()
              })
              .catch(() => returnToInbox())
          } else {
            void snoozePromiseReminder(bridge, rem.promiseId).finally(() => dismissReminderOverlay())
          }
          return
        }
        if (idx === 0 && rem.eventId) {
          activeReminder = null
          void openMeetingBriefById(rem.eventId)
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

      if (screen === 'meeting-brief' && activeMeetingBrief) {
        screen = 'meeting-card'
        meetingActionIndex = 0
        void bridge.rebuildPageContainer(
          new RebuildPageContainer(buildMeetingCardPayload(activeMeetingBrief)),
        )
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
        const draftsCount = Math.min(4, activeCard.drafts.length)
        if (cardDraftIndex >= draftsCount) {
          void skipActiveCard()
          return
        }
        void startSendCountdown()
      }
    }
  })
}
