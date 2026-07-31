import { createError } from 'h3'
import { requireAdmin } from '../../../utils/auth'
import { deleteCheckin, findCheckin, getDatabase, type Checkin } from '../../../utils/database'
import { enforceRateLimit, enforceSameOrigin, readLimitedJson } from '../../../utils/request-security'
import { removeSavedImage } from '../../../utils/uploads'

// 一次請求最多能刪幾筆，數字要同時滿足兩件事：
// 一、真的在清垃圾旅箋的管理員一次勾選不太可能超過這個量；
// 二、就算誤按或管理員 session 被偷，單一請求也不可能把整張表掃光——
//    更大規模的清理會被逼著拆成多次請求，每一次都各自受下面的限流與稽核。
// 100 遠超過人工勾選會用到的數量，同時仍讓「拆成多次」這件事在資安上有意義。
export const MAX_BATCH_DELETE_IDS = 100

/**
 * 刻意不做任何型別轉換（呼應 admin/users/[id]/role.patch.ts 的 parseRole）：
 * 陣列裡的每一個元素都必須「本來就是」JSON number 且為正整數，字串 '1'、1.5、true 等
 * 一律 400，不嘗試幫忙猜使用者的意思。回傳值已去除重複，順序為第一次出現的順序。
 */
export function parseBatchIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw createError({ statusCode: 400, message: '要刪除的旅箋編號必須是陣列' })
  }

  const unique = new Set<number>()
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) {
      throw createError({ statusCode: 400, message: '旅箋編號必須是正整數' })
    }
    unique.add(item)
  }

  if (unique.size === 0) {
    throw createError({ statusCode: 400, message: '請至少選擇一筆旅箋' })
  }
  if (unique.size > MAX_BATCH_DELETE_IDS) {
    throw createError({ statusCode: 400, message: `一次最多刪除 ${MAX_BATCH_DELETE_IDS} 筆旅箋` })
  }
  return [...unique]
}

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  requireAdmin(event)
  // 批量端點一次能動到的資料量遠高於單筆的 /api/admin/checkins/:id（那個端點甚至沒有限流），
  // 所以請求次數的額度訂得比其他管理端點的 20 次／小時更保守。搭配上面 100 筆的單次上限，
  // 這個位址一小時內透過本端點最多刪 10 * 100 = 1000 筆——對真的在清理的管理員仍然寬裕
  // （等於連續按 10 次「確認刪除」），卻讓誤按或被盜用的 session 沒辦法一小時內清空整個網站。
  enforceRateLimit(event, 'admin-checkins-batch-delete', 10, 60 * 60 * 1000)

  // 16 KiB 對 100 個 JSON number 綽綽有餘（就算每個都寫成 Number.MAX_SAFE_INTEGER 也遠低於此），
  // 同時擋掉「body 裡塞一個超巨大陣列」這種在真正解析陣列內容之前就該擋下的請求。
  const body = await readLimitedJson(event, 16 * 1024)
  const ids = parseBatchIds(body.ids)

  const db = getDatabase()
  const removed: Checkin[] = []
  const notFoundIds: number[] = []

  try {
    db.transaction(() => {
      for (const id of ids) {
        const checkin = findCheckin(id)
        if (!checkin) {
          notFoundIds.push(id)
          continue
        }
        // changes 為 0 代表這一筆在「查到」與「刪除」之間消失了——parseBatchIds 之後、
        // 上面的 findCheckin 都已經確認存在過，所以這是真正的競爭條件，不是單純不存在。
        // 直接拋例外讓 transaction() 把這批「已經刪掉的」也一併回滾，不留下刪一半的狀態。
        if (!deleteCheckin(id)) {
          throw createError({ statusCode: 409, message: '批量刪除時發生衝突，請重新整理後再試' })
        }
        removed.push(checkin)
      }
    })()
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    // 理論上不該發生的例外（例如磁碟或資料庫檔案層級的問題），不能把內部訊息原樣外流給用戶端。
    throw createError({ statusCode: 409, message: '批量刪除時發生衝突，請重新整理後再試' })
  }

  // 檔案清除永遠排在交易成功之後：資料列這時已確定刪除，這裡刪不掉檔案只留下孤兒檔案
  // （浪費空間但無害）；反過來若先刪檔案、資料列的刪除又回滾，頁面就會指向不存在的圖片。
  for (const checkin of removed) {
    removeSavedImage(checkin.photo)
    removeSavedImage(checkin.avatar)
  }

  return {
    deletedCount: removed.length,
    deletedIds: removed.map(checkin => checkin.id),
    notFoundIds
  }
})
