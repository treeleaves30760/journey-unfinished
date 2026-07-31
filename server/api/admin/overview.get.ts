import { isConfigAdmin, requireAdmin, roleForDiscordId } from '../../utils/auth'
import { listCheckins, listUsers } from '../../utils/database'

export default defineEventHandler((event) => {
  requireAdmin(event)
  // role 是合併後的最終角色；configAdmin 額外標出「這個人的權限來自環境變數」，
  // 讓管理頁把他的切換按鈕停用 —— 那一層改不動，按下去只會拿到 403。
  const users = listUsers().map(user => ({
    ...user,
    role: roleForDiscordId(event, user.discordId, user.role),
    configAdmin: isConfigAdmin(event, user.discordId)
  }))
  return { users, checkins: listCheckins() }
})
