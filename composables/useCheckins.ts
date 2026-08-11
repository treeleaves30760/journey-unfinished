export interface Checkin {
  id: number
  userId: number | null
  /** 關聯到的娃娃檔案；舊資料與檔案被刪掉之後都是 null，旅箋自己的 dollName 仍在 */
  dollId: number | null
  nickname: string
  location: string
  /** ISO 3166-1 alpha-2；介面上稱為「區域」，顯示名稱由 utils/countries.ts 的 regionName 推導 */
  countryCode: string
  /** 次級行政區：臺灣是縣市、日本是都道府縣、法國是大區 */
  county: string
  latitude: number
  longitude: number
  dollName: string
  series: string | null
  message: string
  visitedAt: string
  photo: string | null
  avatar: string | null
  createdAt: string
  commentCount: number
}

/**
 * 草稿：手機上拍完照、標好地點就先存起來，回家用電腦打開同一筆繼續寫。
 * 每個欄位都可能是空的——它就是一則還沒寫完的旅箋。
 */
export interface Draft {
  id: number
  userId: number
  dollId: number | null
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
  photo: string | null
  avatar: string | null
  createdAt: string
  updatedAt: string
}

export interface CheckinComment {
  id: number
  nickname: string
  message: string
  createdAt: string
}

// 臺灣的縣市清單。全球化之後「行政區」欄位本身是自由文字（世界上沒有一份值得內建的
// 全球一級行政區清單），這份清單只在區域選到臺灣時當成下拉選項，維持既有資料的一致寫法。
export const counties = [
  '基隆市', '臺北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣',
  '臺中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市',
  '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'
]

/**
 * 娃娃檔案：名稱、作品出處與頭像存一次，寫旅箋時直接選。
 * 旅箋仍各自保留一份副本 —— 之後把娃娃改名不會回頭改寫已經寫下的旅程。
 */
export interface Doll {
  id: number
  userId: number
  name: string
  series: string | null
  avatar: string | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  checkinCount: number
}

/**
 * 「日本・京都府」這種一眼看得出在哪裡的地點標籤，卡片、地圖側欄與詳情頁共用。
 * 刻意不加國旗 emoji —— 國旗是最強烈的主權符號，而這個站要說的只是「去過哪裡」。
 */
export function placeLabel(checkin: Pick<Checkin, 'countryCode' | 'county'>) {
  const region = regionName(checkin.countryCode)
  if (!checkin.county) return region
  // 臺灣的縣市名稱本身已經夠明確，再冠一次上層區域只是雜訊
  return checkin.countryCode === 'TW' ? checkin.county : `${region}・${checkin.county}`
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })
    .format(new Date(`${value.slice(0, 10)}T00:00:00`))
}

export function formatCommentDate(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Taipei'
  }).format(new Date(`${value.replace(' ', 'T').replace(/Z$/, '')}Z`))
}

// 探索頁關鍵字搜尋共用的正規化：NFC 讓組合字元與預合成字元視為同一個字（同一個 'é' 不會因為
// 輸入法送出的編碼不同就搜不到），toLowerCase 讓比對與大小寫無關。
export function normalizeSearchText(value: string) {
  return value.normalize('NFC').toLowerCase()
}

export function errorMessage(error: unknown, fallback = '發生未預期的錯誤，請稍後再試。') {
  if (error && typeof error === 'object') {
    const value = error as { data?: { statusMessage?: string, message?: string }, statusMessage?: string, message?: string }
    // message 要排在 statusMessage 前面：Nitro 序列化錯誤時 statusMessage 固定是預設的
    // "Server Error"（nitropack/.../error/prod.mjs），真正的訊息在 message，而本專案所有
    // createError 都只給 message。順序反過來的話，畫面上永遠只會顯示 "Server Error"。
    // 這個順序不會外洩內部細節：Nitro 對 5xx／未處理錯誤本來就會把 message 換成通用字串。
    return value.data?.message || value.data?.statusMessage || value.statusMessage || value.message || fallback
  }
  return fallback
}
