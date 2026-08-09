import { createError } from 'h3'
import { requireUser } from '../../utils/auth'
import { findCheckin, getDatabase, deleteCheckin, type Checkin } from '../../utils/database'
import { enforceRateLimit, enforceSameOrigin, readLimitedJson } from '../../utils/request-security'
import { removeSavedImage } from '../../utils/uploads'
import { isCheckinOwner } from '../checkins/[id].delete'

// 一次請求最多能刪幾筆。管理區是勾選式的，30 已經遠超過一次人工整理會勾到的量，
// 同時讓「清空整個帳號」這件事必須拆成多次請求，每一次都各自受下面的限流。
export const MAX_OWN_BATCH_DELETE_IDS = 30

/**
 * 與 admin 版的 parseBatchIds 同樣刻意不做型別轉換：陣列裡每個元素都必須「本來就是」
 * JSON number 且為正整數。字串 '1'、1.5、true 一律 400，不去猜使用者的意思。
 */
export function parseOwnBatchIds(value: unknown): number[] {
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

  if (unique.size === 0) throw createError({ statusCode: 400, message: '請至少選擇一則旅箋' })
  if (unique.size > MAX_OWN_BATCH_DELETE_IDS) {
    throw createError({ statusCode: 400, message: `一次最多刪除 ${MAX_OWN_BATCH_DELETE_IDS} 則旅箋` })
  }
  return [...unique]
}

/**
 * 刪除自己的旅箋（可一次多則）。
 *
 * 與 /api/admin/checkins/batch 的關鍵差別是**這裡沒有管理員路徑**：即使呼叫者是管理員，
 * 也只會刪到自己名下的旅箋。管理員要清別人的內容有自己那支端點，兩條路徑分開才能讓
 * 「我在整理自己的紀錄」與「我在行使管理權」在稽核上是兩件不同的事。
 *
 * 清單裡混進不屬於自己的 id 時，整批直接拒絕而不是默默跳過：使用者送出的是一個明確的
 * 集合，只做一半卻回報成功，比失敗更難發現出了什麼事。
 */
export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'me-checkins-batch-delete', 20, 60 * 60 * 1000)

  // 16 KiB 對 30 個 JSON number 綽綽有餘，同時擋掉「body 裡塞一個超巨大陣列」這種
  // 在真正解析內容之前就該擋下的請求。
  const body = await readLimitedJson(event, 16 * 1024)
  const ids = parseOwnBatchIds(body.ids)

  const db = getDatabase()
  const removed: Checkin[] = []

  try {
    db.transaction(() => {
      for (const id of ids) {
        const checkin = findCheckin(id)
        // 找不到與不屬於自己回同一種錯誤：兩者分開回答等於提供一支「這個編號存在嗎」的探測器。
        // 旅箋本身雖然公開可讀，但沒必要在這條路徑上額外多送一個訊號。
        if (!checkin || !isCheckinOwner(checkin, user)) {
          throw createError({ statusCode: 404, message: '有旅箋不存在或不屬於你，沒有刪除任何一則' })
        }
        // changes 為 0 代表這一筆在「查到」與「刪除」之間消失了——是真正的競爭條件。
        // 拋例外讓 transaction() 把已經刪掉的一併回滾，不留下刪一半的狀態。
        if (!deleteCheckin(id)) {
          throw createError({ statusCode: 409, message: '刪除時發生衝突，請重新整理後再試' })
        }
        removed.push(checkin)
      }
    })()
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    // 理論上不該發生的例外（磁碟或資料庫檔案層級的問題），不把內部訊息原樣外流給用戶端
    throw createError({ statusCode: 409, message: '刪除時發生衝突，請重新整理後再試' })
  }

  // 檔案清除永遠排在交易成功之後：這時資料列已確定刪除，這裡失敗只留下孤兒檔案
  // （浪費空間但無害）；反過來先刪檔案而交易回滾，頁面就會指向不存在的圖片。
  for (const checkin of removed) {
    removeSavedImage(checkin.photo)
    removeSavedImage(checkin.avatar)
  }

  return { deletedCount: removed.length, deletedIds: removed.map(checkin => checkin.id) }
})
