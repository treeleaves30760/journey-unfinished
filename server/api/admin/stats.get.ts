import { requireAdmin } from '../../utils/auth'
import { getDatabase } from '../../utils/database'

// 站台鎖定台灣使用者。SQLite 的 CURRENT_TIMESTAMP 存的是不含時區資訊的 UTC 字串，
// 若直接按 UTC 日界切「每日」，晚上 8 點後（台北時間）寫下的資料會被算進隔天，
// 折線圖的日期標籤也會跟使用者體感的「今天」對不上。台灣全年沒有日光節約時間，
// 所以固定加 8 小時再取日期字串，就能還原成台北時間的日曆日期——SQL 聚合與底下
// 的 JS 都用同一個位移量，兩邊算出來的「日期」才會是同一把尺。
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAILY_WINDOW_DAYS = 30
const WEEKLY_WINDOW_WEEKS = 12
const TOP_AUTHOR_LIMIT = 10
const RECENT_ACTIVITY_LIMIT = 8

interface DayCount { day: string, count: number }
export interface DailyPoint { date: string, newCheckins: number, newUsers: number }
export interface WeeklyPoint { weekStart: string, newCheckins: number, newUsers: number }

export function taipeiDateString(epochMs: number): string {
  return new Date(epochMs + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
}

// 該日期字串所在週的星期一（ISO 週定義）。輸入輸出都是不含時分秒的日曆日期字串，
// 這裡純粹是日期算術，不需要再牽扯時區位移（taipeiDateString 已經處理過一次）。
export function mondayOf(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00Z`)
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceMonday)
  return date.toISOString().slice(0, 10)
}

export function lastNDays(count: number, endDateString: string): string[] {
  const end = new Date(`${endDateString}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end)
    date.setUTCDate(date.getUTCDate() - (count - 1 - index))
    return date.toISOString().slice(0, 10)
  })
}

export function lastNWeeks(count: number, endDateString: string): string[] {
  const endMonday = new Date(`${mondayOf(endDateString)}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(endMonday)
    date.setUTCDate(date.getUTCDate() - (count - 1 - index) * 7)
    return date.toISOString().slice(0, 10)
  })
}

function toWeeklyCounts(byDay: Map<string, number>): Map<string, number> {
  const weekly = new Map<string, number>()
  for (const [day, count] of byDay) {
    const week = mondayOf(day)
    weekly.set(week, (weekly.get(week) ?? 0) + count)
  }
  return weekly
}

function dayCountMap(rows: DayCount[]): Map<string, number> {
  return new Map(rows.map(row => [row.day, row.count]))
}

/**
 * 時間序列的缺口處理：GROUP BY 只會回傳「有資料的那幾天」，中間沒人寫旅箋、沒人
 * 註冊的日子會直接從結果消失。折線圖如果照這份結果原樣描點，X 軸的間距就會忽長
 * 忽短，讀圖的人會把「沒資料被跳過」誤讀成「趨勢變化」。
 *
 * 做法分兩段：SQL 只負責把整張表依日期分組聚合（GROUP BY + COUNT，聚合本身仍在
 * 資料庫引擎內一次掃描完成，回傳的列數等於「有資料的天數」，不是表的總列數）；
 * 這裡再用一份固定長度（30 天／12 週）的日期骨架去查表補 0——骨架長度是常數，
 * 跟資料表大小無關，不是「把整張表撈出來在 JS 裡算」。
 */
export function buildTimeSeries(checkinsByDay: Map<string, number>, usersByDay: Map<string, number>, today: string) {
  const daily: DailyPoint[] = lastNDays(DAILY_WINDOW_DAYS, today).map(date => ({
    date,
    newCheckins: checkinsByDay.get(date) ?? 0,
    newUsers: usersByDay.get(date) ?? 0
  }))

  const weeklyCheckins = toWeeklyCounts(checkinsByDay)
  const weeklyUsers = toWeeklyCounts(usersByDay)
  const weekly: WeeklyPoint[] = lastNWeeks(WEEKLY_WINDOW_WEEKS, today).map(weekStart => ({
    weekStart,
    newCheckins: weeklyCheckins.get(weekStart) ?? 0,
    newUsers: weeklyUsers.get(weekStart) ?? 0
  }))

  return { daily, weekly }
}

export default defineEventHandler((event) => {
  requireAdmin(event)
  const db = getDatabase()

  // COUNT(photo) 只算非 NULL 的列，一次查詢同時拿到旅箋總數與有照片的旅箋數，
  // 不必為了兩個數字對同一張表跑兩趟全表掃描。
  const checkinTotals = db.prepare(
    'SELECT COUNT(*) AS total, COUNT(photo) AS withPhoto FROM checkins'
  ).get() as { total: number, withPhoto: number }
  const userTotal = (db.prepare('SELECT COUNT(*) AS total FROM users').get() as { total: number }).total
  const commentTotal = (db.prepare('SELECT COUNT(*) AS total FROM comments').get() as { total: number }).total

  // 時間序列一律採 created_at（寫下的當下），不用 visited_at：visited_at 是使用者
  // 自填的旅行日期，可以回填任何過去的日子，拿它畫「新增趨勢」只會做出一張跟站台
  // 實際成長曲線無關、忽快忽慢的假圖。users 同理用 created_at（帳號建立時間；
  // upsertDiscordUser 的 ON CONFLICT 分支不會改寫這一欄），不是 last_login_at——
  // 那一欄記的是「回訪」，不是「新增會員」。
  const checkinsByDay = dayCountMap(db.prepare(
    "SELECT date(created_at, '+8 hours') AS day, COUNT(*) AS count FROM checkins GROUP BY day"
  ).all() as DayCount[])
  const usersByDay = dayCountMap(db.prepare(
    "SELECT date(created_at, '+8 hours') AS day, COUNT(*) AS count FROM users GROUP BY day"
  ).all() as DayCount[])
  const timeSeries = buildTimeSeries(checkinsByDay, usersByDay, taipeiDateString(Date.now()))

  // 縣市分布是類別排行，不是連續時間軸，沒有「缺口扭曲」的問題——沒有旅箋的縣市
  // 本來就該從長條圖裡消失，硬塞 0 值長條反而製造視覺雜訊，所以這裡不做零值補齊。
  const countyDistribution = db.prepare(
    'SELECT county, COUNT(*) AS count FROM checkins GROUP BY county ORDER BY count DESC, county ASC'
  ).all() as Array<{ county: string, count: number }>

  // INNER JOIN 天然排除 user_id IS NULL 的旅箋（demo 種子資料，或作者帳號已被刪除、
  // 外鍵 SET NULL 留下的舊資料）——「最活躍作者」談的是可辨識的會員排行，無主旅箋
  // 沒有作者可歸功，不該混進榜單，也不需要額外的 WHERE 子句特別排除。
  const topAuthors = db.prepare(`
    SELECT u.id AS userId, u.display_name AS displayName, u.avatar_url AS avatarUrl, COUNT(c.id) AS checkinCount
    FROM checkins c JOIN users u ON u.id = c.user_id
    GROUP BY u.id
    ORDER BY checkinCount DESC, u.id ASC
    LIMIT ?
  `).all(TOP_AUTHOR_LIMIT) as Array<{ userId: number, displayName: string, avatarUrl: string | null, checkinCount: number }>

  // 近期活動一樣用 created_at 排序：這裡要回答「站上剛剛發生了什麼」，一則今天寫下、
  // 內容卻是三年前旅行的旅箋，仍然要出現在「最新旅箋」的最上方。多帶 avatar／avatarPreset
  // ／dollName／visitedAt 是為了讓管理頁能直接重用 pages/admin/index.vue 那份
  // 「旅箋管理」列表的既有樣式（DollAvatar + 位置 + 暱稱與娃娃 + 造訪日期），不必另外畫一套。
  const recentCheckins = db.prepare(`
    SELECT id, location, nickname, county, doll_name AS dollName, avatar, avatar_preset AS avatarPreset,
      visited_at AS visitedAt, created_at AS createdAt
    FROM checkins ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(RECENT_ACTIVITY_LIMIT) as Array<{
    id: number, location: string, nickname: string, county: string, dollName: string,
    avatar: string | null, avatarPreset: string, visitedAt: string, createdAt: string
  }>

  const recentComments = db.prepare(`
    SELECT cm.id, cm.checkin_id AS checkinId, c.location AS checkinLocation,
      cm.nickname, cm.message, cm.created_at AS createdAt
    FROM comments cm JOIN checkins c ON c.id = cm.checkin_id
    ORDER BY cm.created_at DESC, cm.id DESC LIMIT ?
  `).all(RECENT_ACTIVITY_LIMIT) as Array<{
    id: number, checkinId: number, checkinLocation: string, nickname: string, message: string, createdAt: string
  }>

  return {
    totals: {
      checkins: checkinTotals.total,
      checkinsWithPhoto: checkinTotals.withPhoto,
      users: userTotal,
      comments: commentTotal
    },
    timeSeries,
    countyDistribution,
    topAuthors,
    recentActivity: { checkins: recentCheckins, comments: recentComments }
  }
})
