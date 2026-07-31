import Busboy from '@fastify/busboy'
import { createError, getRequestHeaders, getRequestWebStream, type H3Event, type MultiPartData } from 'h3'
import { Readable } from 'node:stream'

const MAX_FIELDS = 12
const MAX_FIELD_BYTES = 2_048
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
  const maximumRequestBytes = maxUploadBytes * MAX_FILES + 128 * 1024
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

    let parser: Busboy
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
