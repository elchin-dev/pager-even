import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { loadEnv } from '../lib/env.js'
import { logger } from '../lib/logger.js'
import { getDb, type AppDb } from './index.js'

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

export function runMigrations(db: AppDb = getDb(), migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): void {
  migrate(db, { migrationsFolder })
  logger.info('db_migrations_applied')
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (isDirectRun) {
  loadEnv()
  runMigrations()
}
