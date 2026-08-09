import { requireUser } from '../../utils/auth'
import { listDrafts } from '../../utils/database'

// 只回傳自己的草稿。草稿沒有公開列表，也沒有給管理員的檢視入口。
export default defineEventHandler((event) => {
  const user = requireUser(event)
  return { drafts: listDrafts(user.id) }
})
