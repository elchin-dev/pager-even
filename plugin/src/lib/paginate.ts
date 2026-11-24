export const DEFAULT_LENS_PAGE_CHARS = 180

/**
 * Splits lens-safe text into pages of roughly `maxChars` characters,
 * breaking on whitespace boundaries whenever possible and hard-splitting
 * oversized tokens so every page stays `<= maxChars` characters.
 */
export function paginateLensText(
  input: string,
  maxChars: number = DEFAULT_LENS_PAGE_CHARS,
): string[] {
  const limit = Math.max(20, Math.floor(maxChars))
  const normalized = input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
    .join('\n')
    .trim()

  if (!normalized) {
    return ['']
  }

  if (normalized.length <= limit) {
    return [normalized]
  }

  const pages: string[] = []
  let remaining = normalized

  while (remaining.length > limit) {
    const windowSlice = remaining.slice(0, limit + 1)
    let breakAt = -1

    const newlineIdx = windowSlice.lastIndexOf('\n')
    const spaceIdx = windowSlice.lastIndexOf(' ')
    const bestBreak = Math.max(newlineIdx, spaceIdx)

    if (bestBreak > 0) {
      breakAt = bestBreak
    }

    if (breakAt <= 0) {
      pages.push(remaining.slice(0, limit))
      remaining = remaining.slice(limit).trimStart()
    } else {
      pages.push(remaining.slice(0, breakAt).trimEnd())
      remaining = remaining.slice(breakAt + 1).trimStart()
    }
  }

  if (remaining.length > 0) {
    pages.push(remaining)
  }

  return pages.length > 0 ? pages : ['']
}
