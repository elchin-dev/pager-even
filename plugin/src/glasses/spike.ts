import {
  CreateStartUpPageContainer,
  EventSourceType,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

const CHARS_CONTAINER_ID = 1
const CHARS_CONTAINER_NAME = 'spike-chars'

const LOG_CONTAINER_ID = 2
const LOG_CONTAINER_NAME = 'spike-log'

const LIST_CONTAINER_ID = 3
const LIST_CONTAINER_NAME = 'spike-list'

const TEST_LINES = [
  'Latin: Hello, Aziz! 17:00',
  'Cyrillic: Привет, Азиз!',
  'Uzbek latin: Oʻzbekiston, gʻ, sh',
  'Symbols: > • ● ○ ▲ ▼ ━ ─ ✓ !',
].join('\n')

const LIST_ITEMS = ['1. Reply Aziz', '2. Call Mom', '3. Meet Dilnoza']

function formatOsEventType(eventType?: OsEventTypeList): string {
  if (eventType === undefined) {
    return 'undefined(CLICK=0)'
  }
  const label = OsEventTypeList[eventType] ?? 'UNKNOWN'
  return `${label}(${eventType})`
}

function formatEventSource(source?: EventSourceType): string {
  if (source === undefined) return 'n/a'
  return EventSourceType[source] ?? String(source)
}

function detectEventKind(event: EvenHubEvent): string {
  const kinds: string[] = []
  if (event.listEvent) kinds.push('listEvent')
  if (event.textEvent) kinds.push('textEvent')
  if (event.sysEvent) kinds.push('sysEvent')
  if (event.menuItemClickEvent) kinds.push('menuItemClickEvent')
  if (event.audioEvent) kinds.push('audioEvent')
  return kinds.length > 0 ? kinds.join('+') : 'unknown'
}

function formatLogLine(seq: number, event: EvenHubEvent): string {
  const kind = detectEventKind(event)
  const parts: string[] = [`#${seq} ${kind}`]

  if (event.listEvent) {
    const et = formatOsEventType(event.listEvent.eventType)
    const idx = event.listEvent.currentSelectItemIndex ?? 'n/a'
    const name = event.listEvent.currentSelectItemName ?? ''
    parts.push(`et=${et} idx=${idx} "${name}"`)
  }

  if (event.textEvent) {
    const et = formatOsEventType(event.textEvent.eventType)
    parts.push(`text.et=${et} cid=${event.textEvent.containerID ?? 'n/a'}`)
  }

  if (event.sysEvent) {
    const et = formatOsEventType(event.sysEvent.eventType)
    const src = formatEventSource(event.sysEvent.eventSource)
    const exitCode = event.sysEvent.systemExitReasonCode
    parts.push(
      `sys.et=${et} src=${src}${exitCode !== undefined ? ` exit=${exitCode}` : ''}`,
    )
  }

  if (event.menuItemClickEvent) {
    parts.push(`menu.itemID=${event.menuItemClickEvent.itemID ?? 'n/a'}`)
  }

  if (event.audioEvent) {
    parts.push(`audio.bytes=${event.audioEvent.audioPcm.length}`)
  }

  return parts.join(' | ')
}

export async function runSpikeScreen(): Promise<void> {
  const bridge = await waitForEvenAppBridge()

  const charsContainer = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 116,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: CHARS_CONTAINER_ID,
    containerName: CHARS_CONTAINER_NAME,
    content: TEST_LINES,
    isEventCapture: 0,
  })

  const logContainer = new TextContainerProperty({
    xPosition: 0,
    yPosition: 118,
    width: 576,
    height: 68,
    borderWidth: 1,
    borderColor: 3,
    paddingLength: 4,
    containerID: LOG_CONTAINER_ID,
    containerName: LOG_CONTAINER_NAME,
    content: 'Log: waiting for events...',
    isEventCapture: 0,
  })

  const listContainer = new ListContainerProperty({
    xPosition: 0,
    yPosition: 188,
    width: 576,
    height: 100,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: LIST_CONTAINER_ID,
    containerName: LIST_CONTAINER_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: LIST_ITEMS.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: LIST_ITEMS,
    }),
  })

  const menuObject = new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemName: 'Voice reply', itemID: 1 }),
      new MenuItemProperty({ itemName: 'Skip', itemID: 2 }),
      new MenuItemProperty({ itemName: 'Refresh', itemID: 3 }),
    ],
  })

  const createResult = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 3,
      textObject: [charsContainer, logContainer],
      listObject: [listContainer],
      menuObject,
    }),
  )

  console.log(
    '[spike] createStartUpPageContainer:',
    StartUpPageCreateResult[createResult] ?? createResult,
  )

  let seq = 0
  const recentLogs: string[] = []

  const unsubscribe = bridge.onEvenHubEvent((event) => {
    seq += 1
    const line = formatLogLine(seq, event)

    console.log('[spike] evenHubEvent:', {
      seq,
      type: detectEventKind(event),
      listEvent: event.listEvent
        ? {
            eventType: event.listEvent.eventType,
            eventTypeLabel: formatOsEventType(event.listEvent.eventType),
            currentSelectItemIndex: event.listEvent.currentSelectItemIndex,
            currentSelectItemName: event.listEvent.currentSelectItemName,
            containerID: event.listEvent.containerID,
          }
        : undefined,
      textEvent: event.textEvent
        ? {
            eventType: event.textEvent.eventType,
            eventTypeLabel: formatOsEventType(event.textEvent.eventType),
            containerID: event.textEvent.containerID,
          }
        : undefined,
      sysEvent: event.sysEvent
        ? {
            eventType: event.sysEvent.eventType,
            eventTypeLabel: formatOsEventType(event.sysEvent.eventType),
            eventSource: event.sysEvent.eventSource,
            systemExitReasonCode: event.sysEvent.systemExitReasonCode,
          }
        : undefined,
      menuItemClickEvent: event.menuItemClickEvent
        ? {
            itemID: event.menuItemClickEvent.itemID,
          }
        : undefined,
      raw: event.jsonData,
    })

    recentLogs.unshift(line)
    if (recentLogs.length > 2) {
      recentLogs.length = 2
    }

    void bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: LOG_CONTAINER_ID,
        containerName: LOG_CONTAINER_NAME,
        content: recentLogs.join('\n'),
      }),
    )

    const sysType = event.sysEvent?.eventType
    if (
      sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
      sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
    ) {
      unsubscribe()
    }
  })
}
