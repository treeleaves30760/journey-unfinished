import { requireUser } from '../../utils/auth'
import { deleteDraft } from '../../utils/database'
import { requireOwnedDraft } from '../../utils/drafts'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { removeSavedImage } from '../../utils/uploads'
import { parseId } from '../../utils/validation'

export default defineEventHandler((event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'delete-draft', 60, 60 * 60 * 1000)

  const id = parseId(event.context.params?.id)
  const draft = requireOwnedDraft(id, user.id)
  // 先刪資料列再刪檔案：反過來的話，刪檔成功但刪列失敗會留下一筆指向空檔案的草稿。
  const removed = deleteDraft(id)
  if (removed) {
    removeSavedImage(draft.photo)
    removeSavedImage(draft.avatar)
  }
  return { deleted: removed }
})
