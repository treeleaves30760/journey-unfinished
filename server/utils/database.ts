import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DEFAULT_COUNTRY_CODE } from '../../utils/countries'
import { MAX_MESSAGE_LENGTH, type CheckinInput, type DollInput, type DraftInput } from './validation'

export interface Checkin extends CheckinInput {
  id: number
  userId: number | null
  /** 關聯到的娃娃檔案；舊資料與檔案被刪掉之後都是 null，旅箋本身的 dollName 仍在 */
  dollId: number | null
  photo: string | null
  avatar: string | null
  createdAt: string
  commentCount: number
}

export interface Draft extends DraftInput {
  id: number
  userId: number
  photo: string | null
  avatar: string | null
  createdAt: string
  updatedAt: string
}

/**
 * 娃娃檔案：名稱、作品出處與頭像存一次，寫旅箋時直接選。
 *
 * 旅箋仍然各自保留 doll_name／series／avatar 的副本，不是join 出來的 —— 一則旅箋是
 * 當下的紀錄，之後把娃娃改名不該回頭改寫歷史。doll_id 只是「這幾則是同一隻」的關聯，
 * 娃娃被刪除時設成 NULL，旅箋本身完全不受影響。
 */
export interface Doll {
  id: number
  userId: number
  name: string
  series: string | null
  avatar: string | null
  avatarPreset: string
  createdAt: string
  updatedAt: string
  /** 最近一次被用來寫旅箋的時間。選擇器靠它決定預設選哪一隻。 */
  lastUsedAt: string | null
  /** 一起走過幾個地方，管理頁用 */
  checkinCount: number
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
  SELECT c.id, c.user_id AS userId, c.doll_id AS dollId, c.nickname, c.location,
    c.country_code AS countryCode, c.county,
    c.latitude, c.longitude, c.doll_name AS dollName, c.series,
    c.message, c.visited_at AS visitedAt,
    c.photo, c.avatar, c.avatar_preset AS avatarPreset,
    c.created_at AS createdAt,
    COUNT(cm.id) AS commentCount
  FROM checkins c LEFT JOIN comments cm ON cm.checkin_id = c.id`

const draftColumns = `id, user_id AS userId, nickname, location, country_code AS countryCode, county,
  latitude, longitude, doll_id AS dollId, doll_name AS dollName, series, message, visited_at AS visitedAt,
  photo, avatar, avatar_preset AS avatarPreset, created_at AS createdAt, updated_at AS updatedAt`

// checkinCount 走子查詢而不是 LEFT JOIN + GROUP BY：娃娃只有幾隻，但旅箋會一直長，
// 用 GROUP BY 會讓「沒有旅箋的娃娃」需要額外處理 NULL，子查詢直接回 0 乾淨得多。
const dollColumns = `d.id, d.user_id AS userId, d.name, d.series, d.avatar,
  d.avatar_preset AS avatarPreset, d.created_at AS createdAt, d.updated_at AS updatedAt,
  d.last_used_at AS lastUsedAt,
  (SELECT COUNT(*) FROM checkins c WHERE c.doll_id = d.id) AS checkinCount`

/**
 * checkins 的權威定義只有這一份，重建表格時（見 migrateCheckins）沿用同一個字串，
 * 「新資料庫」與「舊資料庫遷移後」的 schema 因此不可能分岔。
 * message 的上限與 validation.ts 的 MAX_MESSAGE_LENGTH 綁在一起：兩邊都改才算改完。
 */
function checkinsTableSql(tableName: string) {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      doll_id INTEGER REFERENCES dolls(id) ON DELETE SET NULL,
      nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 30),
      location TEXT NOT NULL CHECK(length(location) BETWEEN 2 AND 80),
      country_code TEXT NOT NULL DEFAULT '${DEFAULT_COUNTRY_CODE}' CHECK(length(country_code) = 2),
      county TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      doll_name TEXT NOT NULL CHECK(length(doll_name) BETWEEN 1 AND 40),
      series TEXT CHECK(series IS NULL OR length(series) BETWEEN 1 AND 60),
      message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND ${MAX_MESSAGE_LENGTH}),
      visited_at TEXT NOT NULL,
      photo TEXT,
      avatar TEXT,
      avatar_preset TEXT NOT NULL DEFAULT 'sun',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
}

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
      (nickname, location, country_code, county, latitude, longitude, doll_name, message, visited_at, avatar_preset)
    VALUES
      (@nickname, @location, @countryCode, @county, @latitude, @longitude, @dollName, @message, @visitedAt, @avatarPreset)`)

  // 示範資料刻意跨到臺灣以外，讓全新安裝一打開就看得出地圖是全球的，
  // 而不是要等第一則海外旅箋寫下來才發現支援。留言也順便示範 Markdown 的小標與清單。
  const examples = [
    { nickname: '小晴', location: '淡水漁人碼頭', countryCode: 'TW', county: '新北市', latitude: 25.1826, longitude: 121.4106, dollName: '暖暖', message: '追到一場橘粉色的夕陽，海風把今天吹得很溫柔。', visitedAt: '2025-05-18', avatarPreset: 'sun' },
    { nickname: '森友', location: '阿里山森林遊樂區', countryCode: 'TW', county: '嘉義縣', latitude: 23.5102, longitude: 120.8024, dollName: '芽芽', message: '一起搭小火車穿過霧氣，巨木林像童話的入口。', visitedAt: '2025-04-09', avatarPreset: 'leaf' },
    { nickname: '海鹽', location: '三仙台', countryCode: 'TW', county: '臺東縣', latitude: 23.123, longitude: 121.409, dollName: '藍藍', message: '清晨的浪一層一層發亮，這次也留下最喜歡的合照。', visitedAt: '2025-03-22', avatarPreset: 'ocean' },
    { nickname: '米粒', location: '日月潭向山', countryCode: 'TW', county: '南投縣', latitude: 23.8515, longitude: 120.9021, dollName: '糰子', message: '沿著湖畔散步，雲朵和山都倒映在安靜的水面。', visitedAt: '2025-02-14', avatarPreset: 'cloud' },
    { nickname: '莓果', location: '高美濕地', countryCode: 'TW', county: '臺中市', latitude: 24.3118, longitude: 120.5492, dollName: '莓莓', message: '風車、潮間帶和小小的腳印，都是今天的旅行紀念。', visitedAt: '2025-01-26', avatarPreset: 'berry' },
    { nickname: '桃桃', location: '旗津彩虹教堂', countryCode: 'TW', county: '高雄市', latitude: 22.6101, longitude: 120.2664, dollName: '小桃', message: '南方的陽光正好，和最可愛的旅伴看了整片藍色海岸。', visitedAt: '2024-12-08', avatarPreset: 'peach' },
    { nickname: '柚子', location: '嵐山竹林小徑', countryCode: 'JP', county: '京都府', latitude: 35.0169, longitude: 135.6716, dollName: '小柚', message: '## 竹林的清晨\n\n六點的竹林還沒有人，只有風。\n\n- 記得帶**廣角鏡**\n- 回程繞去渡月橋\n\n> 下次想在秋天再來一次。', visitedAt: '2025-11-03', avatarPreset: 'leaf' },
    { nickname: '北緯', location: 'Reynisfjara 黑沙灘', countryCode: 'IS', county: 'Suðurland', latitude: 63.4056, longitude: -19.0448, dollName: '雪球', message: '浪很大、風更大，但玄武岩柱像一整排管風琴。\n\n把旅伴放在石階上拍了整捲底片。', visitedAt: '2025-09-21', avatarPreset: 'ocean' }
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
    CREATE TABLE IF NOT EXISTS dolls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
      series TEXT CHECK(series IS NULL OR length(series) BETWEEN 1 AND 60),
      avatar TEXT,
      avatar_preset TEXT NOT NULL DEFAULT 'sun',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    );
    ${checkinsTableSql('checkins')};
    CREATE TABLE IF NOT EXISTS checkin_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doll_id INTEGER REFERENCES dolls(id) ON DELETE SET NULL,
      nickname TEXT CHECK(nickname IS NULL OR length(nickname) <= 30),
      location TEXT CHECK(location IS NULL OR length(location) <= 80),
      country_code TEXT CHECK(country_code IS NULL OR length(country_code) = 2),
      county TEXT CHECK(county IS NULL OR length(county) <= 40),
      latitude REAL,
      longitude REAL,
      doll_name TEXT CHECK(doll_name IS NULL OR length(doll_name) <= 40),
      series TEXT CHECK(series IS NULL OR length(series) <= 60),
      message TEXT CHECK(message IS NULL OR length(message) <= ${MAX_MESSAGE_LENGTH}),
      visited_at TEXT,
      photo TEXT,
      avatar TEXT,
      avatar_preset TEXT NOT NULL DEFAULT 'sun',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  migrateCheckins(database)
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);
    CREATE INDEX IF NOT EXISTS idx_checkin_drafts_user ON checkin_drafts(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dolls_user ON dolls(user_id, last_used_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_checkins_doll ON checkins(doll_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
  `)
  seed(database)
  return database
}

/**
 * 把既有資料庫拉到目前的 checkins schema。索引在這之後才建立，重建表格時被一併刪掉的
 * 索引因此會自動補回來。
 */
function migrateCheckins(db: SQLiteDatabase) {
  const checkinColumns = db.prepare('PRAGMA table_info(checkins)').all() as Array<{ name: string }>
  const hasColumn = (name: string) => checkinColumns.some(column => column.name === name)

  if (!hasColumn('user_id')) {
    db.exec('ALTER TABLE checkins ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL')
  }
  // 舊資料庫沒有這欄，一律補 NULL（等同「原創娃娃／未填寫作品」），不影響既有旅箋的顯示。
  // CHECK 約束照抄 CREATE TABLE 那份，讓補齊欄位後的舊資料庫和全新建立的資料庫 schema 一致。
  if (!hasColumn('series')) {
    db.exec('ALTER TABLE checkins ADD COLUMN series TEXT CHECK(series IS NULL OR length(series) BETWEEN 1 AND 60)')
  }
  // 全球化之前的旅箋全都在臺灣，補預設值 TW 就是正確答案，不需要人工回填。
  // 加上 NOT NULL + DEFAULT 的欄位時 SQLite 會直接用預設值填滿既有列。
  if (!hasColumn('country_code')) {
    db.exec(`ALTER TABLE checkins ADD COLUMN country_code TEXT NOT NULL DEFAULT '${DEFAULT_COUNTRY_CODE}' CHECK(length(country_code) = 2)`)
  }
  // 娃娃檔案是後來才有的，既有旅箋一律留 NULL —— 它們寫下的當時沒有可以關聯的檔案，
  // 硬去猜「名字一樣就是同一隻」會把不同人的同名娃娃綁在一起。
  if (!hasColumn('doll_id')) {
    db.exec('ALTER TABLE checkins ADD COLUMN doll_id INTEGER REFERENCES dolls(id) ON DELETE SET NULL')
  }
  const draftColumnNames = (db.prepare('PRAGMA table_info(checkin_drafts)').all() as Array<{ name: string }>)
    .map(column => column.name)
  if (!draftColumnNames.includes('doll_id')) {
    db.exec('ALTER TABLE checkin_drafts ADD COLUMN doll_id INTEGER REFERENCES dolls(id) ON DELETE SET NULL')
  }

  // message 的長度上限寫在 CHECK 約束裡，而 SQLite 不能單獨修改 CHECK —— 只能整張表重建。
  // 用「目前的 SQL 定義是否已經包含新上限」判斷，比記版本號可靠：不論這個資料庫是從哪一版
  // 升上來的，只要定義還是舊的就重建，已經是新的就完全不動。
  const definition = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'checkins'"
  ).get() as { sql: string } | undefined)?.sql || ''
  if (!new RegExp(`length\\(message\\)\\s+BETWEEN\\s+1\\s+AND\\s+${MAX_MESSAGE_LENGTH}`).test(definition)) {
    rebuildCheckins(db)
  }
}

/**
 * 標準的 SQLite「重建表格」流程（建新表 → 搬資料 → 丟舊表 → 改名）。
 *
 * 兩個非做不可的細節：
 * 1. 外鍵必須先關掉，否則 DROP TABLE checkins 會沿著 comments.checkin_id 的 ON DELETE CASCADE
 *    把所有留言一起刪光。關閉期間 comments 的資料列原封不動，改名後 id 對應關係仍然成立。
 * 2. PRAGMA foreign_keys 在交易內是無效指令，所以只能在交易外開關 —— 這也是為什麼
 *    finally 一定要把它開回來，否則整個 process 之後的外鍵約束都會失效。
 * 最後跑一次 foreign_key_check：寧可在啟動時大聲失敗，也不要讓孤兒留言悄悄留在資料庫裡。
 */
function rebuildCheckins(db: SQLiteDatabase) {
  const columns = `id, user_id, doll_id, nickname, location, country_code, county, latitude, longitude,
    doll_name, series, message, visited_at, photo, avatar, avatar_preset, created_at`
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      // DDL 在 SQLite 裡也受交易保護，理論上不會留下半成品；這行純粹是防呆，
      // 避免任何殘留的暫存表讓下面的 CREATE ... IF NOT EXISTS 靜默跳過、寫進舊結構。
      db.exec('DROP TABLE IF EXISTS checkins_migration')
      db.exec(checkinsTableSql('checkins_migration'))
      db.exec(`INSERT INTO checkins_migration (${columns}) SELECT ${columns} FROM checkins`)
      db.exec('DROP TABLE checkins')
      db.exec('ALTER TABLE checkins_migration RENAME TO checkins')
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  const violations = db.pragma('foreign_key_check') as unknown[]
  if (violations.length) {
    throw new Error(`checkins 重建後有 ${violations.length} 筆外鍵不一致，已中止啟動`)
  }
}

export function listCheckins(): Checkin[] {
  return getDatabase().prepare(`${baseSelect} GROUP BY c.id ORDER BY c.visited_at DESC, c.id DESC`).all() as Checkin[]
}

/**
 * 個人管理區與匯出用的「我的旅箋」。
 *
 * 這裡刻意用 SQL 的 `c.user_id = ?` 過濾，而不是讓前端拿 listCheckins() 再自己比對——
 * 種子資料與早期旅箋的 user_id 是 NULL，SQL 的 NULL 比較永遠不成立，正好是我們要的語意
 * （無主旅箋不屬於任何人）；換成 JavaScript 的 == 就會有機會把它們算成某個人的。
 */
export function listCheckinsByUser(userId: number): Checkin[] {
  return getDatabase().prepare(
    `${baseSelect} WHERE c.user_id = ? GROUP BY c.id ORDER BY c.visited_at DESC, c.id DESC`
  ).all(userId) as Checkin[]
}

export function findCheckin(id: number): Checkin | undefined {
  return getDatabase().prepare(`${baseSelect} WHERE c.id = ? GROUP BY c.id`).get(id) as Checkin | undefined
}

export function createCheckin(
  input: CheckinInput,
  photo: string | null,
  avatar: string | null,
  userId: number,
  dollId: number | null = null
): Checkin {
  const result = getDatabase().prepare(`
    INSERT INTO checkins
      (user_id, doll_id, nickname, location, country_code, county, latitude, longitude, doll_name, series, message, visited_at, photo, avatar, avatar_preset)
    VALUES
      (@userId, @dollId, @nickname, @location, @countryCode, @county, @latitude, @longitude, @dollName, @series, @message, @visitedAt, @photo, @avatar, @avatarPreset)`)
    // series 在 CheckinInput 上是可選屬性（舊呼叫端可能沒帶），先補 null 再讓 input 蓋過去；
    // countryCode 則是必填，不需要預設值。
    .run({ series: null, ...input, photo, avatar, userId, dollId })
  return findCheckin(Number(result.lastInsertRowid))!
}

export function deleteCheckin(id: number) {
  return getDatabase().prepare('DELETE FROM checkins WHERE id = ?').run(id).changes > 0
}

/**
 * 草稿：使用者在手機上拍完照、標好地點就先存著，回到電腦再打開同一筆繼續寫。
 * 因此它必須存在伺服器（而不是 localStorage），也因此每個欄位都允許是空的。
 */
export function listDrafts(userId: number): Draft[] {
  return getDatabase().prepare(
    `SELECT ${draftColumns} FROM checkin_drafts WHERE user_id = ? ORDER BY updated_at DESC, id DESC`
  ).all(userId) as Draft[]
}

export function findDraft(id: number): Draft | undefined {
  return getDatabase().prepare(`SELECT ${draftColumns} FROM checkin_drafts WHERE id = ?`).get(id) as Draft | undefined
}

export function countDrafts(userId: number): number {
  return (getDatabase().prepare('SELECT COUNT(*) AS count FROM checkin_drafts WHERE user_id = ?')
    .get(userId) as { count: number }).count
}

export function createDraft(userId: number, input: DraftInput, photo: string | null, avatar: string | null): Draft {
  const result = getDatabase().prepare(`
    INSERT INTO checkin_drafts
      (user_id, doll_id, nickname, location, country_code, county, latitude, longitude, doll_name, series, message, visited_at, photo, avatar, avatar_preset)
    VALUES
      (@userId, @dollId, @nickname, @location, @countryCode, @county, @latitude, @longitude, @dollName, @series, @message, @visitedAt, @photo, @avatar, @avatarPreset)`)
    .run({ ...input, photo, avatar, userId })
  return findDraft(Number(result.lastInsertRowid))!
}

/**
 * 圖片欄位刻意用三種值表達三種意圖：`undefined` 保留原圖（例如電腦端只改文字）、
 * `null` 清空、字串換成新檔。少了「保留」這個狀態，手機存好的照片會在桌機按下儲存時被清掉。
 */
export function updateDraft(
  id: number,
  input: DraftInput,
  photo: string | null | undefined,
  avatar: string | null | undefined
): Draft | undefined {
  getDatabase().prepare(`
    UPDATE checkin_drafts SET
      nickname = @nickname, location = @location, country_code = @countryCode, county = @county,
      latitude = @latitude, longitude = @longitude, doll_id = @dollId, doll_name = @dollName, series = @series,
      message = @message, visited_at = @visitedAt, avatar_preset = @avatarPreset,
      photo = CASE WHEN @keepPhoto = 1 THEN photo ELSE @photo END,
      avatar = CASE WHEN @keepAvatar = 1 THEN avatar ELSE @avatar END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id`)
    .run({
      ...input,
      id,
      photo: photo ?? null,
      avatar: avatar ?? null,
      keepPhoto: photo === undefined ? 1 : 0,
      keepAvatar: avatar === undefined ? 1 : 0
    })
  return findDraft(id)
}

export function deleteDraft(id: number) {
  return getDatabase().prepare('DELETE FROM checkin_drafts WHERE id = ?').run(id).changes > 0
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

/**
 * 娃娃檔案。排序把「最近用過的」放最前面，選擇器的預設值就是清單的第一筆 ——
 * 使用者連續替同一隻娃娃寫旅箋時完全不用選。從未用過的（lastUsedAt 為 NULL）排在後面，
 * 但仍以建立時間遞減排序，剛新增的那隻不會沉到最底下找不到。
 */
export function listDolls(userId: number): Doll[] {
  return getDatabase().prepare(`
    SELECT ${dollColumns} FROM dolls d
    WHERE d.user_id = ?
    ORDER BY d.last_used_at IS NULL, d.last_used_at DESC, d.id DESC`).all(userId) as Doll[]
}

export function findDoll(id: number): Doll | undefined {
  return getDatabase().prepare(`SELECT ${dollColumns} FROM dolls d WHERE d.id = ?`).get(id) as Doll | undefined
}

export function countDolls(userId: number): number {
  return (getDatabase().prepare('SELECT COUNT(*) AS count FROM dolls WHERE user_id = ?')
    .get(userId) as { count: number }).count
}

export function createDoll(userId: number, input: DollInput, avatar: string | null): Doll {
  const result = getDatabase().prepare(`
    INSERT INTO dolls (user_id, name, series, avatar, avatar_preset)
    VALUES (@userId, @name, @series, @avatar, @avatarPreset)`)
    .run({ ...input, avatar, userId })
  return findDoll(Number(result.lastInsertRowid))!
}

/** avatar 的三態與草稿相同：undefined 保留原圖、null 清空、字串換新檔。 */
export function updateDoll(id: number, input: DollInput, avatar: string | null | undefined): Doll | undefined {
  getDatabase().prepare(`
    UPDATE dolls SET
      name = @name, series = @series, avatar_preset = @avatarPreset,
      avatar = CASE WHEN @keepAvatar = 1 THEN avatar ELSE @avatar END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id`)
    .run({ ...input, id, avatar: avatar ?? null, keepAvatar: avatar === undefined ? 1 : 0 })
  return findDoll(id)
}

export function deleteDoll(id: number) {
  return getDatabase().prepare('DELETE FROM dolls WHERE id = ?').run(id).changes > 0
}

/** 發佈旅箋時記一筆「最近用過」，讓下一次的選擇器預設選它。 */
export function touchDoll(id: number) {
  getDatabase().prepare('UPDATE dolls SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
}

/**
 * 這個人上一則旅箋的暱稱。表單用它當預設值 —— 比 Discord 顯示名稱更貼近
 * 「他在這個站上習慣怎麼稱呼自己」。沒寫過旅箋時回 null，由呼叫端退回 Discord 名稱。
 */
export function lastNicknameOf(userId: number): string | null {
  const row = getDatabase().prepare(
    'SELECT nickname FROM checkins WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  ).get(userId) as { nickname: string } | undefined
  return row?.nickname ?? null
}

export function closeDatabaseForTests() {
  database?.close()
  database = undefined
}
