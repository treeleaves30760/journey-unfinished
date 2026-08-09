import { createError } from 'h3'
import { requireUser } from '../../utils/auth'
import { countDrafts, createDraft } from '../../utils/database'
import { requireOwnedDoll } from '../../utils/dolls'
import { MAX_DRAFTS_PER_USER, readDraftUpload, resolveDraftImage } from '../../utils/drafts'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { copySavedImage, removeSavedImage } from '../../utils/uploads'

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
  // 只接受屬於自己的娃娃檔案，否則任何人都能把別人的頭像套到自己的草稿上
  const doll = upload.input.dollId ? requireOwnedDoll(upload.input.dollId, user.id) : null

  let photo: string | null = null
  let avatar: string | null = null
  try {
    photo = (await resolveDraftImage(upload, 'photo')).saved
    // 自己裁的優先；沒有的話套用娃娃檔案的頭像，而且是複製一份，不共用路徑
    // —— 刪掉這份草稿會連圖檔一起刪，共用會弄壞娃娃檔案本身（見 copySavedImage）。
    avatar = (await resolveDraftImage(upload, 'avatar')).saved ?? copySavedImage(doll?.avatar ?? null, 'avatar')
    setResponseStatus(event, 201)
    return { draft: createDraft(user.id, upload.input, photo, avatar) }
  } catch (error) {
    removeSavedImage(photo)
    removeSavedImage(avatar)
    throw error
  }
})
