import { requireUser } from '../../utils/auth'
import { deleteDoll } from '../../utils/database'
import { requireOwnedDoll } from '../../utils/dolls'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { removeSavedImage } from '../../utils/uploads'
import { parseId } from '../../utils/validation'

/**
 * 刪掉娃娃檔案不會動到任何旅箋：checkins.doll_id 是 ON DELETE SET NULL，
 * 而旅箋的娃娃名稱、作品與頭像都是它自己那一份副本。已經寫下的旅程不該因為
 * 「以後不想留這個檔案了」就少掉資訊。
 */
export default defineEventHandler((event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'delete-doll', 30, 60 * 60 * 1000)

  const id = parseId(event.context.params?.id)
  const doll = requireOwnedDoll(id, user.id)
  const removed = deleteDoll(id)
  if (removed) removeSavedImage(doll.avatar)
  return { deleted: removed }
})
