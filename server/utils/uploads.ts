import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createError, type MultiPartData } from 'h3'

const IMAGE_TYPES: Record<string, { extension: string, signatures: number[][] }> = {
  'image/jpeg': { extension: 'jpg', signatures: [[0xff, 0xd8, 0xff]] },
  'image/png': { extension: 'png', signatures: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  'image/webp': { extension: 'webp', signatures: [[0x52, 0x49, 0x46, 0x46]] }
}

function hasSignature(buffer: Buffer, mime: string) {
  if (mime === 'image/webp') {
    return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
  }
  return IMAGE_TYPES[mime]?.signatures.some(signature =>
    signature.every((byte, index) => buffer[index] === byte)
  )
}

export function multipartFields(parts: MultiPartData[]) {
  const fields: Record<string, string> = {}
  const files = new Map<string, MultiPartData>()
  for (const part of parts) {
    if (!part.name) continue
    if (part.filename) {
      if (files.has(part.name)) throw createError({ statusCode: 400, message: `欄位 ${part.name} 只能上傳一個檔案` })
      files.set(part.name, part)
    } else {
      fields[part.name] = part.data.toString('utf8')
    }
  }
  return { fields, files }
}

export function saveImage(part: MultiPartData | undefined, prefix: 'photo' | 'avatar') {
  if (!part || !part.data.length) return null
  const config = useRuntimeConfig()
  const maxBytes = Number(config.maxUploadBytes)
  if (part.data.length > maxBytes) {
    throw createError({ statusCode: 413, message: `圖片不可超過 ${Math.round(maxBytes / 1024 / 1024)}MB` })
  }
  const mime = String(part.type || '').toLowerCase()
  const image = IMAGE_TYPES[mime]
  if (!image || !hasSignature(part.data, mime)) {
    throw createError({ statusCode: 415, message: '只接受有效的 JPEG、PNG 或 WebP 圖片' })
  }
  const uploadDir = path.resolve(String(config.uploadDir))
  fs.mkdirSync(uploadDir, { recursive: true })
  const filename = `${prefix}-${randomBytes(18).toString('hex')}.${image.extension}`
  fs.writeFileSync(path.join(uploadDir, filename), part.data, { flag: 'wx', mode: 0o600 })
  return `/uploads/${filename}`
}

export function removeSavedImage(url: string | null) {
  if (!url) return
  try {
    const filename = path.basename(url)
    fs.unlinkSync(path.resolve(String(useRuntimeConfig().uploadDir), filename))
  } catch {
    // Best-effort rollback when the database insert fails.
  }
}
