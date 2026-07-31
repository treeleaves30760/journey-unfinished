export interface Checkin {
  id: number
  userId: number | null
  nickname: string
  location: string
  county: string
  latitude: number
  longitude: number
  dollName: string
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

export function errorMessage(error: unknown, fallback = '發生未預期的錯誤，請稍後再試。') {
  if (error && typeof error === 'object') {
    const value = error as { data?: { statusMessage?: string, message?: string }, statusMessage?: string, message?: string }
    return value.data?.statusMessage || value.data?.message || value.statusMessage || value.message || fallback
  }
  return fallback
}
