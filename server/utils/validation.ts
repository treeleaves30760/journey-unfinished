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

  return {
    nickname: text(fields.nickname, '暱稱', 1, 30),
    location: text(fields.location, '地點', 2, 80),
    county,
    latitude: numberInRange(fields.latitude, '緯度', 20, 27),
    longitude: numberInRange(fields.longitude, '經度', 118, 123),
    dollName: text(fields.dollName, '娃娃名稱', 1, 40),
    message: text(fields.message, '旅途留言', 1, 500),
    visitedAt,
    avatarPreset
  }
}

export function validateComment(body: Record<string, unknown>) {
  return {
    nickname: text(body.nickname, '暱稱', 1, 30),
    message: text(body.message, '留言', 1, 300)
  }
}

export function parseId(value: string | undefined) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, message: '無效的旅箋編號' })
  }
  return id
}
