import fs from 'node:fs'
import path from 'node:path'
import { createError, sendStream, setHeader } from 'h3'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

export default defineEventHandler((event) => {
  const requested = getRouterParam(event, 'file') || ''
  if (requested !== path.basename(requested) || !/^[a-z]+-[a-f0-9]{36}\.(jpg|png|webp)$/.test(requested)) {
    throw createError({ statusCode: 404, message: '找不到圖片' })
  }
  const filename = path.resolve(String(useRuntimeConfig().uploadDir), requested)
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    throw createError({ statusCode: 404, message: '找不到圖片' })
  }
  setHeader(event, 'Content-Type', MIME[path.extname(filename)] || 'application/octet-stream')
  setHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return sendStream(event, fs.createReadStream(filename))
})
