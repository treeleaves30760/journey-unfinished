import { createHash } from 'node:crypto'
import { createError } from 'h3'

export const COUNTIES = [
  '基隆市', '臺北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣',
  '臺中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市',
  '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'
] as const

export const AVATARS = ['sun', 'leaf', 'berry', 'ocean', 'cloud', 'peach'] as const

export interface CheckinInput {
  nickname: string
  location: string
  county: string
  latitude: number
  longitude: number
  dollName: string
  // 選填：原創娃娃沒有作品出處。標成可選屬性（而非一律要求、值可為 null）是為了讓舊測試
  // 與呼叫端在還沒補上這個欄位時，物件字面量依然合法——真正一定會回填的邏輯在 validateCheckin。
  series?: string | null
  message: string
  visitedAt: string
  avatarPreset: string
}

function text(value: unknown, label: string, min: number, max: number) {
  const clean = String(value ?? '').trim()
  if (clean.length < min || clean.length > max) {
    throw createError({ statusCode: 400, message: `${label}長度須為 ${min}–${max} 個字` })
  }
  return clean
}

function numberInRange(value: unknown, label: string, min: number, max: number) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) {
    throw createError({ statusCode: 400, message: `${label}格式不正確` })
  }
  return number
}

export function validateCheckin(fields: Record<string, unknown>): CheckinInput {
  const county = text(fields.county, '縣市', 2, 4)
  if (!COUNTIES.includes(county as typeof COUNTIES[number])) {
    throw createError({ statusCode: 400, message: '請選擇有效縣市' })
  }

  const visitedAt = String(fields.visitedAt ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visitedAt) || Number.isNaN(Date.parse(`${visitedAt}T00:00:00Z`))) {
    throw createError({ statusCode: 400, message: '日期格式不正確' })
  }
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (new Date(`${visitedAt}T00:00:00Z`) >= tomorrow) {
    throw createError({ statusCode: 400, message: '抵達日期不可在未來' })
  }

  const avatarPreset = String(fields.avatarPreset || 'sun')
  if (!AVATARS.includes(avatarPreset as typeof AVATARS[number])) {
    throw createError({ statusCode: 400, message: '預設頭像無效' })
  }

  // county 與 avatarPreset 是列舉、visitedAt 是嚴格日期格式，都不需要再過衛生檢查；
  // 其餘五個自由文字欄位會公開渲染在旅箋頁上，套用與留言相同的規則。series 額外允許留空
  // （原創娃娃沒有作品出處），交給 optionalSafeText 把空白／未填寫正規化成 null。
  return {
    nickname: safeText(fields.nickname, '暱稱', 1, 30, { multiline: false, maxLinks: 0 }),
    location: safeText(fields.location, '地點', 2, 80, { multiline: false, maxLinks: 0 }),
    county,
    latitude: numberInRange(fields.latitude, '緯度', 20, 27),
    longitude: numberInRange(fields.longitude, '經度', 118, 123),
    dollName: safeText(fields.dollName, '娃娃名稱', 1, 40, { multiline: false, maxLinks: 0 }),
    series: optionalSafeText(fields.series, '作品', 60, { multiline: false, maxLinks: 0 }),
    message: safeText(fields.message, '旅途留言', 1, 500, { multiline: true, maxLinks: MAX_FREE_TEXT_LINKS }),
    visitedAt,
    avatarPreset
  }
}

// 一律拒絕的 C0/C1 控制字元；多行版本只放行 \n，讓 textarea 的換行仍然可用，
// 但擋掉 \r 與 \t 這類會被拿來偽造日誌行、切斷字串或製造假排版的字元。
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/
const MULTILINE_CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/
// 零寬、雙向與行分隔字元本身不顯示，卻能拼出視覺上一模一樣的暱稱（同形異義）
// 或用 RLO 之類的覆寫碼把留言反轉顯示。這裡刻意放行 U+200D 與變體選擇符，
// 否則 👩‍💻、🏳️‍🌈 這類正常 emoji 組合會被誤殺。
// 必須寫成跳脫序列而非直接貼字元：U+2028/U+2029 本身就是 JS 的行終止符，
// 直接嵌在正則字面量裡會把這一行切斷，整個模組無法解析。
const INVISIBLE_CHARACTERS = /[\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/
// 抓 scheme://、www. 與裸網域三種常見寫法；三者的量詞都不巢狀，不會有回溯爆炸
const LINK_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|me|info|biz|xyz|top|shop|site|online|club|link|live|cc|tw|cn|ru)\b/gi
// 一則真心的心得最多附一兩個參考連結；三個以上幾乎只出現在導流垃圾訊息
const MAX_FREE_TEXT_LINKS = 2

interface TextRule {
  multiline: boolean
  maxLinks: number
}

/**
 * 旅箋與留言的自由文字都走這裡。兩者最後都會被公開渲染在旅箋頁上，
 * 差別只在留言不需登入 —— 但 Discord 帳號誰都能註冊，「已登入」不等於「可信任」，
 * 所以兩條路徑套用同一套衛生規則。
 */
function safeText(value: unknown, label: string, min: number, max: number, rule: TextRule) {
  // 先 NFC 再量長度：'é' 可以寫成 'e' + U+0301，在 JS 裡算兩個字，
  // 不正規化就能用視覺上等長的字串塞進兩倍內容繞過上限。
  const clean = text(String(value ?? '').normalize('NFC'), label, min, max)

  const controls = rule.multiline ? MULTILINE_CONTROL_CHARACTERS : CONTROL_CHARACTERS
  if (controls.test(clean) || INVISIBLE_CHARACTERS.test(clean)) {
    throw createError({ statusCode: 400, message: `${label}不可包含隱藏或控制字元` })
  }

  if ((clean.match(LINK_PATTERN) || []).length > rule.maxLinks) {
    throw createError({ statusCode: 400, message: rule.maxLinks ? `${label}包含過多連結` : `${label}不可包含連結` })
  }

  return clean
}

/**
 * 給選填的自由文字欄位用（目前只有 series）：留空、只有空白都要正規化成 null，
 * 而不是把空字串存進資料庫——下游「有值才顯示」與篩選邏輯才不必再各自判斷空字串。
 * 一旦有內容，就交給 safeText 走完整套衛生檢查，不能因為欄位選填就少檢查。
 */
function optionalSafeText(value: unknown, label: string, max: number, rule: TextRule) {
  const trimmed = String(value ?? '').normalize('NFC').trim()
  return trimmed ? safeText(trimmed, label, 1, max, rule) : null
}

export function validateComment(body: Record<string, unknown>) {
  return {
    nickname: safeText(body.nickname, '暱稱', 1, 30, { multiline: false, maxLinks: 0 }),
    message: safeText(body.message, '留言', 1, 300, { multiline: true, maxLinks: MAX_FREE_TEXT_LINKS })
  }
}

// 只記指紋不記原文，重複偵測不需要留著使用者寫了什麼
const commentFingerprints = new Map<string, number>()
const MAX_TRACKED_FINGERPRINTS = 5_000
// 十分鐘：足以擋住把同一段話貼滿多則旅箋的洗版，又不會讓人早上和晚上各留一次「好可愛！」被誤擋
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000

function rememberFingerprint(fingerprint: string, now: number) {
  if (commentFingerprints.size >= MAX_TRACKED_FINGERPRINTS) {
    for (const [key, expiresAt] of commentFingerprints) {
      if (expiresAt <= now) commentFingerprints.delete(key)
    }
    // 清不出過期項目就淘汰最舊的（Map 依插入順序迭代）。這裡跟 enforceRateLimit 的 503 不同：
    // 限流表滿了代表失去節流能力，必須擋下請求；重複表滿了只是可能漏擋一則重複留言，
    // 後面還有分層限流兜底，硬回 503 反而傷到正常使用者。
    for (const key of commentFingerprints.keys()) {
      if (commentFingerprints.size < MAX_TRACKED_FINGERPRINTS) break
      commentFingerprints.delete(key)
    }
  }
  // 先刪再寫，讓插入順序等於最近使用順序，淘汰時才會挑到真正最舊的那筆
  commentFingerprints.delete(fingerprint)
  commentFingerprints.set(fingerprint, now + DUPLICATE_WINDOW_MS)
}

/**
 * 匿名留言沒有帳號可以追蹤，因此以「來源 + 暱稱 + 內容」當指紋擋短時間內的完全重複。
 * 暱稱納入指紋是為了 NAT／CGNAT：同一個出口 IP 後面的兩個人都留「好可愛！」不該互相卡住。
 * 分隔符號用 \u0000，而 validateComment 已經先拒絕控制字元，所以無法靠內容拼接偽造指紋。
 */
export function assertUniqueComment(source: string, nickname: string, message: string, now = Date.now()) {
  const fingerprint = createHash('sha256').update(`${source}\u0000${nickname}\u0000${message}`).digest('base64')
  const seenUntil = commentFingerprints.get(fingerprint)
  if (seenUntil !== undefined && seenUntil > now) {
    // 命中就把時窗往後推：一直重送同一段內容的人會持續被擋，不能靠掐時間鑽空隙
    rememberFingerprint(fingerprint, now)
    throw createError({ statusCode: 429, message: '剛剛已送出相同內容的留言，請換個說法再試' })
  }
  rememberFingerprint(fingerprint, now)
}

export function parseId(value: string | undefined) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, message: '無效的旅箋編號' })
  }
  return id
}
