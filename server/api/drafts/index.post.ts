import { createError } from 'h3'
import { requireUser } from '../../utils/auth'
import { countDrafts, createDraft } from '../../utils/database'
import { MAX_DRAFTS_PER_USER, readDraftUpload, resolveDraftImage } from '../../utils/drafts'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { removeSavedImage } from '../../utils/uploads'

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'create-draft', 60, 60 * 60 * 1000)

  if (countDrafts(user.id) >= MAX_DRAFTS_PER_USER) {
    throw createError({
      statusCode: 409,
      message: `草稿最多只能存 ${MAX_DRAFTS_PER_USER} 份，請先發佈或刪除一些草稿`
    })
  }

  const upload = await readDraftUpload(event)
  let photo: string | null = null
  let avatar: string | null = null
  try {
    photo = (await resolveDraftImage(upload, 'photo')).saved
    avatar = (await resolveDraftImage(upload, 'avatar')).saved
    setResponseStatus(event, 201)
    return { draft: createDraft(user.id, upload.input, photo, avatar) }
  } catch (error) {
    removeSavedImage(photo)
    removeSavedImage(avatar)
    throw error
  }
})
