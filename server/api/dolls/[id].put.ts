import { createError } from 'h3'
import { requireUser } from '../../utils/auth'
import { updateDoll } from '../../utils/database'
import { readDollUpload, requireOwnedDoll } from '../../utils/dolls'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { removeSavedImage } from '../../utils/uploads'
import { parseId } from '../../utils/validation'

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'update-doll', 120, 60 * 60 * 1000)

  const id = parseId(event.context.params?.id)
  const existing = requireOwnedDoll(id, user.id)
  const upload = await readDollUpload(event)

  try {
    // 三態與草稿一致：沒帶新檔＝保留原圖、clearAvatar=1＝清空、帶了檔＝換掉
    const avatar = upload.avatar ?? (upload.clearAvatar ? null : undefined)
    const doll = updateDoll(id, upload.input, avatar)
    if (!doll) throw createError({ statusCode: 404, message: '找不到這隻娃娃' })

    // 換圖成功之後才刪舊檔。既有旅箋不受影響 —— 它們套用時各自複製了一份
    // （見 uploads.ts 的 copySavedImage），不會指向這裡被刪掉的檔案。
    if (avatar !== undefined && existing.avatar !== doll.avatar) removeSavedImage(existing.avatar)
    return { doll }
  } catch (error) {
    removeSavedImage(upload.avatar)
    throw error
  }
})
