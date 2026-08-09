import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { DEFAULT_COUNTRY_CODE, isCountryCode } from '../../utils/countries'

// 臺灣縣市的列舉已經移除：全球化之後「行政區」欄位可能是任何區域底下的行政區，
// 伺服器端改成長度與內容衛生檢查（見 validateCheckin 的 county）。
// 前端在區域選到臺灣時仍會提供這份清單當 datalist 建議值，那一份住在 composables/useCheckins.ts。

export const AVATARS = ['sun', 'leaf', 'berry', 'ocean', 'cloud', 'peach'] as const

// 旅途留言支援 Markdown，一段有小標、清單與引言的遊記需要的篇幅遠比純文字多。
// 這個數字同時是資料庫 CHECK 約束的上限（見 database.ts 的 checkinsTableSql），兩邊必須一致。
export const MAX_MESSAGE_LENGTH = 2_000

export interface CheckinInput {
  nickname: string
  location: string
  // ISO 3166-1 alpha-2 代碼。介面上稱之為「區域」而不是「國家」（見 utils/countries.ts
  // 的檔頭說明）；欄位沿用標準本身的名字。顯示名稱一律由那份表推導，不存自由文字，
  // 同一個區域才不會因為來源不同而在篩選器裡分裂成好幾項。
  countryCode: string
  // 次級行政區（臺灣是縣市、日本是都道府縣、法國是大區）。全球化之後不再是列舉，
  // 因為世界上沒有一份「所有區域的一級行政區」清單值得塞進這個專案；改成走與其他
  // 自由文字相同的衛生檢查。欄位名稱維持 county 是為了不動資料庫與既有 API 形狀。
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

function validateCountryCode(value: unknown) {
  const code = String(value ?? DEFAULT_COUNTRY_CODE).trim().toUpperCase()
  if (!isCountryCode(code)) {
    throw createError({ statusCode: 400, message: '請選擇有效的區域' })
  }
  return code
}

function validateVisitedAt(value: unknown) {
  const visitedAt = String(value ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visitedAt) || Number.isNaN(Date.parse(`${visitedAt}T00:00:00Z`))) {
    throw createError({ statusCode: 400, message: '日期格式不正確' })
  }
  // 旅行日期是使用者自填的日曆日，跨時區時「今天」的定義本來就不只一種；這裡用本機的
  // 明天當上界，等於放行到最寬鬆的那個時區的今天，避免出國旅行當下寫旅箋卻被判成未來。
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (new Date(`${visitedAt}T00:00:00Z`) >= tomorrow) {
    throw createError({ statusCode: 400, message: '抵達日期不可在未來' })
  }
  return visitedAt
}

function validateAvatarPreset(value: unknown) {
  const avatarPreset = String(value || 'sun')
  if (!AVATARS.includes(avatarPreset as typeof AVATARS[number])) {
    throw createError({ statusCode: 400, message: '預設頭像無效' })
  }
  return avatarPreset
}

export function validateCheckin(fields: Record<string, unknown>): CheckinInput {
  // countryCode 與 avatarPreset 是列舉、visitedAt 是嚴格日期格式，都不需要再過衛生檢查；
  // 其餘六個自由文字欄位會公開渲染在旅箋頁上，套用與留言相同的規則。series 額外允許留空
  // （原創娃娃沒有作品出處），交給 optionalSafeText 把空白／未填寫正規化成 null。
  return {
    nickname: safeText(fields.nickname, '暱稱', 1, 30, { multiline: false, maxLinks: 0 }),
    location: safeText(fields.location, '地點', 2, 80, { multiline: false, maxLinks: 0 }),
    countryCode: validateCountryCode(fields.countryCode),
    county: safeText(fields.county, '行政區', 1, 40, { multiline: false, maxLinks: 0 }),
    // 全球座標：緯度 ±90、經度 ±180 就是地球的全部範圍，不再限制在臺灣本島與離島。
    latitude: numberInRange(fields.latitude, '緯度', -90, 90),
    longitude: numberInRange(fields.longitude, '經度', -180, 180),
    dollName: safeText(fields.dollName, '娃娃名稱', 1, 40, { multiline: false, maxLinks: 0 }),
    series: optionalSafeText(fields.series, '作品', 60, { multiline: false, maxLinks: 0 }),
    message: safeText(fields.message, '旅途留言', 1, MAX_MESSAGE_LENGTH, { multiline: true, maxLinks: MAX_FREE_TEXT_LINKS }),
    visitedAt: validateVisitedAt(fields.visitedAt),
    avatarPreset: validateAvatarPreset(fields.avatarPreset)
  }
}

/**
 * 草稿是「還沒寫完的旅箋」：手機上可能只拍了照片、標了座標就先存起來，回家再用電腦補完。
 * 因此每個欄位都允許缺席，但**只要有填就套用與正式旅箋完全相同的衛生規則** ——
 * 草稿最後會原封不動地送進 validateCheckin 發佈，若在這裡放水，等於多開一條沒檢查的
 * 輸入路徑（草稿內容也會回顯在自己的編輯畫面上）。
 *
 * 唯一放寬的是長度下限（location 正式版要 2 個字，草稿允許 1 個字）與必填性，
 * 上限一律照舊，避免有人靠草稿把超長內容存進資料庫。
 */
export interface DraftInput {
  nickname: string | null
  location: string | null
  countryCode: string | null
  county: string | null
  latitude: number | null
  longitude: number | null
  dollName: string | null
  series: string | null
  message: string | null
  visitedAt: string | null
  avatarPreset: string
}

function optionalNumberInRange(value: unknown, label: string, min: number, max: number) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  return numberInRange(value, label, min, max)
}

export function validateDraft(fields: Record<string, unknown>): DraftInput {
  const visitedAtRaw = String(fields.visitedAt ?? '').trim()
  const countryCodeRaw = String(fields.countryCode ?? '').trim()
  return {
    nickname: optionalSafeText(fields.nickname, '暱稱', 30, { multiline: false, maxLinks: 0 }),
    location: optionalSafeText(fields.location, '地點', 80, { multiline: false, maxLinks: 0 }),
    countryCode: countryCodeRaw ? validateCountryCode(countryCodeRaw) : null,
    county: optionalSafeText(fields.county, '行政區', 40, { multiline: false, maxLinks: 0 }),
    latitude: optionalNumberInRange(fields.latitude, '緯度', -90, 90),
    longitude: optionalNumberInRange(fields.longitude, '經度', -180, 180),
    dollName: optionalSafeText(fields.dollName, '娃娃名稱', 40, { multiline: false, maxLinks: 0 }),
    series: optionalSafeText(fields.series, '作品', 60, { multiline: false, maxLinks: 0 }),
    message: optionalSafeText(fields.message, '旅途留言', MAX_MESSAGE_LENGTH, { multiline: true, maxLinks: MAX_FREE_TEXT_LINKS }),
    visitedAt: visitedAtRaw ? validateVisitedAt(visitedAtRaw) : null,
    avatarPreset: validateAvatarPreset(fields.avatarPreset)
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
  const source = String(value ?? '').normalize('NFC')

  // multipart 表單送出時，瀏覽器會依 HTML 規格把 entry 裡的換行一律正規化成 CRLF。
  // 也就是說「使用者在 textarea 按了 Enter」到伺服器端一定是 \r\n —— 少了這一步，
  // 任何多行的旅途留言都會被下面的控制字元檢查擋成 400（Markdown 幾乎必然多行）。
  // 只收斂成對的 CRLF：單獨出現的 \r 不是任何平台的換行，仍然擋下，
  // 它的用途只有偽造日誌行或製造假排版。長度也在收斂之後才量，
  // 否則同一段文字會因為傳輸編碼多算了一半的字數而被誤判超長。
  const clean = text(rule.multiline ? source.replace(/\r\n/g, '\n') : source, label, min, max)

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

/**
 * 景點搜尋的關鍵字。它不會被存起來，但會原樣送去第三方地理編碼服務，
 * 因此同樣要擋掉控制字元與零寬字元 —— 這些字元在地名裡沒有任何意義，
 * 只會被用來混淆上游查詢或污染日誌。這裡刻意重用旅箋欄位那一套規則而不是另寫一份正則。
 */
export function validateSearchQuery(value: unknown) {
  return safeText(value, '關鍵字', 2, 80, { multiline: false, maxLinks: 0 })
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
