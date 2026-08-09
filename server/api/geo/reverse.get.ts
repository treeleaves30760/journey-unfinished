import { createError, getQuery } from 'h3'
import { requireUser } from '../../utils/auth'
import { reverseGeocode } from '../../utils/geocoding'
import { enforceRateLimit } from '../../utils/request-security'

function coordinate(value: unknown, label: string, limit: number) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < -limit || number > limit) {
    throw createError({ statusCode: 400, message: `${label}格式不正確` })
  }
  return number
}

// 在地圖上點一下就自動補齊區域與行政區。與 search 同樣要求登入並限流，理由見該檔註解。
export default defineEventHandler(async (event) => {
  requireUser(event)
  enforceRateLimit(event, 'geo-reverse', 90, 10 * 60 * 1000)

  const query = getQuery(event)
  const place = await reverseGeocode(
    coordinate(query.lat, '緯度', 90),
    coordinate(query.lon, '經度', 180)
  )
  return { place }
})
