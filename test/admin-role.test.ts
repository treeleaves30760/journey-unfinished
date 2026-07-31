import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReadableStream } from 'node:stream/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE, type PublicUser } from '../server/utils/auth'
import type { User } from '../server/utils/database'

const APP_URL = 'https://trip.example.com'
const CONFIG_ADMIN_DISCORD_ID = '100000000000000001'
const MEMBER_DISCORD_ID = '200000000000000002'
const BYSTANDER_DISCORD_ID = '300000000000000003'
// 端點寫死的額度：每個來源位址每小時 20 次
const ROLE_RATE_LIMIT = 20

interface TestEvent {
  method: string
  headers: Record<string, string>
  cookies: Record<string, string>
  params: Record<string, string>
  socket: string
  stream?: ReadableStream<Uint8Array>
}

interface RoleResponse {
  user: {
    id: number
    discordId: string
    username: string
    displayName: string
    avatarUrl: string | null
    role: 'user' | 'admin'
    configAdmin: boolean
  }
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

interface RequestOptions {
  id?: string | number
  token?: string
  role?: unknown
  body?: string
  socket?: string
  headers?: Record<string, string>
}

function roleRequest(options: RequestOptions = {}): TestEvent {
  const body = options.body ?? JSON.stringify({ role: options.role })
  return {
    method: 'PATCH',
    // content-type 一律附上，這樣「缺 Origin／Referer」的案例缺的就只有來源標頭
    headers: { 'content-type': 'application/json', ...(options.headers ?? { origin: APP_URL }) },
    cookies: options.token ? { [SESSION_COOKIE]: options.token } : {},
    params: { id: String(options.id ?? '') },
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
 * 每個測試都拿到全新的模組實例：SQLite 檔與 request-security 的限流計數桶都是模組層級狀態，
 * 共用的話某個測試打滿 20 次額度就會污染下一個。
 */
async function loadContext() {
  closeCurrentDatabase?.()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-role-'))
  temporaryDirectories.push(root)

  vi.resetModules()
  // 可變的設定物件：測試要能在跑到一半把某人從 adminDiscordIds 移除，
  // 用來驗證「撤銷設定管理員」這條路徑真的立即生效。
  const config = {
    databasePath: path.join(root, 'app.sqlite'),
    adminDiscordIds: CONFIG_ADMIN_DISCORD_ID as string,
    trustedProxyHops: 0,
    sessionDays: 30,
    public: { appUrl: APP_URL }
  }
  vi.stubGlobal('useRuntimeConfig', () => config)
  // Nitro 的自動匯入在 vitest 裡不存在，補上等價實作讓路由檔可以被直接載入與呼叫。
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', (event: TestEvent, name: string) => event.params[name])

  const database = await import('../server/utils/database')
  closeCurrentDatabase = database.closeDatabaseForTests
  const auth = await import('../server/utils/auth')
  const route = await import('../server/api/admin/users/[id]/role.patch')
  const overview = await import('../server/api/admin/overview.get')
  const handler = route.default as unknown as (event: TestEvent) => Promise<RoleResponse>
  const overviewHandler = overview.default as unknown as (event: TestEvent) => {
    users: Array<User & { configAdmin: boolean }>
  }

  /**
   * 完整重演 server/routes/auth/discord.get.ts 的登入寫入：同一組 upsertDiscordUser 參數。
   * 登入端完全不傳 role —— 資料列一律以 schema 的 DEFAULT 'user' 建立。
   * 「再登入」與「撤銷設定管理員」兩組測試都是靠這份忠實度才咬得住。
   */
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

  // 直接讀資料列，不經過任何合併邏輯：用來確認「被拒絕的請求真的沒有寫進資料庫」
  const storedRole = (id: number) => database.findUserById(id)?.role
  const currentRole = (token: string) =>
    auth.getCurrentUser({ cookies: { [SESSION_COOKIE]: token } } as never)?.role

  return { ...route, config, database, auth, handler, overviewHandler, signIn, storedRole, currentRole }
}

afterEach(() => {
  closeCurrentDatabase?.()
  closeCurrentDatabase = undefined
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('PATCH /api/admin/users/:id/role', () => {
  it('promotes a member and answers with the full contract the admin page consumes', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    const response = await context.handler(roleRequest({ id: member.id, token: admin.token, role: 'admin' }))

    expect(response).toEqual({
      user: {
        id: member.id,
        discordId: MEMBER_DISCORD_ID,
        username: '會員',
        displayName: '會員',
        avatarUrl: null,
        role: 'admin',
        configAdmin: false
      }
    })
    expect(context.storedRole(member.id)).toBe('admin')
    expect(context.currentRole(member.token)).toBe('admin')
  })

  it('demotes a granted administrator back to an ordinary member', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    await context.handler(roleRequest({ id: member.id, token: admin.token, role: 'admin' }))
    await expect(context.handler(roleRequest({ id: member.id, token: admin.token, role: 'user' })))
      .resolves.toMatchObject({ user: { id: member.id, role: 'user', configAdmin: false } })

    expect(context.storedRole(member.id)).toBe('user')
    expect(context.currentRole(member.token)).toBe('user')
  })
})

describe('錯誤語意', () => {
  it('answers 400 for every role value outside the two-item allowlist', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    const rejected: unknown[] = ['superadmin', 'Admin', 'ADMIN', 'owner', '', ' user', null, 0, 1, true, ['admin'], { role: 'admin' }]
    for (const role of rejected) {
      await expect(context.handler(roleRequest({ id: member.id, token: admin.token, role })))
        .rejects.toMatchObject({ statusCode: 400, message: '權限只能設定為 user 或 admin' })
    }
    // 完全沒有 role 欄位，以及整個 body 是空的
    await expect(context.handler(roleRequest({ id: member.id, token: admin.token, body: '{}' })))
      .rejects.toMatchObject({ statusCode: 400 })

    expect(context.storedRole(member.id)).toBe('user')
  })

  it('answers 400 for an id that is not a positive integer', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')

    for (const id of ['abc', '-1', '0', '1.5', '', ' ', 'NaN', 'Infinity', '99999999999999999999']) {
      await expect(context.handler(roleRequest({ id, token: admin.token, role: 'admin' })))
        .rejects.toMatchObject({ statusCode: 400, message: '無效的使用者編號' })
    }
  })

  it('answers 401 to anonymous callers and 403 to signed-in ordinary members', async () => {
    const context = await loadContext()
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')
    const bystander = context.signIn(BYSTANDER_DISCORD_ID, '路人')

    await expect(context.handler(roleRequest({ id: bystander.id, role: 'admin' })))
      .rejects.toMatchObject({ statusCode: 401, message: '請先使用 Discord 登入' })
    await expect(context.handler(roleRequest({ id: bystander.id, token: 'not-a-real-token', role: 'admin' })))
      .rejects.toMatchObject({ statusCode: 401 })
    await expect(context.handler(roleRequest({ id: bystander.id, token: member.token, role: 'admin' })))
      .rejects.toMatchObject({ statusCode: 403, message: '此功能僅限管理員使用' })

    // 一般會員最想做的就是把自己升級，這條路同樣走不通
    await expect(context.handler(roleRequest({ id: member.id, token: member.token, role: 'admin' })))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(context.storedRole(member.id)).toBe('user')
    expect(context.storedRole(bystander.id)).toBe('user')
  })

  it('answers 404 for a user id that does not exist', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')

    await expect(context.handler(roleRequest({ id: 999_999, token: admin.token, role: 'admin' })))
      .rejects.toMatchObject({ statusCode: 404, message: '找不到這位使用者' })
  })

  it('answers 403 when an administrator targets their own account', async () => {
    const context = await loadContext()
    const configAdmin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const granted = context.signIn(MEMBER_DISCORD_ID, '受權管理員')
    await context.handler(roleRequest({ id: granted.id, token: configAdmin.token, role: 'admin' }))

    // 授權管理員降自己 —— 真的降下去就沒有人能把他升回來，只能請別的管理員救援
    await expect(context.handler(roleRequest({ id: granted.id, token: granted.token, role: 'user' })))
      .rejects.toMatchObject({ statusCode: 403, message: '不能變更自己的權限，以免把自己鎖在管理頁之外' })
    expect(context.storedRole(granted.id)).toBe('admin')

    // 設定管理員改自己也一樣被擋，而且拿到的是「不能改自己」這個比較好懂的說法
    await expect(context.handler(roleRequest({ id: configAdmin.id, token: configAdmin.token, role: 'user' })))
      .rejects.toMatchObject({ statusCode: 403, message: '不能變更自己的權限，以免把自己鎖在管理頁之外' })
  })

  it('answers 403 when the target is a configured administrator', async () => {
    const context = await loadContext()
    const configAdmin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const granted = context.signIn(MEMBER_DISCORD_ID, '受權管理員')
    await context.handler(roleRequest({ id: granted.id, token: configAdmin.token, role: 'admin' }))

    // 授權管理員想把設定管理員踢掉：這正是「防鎖死保底」要擋下的那一手
    await expect(context.handler(roleRequest({ id: configAdmin.id, token: granted.token, role: 'user' })))
      .rejects.toMatchObject({ statusCode: 403, message: '這位管理員由環境變數指定，請改設定檔調整' })
    // 資料列原封不動（設定管理員的權限不來自這裡，所以本來就是 user），權限也還在
    expect(context.storedRole(configAdmin.id)).toBe('user')
    expect(context.currentRole(configAdmin.token)).toBe('admin')

    // 升級也一樣不受理：設定管理員那一層完全不由網頁決定。
    // 這一手若放行，資料列就會被寫成 'admin' —— 正是會讓環境變數撤銷失效的那種殘留。
    await expect(context.handler(roleRequest({ id: configAdmin.id, token: granted.token, role: 'admin' })))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(context.storedRole(configAdmin.id)).toBe('user')
  })

  it('applies both guard rails without going through the request layer', async () => {
    const { assertRoleChangeAllowed } = await loadContext()
    const event = {} as never
    const actor = (id: number): PublicUser => ({ id, displayName: '站長', username: 'admin', avatarUrl: null, role: 'admin' })
    const target = (id: number, discordId: string): User => ({
      id, discordId, username: 'target', displayName: '對象', avatarUrl: null,
      role: 'user', createdAt: '', lastLoginAt: ''
    })

    expect(() => assertRoleChangeAllowed(event, actor(1), target(1, MEMBER_DISCORD_ID)))
      .toThrowError(expect.objectContaining({ statusCode: 403 }))
    expect(() => assertRoleChangeAllowed(event, actor(1), target(2, CONFIG_ADMIN_DISCORD_ID)))
      .toThrowError(expect.objectContaining({ statusCode: 403 }))
    // 別人、又不是設定管理員 —— 唯一放行的組合
    expect(assertRoleChangeAllowed(event, actor(1), target(2, MEMBER_DISCORD_ID))).toBeUndefined()
  })
})

describe('兩層管理員的判定', () => {
  it('keeps a granted administrator after they sign in again', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    await context.handler(roleRequest({ id: member.id, token: admin.token, role: 'admin' }))
    expect(context.storedRole(member.id)).toBe('admin')

    // 登出再登入。upsertDiscordUser 只要動到 role（無論是寫入還是覆寫），
    // 網頁上授權的管理員在這裡就會被打回一般會員。
    const returning = context.signIn(MEMBER_DISCORD_ID, '會員')
    expect(returning.id).toBe(member.id)
    expect(context.storedRole(member.id)).toBe('admin')
    expect(context.currentRole(returning.token)).toBe('admin')

    // 而且他帶著新 session 仍然用得動這個端點
    const bystander = context.signIn(BYSTANDER_DISCORD_ID, '路人')
    await expect(context.handler(roleRequest({ id: bystander.id, token: returning.token, role: 'admin' })))
      .resolves.toMatchObject({ user: { role: 'admin' } })
  })

  it('never lands a configured administrator in the stored row', async () => {
    const context = await loadContext()
    const configAdmin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')

    // 設定管理員的身分純粹每次請求算出來，絕不落地。若登入把 'admin' 固化進資料列，
    // 之後把他從 NUXT_ADMIN_DISCORD_IDS 移除就撤銷不掉，文件寫的撤銷方式會靜默失效。
    expect(context.storedRole(configAdmin.id)).toBe('user')
    expect(context.currentRole(configAdmin.token)).toBe('admin')

    // 再登入幾次也一樣，不會累積出一個 'admin'
    context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    expect(context.storedRole(configAdmin.id)).toBe('user')
  })

  it('revokes a configured administrator as soon as the environment variable drops them', async () => {
    const context = await loadContext()
    const configAdmin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const granted = context.signIn(MEMBER_DISCORD_ID, '受權管理員')
    const bystander = context.signIn(BYSTANDER_DISCORD_ID, '路人')
    await context.handler(roleRequest({ id: granted.id, token: configAdmin.token, role: 'admin' }))

    // 把他從環境變數移除 —— 這是文件寫的撤銷方式
    context.config.adminDiscordIds = ''

    // 下一個請求就不再是管理員：資料列裡沒有殘留的 'admin' 幫他撐著
    expect(context.currentRole(configAdmin.token)).toBe('user')
    await expect(context.handler(roleRequest({ id: bystander.id, token: configAdmin.token, role: 'admin' })))
      .rejects.toMatchObject({ statusCode: 403, message: '此功能僅限管理員使用' })
    expect(context.storedRole(bystander.id)).toBe('user')

    // 授權管理員那一層不受環境變數變動影響，站上不會一次失去所有管理員
    expect(context.currentRole(granted.token)).toBe('admin')
    // 而且卸任的設定管理員已不再受保護，授權管理員現在改得動他
    await expect(context.handler(roleRequest({ id: configAdmin.id, token: granted.token, role: 'admin' })))
      .resolves.toMatchObject({ user: { id: configAdmin.id, role: 'admin', configAdmin: false } })
  })

  it('lets a configured administrator operate the endpoint while their row stays user', async () => {
    const context = await loadContext()
    const configAdmin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    // 設定管理員完全靠環境變數那一層行使權限，資料列自始至終是 user
    expect(context.currentRole(configAdmin.token)).toBe('admin')
    await expect(context.handler(roleRequest({ id: member.id, token: configAdmin.token, role: 'admin' })))
      .resolves.toMatchObject({ user: { role: 'admin' } })
    expect(context.storedRole(configAdmin.id)).toBe('user')
  })

  it('still honours an admin row left behind by the old login path', async () => {
    const context = await loadContext()
    const configAdmin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')

    // 舊版登入會把環境變數推導出的 role 寫進資料列，既有站台的資料庫裡就有這種殘留。
    // 這種列與「管理頁授權的管理員」在資料上完全無法分辨，所以移除環境變數之後
    // 他仍然是管理員 —— 要真的撤銷，得再到管理頁把他降級一次。
    context.database.getDatabase().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(configAdmin.id)
    context.config.adminDiscordIds = ''

    expect(context.currentRole(configAdmin.token)).toBe('admin')
    // 不過他已經不受設定管理員保護了，別的管理員降得掉他
    const granted = context.signIn(MEMBER_DISCORD_ID, '受權管理員')
    context.database.getDatabase().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(granted.id)
    await expect(context.handler(roleRequest({ id: configAdmin.id, token: granted.token, role: 'user' })))
      .resolves.toMatchObject({ user: { id: configAdmin.id, role: 'user' } })
    expect(context.currentRole(configAdmin.token)).toBe('user')
  })

  it('stops a granted administrator from using the endpoint once demoted', async () => {
    const context = await loadContext()
    const configAdmin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const granted = context.signIn(MEMBER_DISCORD_ID, '受權管理員')
    const bystander = context.signIn(BYSTANDER_DISCORD_ID, '路人')

    await context.handler(roleRequest({ id: granted.id, token: configAdmin.token, role: 'admin' }))
    // 授權管理員這時真的用得動這個端點
    await expect(context.handler(roleRequest({ id: bystander.id, token: granted.token, role: 'admin' })))
      .resolves.toMatchObject({ user: { id: bystander.id, role: 'admin' } })

    await expect(context.handler(roleRequest({ id: granted.id, token: configAdmin.token, role: 'user' })))
      .resolves.toMatchObject({ user: { id: granted.id, role: 'user' } })

    // 舊 session 沒有被撤銷，但角色每次請求都重算，所以權限立刻就沒了
    await expect(context.handler(roleRequest({ id: bystander.id, token: granted.token, role: 'user' })))
      .rejects.toMatchObject({ statusCode: 403, message: '此功能僅限管理員使用' })
    expect(context.storedRole(bystander.id)).toBe('admin')
    expect(context.currentRole(granted.token)).toBe('user')
  })
})

describe('cross-site protection and rate limiting', () => {
  it('rejects a PATCH that carries neither Origin nor Referer', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    // 有效 session cookie 會被 SameSite=Lax 之外的路徑帶上，所以來源檢查必須自己擋下來。
    await expect(context.handler(roleRequest({ id: member.id, token: admin.token, role: 'admin', headers: {} })))
      .rejects.toMatchObject({ statusCode: 403, message: '拒絕跨站操作' })
    await expect(context.handler(roleRequest({ id: member.id, token: admin.token, role: 'admin', headers: { origin: 'https://evil.example' } })))
      .rejects.toMatchObject({ statusCode: 403 })
    await expect(context.handler(roleRequest({ id: member.id, token: admin.token, role: 'admin', headers: { referer: 'https://evil.example/attack' } })))
      .rejects.toMatchObject({ statusCode: 403 })

    expect(context.storedRole(member.id)).toBe('user')
  })

  it('accepts a same-origin Referer when the Origin header is absent', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    await expect(context.handler(roleRequest({
      id: member.id,
      token: admin.token,
      role: 'admin',
      headers: { referer: `${APP_URL}/admin` }
    }))).resolves.toMatchObject({ user: { role: 'admin' } })
  })

  it('counts rejected attempts against the quota, so the 21st call is throttled', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    // 限流刻意排在 parseUserId 與 findUserById 之前，所以格式錯誤（400）與查無此人（404）
    // 都會扣額度 —— 這正是「不讓人靠這條路徑大量探測使用者編號」的關鍵。
    for (let attempt = 0; attempt < ROLE_RATE_LIMIT; attempt += 1) {
      const malformed = attempt % 2 === 0
      await expect(context.handler(roleRequest({
        id: malformed ? `not-an-id-${attempt}` : 900_000 + attempt,
        token: admin.token,
        role: 'admin'
      }))).rejects.toMatchObject({ statusCode: malformed ? 400 : 404 })
    }

    await expect(context.handler(roleRequest({ id: member.id, token: admin.token, role: 'admin' })))
      .rejects.toMatchObject({ statusCode: 429 })
    expect(context.storedRole(member.id)).toBe('user')

    // 計數桶以來源位址為 key，換一個位址仍有完整額度
    await expect(context.handler(roleRequest({ id: member.id, token: admin.token, role: 'admin', socket: '198.51.100.77' })))
      .resolves.toMatchObject({ user: { role: 'admin' } })
  })

  it('does not let unauthorized traffic burn the quota of an admin on the same address', async () => {
    const context = await loadContext()
    const admin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    // requireAdmin 排在 enforceRateLimit 之前，401 與 403 都不會進到計數桶
    for (let attempt = 0; attempt < ROLE_RATE_LIMIT; attempt += 1) {
      await expect(context.handler(roleRequest({ id: member.id, role: 'admin' })))
        .rejects.toMatchObject({ statusCode: 401 })
      await expect(context.handler(roleRequest({ id: member.id, token: member.token, role: 'admin' })))
        .rejects.toMatchObject({ statusCode: 403 })
    }

    await expect(context.handler(roleRequest({ id: member.id, token: admin.token, role: 'admin' })))
      .resolves.toMatchObject({ user: { role: 'admin' } })
  })
})

describe('GET /api/admin/overview', () => {
  it('flags the configured administrators so the page can disable their toggle', async () => {
    const context = await loadContext()
    const configAdmin = context.signIn(CONFIG_ADMIN_DISCORD_ID, '站長')
    const granted = context.signIn(MEMBER_DISCORD_ID, '受權管理員')
    const member = context.signIn(BYSTANDER_DISCORD_ID, '一般會員')
    await context.handler(roleRequest({ id: granted.id, token: configAdmin.token, role: 'admin' }))

    const { users } = context.overviewHandler({ cookies: { [SESSION_COOKIE]: configAdmin.token } } as never)
    const byId = new Map(users.map(user => [user.id, user]))

    expect(byId.get(configAdmin.id)).toMatchObject({ role: 'admin', configAdmin: true })
    expect(byId.get(granted.id)).toMatchObject({ role: 'admin', configAdmin: false })
    expect(byId.get(member.id)).toMatchObject({ role: 'user', configAdmin: false })

    // 前端契約：管理頁按這幾個欄位渲染，少一個切換按鈕就畫不出來
    expect(Object.keys(byId.get(granted.id)!)).toEqual(expect.arrayContaining([
      'id', 'discordId', 'username', 'displayName', 'avatarUrl', 'role', 'configAdmin'
    ]))
  })

  it('refuses ordinary members and anonymous visitors', async () => {
    const context = await loadContext()
    const member = context.signIn(MEMBER_DISCORD_ID, '會員')

    expect(() => context.overviewHandler({ cookies: {} } as never))
      .toThrowError(expect.objectContaining({ statusCode: 401 }))
    expect(() => context.overviewHandler({ cookies: { [SESSION_COOKIE]: member.token } } as never))
      .toThrowError(expect.objectContaining({ statusCode: 403 }))
  })
})
