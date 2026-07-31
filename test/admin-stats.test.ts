import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE } from '../server/utils/auth'
import type { CheckinInput } from '../server/utils/validation'

const APP_URL = 'https://trip.example.com'
const ADMIN_DISCORD_ID = '100000000000000001'
const AUTHOR_A_DISCORD_ID = '200000000000000002'
const AUTHOR_B_DISCORD_ID = '300000000000000003'
const AUTHOR_C_DISCORD_ID = '400000000000000004'
const MEMBER_DISCORD_ID = '500000000000000005'

interface TestEvent {
  method: string
  headers: Record<string, string>
  cookies: Record<string, string>
  socket: string
}

interface AdminStatsResponse {
  totals: { checkins: number, checkinsWithPhoto: number, users: number, comments: number }
  timeSeries: {
    daily: Array<{ date: string, newCheckins: number, newUsers: number }>
    weekly: Array<{ weekStart: string, newCheckins: number, newUsers: number }>
  }
  countyDistribution: Array<{ county: string, count: number }>
  topAuthors: Array<{ userId: number, displayName: string, avatarUrl: string | null, checkinCount: number }>
  recentActivity: {
    checkins: Array<{ id: number, location: string, county: string, createdAt: string }>
    comments: Array<{ id: number, checkinId: number, nickname: string, createdAt: string }>
  }
}

// 這支端點是 GET、不呼叫 enforceSameOrigin／enforceRateLimit，requireAdmin 這條路徑
// 只會用到 getCookie／deleteCookie，所以 h3 mock 只換掉這兩個真正會被呼叫到的函式。
vi.mock('h3', async importOriginal => ({
  ...await importOriginal<typeof import('h3')>(),
  getCookie: (event: TestEvent, name: string) => event.cookies[name],
  deleteCookie: () => {},
  setCookie: () => {}
}))

function statsRequest(token?: string): TestEvent {
  return {
    method: 'GET',
    headers: {},
    cookies: token ? { [SESSION_COOKIE]: token } : {},
    socket: '198.51.100.10'
  }
}

const baseCheckin: CheckinInput = {
  nickname: '測試旅人',
  location: '測試景點',
  county: '臺北市',
  latitude: 25.033,
  longitude: 121.5654,
  dollName: '測試娃',
  message: '這是一段測試旅程。',
  visitedAt: '2025-01-01',
  avatarPreset: 'sun'
}

const temporaryDirectories: string[] = []
let closeCurrentDatabase: (() => void) | undefined

/**
 * 每個測試都拿到全新的模組實例：SQLite 檔是模組層級狀態，共用的話某個測試寫入的
 * 使用者／旅箋會污染下一個測試的計數。
 */
async function loadContext() {
  closeCurrentDatabase?.()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-stats-'))
  temporaryDirectories.push(root)

  vi.resetModules()
  vi.stubGlobal('useRuntimeConfig', () => ({
    databasePath: path.join(root, 'app.sqlite'),
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
  const route = await import('../server/api/admin/stats.get')
  const handler = route.default as unknown as (event: TestEvent) => AdminStatsResponse

  function signIn(discordId: string, displayName: string) {
    const user = database.upsertDiscordUser({ discordId, username: displayName, displayName, avatarUrl: null })
    const token = `session-token-${discordId}`
    database.createAuthSession(auth.hashToken(token), user.id, Date.now() + 3_600_000)
    return { id: user.id, token }
  }

  // better-sqlite3 是原生模組，CURRENT_TIMESTAMP 呼叫的是系統時間，不受
  // vi.useFakeTimers() 影響（那只換掉 JS 這一側的 Date／計時器）。要把一筆資料釘在
  // 特定日期，只能在寫入後直接用原生 SQL 覆寫 created_at。
  function setCreatedAt(table: 'checkins' | 'users' | 'comments', id: number, value: string) {
    database.getDatabase().prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(value, id)
  }

  // seed() 會在全新資料庫塞 6 則展示旅箋＋1 則留言；清掉旅箋，留言透過
  // ON DELETE CASCADE 一併清掉，才能測到「真的沒有資料」的情境。
  function wipeSeed() {
    database.getDatabase().exec('DELETE FROM checkins')
  }

  return { database, auth, handler, signIn, setCreatedAt, wipeSeed, ...route }
}

afterEach(() => {
  closeCurrentDatabase?.()
  closeCurrentDatabase = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('純函式：時區與時間骨架工具', () => {
  it('taipeiDateString 把 UTC 毫秒加 8 小時再取日期，跟 SQL 端 date(created_at, \'+8 hours\') 用同一把尺', async () => {
    const { taipeiDateString } = await loadContext()
    expect(taipeiDateString(Date.parse('2026-01-01T15:59:59Z'))).toBe('2026-01-01')
    expect(taipeiDateString(Date.parse('2026-01-01T16:00:00Z'))).toBe('2026-01-02') // 跨過午夜的那一刻
    expect(taipeiDateString(Date.parse('2025-12-31T23:59:59Z'))).toBe('2026-01-01')
  })

  it('mondayOf 找出該日期所在週的星期一；星期日要往回推 6 天，不是往前推', async () => {
    const { mondayOf } = await loadContext()
    expect(mondayOf('2026-02-09')).toBe('2026-02-09') // 本身就是星期一
    expect(mondayOf('2026-02-10')).toBe('2026-02-09') // 星期二，推 1 天
    expect(mondayOf('2026-02-15')).toBe('2026-02-09') // 星期日，推 6 天
  })

  it('lastNDays 回傳含結束日在內、由舊到新排序的連續 N 天', async () => {
    const { lastNDays } = await loadContext()
    expect(lastNDays(5, '2026-02-15')).toEqual(['2026-02-11', '2026-02-12', '2026-02-13', '2026-02-14', '2026-02-15'])
  })

  it('lastNWeeks 回傳含結束日當週在內、由舊到新排序的連續 N 個週一', async () => {
    const { lastNWeeks } = await loadContext()
    expect(lastNWeeks(3, '2026-02-15')).toEqual(['2026-01-26', '2026-02-02', '2026-02-09'])
  })

  it('buildTimeSeries 把「有資料的日期」映射裡的洞補成明確的 0，陣列長度固定不因缺口變動', async () => {
    const { buildTimeSeries } = await loadContext()
    // 2026-02-14 刻意不放進 Map：這就是「沒有人寫旅箋、沒有人註冊的一天」。
    const checkinsByDay = new Map([['2026-02-15', 2], ['2026-02-13', 1]])
    const usersByDay = new Map([['2026-02-15', 1]])
    const { daily, weekly } = buildTimeSeries(checkinsByDay, usersByDay, '2026-02-15')

    expect(daily).toHaveLength(30)
    expect(daily[29]).toEqual({ date: '2026-02-15', newCheckins: 2, newUsers: 1 })
    // 缺口日必須「存在且是 0」，不能整格從陣列裡消失，否則折線圖的 X 軸間距會被壓縮。
    expect(daily[28]).toEqual({ date: '2026-02-14', newCheckins: 0, newUsers: 0 })
    expect(daily[27]).toEqual({ date: '2026-02-13', newCheckins: 1, newUsers: 0 })
    expect(daily[0]).toEqual({ date: '2026-01-17', newCheckins: 0, newUsers: 0 }) // 視窗最舊一天，一樣要在骨架裡

    expect(weekly).toHaveLength(12)
    expect(weekly[11]).toEqual({ weekStart: '2026-02-09', newCheckins: 3, newUsers: 1 })
  })
})

describe('權限驗證', () => {
  it('未登入回 401', async () => {
    const context = await loadContext()
    expect(() => context.handler(statsRequest())).toThrowError(expect.objectContaining({ statusCode: 401, message: '請先使用 Discord 登入' }))
  })

  it('無效或過期的 token 一樣回 401', async () => {
    const context = await loadContext()
    expect(() => context.handler(statsRequest('not-a-real-token'))).toThrowError(expect.objectContaining({ statusCode: 401 }))
  })

  it('已登入的一般會員回 403，不是 401', async () => {
    const context = await loadContext()
    const member = context.signIn(MEMBER_DISCORD_ID, '一般會員')
    expect(() => context.handler(statsRequest(member.token)))
      .toThrowError(expect.objectContaining({ statusCode: 403, message: '此功能僅限管理員使用' }))
  })

  it('管理員可以成功呼叫', async () => {
    const context = await loadContext()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    expect(() => context.handler(statsRequest(admin.token))).not.toThrow()
  })
})

describe('空資料庫：每一項聚合都要能處理 0 筆', () => {
  it('回傳全部歸零／空陣列，時間序列仍是完整長度的 0 值骨架', async () => {
    const context = await loadContext()
    context.wipeSeed()
    const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
    context.setCreatedAt('users', admin.id, '2026-02-15 04:00:00')

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-02-15T04:00:00Z'))
    const response = context.handler(statsRequest(admin.token))

    // users 不可能是 0：呼叫這支 API 本身就需要一個已登入的管理員，而 session
    // 是靠 auth_sessions JOIN users 解析出身分，「通過驗證」與「users 是空表」
    // 兩件事在這個系統裡互相矛盾，不會同時成立。這裡真正要驗證的是其餘每一項
    // 聚合——旅箋、留言、時間序列的旅箋欄位、縣市分布、作者排行、近期活動——
    // 在 0 筆時都不會噴錯、也不會回傳 undefined／NaN。
    expect(response.totals).toEqual({ checkins: 0, checkinsWithPhoto: 0, users: 1, comments: 0 })
    expect(response.countyDistribution).toEqual([])
    expect(response.topAuthors).toEqual([])
    expect(response.recentActivity.checkins).toEqual([])
    expect(response.recentActivity.comments).toEqual([])

    expect(response.timeSeries.daily).toHaveLength(30)
    expect(response.timeSeries.daily.every(point => point.newCheckins === 0)).toBe(true)
    // 唯一非 0 的格子是「今天」（admin 登入的那天）的 newUsers，其餘 29 天都是 0。
    expect(response.timeSeries.daily.filter(point => point.newUsers !== 0))
      .toEqual([{ date: '2026-02-15', newCheckins: 0, newUsers: 1 }])

    expect(response.timeSeries.weekly).toHaveLength(12)
    expect(response.timeSeries.weekly.every(point => point.newCheckins === 0)).toBe(true)
    expect(response.timeSeries.weekly.filter(point => point.newUsers !== 0))
      .toEqual([{ weekStart: '2026-02-09', newCheckins: 0, newUsers: 1 }])
  })
})

/**
 * 建出一組跨日期、跨作者、有意「刻意搞亂」的資料集，「今天」固定在 2026-02-15（週日）：
 *
 *  列   作者      created_at 偏移   縣市     照片  visited_at（刻意跟 created_at 順序相反）
 *  row1 authorA   今天 (D0)         臺北市   有    2019-01-01（最舊）
 *  row2 authorA   D0-2              臺北市   無    2021-05-05
 *  row3 authorA   D0-10             高雄市   有    2025-12-25
 *  row4 authorB   D0-1              臺北市   無    2018-07-07（最舊）
 *  row5 authorB   D0-30（超出每日視窗，未超出每週視窗）  花蓮縣  無  2026-01-10
 *  row6 authorB   D0-100（超出每日與每週視窗）           花蓮縣  無  2026-02-01（最新）
 *  row7 無主      D0-5              南投縣   有    2022-03-03
 *
 * visited_at 刻意跟 created_at 的新舊順序相反：如果程式不小心把「近期活動」或時間序列
 * 的排序／分桶依據誤用成 visited_at，這裡算出來的期望值會整組兜不攏，才抓得到那種
 * 把兩個時間欄位搞混的錯誤。
 */
async function populatedContext() {
  const context = await loadContext()
  context.wipeSeed()

  const admin = context.signIn(ADMIN_DISCORD_ID, '站長')
  const authorA = context.signIn(AUTHOR_A_DISCORD_ID, '愛旅行的 A')
  const authorB = context.signIn(AUTHOR_B_DISCORD_ID, '偶爾出遊的 B')
  const authorC = context.signIn(AUTHOR_C_DISCORD_ID, '只註冊沒寫過的 C')

  context.setCreatedAt('users', admin.id, '2026-02-15 04:00:00') // D0
  context.setCreatedAt('users', authorA.id, '2026-02-13 04:00:00') // D0-2
  context.setCreatedAt('users', authorB.id, '2026-02-14 04:00:00') // D0-1
  context.setCreatedAt('users', authorC.id, '2026-01-06 04:00:00') // D0-40：每日視窗外、每週視窗內

  function checkin(fields: Partial<CheckinInput>, userId: number | null, createdAt: string, photo: string | null = null) {
    const input: CheckinInput = { ...baseCheckin, ...fields }
    // createCheckin 要求 userId 是 number；無主旅箋（模擬作者帳號被刪除、外鍵 SET NULL
    // 留下的舊資料）先用一個暫時擁有者寫入，再用原生 SQL 把 user_id 覆寫成 NULL。
    const record = context.database.createCheckin(input, photo, null, userId ?? admin.id)
    if (userId === null) {
      context.database.getDatabase().prepare('UPDATE checkins SET user_id = NULL WHERE id = ?').run(record.id)
    }
    context.setCreatedAt('checkins', record.id, createdAt)
    return record
  }

  const row1 = checkin({ location: '今天寫、很久以前去過', county: '臺北市', visitedAt: '2019-01-01' }, authorA.id, '2026-02-15 04:00:00', '/uploads/photo-1.jpg')
  const row2 = checkin({ location: '前天寫的旅箋', county: '臺北市', visitedAt: '2021-05-05' }, authorA.id, '2026-02-13 04:00:00')
  const row3 = checkin({ location: '十天前寫的旅箋', county: '高雄市', visitedAt: '2025-12-25' }, authorA.id, '2026-02-05 04:00:00', '/uploads/photo-3.jpg')
  const row4 = checkin({ location: '昨天寫的旅箋', county: '臺北市', visitedAt: '2018-07-07' }, authorB.id, '2026-02-14 04:00:00')
  const row5 = checkin({ location: '超出每日視窗的旅箋', county: '花蓮縣', visitedAt: '2026-01-10' }, authorB.id, '2026-01-16 04:00:00')
  const row6 = checkin({ location: '超出每日與每週視窗的旅箋', county: '花蓮縣', visitedAt: '2026-02-01' }, authorB.id, '2025-11-07 04:00:00')
  const row7 = checkin({ location: '無主旅箋', county: '南投縣', visitedAt: '2022-03-03' }, null, '2026-02-10 04:00:00', '/uploads/photo-7.jpg')

  const comment1 = context.database.createComment(row1.id, '留言者一', '今天剛留的言')
  context.setCreatedAt('comments', comment1.id, '2026-02-15 05:00:00')
  const comment2 = context.database.createComment(row3.id, '留言者二', '幾天前留的言')
  context.setCreatedAt('comments', comment2.id, '2026-02-12 04:00:00')
  const comment3 = context.database.createComment(row5.id, '留言者三', '很久以前留的言')
  context.setCreatedAt('comments', comment3.id, '2025-12-27 04:00:00')

  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-15T04:00:00Z'))
  const response = context.handler(statsRequest(admin.token))
  vi.useRealTimers()

  return { context, response, ids: { admin, authorA, authorB, authorC, row1, row2, row3, row4, row5, row6, row7 } }
}

describe('有資料時：各項聚合數字與時間序列都要正確', () => {
  it('總量統計只算真實資料，不含已被清掉的種子資料', async () => {
    const { response } = await populatedContext()
    expect(response.totals).toEqual({ checkins: 7, checkinsWithPhoto: 3, users: 4, comments: 3 })
  })

  it('縣市分布依數量遞減排序，數量相同時依縣市名稱遞增排序', async () => {
    const { response } = await populatedContext()
    expect(response.countyDistribution).toEqual([
      { county: '臺北市', count: 3 },
      { county: '花蓮縣', count: 2 },
      { county: '南投縣', count: 1 }, // 與高雄市同分，縣市名稱遞增排序下 南投縣 在前
      { county: '高雄市', count: 1 }
    ])
  })

  it('最活躍作者排除無主旅箋與零旅箋的會員，同分依會員編號排序', async () => {
    const { response, ids } = await populatedContext()
    expect(response.topAuthors).toEqual([
      { userId: ids.authorA.id, displayName: '愛旅行的 A', avatarUrl: null, checkinCount: 3 },
      { userId: ids.authorB.id, displayName: '偶爾出遊的 B', avatarUrl: null, checkinCount: 3 }
    ])
    // authorC 註冊了帳號但從沒寫過旅箋，「最活躍作者」談的是實際貢獻，不該上榜
    expect(response.topAuthors.some(author => author.userId === ids.authorC.id)).toBe(false)
  })

  it('近期活動一律照 created_at 排序而不是 visited_at——兩者刻意設成相反的順序', async () => {
    const { response, ids } = await populatedContext()
    expect(response.recentActivity.checkins.map(item => item.id)).toEqual([
      ids.row1.id, ids.row4.id, ids.row2.id, ids.row7.id, ids.row3.id, ids.row5.id, ids.row6.id
    ])
    expect(response.recentActivity.comments.map(item => item.nickname)).toEqual(['留言者一', '留言者二', '留言者三'])
  })

  it('每日時間序列維持固定 30 天骨架，缺口補 0，超出視窗的資料不出現', async () => {
    const { response } = await populatedContext()
    const { daily } = response.timeSeries
    expect(daily).toHaveLength(30)
    expect(daily[0]).toEqual({ date: '2026-01-17', newCheckins: 0, newUsers: 0 }) // 視窗最舊一天，沒資料但仍在骨架裡
    expect(daily[27]).toEqual({ date: '2026-02-13', newCheckins: 1, newUsers: 1 }) // row2 與 authorA 註冊同一天
    expect(daily[28]).toEqual({ date: '2026-02-14', newCheckins: 1, newUsers: 1 }) // row4 與 authorB 註冊同一天
    expect(daily[29]).toEqual({ date: '2026-02-15', newCheckins: 1, newUsers: 1 }) // row1 與 admin 登入同一天（今天）
    expect(daily[26]).toEqual({ date: '2026-02-12', newCheckins: 0, newUsers: 0 }) // 刻意留白的缺口日
    expect(daily[24]).toEqual({ date: '2026-02-10', newCheckins: 1, newUsers: 0 }) // row7：無主旅箋一樣算進每日總數
    expect(daily[19]).toEqual({ date: '2026-02-05', newCheckins: 1, newUsers: 0 }) // row3
    // row5（30 天前）與 row6（100 天前）都在每日視窗外，總和只會看到 row1/2/3/4/7 這 5 筆
    expect(daily.reduce((sum, point) => sum + point.newCheckins, 0)).toBe(5)
    // authorC（40 天前）在每日視窗外，總和只會看到 admin/authorA/authorB
    expect(daily.reduce((sum, point) => sum + point.newUsers, 0)).toBe(3)
  })

  it('每週時間序列維持固定 12 週骨架，週界以星期一起算，視窗比每日寬所以撈得到 40 天前的資料', async () => {
    const { response } = await populatedContext()
    const { weekly } = response.timeSeries
    expect(weekly).toHaveLength(12)
    expect(weekly[11]).toEqual({ weekStart: '2026-02-09', newCheckins: 4, newUsers: 3 }) // row1,2,4,7 + admin,authorA,authorB
    expect(weekly[10]).toEqual({ weekStart: '2026-02-02', newCheckins: 1, newUsers: 0 }) // row3
    expect(weekly[7]).toEqual({ weekStart: '2026-01-12', newCheckins: 1, newUsers: 0 }) // row5：每日視窗外，每週視窗內
    expect(weekly[6]).toEqual({ weekStart: '2026-01-05', newCheckins: 0, newUsers: 1 }) // authorC 註冊那一週
    // row6（100 天前）連每週視窗都超出，總和比每日多算到 row5、但看不到 row6
    expect(weekly.reduce((sum, point) => sum + point.newCheckins, 0)).toBe(6)
    // 每週視窗夠寬，4 位使用者（含 40 天前註冊的 authorC）全部落在範圍內
    expect(weekly.reduce((sum, point) => sum + point.newUsers, 0)).toBe(4)
  })
})
