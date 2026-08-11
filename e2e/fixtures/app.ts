import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import type { BrowserContext, Page } from '@playwright/test'

export const baseURL = 'http://127.0.0.1:3200'
export const identities = {
  admin: { discordId: '123456789012345678', username: 'layout-admin', displayName: '版面管理員', role: 'admin' },
  member: { discordId: '223456789012345678', username: 'layout-member', displayName: '測試旅人', role: 'user' },
  expired: { discordId: '323456789012345678', username: 'expired-member', displayName: '過期旅人', role: 'user' }
} as const
export const sessionTokens = {
  admin: 'admin-session-token-with-enough-entropy-for-e2e',
  member: 'member-session-token-with-enough-entropy-for-e2e',
  expired: 'expired-session-token-with-enough-entropy-for-e2e',
  revocable: 'revocable-session-token-with-enough-entropy-for-e2e'
} as const

function databasePath() {
  const directory = process.env.JOURNEY_UNFINISHED_E2E_DIR
  if (!directory) throw new Error('JOURNEY_UNFINISHED_E2E_DIR is not configured')
  return path.join(directory, 'app.sqlite')
}

export function sessionHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 上傳測試要用真的能解碼的圖片：伺服器會用 sharp 重新編碼以剝除 EXIF/GPS，
 * 只湊出 magic bytes 的假檔案會在解碼階段就被擋成 415，測不到它後面的任何行為。
 */
export function sampleJpeg(background = '#d9677e') {
  return sharp({ create: { width: 32, height: 32, channels: 3, background } }).jpeg().toBuffer()
}

export async function seedApplication() {
  const response = await fetch(`${baseURL}/api/checkins`)
  if (!response.ok) throw new Error(`Unable to initialize app: ${await response.text()}`)

  const db = new Database(databasePath())
  for (const identity of Object.values(identities)) {
    db.prepare(`
      INSERT INTO users (discord_id, username, display_name, role)
      VALUES (@discordId, @username, @displayName, @role)
      ON CONFLICT(discord_id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        role = excluded.role
    `).run(identity)
  }
  const rows = db.prepare('SELECT id, discord_id AS discordId FROM users').all() as Array<{ id: number, discordId: string }>
  const userIds = new Map(rows.map(row => [row.discordId, row.id]))
  const future = Date.now() + 60 * 60 * 1000
  const expired = Date.now() - 1
  const insertSession = db.prepare('INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
  insertSession.run(sessionHash(sessionTokens.admin), userIds.get(identities.admin.discordId), future)
  insertSession.run(sessionHash(sessionTokens.member), userIds.get(identities.member.discordId), future)
  insertSession.run(sessionHash(sessionTokens.expired), userIds.get(identities.expired.discordId), expired)
  insertSession.run(sessionHash(sessionTokens.revocable), userIds.get(identities.member.discordId), future)
  await seedCheckins(db, userIds.get(identities.member.discordId)!)
  const firstCheckin = db.prepare(`SELECT id FROM checkins WHERE nickname = '${FIXTURE_NICKNAME}' ORDER BY id LIMIT 1`)
    .get() as { id: number }
  db.close()
  return { firstCheckinId: firstCheckin.id }
}

// 應用程式本身不再帶示範資料 —— 全新安裝就是一張空地圖。需要有旅箋才跑得動的測試
// （詳情頁的版面、留言、地圖側欄）因此得自己準備，這也讓它們不再受應用程式示範內容改動的影響。
const FIXTURE_NICKNAME = 'E2E 旅人'

async function seedCheckins(db: Database.Database, userId: number) {
  // 每個 beforeEach 都會呼叫 seedApplication，所以這裡必須是冪等的：已經鋪好就直接離開，
  // 否則跑完整輪測試會累積出幾十則一模一樣的旅箋。
  const existing = db.prepare(`SELECT COUNT(*) AS count FROM checkins WHERE nickname = '${FIXTURE_NICKNAME}'`)
    .get() as { count: number }
  if (existing.count) return

  const uploadDir = path.join(process.env.JOURNEY_UNFINISHED_E2E_DIR!, 'uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  // 圖檔要真的存在：詳情頁與卡片會把它算進版面，破圖會讓版面測試量到錯的高度。
  async function writeImage(name: string, background: string) {
    fs.writeFileSync(path.join(uploadDir, name), await sampleJpeg(background))
    return `/uploads/${name}`
  }

  const rows = [
    { location: '嵐山竹林小徑', countryCode: 'JP', county: '京都府', latitude: 35.0169, longitude: 135.6716, dollName: '小柚', series: '夏日重現', message: '## 竹林的清晨\n\n六點的竹林還沒有人，只有風。\n\n- 記得帶**廣角鏡**\n- 回程繞去渡月橋', visitedAt: '2025-11-03' },
    { location: '淡水漁人碼頭', countryCode: 'TW', county: '新北市', latitude: 25.1826, longitude: 121.4106, dollName: '暖暖', series: null, message: '追到一場橘粉色的夕陽，海風把今天吹得很溫柔。', visitedAt: '2025-05-18' },
    { location: 'Reynisfjara 黑沙灘', countryCode: 'IS', county: 'Suðurland', latitude: 63.4056, longitude: -19.0448, dollName: '雪球', series: null, message: '浪很大、風更大，但玄武岩柱像一整排管風琴。', visitedAt: '2025-09-21' }
  ]
  const insert = db.prepare(`
    INSERT INTO checkins
      (user_id, nickname, location, country_code, county, latitude, longitude, doll_name, series, message, visited_at, photo, avatar)
    VALUES
      (@userId, @nickname, @location, @countryCode, @county, @latitude, @longitude, @dollName, @series, @message, @visitedAt, @photo, @avatar)`)

  let firstId: number | null = null
  for (const [index, row] of rows.entries()) {
    const photo = await writeImage(`photo-e2e-fixture-${index}.jpg`, '#d9677e')
    const avatar = await writeImage(`avatar-e2e-fixture-${index}.jpg`, '#3f705d')
    const result = insert.run({ ...row, userId, nickname: FIXTURE_NICKNAME, photo, avatar })
    if (firstId === null) firstId = Number(result.lastInsertRowid)
  }
  // 留言測試要有一則已經存在的留言才驗得到「新留言接在既有的後面」
  db.prepare('INSERT INTO comments (checkin_id, nickname, message) VALUES (?, ?, ?)')
    .run(firstId, '路過的旅人', '夕陽顏色好夢幻，下次也想帶娃娃去！')
}

/**
 * 草稿是跨測試殘留的狀態：同一個 e2e 資料庫會被整輪測試共用，前一個案例存下的草稿
 * 會讓下一個案例的「應該只有一份草稿」變成三份。每個草稿測試開始前清空，彼此才獨立。
 */
export function clearDrafts() {
  const db = new Database(databasePath())
  db.prepare('DELETE FROM checkin_drafts').run()
  db.close()
}

export function deleteSession(token: string) {
  const db = new Database(databasePath())
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sessionHash(token))
  db.close()
}

export function sessionExists(token: string) {
  const db = new Database(databasePath(), { readonly: true })
  const row = db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash = ?').get(sessionHash(token))
  db.close()
  return Boolean(row)
}

export function ownerDiscordId(checkinId: number) {
  const db = new Database(databasePath(), { readonly: true })
  const row = db.prepare(`
    SELECT u.discord_id AS discordId
    FROM checkins c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(checkinId) as { discordId: string | null } | undefined
  db.close()
  return row?.discordId || null
}

export async function authenticate(context: BrowserContext, type: keyof typeof sessionTokens) {
  await context.addCookies([{ name: 'journey-unfinished-session', value: sessionTokens[type], url: baseURL }])
}

export async function waitForHydration(page: Page) {
  await page.waitForFunction(() => Boolean((document.querySelector('#__nuxt') as HTMLElement & { __vue_app__?: unknown })?.__vue_app__))
}
