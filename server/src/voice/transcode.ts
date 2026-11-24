import { spawn } from 'node:child_process'
import { logger } from '../lib/logger.js'

const FFMPEG_TIMEOUT_MS = 15_000

let cachedFfmpegOk: boolean | null = null

export function parseWavDurationSec(wavBuffer: Buffer): number {
  if (wavBuffer.length < 44) {
    throw new Error('wav_too_short')
  }
  const riff = wavBuffer.subarray(0, 4).toString('ascii')
  const wave = wavBuffer.subarray(8, 12).toString('ascii')
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('invalid_wav_header')
  }

  const byteRate = wavBuffer.readUInt32LE(28)
  const dataBytes = Math.max(0, wavBuffer.length - 44)
  if (byteRate === 0) {
    throw new Error('invalid_wav_byterate')
  }
  return Number((dataBytes / byteRate).toFixed(2))
}

export async function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let firstLine = ''

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      cachedFfmpegOk = ok
      logger.info('ffmpeg_health_check', {
        available: ok,
        ...(firstLine ? { version: firstLine.slice(0, 80) } : {}),
      })
      resolve(ok)
    }

    try {
      const child = spawn('ffmpeg', ['-version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(false)
      }, 3000)

      child.stdout.on('data', (chunk: Buffer) => {
        if (!firstLine) {
          firstLine = chunk.toString('utf8').split('\n')[0]?.trim() ?? ''
        }
      })

      child.on('error', () => {
        clearTimeout(timer)
        finish(false)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        finish(code === 0)
      })
    } catch {
      finish(false)
    }
  })
}

export function getCachedFfmpegStatus(): boolean | null {
  return cachedFfmpegOk
}

export type TranscodeWavFn = (
  wavBuffer: Buffer,
) => Promise<{ oggBuffer: Buffer; durationSec: number }>

export const transcodeWavToOpus: TranscodeWavFn = async (wavBuffer: Buffer) => {
  const durationSec = parseWavDurationSec(wavBuffer)

  return new Promise<{ oggBuffer: Buffer; durationSec: number }>((resolve, reject) => {
    let settled = false
    const stdoutChunks: Buffer[] = []

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'wav',
          '-i',
          'pipe:0',
          '-c:a',
          'libopus',
          '-b:a',
          '24k',
          '-ac',
          '1',
          '-ar',
          '48000',
          '-f',
          'ogg',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch (err) {
      fail(err instanceof Error ? err : new Error('ffmpeg_spawn_failed'))
      return
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(new Error('ffmpeg_timeout'))
    }, FFMPEG_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    child.stdin?.on('error', () => {
      // Handled by process close/error if ffmpeg exits early
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      fail(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      if (code !== 0) {
        fail(new Error(`ffmpeg_exit_${code ?? 'signal'}`))
        return
      }
      const oggBuffer = Buffer.concat(stdoutChunks)
      if (oggBuffer.length === 0) {
        fail(new Error('ffmpeg_empty_output'))
        return
      }
      settled = true
      resolve({ oggBuffer, durationSec })
    })

    child.stdin?.end(wavBuffer)
  })
}
