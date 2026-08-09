import { getQuery } from 'h3'
import { requireUser } from '../../utils/auth'
import { searchPlaces } from '../../utils/geocoding'
import { enforceRateLimit } from '../../utils/request-security'
import { validateSearchQuery } from '../../utils/validation'

// 這個端點會替使用者去打第三方服務，等於把本站變成一台開放的地理編碼代理。
// 因此要求登入（與寫旅箋同一道門檻）並額外限流，避免變成別人濫用 Nominatim 的跳板。
export default defineEventHandler(async (event) => {
  requireUser(event)
  enforceRateLimit(event, 'geo-search', 60, 10 * 60 * 1000)

  // 關鍵字走與旅箋自由文字同一套衛生規則（NFC、控制字元、零寬字元），
  // 不另外複製一份正則——地名裡的隱藏字元只會被拿來混淆上游查詢或日誌。
  return { places: await searchPlaces(validateSearchQuery(getQuery(event).q)) }
})
