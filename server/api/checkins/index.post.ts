import { createError } from 'h3'
import { requireUser } from '../../utils/auth'
import { createCheckin, deleteDraft } from '../../utils/database'
import { requireOwnedDraft } from '../../utils/drafts'
import { readLimitedMultipart } from '../../utils/multipart'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { multipartFields, removeSavedImage, saveImage } from '../../utils/uploads'
import { parseId, validateCheckin } from '../../utils/validation'

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'create-checkin', 12, 60 * 60 * 1000)
  const config = useRuntimeConfig(event)
  const parts = await readLimitedMultipart(event, Number(config.maxUploadBytes))

  const { fields, files } = multipartFields(parts)
  const input = validateCheckin(fields)

  // 發佈草稿走的是同一條路徑，只是多帶一個 draftId：草稿在手機上已經上傳過照片，
  // 沒有再傳一次新檔時就沿用草稿那張（它早就被 sharp 重新編碼、剝過 EXIF），
  // 不必為了發佈而重新上傳一次幾 MB 的圖。
  const draft = fields.draftId ? requireOwnedDraft(parseId(fields.draftId), user.id) : null

  let photo: string | null = null
  let avatar: string | null = null
  try {
    // saveImage 會用 sharp 重新解碼並剝除 EXIF/GPS，因此是非同步的；
    // 被 reject 時一樣落到下方 catch，圖片回滾邏輯不受影響。
    photo = await saveImage(files.get('photo'), 'photo')
    avatar = await saveImage(files.get('avatar'), 'avatar')
    const finalPhoto = photo ?? draft?.photo ?? null
    if (!finalPhoto) throw createError({ statusCode: 400, message: '請上傳一張旅途照片' })
    // clearAvatar 是「我在草稿裡裁過頭像，但決定改回預設頭像」的明確意思表示。
    // 沒有這個判斷，畫面上切回預設頭像後發佈，出來的仍然是草稿那張裁切圖。
    const finalAvatar = avatar ?? (fields.clearAvatar === '1' ? null : draft?.avatar ?? null)

    const checkin = createCheckin(input, finalPhoto, finalAvatar, user.id)
    // 旅箋建立成功後才刪草稿列，而且刻意不刪草稿的圖檔 —— 那些檔案現在屬於這則旅箋。
    // 若這次另外上傳了新圖，草稿舊圖就沒人引用了，一併清掉才不會留下孤兒檔案。
    if (draft) {
      deleteDraft(draft.id)
      if (draft.photo && draft.photo !== finalPhoto) removeSavedImage(draft.photo)
      if (draft.avatar && draft.avatar !== finalAvatar) removeSavedImage(draft.avatar)
    }
    setResponseStatus(event, 201)
    return { checkin }
  } catch (error) {
    // 只回滾這次請求存下的檔案；草稿沿用的舊圖必須留著，草稿本身還在。
    removeSavedImage(photo)
    removeSavedImage(avatar)
    throw error
  }
})
