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
  series: '測試作品',
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
    const checkinColumnNames = (db.prepare('PRAGMA table_info(checkins)').all() as Array<{ name: string }>).map(column => column.name)
    expect(checkinColumnNames).toEqual(expect.arrayContaining(['user_id', 'series']))
    expect(database.listCheckins()).toHaveLength(6)
    const firstId = Math.min(...database.listCheckins().map(checkin => checkin.id))
    expect(database.listComments(firstId)).toHaveLength(1)
    expect(database.listCheckins().every(checkin => checkin.userId === null)).toBe(true)
    // 種子資料是站方聲明的原創創作（見首頁頁尾「本站示意內容與頭像皆為原創」），
    // 全部都不該帶作品出處——這也順便釘住「留空要存 null」不會被悄悄改回空字串。
    expect(database.listCheckins().every(checkin => checkin.series === null)).toBe(true)

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
    // series 是這次遷移新加的欄位，舊資料列理所當然沒填過，必須補成 null 而不是空字串或 undefined。
    expect(records[0]).toMatchObject({ nickname: '舊旅人', location: '舊景點', userId: null, series: null })
    const columns = database.getDatabase().prepare('PRAGMA table_info(checkins)').all() as Array<{ name: string }>
    expect(columns.some(column => column.name === 'user_id')).toBe(true)
    expect(columns.some(column => column.name === 'series')).toBe(true)
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
      discordId: '123456789012345678', username: 'owner', displayName: '足跡主人', avatarUrl: null
    })
    const checkin = database.createCheckin(input, '/uploads/photo-test.jpg', null, user.id)
    expect(checkin.userId).toBe(user.id)
    expect(checkin.series).toBe('測試作品')
    database.createComment(checkin.id, '留言者', '會一起被刪除')
    expect(database.listComments(checkin.id)).toHaveLength(1)
    expect(database.deleteCheckin(checkin.id)).toBe(true)
    expect(database.findCheckin(checkin.id)).toBeUndefined()
    expect(database.listComments(checkin.id)).toHaveLength(0)
  })

  it('sets ownership to null and removes sessions when a user is deleted', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const user = database.upsertDiscordUser({
      discordId: '223456789012345678', username: 'member', displayName: '會員', avatarUrl: null
    })
    const checkin = database.createCheckin(input, null, null, user.id)
    database.createAuthSession('active-hash', user.id, Date.now() + 60_000)
    // role 必須被投影出來：publicUser 靠它算出合併後的角色，漏掉這個欄位授權管理員就會失效
    expect(database.findUserBySession('active-hash')).toMatchObject({ id: user.id, role: 'user' })
    database.getDatabase().prepare('DELETE FROM users WHERE id = ?').run(user.id)
    expect(database.findCheckin(checkin.id)?.userId).toBeNull()
    expect(database.findUserBySession('active-hash')).toBeUndefined()
  })

  it('never writes role on login, so grants survive and config admins never persist', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const created = database.upsertDiscordUser({
      discordId: '423456789012345678', username: 'granted', displayName: '受權管理員', avatarUrl: null
    })
    // 登入一律以一般會員建立資料列。setUserRole（也就是管理頁）是 users.role 的唯一寫入點。
    expect(created.role).toBe('user')
    expect(database.setUserRole(created.id, 'admin')).toMatchObject({ id: created.id, role: 'admin' })

    // 再登入一次。若 ON CONFLICT 分支動到 role，網頁上授權的管理員一登出再登入就會被打回一般會員。
    const returning = database.upsertDiscordUser({
      discordId: '423456789012345678', username: 'renamed', displayName: '改名後', avatarUrl: 'https://cdn.example/a.png'
    })
    expect(returning).toMatchObject({ id: created.id, role: 'admin' })
    // 其餘個人資料仍然要跟著 Discord 更新，不能為了保住 role 就整排不動
    expect(returning).toMatchObject({ username: 'renamed', displayName: '改名後', avatarUrl: 'https://cdn.example/a.png' })
    expect(database.listUsers().find(user => user.id === created.id)).toMatchObject({ role: 'admin' })

    // 設定管理員（NUXT_ADMIN_DISCORD_IDS）的身分絕不能落地。一旦第一次登入把 'admin' 固化進
    // 資料列，之後把他從環境變數移除就撤銷不掉 —— 文件寫的撤銷方式會靜默失效。
    const configAdmin = database.upsertDiscordUser({
      discordId: '523456789012345678', username: 'config-admin', displayName: '站長', avatarUrl: null
    })
    expect(configAdmin.role).toBe('user')
    expect(database.upsertDiscordUser({
      discordId: '523456789012345678', username: 'config-admin', displayName: '站長', avatarUrl: null
    })).toMatchObject({ role: 'user' })
  })

  it('looks users up by id and refuses a role outside the schema allowlist', async () => {
    const database = await loadDatabase(temporaryDatabase())
    expect(database.findUserById(999_999)).toBeUndefined()
    expect(database.setUserRole(999_999, 'admin')).toBeUndefined()

    const user = database.upsertDiscordUser({
      discordId: '623456789012345678', username: 'member', displayName: '會員', avatarUrl: null
    })
    expect(database.findUserById(user.id)).toMatchObject({ id: user.id, discordId: '623456789012345678', role: 'user' })
    // users.role 的 CHECK 約束是最後一道防線：呼叫端漏掉驗證也寫不進第三種值
    expect(() => database.setUserRole(user.id, 'owner' as 'user')).toThrowError()
    expect(database.findUserById(user.id)?.role).toBe('user')
  })

  it('treats the expiry boundary as invalid and cleans stale sessions on creation', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const user = database.upsertDiscordUser({
      discordId: '323456789012345678', username: 'session-user', displayName: 'Session 會員', avatarUrl: null
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
