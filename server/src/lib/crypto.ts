import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export function generateDeviceToken(): string {
  return randomBytes(32).toString('base64url')
}

export function generateLinkToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function resolveEncryptionKey(explicitKey?: string): Buffer {
  const raw = (explicitKey ?? process.env.ENCRYPTION_KEY ?? '').trim()
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not configured')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be base64-encoded 32 bytes')
  }
  return key
}

export function encryptSecret(plaintext: string, explicitKey?: string): string {
  const key = resolveEncryptionKey(explicitKey)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`
}

export function decryptSecret(payload: string, explicitKey?: string): string {
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted secret format')
  }
  const key = resolveEncryptionKey(explicitKey)
  const iv = Buffer.from(parts[1], 'base64url')
  const tag = Buffer.from(parts[2], 'base64url')
  const ciphertext = Buffer.from(parts[3], 'base64url')

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}
