import { createError } from 'h3'
import { requireUser } from '../../utils/auth'
import { createCheckin } from '../../utils/database'
import { readLimitedMultipart } from '../../utils/multipart'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { multipartFields, removeSavedImage, saveImage } from '../../utils/uploads'
import { validateCheckin } from '../../utils/validation'

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'create-checkin', 12, 60 * 60 * 1000)
  const config = useRuntimeConfig(event)
  const parts = await readLimitedMultipart(event, Number(config.maxUploadBytes))

  const { fields, files } = multipartFields(parts)
  const input = validateCheckin(fields)
  let photo: string | null = null
  let avatar: string | null = null
  try {
    photo = saveImage(files.get('photo'), 'photo')
    if (!photo) throw createError({ statusCode: 400, message: '請上傳一張旅途照片' })
    avatar = saveImage(files.get('avatar'), 'avatar')
    const checkin = createCheckin(input, photo, avatar, user.id)
    setResponseStatus(event, 201)
    return { checkin }
  } catch (error) {
    removeSavedImage(photo)
    removeSavedImage(avatar)
    throw error
  }
})
