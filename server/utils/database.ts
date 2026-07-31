import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { CheckinInput } from './validation'

export interface Checkin extends CheckinInput {
  id: number
  userId: number | null
  photo: string | null
  avatar: string | null
  createdAt: string
  commentCount: number
}

export interface Comment {
  id: number
  nickname: string
  message: string
  createdAt: string
}

export interface User {
  id: number
  discordId: string
  username: string
  displayName: string
  avatarUrl: string | null
  role: 'user' | 'admin'
  createdAt: string
  lastLoginAt: string
}

type SQLiteDatabase = InstanceType<typeof Database>
let database: SQLiteDatabase | undefined

const DATABASE_FILENAME = 'journey-unfinished.sqlite'
const LEGACY_DATABASE_FILENAME = 'wa-trip.sqlite'

// 四個查詢共用同一份欄位清單，欄位增減時不會有人漏掉其中一個而讓回傳形狀分岔
const userColumns = `id, discord_id AS discordId, username, display_name AS displayName,
  avatar_url AS avatarUrl, role, created_at AS createdAt, last_login_at AS lastLoginAt`

const baseSelect = `
  SELECT c.id, c.user_id AS userId, c.nickname, c.location, c.county,
    c.latitude, c.longitude, c.doll_name AS dollName,
    c.message, c.visited_at AS visitedAt,
    c.photo, c.avatar, c.avatar_preset AS avatarPreset,
    c.created_at AS createdAt,
    COUNT(cm.id) AS commentCount
  FROM checkins c LEFT JOIN comments cm ON cm.checkin_id = c.id`

function seed(db: SQLiteDatabase) {
  const seedMarker = db.prepare("SELECT value FROM app_meta WHERE key = 'demo_seeded'").get() as { value: string } | undefined
  if (seedMarker) return
  const count = db.prepare('SELECT COUNT(*) AS count FROM checkins').get() as { count: number }
  if (count.count) {
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('demo_seeded', 'legacy')").run()
    return
  }

  const insert = db.prepare(`
    INSERT INTO checkins
      (nickname, location, county, latitude, longitude, doll_name, message, visited_at, avatar_preset)
    VALUES
      (@nickname, @location, @county, @latitude, @longitude, @dollName, @message, @visitedAt, @avatarPreset)`)

  const examples = [
    { nickname: '小晴', location: '淡水漁人碼頭', county: '新北市', latitude: 25.1826, longitude: 121.4106, dollName: '暖暖', message: '追到一場橘粉色的夕陽，海風把今天吹得很溫柔。', visitedAt: '2025-05-18', avatarPreset: 'sun' },
    { nickname: '森友', location: '阿里山森林遊樂區', county: '嘉義縣', latitude: 23.5102, longitude: 120.8024, dollName: '芽芽', message: '一起搭小火車穿過霧氣，巨木林像童話的入口。', visitedAt: '2025-04-09', avatarPreset: 'leaf' },
    { nickname: '海鹽', location: '三仙台', county: '臺東縣', latitude: 23.123, longitude: 121.409, dollName: '藍藍', message: '清晨的浪一層一層發亮，這次也留下最喜歡的合照。', visitedAt: '2025-03-22', avatarPreset: 'ocean' },
    { nickname: '米粒', location: '日月潭向山', county: '南投縣', latitude: 23.8515, longitude: 120.9021, dollName: '糰子', message: '沿著湖畔散步，雲朵和山都倒映在安靜的水面。', visitedAt: '2025-02-14', avatarPreset: 'cloud' },
    { nickname: '莓果', location: '高美濕地', county: '臺中市', latitude: 24.3118, longitude: 120.5492, dollName: '莓莓', message: '風車、潮間帶和小小的腳印，都是今天的旅行紀念。', visitedAt: '2025-01-26', avatarPreset: 'berry' },
    { nickname: '桃桃', location: '旗津彩虹教堂', county: '高雄市', latitude: 22.6101, longitude: 120.2664, dollName: '小桃', message: '南方的陽光正好，和最可愛的旅伴看了整片藍色海岸。', visitedAt: '2024-12-08', avatarPreset: 'peach' }
  ]
  const transaction = db.transaction(() => {
    let firstId: number | null = null
    examples.forEach((example) => {
      const result = insert.run(example)
      if (firstId === null) firstId = Number(result.lastInsertRowid)
    })
    if (firstId !== null) {
      db.prepare('INSERT INTO comments (checkin_id, nickname, message) VALUES (?, ?, ?)').run(firstId, '路過的旅人', '夕陽顏色好夢幻，下次也想帶娃娃去！')
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('demo_seeded', '1')").run()
  })
  transaction()
}

export function getDatabase(): SQLiteDatabase {
  if (database) return database
  const config = useRuntimeConfig()
  const configuredFilename = path.resolve(String(config.databasePath))
  const legacyFilename = path.join(path.dirname(configuredFilename), LEGACY_DATABASE_FILENAME)
  const filename = path.basename(configuredFilename) === DATABASE_FILENAME
    && !fs.existsSync(configuredFilename)
    && fs.existsSync(legacyFilename)
    ? legacyFilename
    : configuredFilename
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  database = new Database(filename)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 30),
      location TEXT NOT NULL CHECK(length(location) BETWEEN 2 AND 80),
      county TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      doll_name TEXT NOT NULL CHECK(length(doll_name) BETWEEN 1 AND 40),
      message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 500),
      visited_at TEXT NOT NULL,
      photo TEXT,
      avatar TEXT,
      avatar_preset TEXT NOT NULL DEFAULT 'sun',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 30),
      message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 300),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_comments_checkin ON comments(checkin_id);
  `)

  const checkinColumns = database.prepare('PRAGMA table_info(checkins)').all() as Array<{ name: string }>
  if (!checkinColumns.some(column => column.name === 'user_id')) {
    database.exec('ALTER TABLE checkins ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL')
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
  `)
  seed(database)
  return database
}

export function listCheckins(): Checkin[] {
  return getDatabase().prepare(`${baseSelect} GROUP BY c.id ORDER BY c.visited_at DESC, c.id DESC`).all() as Checkin[]
}

export function findCheckin(id: number): Checkin | undefined {
  return getDatabase().prepare(`${baseSelect} WHERE c.id = ? GROUP BY c.id`).get(id) as Checkin | undefined
}

export function createCheckin(input: CheckinInput, photo: string | null, avatar: string | null, userId: number): Checkin {
  const result = getDatabase().prepare(`
    INSERT INTO checkins
      (user_id, nickname, location, county, latitude, longitude, doll_name, message, visited_at, photo, avatar, avatar_preset)
    VALUES
      (@userId, @nickname, @location, @county, @latitude, @longitude, @dollName, @message, @visitedAt, @photo, @avatar, @avatarPreset)`)
    .run({ ...input, photo, avatar, userId })
  return findCheckin(Number(result.lastInsertRowid))!
}

export function deleteCheckin(id: number) {
  return getDatabase().prepare('DELETE FROM checkins WHERE id = ?').run(id).changes > 0
}

export function listComments(checkinId: number): Comment[] {
  return getDatabase().prepare(`
    SELECT id, nickname, message, created_at AS createdAt
    FROM comments WHERE checkin_id = ? ORDER BY id ASC`).all(checkinId) as Comment[]
}

export function createComment(checkinId: number, nickname: string, message: string): Comment {
  const result = getDatabase().prepare(
    'INSERT INTO comments (checkin_id, nickname, message) VALUES (?, ?, ?)'
  ).run(checkinId, nickname, message)
  return getDatabase().prepare(`
    SELECT id, nickname, message, created_at AS createdAt FROM comments WHERE id = ?`
  ).get(result.lastInsertRowid) as Comment
}

/**
 * 這裡完全不碰 role —— 登入既不寫入也不覆寫它。兩層管理員因此互不汙染：
 *
 * - 設定管理員（NUXT_ADMIN_DISCORD_IDS）純粹在每次請求時計算，從不落地。
 *   把某人從環境變數移除，下一個請求就立刻失去管理權，不會有殘留。
 * - 授權管理員（users.role）只由 setUserRole 寫入，也就是只由管理頁授權。
 *   重新登入不會把它洗掉。
 *
 * 若讓登入寫入由環境變數推導的 role，設定管理員第一次登入就會把 'admin'
 * 固化進資料列，之後從環境變數移除他也撤銷不掉 —— 文件寫的撤銷方式會靜默失效。
 * INSERT 不列 role 欄位，交給 schema 的 DEFAULT 'user'。
 */
export function upsertDiscordUser(input: {
  discordId: string
  username: string
  displayName: string
  avatarUrl: string | null
}): User {
  getDatabase().prepare(`
    INSERT INTO users (discord_id, username, display_name, avatar_url)
    VALUES (@discordId, @username, @displayName, @avatarUrl)
    ON CONFLICT(discord_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      last_login_at = CURRENT_TIMESTAMP
  `).run(input)
  return getDatabase().prepare(`SELECT ${userColumns} FROM users WHERE discord_id = ?`).get(input.discordId) as User
}

export function createAuthSession(tokenHash: string, userId: number, expiresAt: number) {
  const db = getDatabase()
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now())
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash, userId, expiresAt)
}

export function findUserBySession(tokenHash: string, now = Date.now()): (User & { sessionExpiresAt: number }) | undefined {
  return getDatabase().prepare(`
    SELECT u.id, u.discord_id AS discordId, u.username, u.display_name AS displayName,
      u.avatar_url AS avatarUrl, u.role, u.created_at AS createdAt,
      u.last_login_at AS lastLoginAt, s.expires_at AS sessionExpiresAt
    FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, now) as (User & { sessionExpiresAt: number }) | undefined
}

export function deleteAuthSession(tokenHash: string) {
  getDatabase().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash)
}

export function listUsers(): User[] {
  return getDatabase().prepare(`SELECT ${userColumns} FROM users ORDER BY last_login_at DESC, id DESC`).all() as User[]
}

export function findUserById(id: number): User | undefined {
  return getDatabase().prepare(`SELECT ${userColumns} FROM users WHERE id = ?`).get(id) as User | undefined
}

/**
 * 授權管理員這一層的唯一寫入點。role 走參數繫結，且 users.role 有 CHECK 約束把關，
 * 就算呼叫端漏了驗證也寫不進第三種值。回傳更新後的資料列；資料列已不存在時回 undefined。
 */
export function setUserRole(id: number, role: 'user' | 'admin'): User | undefined {
  getDatabase().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id)
  return findUserById(id)
}

export function closeDatabaseForTests() {
  database?.close()
  database = undefined
}
