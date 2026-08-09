import { createError, type H3Event, type MultiPartData } from 'h3'
import { findDraft, type Draft } from './database'
import { readLimitedMultipart } from './multipart'
import { multipartFields, saveImage } from './uploads'
import { validateDraft, type DraftInput } from './validation'

// 每人最多存幾份草稿。草稿會帶著一張已上傳的照片，沒有上限的話，
// 「一直存草稿、從不發佈」就是一條無限制的空間消耗路徑。
export const MAX_DRAFTS_PER_USER = 20

/**
 * 草稿是使用者自己還沒公開的內容，連管理員都不該讀取或修改，
 * 因此非擁有者一律回 404 而不是 403 —— 403 等於告訴對方「這個編號的草稿存在」。
 */
export function requireOwnedDraft(id: number, userId: number): Draft {
  const draft = findDraft(id)
  if (!draft || draft.userId !== userId) {
    throw createError({ statusCode: 404, message: '找不到這份草稿' })
  }
  return draft
}

export interface DraftUpload {
  input: DraftInput
  fields: Record<string, string>
  files: Map<string, MultiPartData>
}

export async function readDraftUpload(event: H3Event): Promise<DraftUpload> {
  const config = useRuntimeConfig(event)
  const parts = await readLimitedMultipart(event, Number(config.maxUploadBytes))
  const { fields, files } = multipartFields(parts)
  return { input: validateDraft(fields), fields, files }
}

/**
 * 三種狀態要分清楚（見 database.ts 的 updateDraft）：
 * 有新檔案就換掉、明確要求清空就清空、其餘一律回 undefined 代表「保留原圖」。
 * 回傳值同時帶出「這次請求存了哪個新檔」，失敗回滾時才知道該刪哪一個 ——
 * 不能連草稿原本那張一起刪掉。
 */
export async function resolveDraftImage(
  upload: DraftUpload,
  field: 'photo' | 'avatar'
): Promise<{ value: string | null | undefined, saved: string | null }> {
  const saved = await saveImage(upload.files.get(field), field)
  if (saved) return { value: saved, saved }
  if (upload.fields[`clear${field === 'photo' ? 'Photo' : 'Avatar'}`] === '1') {
    return { value: null, saved: null }
  }
  return { value: undefined, saved: null }
}
