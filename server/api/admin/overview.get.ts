import { requireAdmin, roleForDiscordId } from '../../utils/auth'
import { listCheckins, listUsers } from '../../utils/database'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const users = listUsers().map(user => ({ ...user, role: roleForDiscordId(event, user.discordId) }))
  return { users, checkins: listCheckins() }
})
