import { createError } from 'h3'
import { findCheckin, listComments } from '../../utils/database'
import { parseId } from '../../utils/validation'

export default defineEventHandler((event) => {
  const id = parseId(getRouterParam(event, 'id'))
  const checkin = findCheckin(id)
  if (!checkin) throw createError({ statusCode: 404, message: '找不到這則旅箋' })
  return { checkin, comments: listComments(id) }
})
