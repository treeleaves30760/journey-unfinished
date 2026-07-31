import { createError } from 'h3'
import { createComment, findCheckin } from '../../../../utils/database'
import { enforceRateLimit, enforceSameOrigin, readLimitedJson } from '../../../../utils/request-security'
import { parseId, validateComment } from '../../../../utils/validation'

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  enforceRateLimit(event, 'create-comment', 30, 60 * 60 * 1000)
  const id = parseId(getRouterParam(event, 'id'))
  if (!findCheckin(id)) throw createError({ statusCode: 404, message: '找不到這則旅箋' })
  const body = await readLimitedJson(event, 8 * 1024)
  const input = validateComment(body)
  const comment = createComment(id, input.nickname, input.message)
  setResponseStatus(event, 201)
  return { comment }
})
