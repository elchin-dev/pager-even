import { existsSync } from 'node:fs'

let loaded = false

export function loadEnv(): void {
  if (loaded) return
  loaded = true
  if (existsSync('.env')) {
    const loadEnvFile = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile
    loadEnvFile?.('.env')
  }
}
