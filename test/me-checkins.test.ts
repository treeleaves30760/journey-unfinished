import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReadableStream } from 'node:stream/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE } from '../server/utils/auth'
import type { Checkin } from '../server/utils/database'
import type { CheckinInput } from '../server/utils/validation'

const APP_URL = 'https://trip.example.com'
const ADMIN_DISCORD_ID = '100000000000000001'
const OWNER_DISCORD_ID = '200000000000000002'
const STRANGER_DISCORD_ID = '300000000000000003'
// 端點寫死的額度：每個來源位址每小時 20 次
const BATCH_RATE_LIMIT = 20

interface TestEvent {
  method: string
  headers: Record<string, string>
  cookies: Record<string, string>
  socket: string
  stream?: ReadableStream<Uint8Array>
}

interface BatchDeleteResponse {
  deletedCount: number
  deletedIds: number[]
}

// 跑的是「整條 handler」，所以只把 h3 讀請求狀態的入口換成純物件版本；
// createError 與其餘行為都留給真的 h3，狀態碼才不會是測試自己捏出來的。
vi.mock('h3', async importOriginal => ({
  ...await importOriginal<typeof import('h3')>(),
  getRequestHeader: (event: TestEvent, name: string) => event.headers[name.toLowerCase()],
  getRequestIP: (event: TestEvent) => event.socket,
  getCookie: (event: TestEvent, name: string) => event.cookies[name],
  getRequestWebStream: (event: TestEvent) => event.stream,
  deleteCookie: () => {},
  setCookie: () => {}
}))

const checkinInput: CheckinInput = {
  nickname: '旅箋主人',
  location: '測試景點',
  countryCode: 'TW',
  county: '臺北市',
  latitude: 25.033,
  longitude: 121.5654,
  dollName: '測試娃',
  message: '這是一段放在個人管理區裡的旅程。',
  visitedAt: '2026-01-01'
}

interface RequestOptions {
  ids?: unknown
  token?: string
  socket?: string
  headers?: Record<string, string>
  body?: string
}

function listEvent(options: { token?: string, socket?: string } = {}): TestEvent {
  return {
    method: 'GET',
    headers: {},
    cookies: options.token ? { [SESSION_COOKIE]: options.token } : {},
    socket: options.socket ?? '198.51.100.10'
  }
}

function batchDeleteEvent(options: RequestOptions = {}): TestEvent {
  const body = options.body ?? JSON.stringify({ ids: options.ids })
  return {
    method: 'DELETE',
    // content-type 一律附上，這樣「缺 Origin／Referer」的案例缺的就只有來源標頭
    headers: { 'content-type': 'application/json', ...(options.headers ?? { origin: APP_URL }) },
    cookies: options.token ? { [SESSION_COOKIE]: options.token } : {},
    socket: options.socket ?? '198.51.100.10',
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      }
    })
  }
}

const temporaryDirectories: string[] = []
let closeCurrentDatabase: (() => void) | undefined
let sessionCounter = 0

/**
 * 每個測試都拿到全新的模組實例：SQLite 檔、上傳目錄與 request-security 的限流計數桶
 * 都是模組層級狀態，共用的話某個測試打滿額度就會污染下一個。
 */
async function loadContext() {
  closeCurrentDatabase?.()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-me-'))
  temporaryDirectories.push(root)
  const uploadDir = path.join(root, 'uploads')
  fs.mkdirSync(uploadDir, { recursive: true })

  vi.resetModules()
  vi.stubGlobal('useRuntimeConfig', () => ({
    databasePath: path.join(root, 'app.sqlite'),
    uploadDir,
    adminDiscordIds: ADMIN_DISCORD_ID,
    trustedProxyHops: 0,
    sessionDays: 30,
    public: { appUrl: APP_URL }
  }))
  // Nitro 的自動匯入在 vitest 裡不存在，補上等價實作讓路由檔可以被直接載入與呼叫。
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)

  const database = await import('../server/utils/database')
  closeCurrentDatabase = database.closeDatabaseForTests
  const auth = await import('../server/utils/auth')
  const listRoute = await import('../server/api/me/checkins.get')
  const deleteRoute = await import('../server/api/me/checkins.delete')
  const list = listRoute.default as unknown as (event: TestEvent) => { checkins: Checkin[] }
  const remove = deleteRoute.default as unknown as (event: TestEvent) => Promise<BatchDeleteResponse>

  function signIn(discordId: string, displayName: string) {
    const user = database.upsertDiscordUser({ discordId, username: displayName, displayName, avatarUrl: null })
    sessionCounter += 1
    const token = `session-token-${discordId}-${sessionCounter}`
    database.createAuthSession(auth.hashToken(token), user.id, Date.now() + 3_600_000)
    return { id: user.id, token }
  }

  function storedImage(prefix: 'photo' | 'avatar', name: string) {
    const filename = `${prefix}-${name}.jpg`
    fs.writeFileSync(path.join(uploadDir, filename), 'binary-placeholder')
    return `/uploads/${filename}`
  }

  function imageExists(url: string | null) {
    return url !== null && fs.existsSync(path.join(uploadDir, path.basename(url)))
  }

  return { ...deleteRoute, database, list, remove, signIn, storedImage, imageExists }
}

afterEach(() => {
  closeCurrentDatabase?.()
  closeCurrentDatabase = undefined
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('GET /api/me/checkins', () => {
  it('只回自己的旅箋，別人的與無主的都不出現', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const stranger = context.signIn(STRANGER_DISCORD_ID, '路人')
    const mine = context.database.createCheckin(checkinInput, null, null, owner.id)
    context.database.createCheckin(checkinInput, null, null, stranger.id)
    // 早期匿名寫下的旅箋 user_id 是 NULL，它們不屬於任何人
    context.database.getDatabase()
      .prepare('UPDATE checkins SET user_id = NULL WHERE id = ?')
      .run(context.database.createCheckin(checkinInput, null, null, stranger.id).id)

    const response = context.list(listEvent({ token: owner.token }))

    expect(response.checkins.map(checkin => checkin.id)).toEqual([mine.id])
  })

  it('管理員在這支端點上也只看得到自己寫的', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const adminNote = context.database.createCheckin(checkinInput, null, null, admin.id)
    context.database.createCheckin(checkinInput, null, null, owner.id)

    expect(context.list(listEvent({ token: admin.token })).checkins.map(checkin => checkin.id))
      .toEqual([adminNote.id])
  })

  it('沒有登入就是 401', async () => {
    const context = await loadContext()
    expect(() => context.list(listEvent())).toThrow(expect.objectContaining({ statusCode: 401 }))
  })
})

describe('DELETE /api/me/checkins', () => {
  it('一次刪掉勾選的多則，並回報確切數量', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const a = context.database.createCheckin(checkinInput, null, null, owner.id)
    const b = context.database.createCheckin(checkinInput, null, null, owner.id)
    const kept = context.database.createCheckin(checkinInput, null, null, owner.id)

    const response = await context.remove(batchDeleteEvent({ ids: [a.id, b.id], token: owner.token }))

    expect(response).toEqual({ deletedCount: 2, deletedIds: [a.id, b.id] })
    expect(context.database.findCheckin(a.id)).toBeUndefined()
    expect(context.database.findCheckin(b.id)).toBeUndefined()
    expect(context.database.findCheckin(kept.id)).toBeDefined()
  })

  it('連照片與頭像檔案一起刪掉，其他人的檔案不受影響', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const stranger = context.signIn(STRANGER_DISCORD_ID, '路人')
    const photo = context.storedImage('photo', 'mine')
    const avatar = context.storedImage('avatar', 'mine')
    const otherPhoto = context.storedImage('photo', 'other')
    const mine = context.database.createCheckin(checkinInput, photo, avatar, owner.id)
    context.database.createCheckin(checkinInput, otherPhoto, null, stranger.id)

    await context.remove(batchDeleteEvent({ ids: [mine.id], token: owner.token }))

    expect(context.imageExists(photo)).toBe(false)
    expect(context.imageExists(avatar)).toBe(false)
    expect(context.imageExists(otherPhoto)).toBe(true)
  })

  it('清單裡混進別人的旅箋時整批拒絕，一則都不刪', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const stranger = context.signIn(STRANGER_DISCORD_ID, '路人')
    const mine = context.database.createCheckin(checkinInput, null, null, owner.id)
    const theirs = context.database.createCheckin(checkinInput, null, null, stranger.id)

    await expect(context.remove(batchDeleteEvent({ ids: [mine.id, theirs.id], token: owner.token })))
      .rejects.toThrow(expect.objectContaining({ statusCode: 404 }))

    // 交易回滾：自己那則也必須還在，不能出現「刪一半」的狀態
    expect(context.database.findCheckin(mine.id)).toBeDefined()
    expect(context.database.findCheckin(theirs.id)).toBeDefined()
  })

  it('管理員不能靠這支端點刪別人的旅箋', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const theirs = context.database.createCheckin(checkinInput, null, null, owner.id)

    await expect(context.remove(batchDeleteEvent({ ids: [theirs.id], token: admin.token })))
      .rejects.toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(context.database.findCheckin(theirs.id)).toBeDefined()
  })

  it('無主旅箋（user_id 為 NULL）不屬於任何人，誰都刪不掉', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const orphan = context.database.createCheckin(checkinInput, null, null, owner.id)
    context.database.getDatabase().prepare('UPDATE checkins SET user_id = NULL WHERE id = ?').run(orphan.id)

    await expect(context.remove(batchDeleteEvent({ ids: [orphan.id], token: owner.token })))
      .rejects.toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(context.database.findCheckin(orphan.id)).toBeDefined()
  })

  it('沒有登入就是 401', async () => {
    const context = await loadContext()
    await expect(context.remove(batchDeleteEvent({ ids: [1] })))
      .rejects.toThrow(expect.objectContaining({ statusCode: 401 }))
  })

  it('缺少 Origin 與 Referer 一律拒絕（CSRF）', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const mine = context.database.createCheckin(checkinInput, null, null, owner.id)

    await expect(context.remove(batchDeleteEvent({
      ids: [mine.id], token: owner.token, headers: {}
    }))).rejects.toThrow(expect.objectContaining({ statusCode: 403 }))
    expect(context.database.findCheckin(mine.id)).toBeDefined()
  })

  it('外站 Origin 也拒絕', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const mine = context.database.createCheckin(checkinInput, null, null, owner.id)

    await expect(context.remove(batchDeleteEvent({
      ids: [mine.id], token: owner.token, headers: { origin: 'https://evil.example.com' }
    }))).rejects.toThrow(expect.objectContaining({ statusCode: 403 }))
    expect(context.database.findCheckin(mine.id)).toBeDefined()
  })

  it('超過每小時額度之後改回 429', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    for (let attempt = 0; attempt < BATCH_RATE_LIMIT; attempt += 1) {
      const note = context.database.createCheckin(checkinInput, null, null, owner.id)
      await context.remove(batchDeleteEvent({ ids: [note.id], token: owner.token }))
    }
    const extra = context.database.createCheckin(checkinInput, null, null, owner.id)

    await expect(context.remove(batchDeleteEvent({ ids: [extra.id], token: owner.token })))
      .rejects.toThrow(expect.objectContaining({ statusCode: 429 }))
    expect(context.database.findCheckin(extra.id)).toBeDefined()
  })
})

describe('parseOwnBatchIds', () => {
  it('去除重複並保留第一次出現的順序', async () => {
    const context = await loadContext()
    expect(context.parseOwnBatchIds([3, 1, 3, 2, 1])).toEqual([3, 1, 2])
  })

  it('拒絕字串、小數、零、負數與布林——不猜使用者的意思', async () => {
    const context = await loadContext()
    for (const value of [['1'], [1.5], [0], [-1], [true], [null]]) {
      expect(() => context.parseOwnBatchIds(value)).toThrow(expect.objectContaining({ statusCode: 400 }))
    }
  })

  it('拒絕非陣列與空陣列', async () => {
    const context = await loadContext()
    expect(() => context.parseOwnBatchIds(undefined)).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => context.parseOwnBatchIds({ ids: [1] })).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => context.parseOwnBatchIds([])).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it('超過單次上限就拒絕', async () => {
    const context = await loadContext()
    const limit = context.MAX_OWN_BATCH_DELETE_IDS
    const ids = Array.from({ length: limit + 1 }, (_, index) => index + 1)
    expect(() => context.parseOwnBatchIds(ids)).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(context.parseOwnBatchIds(ids.slice(0, limit))).toHaveLength(limit)
  })
})
