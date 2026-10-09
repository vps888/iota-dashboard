import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

interface StoredValue {
  value: string
  expires_at: number | null
}

export class SqliteKV {
  private readonly database: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
    this.database = new Database(path)
    chmodSync(path, 0o600)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = NORMAL')
    this.database.pragma('busy_timeout = 5000')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS kv_expires_at ON kv(expires_at);
    `)
  }

  async get(key: string, type?: 'text' | 'json'): Promise<unknown> {
    const row = this.database.prepare('SELECT value, expires_at FROM kv WHERE key = ?').get(key) as StoredValue | undefined
    if (!row) return null
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.database.prepare('DELETE FROM kv WHERE key = ?').run(key)
      return null
    }
    return type === 'json' ? JSON.parse(row.value) as unknown : row.value
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const ttl = options?.expirationTtl
    const expiresAt = ttl === undefined ? null : Date.now() + Math.max(0, Math.floor(ttl)) * 1000
    this.database.prepare(`
      INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
    `).run(key, value, expiresAt)
  }

  async delete(key: string): Promise<void> {
    this.database.prepare('DELETE FROM kv WHERE key = ?').run(key)
  }

  purgeExpired(now = Date.now()): number {
    return this.database.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now).changes
  }

  close(): void {
    this.database.close()
  }
}
