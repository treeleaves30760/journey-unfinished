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
    // saveImage 會用 sharp 重新解碼並剝除 EXIF/GPS，因此是非同步的；
    // 被 reject 時一樣落到下方 catch，圖片回滾邏輯不受影響。
    photo = await saveImage(files.get('photo'), 'photo')
    if (!photo) throw createError({ statusCode: 400, message: '請上傳一張旅途照片' })
    avatar = await saveImage(files.get('avatar'), 'avatar')
    const checkin = createCheckin(input, photo, avatar, user.id)
    setResponseStatus(event, 201)
    return { checkin }
  } catch (error) {
    removeSavedImage(photo)
    removeSavedImage(avatar)
    throw error
  }
})
