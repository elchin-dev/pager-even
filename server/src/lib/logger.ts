type LogMeta = Record<string, string | number | boolean | null | undefined>

function write(level: 'info' | 'warn' | 'error', event: string, meta?: LogMeta): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(meta ?? {}),
  }
  const line = JSON.stringify(payload)
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

export const logger = {
  info: (event: string, meta?: LogMeta) => write('info', event, meta),
  warn: (event: string, meta?: LogMeta) => write('warn', event, meta),
  error: (event: string, meta?: LogMeta) => write('error', event, meta),
}
