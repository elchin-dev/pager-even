import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export type AppDb = BetterSQLite3Database<typeof schema>

let sqliteInstance: Database.Database | null = null
let dbInstance: AppDb | null = null

export function createDb(databasePath: string): { sqlite: Database.Database; db: AppDb } {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true })
  }
  const sqlite = new Database(databasePath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  return { sqlite, db }
}

export function getDb(): AppDb {
  if (!dbInstance) {
    const dbPath = process.env.DATABASE_PATH || './data/pager.db'
    const created = createDb(dbPath)
    sqliteInstance = created.sqlite
    dbInstance = created.db
  }
  return dbInstance
}

export function closeDb(): void {
  if (sqliteInstance) {
    sqliteInstance.close()
    sqliteInstance = null
    dbInstance = null
  }
}
