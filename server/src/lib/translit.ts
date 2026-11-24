const CYRILLIC_MAP: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ў: "o'",
  қ: 'q',
  ғ: "g'",
  ҳ: 'h',
  А: 'A',
  Б: 'B',
  В: 'V',
  Г: 'G',
  Д: 'D',
  Е: 'E',
  Ё: 'Yo',
  Ж: 'Zh',
  З: 'Z',
  И: 'I',
  Й: 'Y',
  К: 'K',
  Л: 'L',
  М: 'M',
  Н: 'N',
  О: 'O',
  П: 'P',
  Р: 'R',
  С: 'S',
  Т: 'T',
  У: 'U',
  Ф: 'F',
  Х: 'Kh',
  Ц: 'Ts',
  Ч: 'Ch',
  Ш: 'Sh',
  Щ: 'Shch',
  Ъ: '',
  Ы: 'Y',
  Ь: '',
  Э: 'E',
  Ю: 'Yu',
  Я: 'Ya',
  Ў: "O'",
  Қ: 'Q',
  Ғ: "G'",
  Ҳ: 'H',
}

const TYPOGRAPHIC_MAP: Record<string, string> = {
  '\u02BB': "'",
  '\u02BC': "'",
  '\u2018': "'",
  '\u2019': "'",
  '\u02B9': "'",
  '\u2032': "'",
  '\u2014': '-',
  '\u2013': '-',
  '\u2212': '-',
  '\u00AB': '"',
  '\u00BB': '"',
  '\u201C': '"',
  '\u201D': '"',
  '\u00A0': ' ',
}

function isSupportedLensChar(code: number): boolean {
  if (code >= 0x20 && code <= 0x7e) return true
  if (code >= 0x00a1 && code <= 0x00ff) return true
  if (code === 0x2026) return true
  if (code >= 0x2190 && code <= 0x21ff) return true
  if (code >= 0x2500 && code <= 0x259f) return true
  return false
}

export function translit(input: string): string {
  let out = ''
  for (const ch of input) {
    if (ch in CYRILLIC_MAP) {
      out += CYRILLIC_MAP[ch]
      continue
    }
    if (ch in TYPOGRAPHIC_MAP) {
      out += TYPOGRAPHIC_MAP[ch]
      continue
    }
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

export function stripUnsupportedLensChars(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0)
    if (code !== undefined && isSupportedLensChar(code)) {
      out += ch
    }
  }
  return out
}

export function toLens(input: string, maxLen: number): string {
  if (maxLen <= 0) return ''

  const normalized = stripUnsupportedLensChars(translit(input))
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized.length <= maxLen) {
    return normalized
  }

  if (maxLen === 1) {
    return '…'
  }

  const sliced = normalized.slice(0, maxLen - 1).trimEnd()
  return `${sliced}…`
}
