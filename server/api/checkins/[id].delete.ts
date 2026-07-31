import { createError } from 'h3'
import { requireUser, type PublicUser } from '../../utils/auth'
import { deleteCheckin, findCheckin, type Checkin } from '../../utils/database'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { removeSavedImage } from '../../utils/uploads'
import { parseId } from '../../utils/validation'

/**
 * 種子資料與舊資料的 user_id 是 NULL（見 database.ts 的 seed()），這些旅箋沒有擁有者。
 * 兩邊都先確認是整數再比對，null／undefined 出現在任何一邊都直接算「非擁有者」，
 * 不讓任何寬鬆比較有機會把無主旅箋認成某個人的。
 */
export function isCheckinOwner(checkin: Checkin, user: PublicUser) {
  return Number.isInteger(checkin.userId) && Number.isInteger(user.id) && checkin.userId === user.id
}

export function assertCheckinDeletable(checkin: Checkin, user: PublicUser) {
  if (user.role === 'admin' || isCheckinOwner(checkin, user)) return
  // 這裡刻意回 403 而不是用 404 掩蓋：旅箋本來就公開可讀（GET /api/checkins/:id 不需登入），
  // 「這個 id 存在」不是秘密，403 沒有多洩漏任何東西，卻能讓使用者分辨「沒有權限」與「連結失效」。
  throw createError({ statusCode: 403, message: '只能刪除自己寫下的旅箋' })
}

export function deleteCheckinAndImages(checkin: Checkin) {
  // 先刪資料列再刪檔案：檔案清掉但資料列還在的話，頁面會指向不存在的圖片；
  // 反過來留下孤兒檔案只是浪費空間，是比較安全的失敗方向。
  if (!deleteCheckin(checkin.id)) throw createError({ statusCode: 409, message: '旅箋刪除失敗，請重試' })
  removeSavedImage(checkin.photo)
  removeSavedImage(checkin.avatar)
  return { deleted: true }
}

export default defineEventHandler((event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  // 限流放在查詢之前，讓沒有權限的人也無法靠這條路徑大量探測 id 是否存在。
  enforceRateLimit(event, 'delete-checkin', 20, 60 * 60 * 1000)
  const id = parseId(getRouterParam(event, 'id'))
  const checkin = findCheckin(id)
  if (!checkin) throw createError({ statusCode: 404, message: '找不到這則旅箋' })
  assertCheckinDeletable(checkin, user)
  return deleteCheckinAndImages(checkin)
})
