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

const STICKER_EMOJI_LABELS_EN: Record<string, string> = {
  '👍': 'thumbs up',
  '👎': 'thumbs down',
  '❤': 'heart',
  '❤️': 'heart',
  '🧡': 'heart',
  '💛': 'heart',
  '💚': 'heart',
  '💙': 'heart',
  '💜': 'heart',
  '🖤': 'heart',
  '🤍': 'heart',
  '💔': 'broken heart',
  '💕': 'hearts',
  '💖': 'heart',
  '😂': 'laughing',
  '🤣': 'laughing hard',
  '😊': 'smiling',
  '😁': 'smiling',
  '😄': 'happy',
  '😃': 'happy',
  '😅': 'awkward laugh',
  '😉': 'winking',
  '😍': 'in love',
  '🥰': 'adoring',
  '😘': 'kiss',
  '😎': 'cool',
  '🤩': 'amazed',
  '🥳': 'party',
  '😢': 'sad',
  '😭': 'crying',
  '😞': 'disappointed',
  '😔': 'sad',
  '😡': 'angry',
  '🤬': 'furious',
  '😠': 'mad',
  '😱': 'shocked',
  '😳': 'blushing',
  '🤯': 'mind blown',
  '🤔': 'thinking',
  '🤨': 'skeptical',
  '🙄': 'eye roll',
  '😐': 'neutral',
  '😴': 'sleeping',
  '🥱': 'yawning',
  '🤒': 'sick',
  '🤢': 'nauseated',
  '🤡': 'clown',
  '👻': 'ghost',
  '💀': 'skull',
  '🔥': 'fire',
  '💯': '100%',
  '✨': 'sparkles',
  '⚡': 'lightning',
  '🎉': 'party',
  '🎊': 'party',
  '🎁': 'gift',
  '🙏': 'thank you',
  '👏': 'applause',
  '🤝': 'handshake',
  '👋': 'hello',
  '👌': 'ok',
  '✌': 'peace',
  '✌️': 'peace',
  '🤞': 'good luck',
  '💪': 'strong',
  '👀': 'looking',
  '🤷': 'shrug',
  '🤦': 'facepalm',
  '✅': 'done',
  '❌': 'no',
  '❓': 'question',
  '❗': 'important',
  '☕': 'coffee',
  '🍻': 'cheers',
  '🍕': 'pizza',
  '🚗': 'car',
  '✈': 'plane',
  '✈️': 'plane',
  '💸': 'money',
  '💰': 'money',
  '🐱': 'cat',
  '🐶': 'dog',
  '🐻': 'bear',
  '🐸': 'frog',
}

function stripEmojiVariationSelectors(emoji: string): string {
  return emoji.replace(/[\uFE0E\uFE0F\u200D]/g, '').trim()
}

function lookupEmojiLabel(emoji?: string, lang: 'ru' | 'en' = 'ru'): string | null {
  if (!emoji) return null
  const table = lang === 'en' ? STICKER_EMOJI_LABELS_EN : STICKER_EMOJI_LABELS
  const trimmed = emoji.trim()
  if (trimmed in table) {
    return table[trimmed]
  }
  const stripped = stripEmojiVariationSelectors(trimmed)
  if (stripped in table) {
    return table[stripped]
  }
  const firstCodePoint = Array.from(stripped)[0]
  if (firstCodePoint && firstCodePoint in table) {
    return table[firstCodePoint]
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

export function formatStickerText(
  sticker: {
    emoji?: string
    set_name?: string
  },
  lang: 'ru' | 'en' = 'ru',
): string {
  const word = lang === 'en' ? 'Sticker' : 'Стикер'
  const emoji = sticker.emoji?.trim()
  const emojiLabel = lookupEmojiLabel(emoji, lang)
  if (emoji && emojiLabel) {
    return `[${word} ${emoji}: ${emojiLabel}]`
  }
  if (emoji) {
    return `[${word} ${emoji}]`
  }
  const setLabel = cleanSetName(sticker.set_name)
  if (setLabel) {
    return `[${word}: ${setLabel}]`
  }
  return `[${word}]`
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
