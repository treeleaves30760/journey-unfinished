import { createError } from 'h3'
import { requireUser } from '../../utils/auth'
import { updateDraft } from '../../utils/database'
import { readDraftUpload, requireOwnedDraft, resolveDraftImage } from '../../utils/drafts'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { removeSavedImage } from '../../utils/uploads'
import { parseId } from '../../utils/validation'

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'update-draft', 240, 60 * 60 * 1000)

  const id = parseId(event.context.params?.id)
  const existing = requireOwnedDraft(id, user.id)
  const upload = await readDraftUpload(event)

  let savedPhoto: string | null = null
  let savedAvatar: string | null = null
  try {
    const photo = await resolveDraftImage(upload, 'photo')
    savedPhoto = photo.saved
    const avatar = await resolveDraftImage(upload, 'avatar')
    savedAvatar = avatar.saved

    const draft = updateDraft(id, upload.input, photo.value, avatar.value)
    if (!draft) throw createError({ statusCode: 404, message: '找不到這份草稿' })

    // 換圖或清空成功之後才刪舊檔：先刪的話，這中間任何一個錯誤都會讓草稿指向已經不存在的圖。
    if (photo.value !== undefined && existing.photo !== draft.photo) removeSavedImage(existing.photo)
    if (avatar.value !== undefined && existing.avatar !== draft.avatar) removeSavedImage(existing.avatar)
    return { draft }
  } catch (error) {
    // 只回滾這次請求剛存下的檔案，草稿原本那張要留著
    removeSavedImage(savedPhoto)
    removeSavedImage(savedAvatar)
    throw error
  }
})
