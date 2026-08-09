import { requireUser } from '../../utils/auth'
import { requireOwnedDraft } from '../../utils/drafts'
import { parseId } from '../../utils/validation'

// 「手機存草稿、電腦接手」的接手端就是這裡：登入同一個帳號就能打開同一份草稿。
export default defineEventHandler((event) => {
  const user = requireUser(event)
  return { draft: requireOwnedDraft(parseId(event.context.params?.id), user.id) }
})
