import { createError } from 'h3'
import { requireAdmin } from '../../../utils/auth'
import { deleteCheckin, findCheckin } from '../../../utils/database'
import { removeSavedImage } from '../../../utils/uploads'
import { parseId } from '../../../utils/validation'
import { enforceSameOrigin } from '../../../utils/request-security'

export default defineEventHandler((event) => {
  enforceSameOrigin(event)
  requireAdmin(event)
  const id = parseId(getRouterParam(event, 'id'))
  const checkin = findCheckin(id)
  if (!checkin) throw createError({ statusCode: 404, message: '找不到這則旅箋' })
  if (!deleteCheckin(id)) throw createError({ statusCode: 409, message: '旅箋刪除失敗，請重試' })
  removeSavedImage(checkin.photo)
  removeSavedImage(checkin.avatar)
  return { deleted: true }
})
