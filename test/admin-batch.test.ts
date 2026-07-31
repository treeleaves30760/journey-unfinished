import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReadableStream } from 'node:stream/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE } from '../server/utils/auth'
import type { CheckinInput } from '../server/utils/validation'

const APP_URL = 'https://trip.example.com'
const ADMIN_DISCORD_ID = '100000000000000001'
const MEMBER_DISCORD_ID = '200000000000000002'
// 端點寫死的額度：每個來源位址每小時 10 次（見 batch.delete.ts 內的取捨說明）
const BATCH_RATE_LIMIT = 10

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
  notFoundIds: number[]
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
  county: '臺北市',
  latitude: 25.033,
  longitude: 121.5654,
  dollName: '測試娃',
  message: '這是一段等待被批量刪除的旅程。',
  visitedAt: '2026-01-01',
  avatarPreset: 'sun'
}

interface RequestOptions {
  ids?: unknown
  token?: string
  socket?: string
  headers?: Record<string, string>
  body?: string
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-admin-batch-'))
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
  const route = await import('../server/api/admin/checkins/batch.delete')
  const handler = route.default as unknown as (event: TestEvent) => Promise<BatchDeleteResponse>

  function signIn(discordId: string, displayName: string) {
    const user = database.upsertDiscordUser({
      discordId,
      username: displayName,
      displayName,
      avatarUrl: null
    })
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

  return { ...route, database, handler, signIn, storedImage, imageExists, uploadDir }
}

afterEach(() => {
  closeCurrentDatabase?.()
  closeCurrentDatabase = undefined
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('DELETE /api/admin/checkins/batch', () => {
  it('deletes every requested note in one call and reports the exact count', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const a = context.database.createCheckin(checkinInput, null, null, admin.id)
    const b = context.database.createCheckin(checkinInput, null, null, admin.id)
    const c = context.database.createCheckin(checkinInput, null, null, admin.id)
    const untouched = context.database.createCheckin(checkinInput, null, null, admin.id)

    const response = await context.handler(batchDeleteEvent({ ids: [a.id, b.id, c.id], token: admin.token }))

    expect(response).toEqual({ deletedCount: 3, deletedIds: [a.id, b.id, c.id], notFoundIds: [] })
    expect(context.database.findCheckin(a.id)).toBeUndefined()
    expect(context.database.findCheckin(b.id)).toBeUndefined()
    expect(context.database.findCheckin(c.id)).toBeUndefined()
    expect(context.database.findCheckin(untouched.id)).toBeDefined()
  })

  it('removes the stored photo and avatar files for every deleted note, and leaves others alone', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const photoA = context.storedImage('photo', 'a')
    const avatarA = context.storedImage('avatar', 'a')
    const photoB = context.storedImage('photo', 'b')
    const keptPhoto = context.storedImage('photo', 'kept')
    const a = context.database.createCheckin(checkinInput, photoA, avatarA, admin.id)
    const b = context.database.createCheckin(checkinInput, photoB, null, admin.id)
    const kept = context.database.createCheckin(checkinInput, keptPhoto, null, admin.id)

    const response = await context.handler(batchDeleteEvent({ ids: [a.id, b.id], token: admin.token }))

    expect(response.deletedCount).toBe(2)
    expect(context.imageExists(photoA)).toBe(false)
    expect(context.imageExists(avatarA)).toBe(false)
    expect(context.imageExists(photoB)).toBe(false)
    expect(context.imageExists(keptPhoto)).toBe(true)
    expect(context.database.findCheckin(kept.id)).toBeDefined()
  })

  it('reports missing ids without failing the rest of the batch', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const a = context.database.createCheckin(checkinInput, null, null, admin.id)
    const b = context.database.createCheckin(checkinInput, null, null, admin.id)

    const response = await context.handler(batchDeleteEvent({ ids: [a.id, 999_999, b.id, 999_998], token: admin.token }))

    expect(response).toEqual({ deletedCount: 2, deletedIds: [a.id, b.id], notFoundIds: [999_999, 999_998] })
    expect(context.database.findCheckin(a.id)).toBeUndefined()
    expect(context.database.findCheckin(b.id)).toBeUndefined()
  })

  it('answers success with zero deletions when every id is missing', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')

    const response = await context.handler(batchDeleteEvent({ ids: [999_999, 999_998], token: admin.token }))

    expect(response).toEqual({ deletedCount: 0, deletedIds: [], notFoundIds: [999_999, 999_998] })
  })

  it('deduplicates repeated ids instead of double-counting or misreporting them as missing', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const a = context.database.createCheckin(checkinInput, null, null, admin.id)
    const b = context.database.createCheckin(checkinInput, null, null, admin.id)

    const response = await context.handler(batchDeleteEvent({ ids: [a.id, a.id, b.id, a.id], token: admin.token }))

    expect(response).toEqual({ deletedCount: 2, deletedIds: [a.id, b.id], notFoundIds: [] })
  })
})

describe('transaction rollback', () => {
  it('rolls back the entire batch when one deletion fails mid-transaction', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const before = context.database.createCheckin(checkinInput, null, null, admin.id)
    const boom = context.database.createCheckin(checkinInput, null, null, admin.id)
    const after = context.database.createCheckin(checkinInput, null, null, admin.id)

    // 用真正的 SQLite trigger 讓刪除 boom 這一筆時在資料庫層丟出例外，而不是用 mock 假裝一個
    // 正式環境不會發生的失敗——這樣才能證明 db.transaction() 真的會把整批回滾，不是憑空假設。
    context.database.getDatabase().exec(`
      CREATE TRIGGER boom_before_delete BEFORE DELETE ON checkins
      WHEN OLD.id = ${boom.id}
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;
    `)

    await expect(context.handler(batchDeleteEvent({ ids: [before.id, boom.id, after.id], token: admin.token })))
      .rejects.toMatchObject({ statusCode: 409, message: '批量刪除時發生衝突，請重新整理後再試' })

    // 三筆都還在——包含在觸發失敗「之前」已經在同一筆交易裡執行過 DELETE 的 before.id，
    // 證明失敗真的讓整批回滾，不是「刪到哪算哪」。
    expect(context.database.findCheckin(before.id)).toBeDefined()
    expect(context.database.findCheckin(boom.id)).toBeDefined()
    expect(context.database.findCheckin(after.id)).toBeDefined()
  })

  it('keeps image files on disk when the transaction rolls back', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const photo = context.storedImage('photo', 'rollback')
    const before = context.database.createCheckin(checkinInput, photo, null, admin.id)
    const boom = context.database.createCheckin(checkinInput, null, null, admin.id)

    context.database.getDatabase().exec(`
      CREATE TRIGGER boom_before_delete_2 BEFORE DELETE ON checkins
      WHEN OLD.id = ${boom.id}
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;
    `)

    // 圖片清除排在交易成功之後才會執行；這裡的交易注定失敗，所以 photo 必須完好無缺——
    // 這條測試專門釘住「清除順序」，前一條 rollback 測試用的都是沒有圖片的旅箋，抓不到這個規則。
    await expect(context.handler(batchDeleteEvent({ ids: [before.id, boom.id], token: admin.token })))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(context.imageExists(photo)).toBe(true)
  })
})

describe('authorization', () => {
  it('answers 401 to anonymous callers and stale sessions, 403 to signed-in ordinary members', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')
    const target = context.database.createCheckin(checkinInput, null, null, admin.id)

    await expect(context.handler(batchDeleteEvent({ ids: [target.id] })))
      .rejects.toMatchObject({ statusCode: 401, message: '請先使用 Discord 登入' })
    await expect(context.handler(batchDeleteEvent({ ids: [target.id], token: 'not-a-real-token' })))
      .rejects.toMatchObject({ statusCode: 401 })
    await expect(context.handler(batchDeleteEvent({ ids: [target.id], token: member.token })))
      .rejects.toMatchObject({ statusCode: 403, message: '此功能僅限管理員使用' })

    expect(context.database.findCheckin(target.id)).toBeDefined()
  })
})

describe('ids 驗證', () => {
  it('rejects every value that is not an array, including a missing field', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')

    const rejected: unknown[] = ['1,2,3', 1, null, true, { ids: [1] }, undefined]
    for (const ids of rejected) {
      await expect(context.handler(batchDeleteEvent({ ids, token: admin.token })))
        .rejects.toMatchObject({ statusCode: 400, message: '要刪除的旅箋編號必須是陣列' })
    }
  })

  it('rejects an empty array', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')

    await expect(context.handler(batchDeleteEvent({ ids: [], token: admin.token })))
      .rejects.toMatchObject({ statusCode: 400, message: '請至少選擇一筆旅箋' })
  })

  it('rejects an array containing anything other than a positive safe integer', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const target = context.database.createCheckin(checkinInput, null, null, admin.id)

    const badElements: unknown[] = [0, -1, 1.5, '1', true, false, null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, [1], { id: 1 }]
    // 12 種案例超過本端點 10 次／小時的額度，每個案例換一個來源位址，
    // 這樣才是在驗證「型別檢查」本身，而不是不小心先撞上了限流。
    for (const [index, bad] of badElements.entries()) {
      await expect(context.handler(batchDeleteEvent({ ids: [target.id, bad], token: admin.token, socket: `198.51.100.${50 + index}` })))
        .rejects.toMatchObject({ statusCode: 400, message: '旅箋編號必須是正整數' })
    }
    // 型別檢查失敗時完全不動資料庫，混在陣列裡的合法 id 也不會被刪
    expect(context.database.findCheckin(target.id)).toBeDefined()
  })

  it('accepts Number.MAX_SAFE_INTEGER as a well-formed (if nonexistent) id', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')

    await expect(context.handler(batchDeleteEvent({ ids: [Number.MAX_SAFE_INTEGER], token: admin.token })))
      .resolves.toEqual({ deletedCount: 0, deletedIds: [], notFoundIds: [Number.MAX_SAFE_INTEGER] })
  })

  it('rejects a batch larger than the maximum without touching the database', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const before = context.database.listCheckins().length

    // 1..MAX+1：刻意涵蓋種子資料真的存在的 id（seed() 建立的旅箋通常是 1–6），
    // 用來確認上限檢查發生在任何資料庫操作之前，而不是刪到一半才喊停。
    const tooMany = Array.from({ length: context.MAX_BATCH_DELETE_IDS + 1 }, (_, index) => index + 1)

    await expect(context.handler(batchDeleteEvent({ ids: tooMany, token: admin.token })))
      .rejects.toMatchObject({ statusCode: 400, message: `一次最多刪除 ${context.MAX_BATCH_DELETE_IDS} 筆旅箋` })
    expect(context.database.listCheckins().length).toBe(before)
  })

  it('accepts a batch exactly at the maximum', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const created = Array.from(
      { length: context.MAX_BATCH_DELETE_IDS },
      () => context.database.createCheckin(checkinInput, null, null, admin.id)
    )

    const response = await context.handler(batchDeleteEvent({ ids: created.map(item => item.id), token: admin.token }))

    expect(response.deletedCount).toBe(context.MAX_BATCH_DELETE_IDS)
    expect(response.notFoundIds).toEqual([])
  })
})

describe('cross-site protection and rate limiting', () => {
  it('rejects a DELETE that carries neither Origin nor Referer', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const target = context.database.createCheckin(checkinInput, null, null, admin.id)

    // 有效 session cookie 會被 SameSite=Lax 之外的路徑帶上，所以來源檢查必須自己擋下來。
    await expect(context.handler(batchDeleteEvent({ ids: [target.id], token: admin.token, headers: {} })))
      .rejects.toMatchObject({ statusCode: 403, message: '拒絕跨站操作' })
    await expect(context.handler(batchDeleteEvent({ ids: [target.id], token: admin.token, headers: { origin: 'https://evil.example' } })))
      .rejects.toMatchObject({ statusCode: 403 })
    await expect(context.handler(batchDeleteEvent({ ids: [target.id], token: admin.token, headers: { referer: 'https://evil.example/attack' } })))
      .rejects.toMatchObject({ statusCode: 403 })

    expect(context.database.findCheckin(target.id)).toBeDefined()
  })

  it('accepts a same-origin Referer when the Origin header is absent', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const target = context.database.createCheckin(checkinInput, null, null, admin.id)

    await expect(context.handler(batchDeleteEvent({
      ids: [target.id],
      token: admin.token,
      headers: { referer: `${APP_URL}/admin` }
    }))).resolves.toMatchObject({ deletedCount: 1 })
  })

  it('counts rejected attempts against the quota, so the 11th call is throttled', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')

    // 限流刻意排在 ids 驗證之前，所以格式錯誤（400）也會扣額度——
    // 不然這條路徑可以無限次探測「陣列多長會被拒絕」而不受限流節制。
    for (let attempt = 0; attempt < BATCH_RATE_LIMIT; attempt += 1) {
      const malformed = attempt % 2 === 0
      await expect(context.handler(batchDeleteEvent({ ids: malformed ? 'not-an-array' : [], token: admin.token })))
        .rejects.toMatchObject({ statusCode: 400 })
    }

    const target = context.database.createCheckin(checkinInput, null, null, admin.id)
    await expect(context.handler(batchDeleteEvent({ ids: [target.id], token: admin.token })))
      .rejects.toMatchObject({ statusCode: 429 })
    expect(context.database.findCheckin(target.id)).toBeDefined()

    // 計數桶以來源位址為 key，換一個位址仍有完整額度。
    await expect(context.handler(batchDeleteEvent({ ids: [target.id], token: admin.token, socket: '198.51.100.77' })))
      .resolves.toMatchObject({ deletedCount: 1 })
  })

  it('does not let unauthorized traffic burn the quota of an admin on the same address', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    // enforceSameOrigin／requireAdmin 都排在 enforceRateLimit 之前，401 與 403 都不會進到計數桶。
    for (let attempt = 0; attempt < BATCH_RATE_LIMIT; attempt += 1) {
      await expect(context.handler(batchDeleteEvent({ ids: [1] })))
        .rejects.toMatchObject({ statusCode: 401 })
      await expect(context.handler(batchDeleteEvent({ ids: [1], token: member.token })))
        .rejects.toMatchObject({ statusCode: 403 })
    }

    const target = context.database.createCheckin(checkinInput, null, null, admin.id)
    await expect(context.handler(batchDeleteEvent({ ids: [target.id], token: admin.token })))
      .resolves.toMatchObject({ deletedCount: 1 })
  })
})
