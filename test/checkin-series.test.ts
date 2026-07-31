import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CheckinInput } from '../server/utils/validation'
import { validateCheckin } from '../server/utils/validation'

const directories: string[] = []
let closeCurrentDatabase: (() => void) | undefined

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-series-'))
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

const baseFields = {
  nickname: '旅人小花',
  location: '大安森林公園',
  county: '臺北市',
  latitude: '25.033',
  longitude: '121.535',
  dollName: '小櫻',
  message: '今天一起來散步。',
  visitedAt: '2026-03-15',
  avatarPreset: 'peach'
}

describe('series：從表單驗證到資料庫的完整路徑', () => {
  it('persists a provided series end-to-end and returns it from both listCheckins and findCheckin', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const user = database.upsertDiscordUser({
      discordId: '900000000000000001', username: 'creator', displayName: '創作者', avatarUrl: null
    })
    const input = validateCheckin({ ...baseFields, series: '  夏日重現  ' })
    expect(input.series).toBe('夏日重現') // 前後空白要被修掉

    const created = database.createCheckin(input, null, null, user.id)
    expect(created.series).toBe('夏日重現')
    expect(database.findCheckin(created.id)?.series).toBe('夏日重現')
    expect(database.listCheckins().find(checkin => checkin.id === created.id)?.series).toBe('夏日重現')
  })

  it('normalizes a missing or blank series to null and persists null rather than an empty string', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const user = database.upsertDiscordUser({
      discordId: '900000000000000002', username: 'creator2', displayName: '創作者二號', avatarUrl: null
    })

    expect(validateCheckin({ ...baseFields }).series).toBeNull()
    expect(validateCheckin({ ...baseFields, series: '' }).series).toBeNull()
    expect(validateCheckin({ ...baseFields, series: '   ' }).series).toBeNull()

    const created = database.createCheckin(validateCheckin({ ...baseFields }), null, null, user.id)
    expect(created.series).toBeNull()
    expect(database.findCheckin(created.id)?.series).toBeNull()
  })

  // series 是選填欄位，但「選填」不代表「不檢查」：一旦有內容就要走跟其他自由文字欄位
  // 一樣的衛生規則，因為它同樣會公開渲染在旅箋頁與探索頁的卡片上。
  it('still runs the same content-hygiene checks on series even though the field is optional', () => {
    const zeroWidth = String.fromCodePoint(0x200B)
    expect(() => validateCheckin({ ...baseFields, series: `第一${zeroWidth}集` }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    // 控制字元要放在字串中間：放在頭尾的話會被 trim() 一併修掉，測到的就不是衛生檢查本身了。
    expect(() => validateCheckin({ ...baseFields, series: `第一${String.fromCodePoint(0x000D)}集` }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => validateCheckin({ ...baseFields, series: '追蹤我 www.spam.example' }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => validateCheckin({ ...baseFields, series: 'a'.repeat(61) }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it('keeps the CHECK constraint as a defense-in-depth backstop at the database layer', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const user = database.upsertDiscordUser({
      discordId: '900000000000000003', username: 'creator3', displayName: '創作者三號', avatarUrl: null
    })
    const input = validateCheckin({ ...baseFields })
    // 繞過應用層驗證，直接把過長／空字串的 series 交給資料庫，CHECK 約束仍要擋下來，
    // 不能只靠 validateCheckin 這一層——這正是 users.role 那個 CHECK 約束的同一種防禦思路。
    expect(() => database.createCheckin({ ...input, series: 'a'.repeat(61) }, null, null, user.id))
      .toThrowError(/CHECK constraint failed/)
    expect(() => database.createCheckin({ ...input, series: '' }, null, null, user.id))
      .toThrowError(/CHECK constraint failed/)
  })

  it('tolerates a CheckinInput object literal that omits the optional series key entirely', async () => {
    const database = await loadDatabase(temporaryDatabase())
    const user = database.upsertDiscordUser({
      discordId: '900000000000000004', username: 'creator4', displayName: '創作者四號', avatarUrl: null
    })
    // series 是可選屬性：模擬呼叫端（例如既有測試裡的字面量）完全沒有這個 key，
    // 而不是刻意設成 undefined。createCheckin 兩種情況都要撐得住，這裡測的是「key 不存在」。
    const legacyInput: CheckinInput = {
      nickname: '舊呼叫端',
      location: '舊景點',
      county: '臺北市',
      latitude: 25.033,
      longitude: 121.535,
      dollName: '舊娃',
      message: '沒有帶 series 欄位。',
      visitedAt: '2026-01-01',
      avatarPreset: 'sun'
    }
    const created = database.createCheckin(legacyInput, null, null, user.id)
    expect(created.series).toBeNull()
  })
})

describe('series 欄位的資料庫升級', () => {
  it('adds a nullable series column to a pre-existing database without touching existing rows', async () => {
    const filename = temporaryDatabase()
    const legacy = new Database(filename)
    legacy.exec(`
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
      INSERT INTO checkins (nickname, location, county, latitude, longitude, doll_name, message, visited_at)
      VALUES ('舊旅人', '舊景點', '臺北市', 25.03, 121.56, '舊娃', '這欄位新增前就存在的資料', '2025-01-01');
    `)
    legacy.close()

    const database = await loadDatabase(filename)
    const columns = database.getDatabase().prepare('PRAGMA table_info(checkins)').all() as Array<{ name: string }>
    expect(columns.some(column => column.name === 'series')).toBe(true)

    const records = database.listCheckins()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ location: '舊景點', series: null })

    // 升級後的資料庫要能正常收新旅箋的作品欄位，CHECK 約束也要跟全新建立的資料庫一致。
    const user = database.upsertDiscordUser({
      discordId: '900000000000000005', username: 'creator5', displayName: '創作者五號', avatarUrl: null
    })
    const created = database.createCheckin(
      validateCheckin({ ...baseFields, series: '升級後的新作品' }), null, null, user.id
    )
    expect(created.series).toBe('升級後的新作品')
    expect(() => database.createCheckin({ ...validateCheckin({ ...baseFields }), series: 'b'.repeat(61) }, null, null, user.id))
      .toThrowError(/CHECK constraint failed/)
  })
})
