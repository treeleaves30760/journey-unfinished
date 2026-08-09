import { createError } from 'h3'
import { requireUser } from '../../utils/auth'
import { countDolls, createDoll } from '../../utils/database'
import { MAX_DOLLS_PER_USER, readDollUpload } from '../../utils/dolls'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { removeSavedImage } from '../../utils/uploads'

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'create-doll', 30, 60 * 60 * 1000)

  if (countDolls(user.id) >= MAX_DOLLS_PER_USER) {
    throw createError({
      statusCode: 409,
      message: `最多只能建立 ${MAX_DOLLS_PER_USER} 隻娃娃，請先刪除用不到的`
    })
  }

  const upload = await readDollUpload(event)
  try {
    setResponseStatus(event, 201)
    return { doll: createDoll(user.id, upload.input, upload.avatar) }
  } catch (error) {
    removeSavedImage(upload.avatar)
    throw error
  }
})
