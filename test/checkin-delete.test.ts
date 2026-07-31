import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE, type PublicUser } from '../server/utils/auth'
import type { Checkin } from '../server/utils/database'
import type { CheckinInput } from '../server/utils/validation'

const APP_URL = 'https://trip.example.com'
const ADMIN_DISCORD_ID = '100000000000000001'
const OWNER_DISCORD_ID = '200000000000000002'
const STRANGER_DISCORD_ID = '300000000000000003'
// 端點寫死的額度：每個來源位址每小時 20 次
const DELETE_RATE_LIMIT = 20

interface TestEvent {
  method: string
  headers: Record<string, string>
  cookies: Record<string, string>
  params: Record<string, string>
  socket: string
}

// 這個檔案要跑的是「整條 handler」，所以只把 h3 讀請求狀態的入口換成純物件版本，
// createError 與其餘行為都留給真的 h3，狀態碼才不會是測試自己捏出來的。
vi.mock('h3', async importOriginal => ({
  ...await importOriginal<typeof import('h3')>(),
  getRequestHeader: (event: TestEvent, name: string) => event.headers[name.toLowerCase()],
  getRequestIP: (event: TestEvent) => event.socket,
  getCookie: (event: TestEvent, name: string) => event.cookies[name],
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
  message: '這是一段等待被刪除的旅程。',
  visitedAt: '2026-01-01',
  avatarPreset: 'sun'
}

function checkinRecord(overrides: Partial<Checkin> = {}): Checkin {
  return {
    ...checkinInput,
    id: 1,
    userId: 1,
    photo: null,
    avatar: null,
    createdAt: '2026-01-01 00:00:00',
    commentCount: 0,
    ...overrides
  }
}

function memberOf(overrides: Partial<PublicUser> = {}): PublicUser {
  return { id: 1, displayName: '旅人', username: 'traveler', avatarUrl: null, role: 'user', ...overrides }
}

function deleteEvent(options: {
  id?: string | number
  token?: string
  socket?: string
  headers?: Record<string, string>
} = {}): TestEvent {
  return {
    method: 'DELETE',
    headers: options.headers ?? { origin: APP_URL },
    cookies: options.token ? { [SESSION_COOKIE]: options.token } : {},
    params: { id: String(options.id ?? '') },
    socket: options.socket ?? '198.51.100.10'
  }
}

const temporaryDirectories: string[] = []
let closeCurrentDatabase: (() => void) | undefined

/**
 * 每個測試都拿到全新的模組實例：SQLite 檔、上傳目錄與 request-security 的限流計數桶
 * 都是模組層級狀態，共用的話某個測試打滿 20 次額度就會污染下一個。
 */
async function loadContext() {
  closeCurrentDatabase?.()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-delete-'))
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
  vi.stubGlobal('getRouterParam', (event: TestEvent, name: string) => event.params[name])

  const database = await import('../server/utils/database')
  closeCurrentDatabase = database.closeDatabaseForTests
  const auth = await import('../server/utils/auth')
  const route = await import('../server/api/checkins/[id].delete')
  const handler = route.default as unknown as (event: TestEvent) => { deleted: boolean }

  function signIn(discordId: string, displayName: string) {
    const user = database.upsertDiscordUser({
      discordId,
      username: displayName,
      displayName,
      avatarUrl: null,
      // 真正決定 role 的是 runtimeConfig.adminDiscordIds（見 auth.ts 的 publicUser），
      // 這裡寫進資料列只是為了讓資料保持一致。
      role: discordId === ADMIN_DISCORD_ID ? 'admin' : 'user'
    })
    const token = `session-token-${discordId}`
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

describe('DELETE /api/checkins/:id authorization', () => {
  it('lets the owner delete their own note along with its images and comments', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const photo = context.storedImage('photo', 'owned')
    const avatar = context.storedImage('avatar', 'owned')
    const checkin = context.database.createCheckin(checkinInput, photo, avatar, owner.id)
    context.database.createComment(checkin.id, '留言者', '會一起被刪掉')

    expect(context.handler(deleteEvent({ id: checkin.id, token: owner.token }))).toEqual({ deleted: true })

    expect(context.database.findCheckin(checkin.id)).toBeUndefined()
    expect(context.database.listComments(checkin.id)).toHaveLength(0)
    expect(context.imageExists(photo)).toBe(false)
    expect(context.imageExists(avatar)).toBe(false)
  })

  it('answers 403 (not 404) to another signed-in member and keeps everything intact', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const stranger = context.signIn(STRANGER_DISCORD_ID, '路過旅人')
    const photo = context.storedImage('photo', 'kept')
    const checkin = context.database.createCheckin(checkinInput, photo, null, owner.id)

    // 旅箋本來就公開可讀，回 404 假裝不存在只會誤導使用者，這裡必須是 403。
    expect(() => context.handler(deleteEvent({ id: checkin.id, token: stranger.token })))
      .toThrowError(expect.objectContaining({ statusCode: 403, message: '只能刪除自己寫下的旅箋' }))

    expect(context.database.findCheckin(checkin.id)).toBeDefined()
    expect(context.imageExists(photo)).toBe(true)
  })

  it('lets an administrator delete a note written by someone else', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    const photo = context.storedImage('photo', 'moderated')
    const checkin = context.database.createCheckin(checkinInput, photo, null, owner.id)

    expect(context.handler(deleteEvent({ id: checkin.id, token: admin.token }))).toEqual({ deleted: true })
    expect(context.database.findCheckin(checkin.id)).toBeUndefined()
    expect(context.imageExists(photo)).toBe(false)
  })

  it('answers 401 to anonymous and stale-session requests', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const checkin = context.database.createCheckin(checkinInput, null, null, owner.id)

    expect(() => context.handler(deleteEvent({ id: checkin.id })))
      .toThrowError(expect.objectContaining({ statusCode: 401 }))
    expect(() => context.handler(deleteEvent({ id: checkin.id, token: 'not-a-real-token' })))
      .toThrowError(expect.objectContaining({ statusCode: 401 }))

    expect(context.database.findCheckin(checkin.id)).toBeDefined()
  })

  it('answers 404 for a missing id and 400 for a malformed one', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')

    expect(() => context.handler(deleteEvent({ id: 999_999, token: owner.token })))
      .toThrowError(expect.objectContaining({ statusCode: 404, message: '找不到這則旅箋' }))
    expect(() => context.handler(deleteEvent({ id: 'abc', token: owner.token })))
      .toThrowError(expect.objectContaining({ statusCode: 400 }))
    expect(() => context.handler(deleteEvent({ id: -1, token: owner.token })))
      .toThrowError(expect.objectContaining({ statusCode: 400 }))
  })
})

describe('seeded notes whose user_id is NULL', () => {
  async function seededContext() {
    const context = await loadContext()
    const seeded = context.database.listCheckins().filter(checkin => checkin.userId === null)
    expect(seeded.length).toBeGreaterThan(0)
    const target = seeded[0]!
    const photo = context.storedImage('photo', 'seeded')
    const avatar = context.storedImage('avatar', 'seeded')
    context.database.getDatabase()
      .prepare('UPDATE checkins SET photo = ?, avatar = ? WHERE id = ?')
      .run(photo, avatar, target.id)
    return { ...context, target, photo, avatar }
  }

  it('refuses every ordinary member, because NULL must not match any user id', async () => {
    const context = await seededContext()
    const member = context.signIn(OWNER_DISCORD_ID, '一般會員')
    // 這個會員的 id 就是資料庫裡的第一個 user id；若擁有者判斷寫得寬鬆
    // （例如 `!checkin.userId || checkin.userId === user.id`），這裡就會被放行。
    expect(member.id).toBe(1)

    expect(() => context.handler(deleteEvent({ id: context.target.id, token: member.token })))
      .toThrowError(expect.objectContaining({ statusCode: 403 }))

    expect(context.database.findCheckin(context.target.id)).toBeDefined()
    expect(context.imageExists(context.photo)).toBe(true)
    expect(context.imageExists(context.avatar)).toBe(true)
  })

  it('lets an administrator clean up an ownerless seeded note', async () => {
    const context = await seededContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')

    expect(context.handler(deleteEvent({ id: context.target.id, token: admin.token }))).toEqual({ deleted: true })
    expect(context.database.findCheckin(context.target.id)).toBeUndefined()
    expect(context.imageExists(context.photo)).toBe(false)
    expect(context.imageExists(context.avatar)).toBe(false)
  })

  it('never treats a null or non-integer id as ownership', async () => {
    const { isCheckinOwner } = await loadContext()
    const ownerless = checkinRecord({ userId: null })

    expect(isCheckinOwner(ownerless, memberOf({ id: 4 }))).toBe(false)
    // 兩邊都缺值時 `null === null` / `undefined === undefined` 會成立，
    // 因此擋下無主旅箋的其實是 user 這一側的 Number.isInteger 守衛。
    expect(isCheckinOwner(ownerless, memberOf({ id: null as unknown as number }))).toBe(false)
    expect(isCheckinOwner(ownerless, memberOf({ id: undefined as unknown as number }))).toBe(false)
    expect(isCheckinOwner(ownerless, memberOf({ id: Number.NaN }))).toBe(false)
    expect(isCheckinOwner(checkinRecord({ userId: 4 }), memberOf({ id: 4 }))).toBe(true)
    expect(isCheckinOwner(checkinRecord({ userId: 4 }), memberOf({ id: 5 }))).toBe(false)
  })

  it('mirrors the exact rule the detail page uses to show the delete button', async () => {
    const { assertCheckinDeletable } = await loadContext()
    // pages/checkins/[id].vue 的 canDelete 判斷（原樣抄過來），用來釘住前後端不會各走各的規則。
    const canDeleteInPage = (checkin: Checkin, user: PublicUser) =>
      user.role === 'admin' || (typeof checkin.userId === 'number' && checkin.userId === user.id)

    const cases: Array<[Checkin, PublicUser]> = []
    for (const userId of [null, 4, 5]) {
      for (const role of ['user', 'admin'] as const) {
        cases.push([checkinRecord({ userId }), memberOf({ id: 4, role })])
      }
    }

    for (const [checkin, user] of cases) {
      let backendAllows = true
      try {
        assertCheckinDeletable(checkin, user)
      } catch {
        backendAllows = false
      }
      expect({ userId: checkin.userId, role: user.role, allowed: backendAllows })
        .toEqual({ userId: checkin.userId, role: user.role, allowed: canDeleteInPage(checkin, user) })
    }
  })
})

describe('cross-site protection and rate limiting', () => {
  it('rejects a DELETE that carries neither Origin nor Referer', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const photo = context.storedImage('photo', 'csrf')
    const checkin = context.database.createCheckin(checkinInput, photo, null, owner.id)

    // 有效 session cookie 會被 SameSite=Lax 之外的路徑帶上，所以來源檢查必須自己擋下來。
    expect(() => context.handler(deleteEvent({ id: checkin.id, token: owner.token, headers: {} })))
      .toThrowError(expect.objectContaining({ statusCode: 403, message: '拒絕跨站操作' }))
    expect(() => context.handler(deleteEvent({ id: checkin.id, token: owner.token, headers: { origin: 'https://evil.example' } })))
      .toThrowError(expect.objectContaining({ statusCode: 403 }))
    expect(() => context.handler(deleteEvent({ id: checkin.id, token: owner.token, headers: { referer: 'https://evil.example/attack' } })))
      .toThrowError(expect.objectContaining({ statusCode: 403 }))

    expect(context.database.findCheckin(checkin.id)).toBeDefined()
    expect(context.imageExists(photo)).toBe(true)
  })

  it('accepts a same-origin Referer when the Origin header is absent', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const checkin = context.database.createCheckin(checkinInput, null, null, owner.id)

    expect(context.handler(deleteEvent({
      id: checkin.id,
      token: owner.token,
      headers: { referer: `${APP_URL}/checkins/${checkin.id}` }
    }))).toEqual({ deleted: true })
  })

  it('counts failed attempts against the quota, so the 21st call is throttled', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const checkin = context.database.createCheckin(checkinInput, null, null, owner.id)

    // 限流刻意排在 parseId 與 findCheckin 兩者之前，所以連格式錯誤（400）和查無此筆（404）
    // 都會扣額度 —— 這正是「不讓人靠這條路徑大量探測 id 是否存在」的關鍵。
    // 兩種失敗各半，任何一種被移到限流之前，下面的 429 就不會發生。
    for (let attempt = 0; attempt < DELETE_RATE_LIMIT; attempt += 1) {
      const malformed = attempt % 2 === 0
      expect(() => context.handler(deleteEvent({
        id: malformed ? `not-an-id-${attempt}` : 900_000 + attempt,
        token: owner.token
      }))).toThrowError(expect.objectContaining({ statusCode: malformed ? 400 : 404 }))
    }

    expect(() => context.handler(deleteEvent({ id: checkin.id, token: owner.token })))
      .toThrowError(expect.objectContaining({ statusCode: 429 }))
    expect(context.database.findCheckin(checkin.id)).toBeDefined()

    // 計數桶以來源位址為 key，換一個位址仍有完整額度。
    expect(context.handler(deleteEvent({ id: checkin.id, token: owner.token, socket: '198.51.100.77' })))
      .toEqual({ deleted: true })
  })

  it('does not let unauthenticated traffic burn the quota of a member on the same address', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const checkin = context.database.createCheckin(checkinInput, null, null, owner.id)

    // requireUser 排在 enforceRateLimit 之前，401 不會進到計數桶。
    for (let attempt = 0; attempt < DELETE_RATE_LIMIT * 2; attempt += 1) {
      expect(() => context.handler(deleteEvent({ id: checkin.id })))
        .toThrowError(expect.objectContaining({ statusCode: 401 }))
    }

    expect(context.handler(deleteEvent({ id: checkin.id, token: owner.token }))).toEqual({ deleted: true })
  })
})

describe('deleteCheckinAndImages', () => {
  it('keeps the files on disk when the row could not be deleted', async () => {
    const context = await loadContext()
    const photo = context.storedImage('photo', 'ghost')
    const avatar = context.storedImage('avatar', 'ghost')
    // 資料列不存在 → deleteCheckin 回 false。檔案必須完好，否則會出現「圖沒了但旅箋還在」。
    const ghost = checkinRecord({ id: 987_654, userId: 1, photo, avatar })

    expect(() => context.deleteCheckinAndImages(ghost)).toThrowError(expect.objectContaining({ statusCode: 409 }))
    expect(context.imageExists(photo)).toBe(true)
    expect(context.imageExists(avatar)).toBe(true)
  })

  it('removes only the two images the note references', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const photo = context.storedImage('photo', 'target')
    const avatar = context.storedImage('avatar', 'target')
    const unrelated = context.storedImage('photo', 'someone-else')
    const checkin = context.database.createCheckin(checkinInput, photo, avatar, owner.id)

    expect(context.deleteCheckinAndImages(checkin)).toEqual({ deleted: true })
    expect(fs.readdirSync(context.uploadDir)).toEqual([path.basename(unrelated)])
  })

  it('handles notes that have no stored images', async () => {
    const context = await loadContext()
    const owner = context.signIn(OWNER_DISCORD_ID, '旅箋主人')
    const checkin = context.database.createCheckin(checkinInput, null, null, owner.id)

    expect(context.deleteCheckinAndImages(checkin)).toEqual({ deleted: true })
    expect(context.database.findCheckin(checkin.id)).toBeUndefined()
  })
})
