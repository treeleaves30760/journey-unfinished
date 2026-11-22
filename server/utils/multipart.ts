import Busboy, { type BusboyInstance } from '@fastify/busboy'
import { createError, getRequestHeaders, getRequestWebStream, type H3Event, type MultiPartData } from 'h3'
import { Readable } from 'node:stream'

// 目前最多的一次是「發佈草稿」：11 個旅箋欄位 + draftId + clearPhoto/clearAvatar = 14。
// 留一點餘裕，但仍然是硬上限——欄位數乘上 MAX_FIELD_BYTES 就是這個 parser 的記憶體天花板。
const MAX_FIELDS = 18
// Markdown 讓旅途留言的上限拉到 2000 個字，換算成 UTF-8 最壞情況（中日韓字元 3 bytes、
// 少數 emoji 4 bytes）約 8 KiB，這裡取 12 KiB 保留餘裕，仍遠低於任何記憶體風險。
const MAX_FIELD_BYTES = 12_288
const MAX_FILES = 2

/**
 * Streams multipart input with hard parser limits instead of buffering an
 * unbounded request through readMultipartFormData(). Each accepted file is
 * capped by maxUploadBytes and only the small, validated upload is buffered.
 */
export async function readLimitedMultipart(event: H3Event, maxUploadBytes: number): Promise<MultiPartData[]> {
  const headers = getRequestHeaders(event)
  const contentType = headers['content-type'] || ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw createError({ statusCode: 415, message: '請使用 multipart/form-data 傳送旅箋資料' })
  }

  const declaredLength = Number(headers['content-length'])
  // 上限＝兩張圖 + 所有文字欄位的最壞情況 + multipart 分隔線之類的框架開銷。
  // 直接由 MAX_FIELDS／MAX_FIELD_BYTES 推導，改動欄位限制時不會忘了同步這個數字。
  const maximumRequestBytes = maxUploadBytes * MAX_FILES + MAX_FIELDS * MAX_FIELD_BYTES + 64 * 1024
  if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBytes) {
    throw createError({ statusCode: 413, message: '上傳資料超過允許大小' })
  }

  return await new Promise<MultiPartData[]>((resolve, reject) => {
    const parts: MultiPartData[] = []
    let settled = false
    let totalBytes = 0
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    let parser: BusboyInstance
    try {
      parser = new Busboy({
        headers: { 'content-type': contentType, 'content-length': headers['content-length'] },
        limits: {
          fields: MAX_FIELDS,
          fieldNameSize: 100,
          fieldSize: MAX_FIELD_BYTES,
          files: MAX_FILES,
          fileSize: maxUploadBytes,
          parts: MAX_FIELDS + MAX_FILES
        }
      })
    } catch {
      fail(createError({ statusCode: 400, message: 'multipart 格式不正確' }))
      return
    }

    parser.on('field', (name, value, _nameTruncated, valueTruncated) => {
      if (valueTruncated) {
        fail(createError({ statusCode: 413, message: '文字欄位超過允許大小' }))
        return
      }
      parts.push({ name, data: Buffer.from(value) })
    })

    parser.on('file', (name, stream, filename, _encoding, mimeType) => {
      const chunks: Buffer[] = []
      let fileBytes = 0
      stream.on('data', (chunk: Buffer) => {
        fileBytes += chunk.length
        totalBytes += chunk.length
        if (fileBytes > maxUploadBytes || totalBytes > maxUploadBytes * MAX_FILES) {
          stream.resume()
          fail(createError({ statusCode: 413, message: `每張圖片不可超過 ${Math.floor(maxUploadBytes / 1024 / 1024)} MiB` }))
          return
        }
        chunks.push(chunk)
      })
      stream.on('limit', () => fail(createError({
        statusCode: 413,
        message: `每張圖片不可超過 ${Math.floor(maxUploadBytes / 1024 / 1024)} MiB`
      })))
      stream.on('end', () => {
        if (!settled) parts.push({ name, filename, type: mimeType, data: Buffer.concat(chunks) })
      })
      stream.on('error', fail)
    })

    parser.on('fieldsLimit', () => fail(createError({ statusCode: 413, message: '欄位數量超過限制' })))
    parser.on('filesLimit', () => fail(createError({ statusCode: 413, message: '最多只能上傳旅途照片與頭像各一張' })))
    parser.on('partsLimit', () => fail(createError({ statusCode: 413, message: 'multipart 區段數量超過限制' })))
    parser.on('error', () => fail(createError({ statusCode: 400, message: '無法解析 multipart 資料' })))
    parser.on('finish', () => {
      if (settled) return
      settled = true
      resolve(parts)
    })

    const webStream = getRequestWebStream(event)
    if (!webStream) {
      fail(createError({ statusCode: 400, message: '找不到請求內容' }))
      return
    }
    Readable.fromWeb(webStream as never).on('error', fail).pipe(parser)
  })
}
