import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CheckinInput } from '../server/utils/validation'

const directories: string[] = []
let closeCurrentDatabase: (() => void) | undefined

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-database-'))
  directories.push(directory)
  return path.join(directory, 'app.sqlite')
}

async function loadDatabase(filename: string) {
  closeCurrentDatabase?.()
  vi.resetModules()
  vi.stubGlobal('useRuntimeConfig', () => ({ databasePath: filename }))
  const module = await import('../server/utils/database')
  closeCurrentDatabase = module.closeDatabaseForTests
  return module
}

afterEach(() => {
  closeCurrentDatabase?.()
  closeCurrentDatabase = undefined
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const input: CheckinInput = {
  nickname: '測試旅人',
  location: '測試景點',
  county: '臺北市',
  latitude: 25.033,
  longitude: 121.5654,
  dollName: '測試娃',
  message: '這是一段測試旅程。',
  visitedAt: '2026-01-01',
  avatarPreset: 'sun'
}

describe('SQLite schema and migrations', () => {
  it('creates the complete schema, relationships and demo data once', async () => {
    const filename = temporaryDatabase()
    const database = await loadDatabase(filename)
    const db = database.getDatabase()
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual(expect.arrayContaining(['app_meta', 'users', 'checkins', 'comments', 'auth_sessions']))
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(row => row.name)
    expect(indexes).toEqual(expect.arrayContaining(['idx_comments_checkin', 'idx_checkins_user', 'idx_auth_sessions_expiry']))

    const checkinForeignKey = db.prepare('PRAGMA foreign_key_list(checkins)').all() as Array<{ from: string, on_delete: string }>
    const commentForeignKey = db.prepare('PRAGMA foreign_key_list(comments)').all() as Array<{ from: string, on_delete: string }>
    expect(checkinForeignKey).toContainEqual(expect.objectContaining({ from: 'user_id', on_delete: 'SET NULL' }))
    expect(commentForeignKey).toContainEqual(expect.objectContaining({ from: 'checkin_id', on_delete: 'CASCADE' }))
    expect(database.listCheckins()).toHaveLength(6)
    const firstId = Math.min(...database.listCheckins().map(checkin => checkin.id))
    expect(database.listComments(firstId)).toHaveLength(1)
    expect(database.listCheckins().every(checkin => checkin.userId === null)).toBe(true)

    db.prepare('DELETE FROM checkins').run()
    database.closeDatabaseForTests()
    expect(database.listCheckins()).toHaveLength(0)
    expect(database.getDatabase().prepare("SELECT value FROM app_meta WHERE key = 'demo_seeded'").get()).toBeTruthy()
  })

  it('migrates the legacy schema without replacing existing rows', async () => {
    const filename = temporaryDatabase()
    const legacy = new Database(filename)
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT NOT NULL,
        location TEXT NOT NULL,
        county TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        doll_name TEXT NOT NULL,
        message TEXT NOT NULL,
        visited_at TEXT NOT NULL,
        photo TEXT,
        avatar TEXT,
        avatar_preset TEXT NOT NULL DEFAULT 'sun',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO checkins (nickname, location, county, latitude, longitude, doll_name, message, visited_at)
      VALUES ('舊旅人', '舊景點', '臺北市', 25.03, 121.56, '舊娃', '保留這筆資料', '2025-01-01');
    `)
    legacy.close()

    const database = await loadDatabase(filename)
    const records = database.listCheckins()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ nickname: '舊旅人', location: '舊景點', userId: null })
    const columns = database.getDatabase().prepare('PRAGMA table_info(checkins)').all() as Array<{ name: string }>
    expect(columns.some(column => column.name === 'user_id')).toBe(true)
    expect(database.getDatabase().prepare("SELECT value FROM app_meta WHERE key = 'demo_seeded'").get()).toEqual({ value: 'legacy' })

    database.closeDatabaseForTests()
    expect(database.listCheckins()).toHaveLength(1)
  })

  it('continues using the legacy database filename when the renamed default is absent', async () => {
    const requestedFilename = temporaryDatabase().replace('app.sqlite', 'journey-unfinished.sqlite')
    const legacyFilename = path.join(path.dirname(requestedFilename), 'wa-trip.sqlite')
    new Database(legacyFilename).close()

    const database = await loadDatabase(requestedFilename)
    expect(database.listCheckins()).toHaveLength(6)
    expect(fs.existsSync(requestedFilename)).toBe(false)
  })
})

describe('users, ownership and sessions', () => {
  it('stores creator ownership and enforces delete cascades', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const user = database.upsertDiscordUser({
      discordId: '123456789012345678', username: 'owner', displayName: '足跡主人', avatarUrl: null, role: 'user'
    })
    const checkin = database.createCheckin(input, '/uploads/photo-test.jpg', null, user.id)
    expect(checkin.userId).toBe(user.id)
    database.createComment(checkin.id, '留言者', '會一起被刪除')
    expect(database.listComments(checkin.id)).toHaveLength(1)
    expect(database.deleteCheckin(checkin.id)).toBe(true)
    expect(database.findCheckin(checkin.id)).toBeUndefined()
    expect(database.listComments(checkin.id)).toHaveLength(0)
  })

  it('sets ownership to null and removes sessions when a user is deleted', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const user = database.upsertDiscordUser({
      discordId: '223456789012345678', username: 'member', displayName: '會員', avatarUrl: null, role: 'admin'
    })
    const checkin = database.createCheckin(input, null, null, user.id)
    database.createAuthSession('active-hash', user.id, Date.now() + 60_000)
    expect(database.findUserBySession('active-hash')).toMatchObject({ id: user.id, role: 'admin' })
    database.getDatabase().prepare('DELETE FROM users WHERE id = ?').run(user.id)
    expect(database.findCheckin(checkin.id)?.userId).toBeNull()
    expect(database.findUserBySession('active-hash')).toBeUndefined()
  })

  it('treats the expiry boundary as invalid and cleans stale sessions on creation', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const user = database.upsertDiscordUser({
      discordId: '323456789012345678', username: 'session-user', displayName: 'Session 會員', avatarUrl: null, role: 'user'
    })
    const now = Date.now()
    database.createAuthSession('expired-hash', user.id, now)
    expect(database.findUserBySession('expired-hash', now)).toBeUndefined()
    database.createAuthSession('future-hash', user.id, now + 60_000)
    expect(database.getDatabase().prepare("SELECT 1 FROM auth_sessions WHERE token_hash = 'expired-hash'").get()).toBeUndefined()
    expect(database.findUserBySession('future-hash', now)).toMatchObject({ id: user.id })
    database.deleteAuthSession('future-hash')
    expect(database.findUserBySession('future-hash', now)).toBeUndefined()
  })
})
