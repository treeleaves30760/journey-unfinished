import { createError, type H3Event } from 'h3'
import { findDoll, type Doll } from './database'
import { readLimitedMultipart } from './multipart'
import { multipartFields, saveImage } from './uploads'
import { validateDoll, type DollInput } from './validation'

// 每人最多幾隻娃娃。每一隻帶一張頭像，沒有上限就是一條沒有節制的空間消耗路徑；
// 30 對「帶著收藏娃娃去旅行」這件事來說遠超過實際需要。
export const MAX_DOLLS_PER_USER = 30

/**
 * 娃娃檔案屬於建立它的人。非擁有者一律回 404 而不是 403 —— 與草稿同樣的理由：
 * 403 等於確認「這個編號存在」。娃娃的名稱雖然會隨旅箋公開，但「某人有幾隻、編號多少」
 * 不是公開資訊。
 */
export function requireOwnedDoll(id: number, userId: number): Doll {
  const doll = findDoll(id)
  if (!doll || doll.userId !== userId) {
    throw createError({ statusCode: 404, message: '找不到這隻娃娃' })
  }
  return doll
}

export interface DollUpload {
  input: DollInput
  fields: Record<string, string>
  avatar: string | null
  clearAvatar: boolean
}

export async function readDollUpload(event: H3Event): Promise<DollUpload> {
  const config = useRuntimeConfig(event)
  const parts = await readLimitedMultipart(event, Number(config.maxUploadBytes))
  const { fields, files } = multipartFields(parts)
  return {
    input: validateDoll(fields),
    fields,
    avatar: await saveImage(files.get('avatar'), 'avatar'),
    clearAvatar: fields.clearAvatar === '1'
  }
}
