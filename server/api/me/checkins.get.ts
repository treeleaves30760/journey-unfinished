import { requireUser } from '../../utils/auth'
import { listCheckinsByUser } from '../../utils/database'

/**
 * 個人管理區的「我的旅箋」。
 *
 * 內容本身是公開的（`/api/checkins` 誰都讀得到），這支端點的價值不在保密而在「範圍」：
 * 前端要的是「我寫的那些」，靠全站清單自己過濾會隨資料成長而愈拉愈多，
 * 而且過濾條件散在前端就有機會與伺服器的擁有者判定分岔。管理與匯出都以這一份為準。
 */
export default defineEventHandler((event) => {
  const user = requireUser(event)
  return { checkins: listCheckinsByUser(user.id) }
})
