const STICKER_EMOJI_LABELS: Record<string, string> = {
  '👍': 'палец вверх',
  '👎': 'палец вниз',
  '❤': 'сердце',
  '❤️': 'сердце',
  '🧡': 'сердце',
  '💛': 'сердце',
  '💚': 'сердце',
  '💙': 'сердце',
  '💜': 'сердце',
  '🖤': 'сердце',
  '🤍': 'сердце',
  '💔': 'разбитое сердце',
  '💕': 'сердечки',
  '💖': 'сердце',
  '😂': 'смех',
  '🤣': 'смеется до слез',
  '😊': 'улыбка',
  '😁': 'улыбка',
  '😄': 'радость',
  '😃': 'радость',
  '😅': 'неловкий смех',
  '😉': 'подмигивает',
  '😍': 'влюблен',
  '🥰': 'умиление',
  '😘': 'поцелуй',
  '😎': 'круто',
  '🤩': 'восторг',
  '🥳': 'праздник',
  '😢': 'грусть',
  '😭': 'плачет',
  '😞': 'расстроен',
  '😔': 'грустно',
  '😡': 'злится',
  '🤬': 'в ярости',
  '😠': 'сердится',
  '😱': 'шок',
  '😳': 'смущение',
  '🤯': 'взрыв мозга',
  '🤔': 'думает',
  '🤨': 'сомнение',
  '🙄': 'закатил глаза',
  '😐': 'без эмоций',
  '😴': 'спит',
  '🥱': 'зевает',
  '🤒': 'болеет',
  '🤢': 'тошнит',
  '🤡': 'клоун',
  '👻': 'призрак',
  '💀': 'череп',
  '🔥': 'огонь',
  '💯': '100%',
  '✨': 'искры',
  '⚡': 'молния',
  '🎉': 'праздник',
  '🎊': 'праздник',
  '🎁': 'подарок',
  '🙏': 'спасибо',
  '👏': 'аплодисменты',
  '🤝': 'рукопожатие',
  '👋': 'привет',
  '👌': 'ок',
  '✌': 'мир',
  '✌️': 'мир',
  '🤞': 'удачи',
  '💪': 'сила',
  '👀': 'смотрит',
  '🤷': 'не знаю',
  '🤦': 'фейспалм',
  '✅': 'готово',
  '❌': 'нет',
  '❓': 'вопрос',
  '❗': 'важно',
  '☕': 'кофе',
  '🍻': 'чокаемся',
  '🍕': 'пицца',
  '🚗': 'машина',
  '✈': 'самолет',
  '✈️': 'самолет',
  '💸': 'деньги',
  '💰': 'деньги',
  '🐱': 'кот',
  '🐶': 'собака',
  '🐻': 'медведь',
  '🐸': 'лягушка',
}

function stripEmojiVariationSelectors(emoji: string): string {
  return emoji.replace(/[\uFE0E\uFE0F\u200D]/g, '').trim()
}

function lookupEmojiLabel(emoji?: string): string | null {
  if (!emoji) return null
  const trimmed = emoji.trim()
  if (trimmed in STICKER_EMOJI_LABELS) {
    return STICKER_EMOJI_LABELS[trimmed]
  }
  const stripped = stripEmojiVariationSelectors(trimmed)
  if (stripped in STICKER_EMOJI_LABELS) {
    return STICKER_EMOJI_LABELS[stripped]
  }
  const firstCodePoint = Array.from(stripped)[0]
  if (firstCodePoint && firstCodePoint in STICKER_EMOJI_LABELS) {
    return STICKER_EMOJI_LABELS[firstCodePoint]
  }
  return null
}

function cleanSetName(setName?: string): string | null {
  if (!setName) return null
  const cleaned = setName
    .replace(/_by_[a-z0-9_]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 24) : null
}

export function formatStickerText(sticker: {
  emoji?: string
  set_name?: string
}): string {
  const emoji = sticker.emoji?.trim()
  const emojiLabel = lookupEmojiLabel(emoji)
  if (emoji && emojiLabel) {
    return `[Стикер ${emoji}: ${emojiLabel}]`
  }
  if (emoji) {
    return `[Стикер ${emoji}]`
  }
  const setLabel = cleanSetName(sticker.set_name)
  if (setLabel) {
    return `[Стикер: ${setLabel}]`
  }
  return '[Стикер]'
}

const GENERIC_GIF_NAMES = new Set([
  'animation',
  'giphy',
  'tenor',
  'video',
  'document',
  'gif',
  'img',
  'file',
  'mp4',
])

function cleanGifFileName(fileName?: string): string | null {
  if (!fileName) return null
  const base = fileName.replace(/\.[a-z0-9]{1,5}$/i, '').trim()
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned || cleaned.length < 2) return null
  if (GENERIC_GIF_NAMES.has(cleaned.toLowerCase())) return null
  if (/^[0-9a-f\s-]+$/i.test(cleaned)) return null
  return cleaned.slice(0, 24)
}

export function formatGifText(
  animation: { file_name?: string },
  caption?: string,
): string {
  const cleanCaption = caption?.trim()
  if (cleanCaption) {
    return `[GIF] ${cleanCaption}`
  }
  const fileLabel = cleanGifFileName(animation.file_name)
  if (fileLabel) {
    return `[GIF: ${fileLabel}]`
  }
  return '[GIF]'
}
