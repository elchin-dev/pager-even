export const VOICE_CONFIG = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  minDurationSec: 0.7,
  shortConfirmMaxSec: 2.0,
  autoSendMaxSec: 30.0,
  maxRecordSec: 60,
  undoWindowSec: 3,
} as const

export function formatDurationMmSs(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export function encodeWavPcm16Mono(
  chunks: Uint8Array[],
  sampleRate: number = VOICE_CONFIG.sampleRate,
): { wavBytes: Uint8Array; durationSec: number } {
  let rawTotalBytes = 0
  for (const chunk of chunks) {
    rawTotalBytes += chunk.byteLength
  }

  // Ensure even byte count for 16-bit signed PCM samples
  const dataBytes = rawTotalBytes & ~1
  const wavBytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(wavBytes.buffer)

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      wavBytes[offset + i] = str.charCodeAt(i)
    }
  }

  const channels = VOICE_CONFIG.channels
  const bitsPerSample = VOICE_CONFIG.bitsPerSample
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign

  // 44-byte RIFF/WAVE header
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // AudioFormat = 1 (PCM)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  let remaining = dataBytes
  for (const chunk of chunks) {
    if (remaining <= 0) break
    const copyLen = Math.min(chunk.byteLength, remaining)
    wavBytes.set(chunk.subarray(0, copyLen), offset)
    offset += copyLen
    remaining -= copyLen
  }

  const durationSec = byteRate > 0 ? dataBytes / byteRate : 0
  return { wavBytes, durationSec }
}
