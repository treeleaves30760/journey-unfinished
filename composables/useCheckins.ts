export interface Checkin {
  id: number
  userId: number | null
  nickname: string
  location: string
  county: string
  latitude: number
  longitude: number
  dollName: string
  series: string | null
  message: string
  visitedAt: string
  photo: string | null
  avatar: string | null
  avatarPreset: string
  createdAt: string
  commentCount: number
}

export interface CheckinComment {
  id: number
  nickname: string
  message: string
  createdAt: string
}

export const avatarChoices = [
  { id: 'sun', label: '暖陽', face: '☀' },
  { id: 'leaf', label: '森芽', face: '♣' },
  { id: 'berry', label: '莓果', face: '●' },
  { id: 'ocean', label: '海浪', face: '≈' },
  { id: 'cloud', label: '雲朵', face: '☁' },
  { id: 'peach', label: '蜜桃', face: '♥' }
]

export const counties = [
  '基隆市', '臺北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣',
  '臺中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市',
  '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'
]

export function avatarClass(preset: string) {
  return `avatar-${avatarChoices.some(choice => choice.id === preset) ? preset : 'sun'}`
}

export function avatarFace(preset: string) {
  return avatarChoices.find(choice => choice.id === preset)?.face || '☀'
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
