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
  // nuxt.config.ts 的 routeRules 也會設這個 CSP，但 route rules 的比對曾多次被繞過
  // （大小寫變體、%2F 編碼，見 GHSA-vjh5-4x84-xrqp／GHSA-f3x9-2chm-73c8）。
  // 使用者上傳的內容「就算被當成文件開啟也沒有任何執行能力」這件事不能只靠路由比對，
  // 所以在實際送出檔案的地方再設一次，兩層任一層生效即可。
  setHeader(event, 'Content-Security-Policy', "default-src 'none'; sandbox")
  return sendStream(event, fs.createReadStream(filename))
})
