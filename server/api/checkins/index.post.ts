import { createError } from 'h3'
import { requireUser } from '../../utils/auth'
import { createCheckin, deleteDraft, touchDoll } from '../../utils/database'
import { requireOwnedDoll } from '../../utils/dolls'
import { requireOwnedDraft } from '../../utils/drafts'
import { readLimitedMultipart } from '../../utils/multipart'
import { enforceRateLimit, enforceSameOrigin } from '../../utils/request-security'
import { copySavedImage, multipartFields, removeSavedImage, saveImage } from '../../utils/uploads'
import { optionalId, parseId, validateCheckin } from '../../utils/validation'

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  const user = requireUser(event)
  enforceRateLimit(event, 'create-checkin', 12, 60 * 60 * 1000)
  const config = useRuntimeConfig(event)
  const parts = await readLimitedMultipart(event, Number(config.maxUploadBytes))

  const { fields, files } = multipartFields(parts)
  const input = validateCheckin(fields)

  // 發佈草稿走的是同一條路徑，只多帶一個 draftId：草稿在手機上已經上傳過照片，
  // 沒有再傳一次新檔時就沿用草稿那張（它早就被 sharp 重新編碼、剝過 EXIF），
  // 不必為了發佈而重新上傳一次幾 MB 的圖。
  const draft = fields.draftId ? requireOwnedDraft(parseId(fields.draftId), user.id) : null
  // 娃娃檔案：只接受屬於自己的，否則任何人都能把別人的頭像套到自己的旅箋上。
  const dollId = optionalId(fields.dollId)
  const doll = dollId ? requireOwnedDoll(dollId, user.id) : null

  let photo: string | null = null
  let avatar: string | null = null
  let dollAvatar: string | null = null
  try {
    // saveImage 會用 sharp 重新解碼並剝除 EXIF/GPS，因此是非同步的；
    // 被 reject 時一樣落到下方 catch，圖片回滾邏輯不受影響。
    photo = await saveImage(files.get('photo'), 'photo')
    avatar = await saveImage(files.get('avatar'), 'avatar')
    const finalPhoto = photo ?? draft?.photo ?? null
    if (!finalPhoto) throw createError({ statusCode: 400, message: '請上傳一張旅途照片' })

    // 頭像的來源優先序，由「最明確的意圖」往下排：
    //   1. 這次自己裁了一張    2. 明確要求改回預設頭像    3. 選了娃娃檔案
    //   4. 草稿本來就帶著的那張
    // 娃娃檔案的頭像要複製一份，不能共用路徑 —— 刪掉這則旅箋時會連圖檔一起刪，
    // 共用的話會順手弄壞娃娃檔案本身與其他所有引用它的旅箋（見 copySavedImage）。
    if (!avatar && fields.clearAvatar !== '1' && doll?.avatar && draft?.dollId !== doll.id) {
      dollAvatar = copySavedImage(doll.avatar, 'avatar')
    }
    const finalAvatar = avatar
      ?? (fields.clearAvatar === '1' ? null : dollAvatar ?? draft?.avatar ?? null)
    // 頭像與照片同級必填。表單那邊也擋了一次，但真正的規則必須在這裡：沒有頭像的旅箋
    // 在列表上只會是一個空的色圓，而旅箋寫下後沒有編輯端點，補不回來。
    // 草稿刻意不受這條限制 —— 手機上先存起來的東西本來就還沒寫完。
    if (!finalAvatar) throw createError({ statusCode: 400, message: '請為娃娃準備一張頭像' })

    const checkin = createCheckin(input, finalPhoto, finalAvatar, user.id, doll?.id ?? null)
    // 記一筆「最近用過」，下次打開表單就會預設選這一隻
    if (doll) touchDoll(doll.id)
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
    // 只回滾這次請求存下的檔案；草稿沿用的舊圖與娃娃檔案本身的頭像都必須留著。
    removeSavedImage(photo)
    removeSavedImage(avatar)
    removeSavedImage(dollAvatar)
    throw error
  }
})
