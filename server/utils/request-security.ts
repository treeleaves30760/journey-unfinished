import { createError, getRequestHeader, getRequestIP, getRequestWebStream, type H3Event } from 'h3'
import { Readable } from 'node:stream'

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const MAX_TRACKED_BUCKETS = 10_000

export function enforceRateLimit(event: H3Event, scope: string, limit: number, windowMs: number) {
  const now = Date.now()
  const config = useRuntimeConfig(event)
  const trustProxy = config.trustProxy === true
  const address = getRequestIP(event, { xForwardedFor: trustProxy }) || 'unknown'
  const key = `${scope}:${address}`
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= MAX_TRACKED_BUCKETS) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey)
      }
      if (buckets.size >= MAX_TRACKED_BUCKETS) {
        throw createError({ statusCode: 503, message: '服務目前繁忙，請稍後再試' })
      }
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs })
  } else {
    bucket.count += 1
    if (bucket.count > limit) {
      throw createError({ statusCode: 429, message: '操作太頻繁，請稍後再試' })
    }
  }

  if (buckets.size > MAX_TRACKED_BUCKETS * 0.8) {
    for (const [bucketKey, value] of buckets) {
      if (value.resetAt <= now) buckets.delete(bucketKey)
    }
  }
}

export function enforceSameOrigin(event: H3Event) {
  const origin = getRequestHeader(event, 'origin')
  if (!origin) return
  const appUrl = String(useRuntimeConfig(event).public.appUrl || '')
  try {
    if (!appUrl || new URL(origin).origin !== new URL(appUrl).origin) {
      throw createError({ statusCode: 403, message: '拒絕跨站操作' })
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw createError({ statusCode: 403, message: '請求來源無效' })
  }
}

export async function readLimitedJson(event: H3Event, maxBytes: number): Promise<Record<string, unknown>> {
  const contentType = getRequestHeader(event, 'content-type') || ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw createError({ statusCode: 415, message: '請使用 application/json 傳送留言' })
  }

  const declaredLength = Number(getRequestHeader(event, 'content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw createError({ statusCode: 413, message: '留言請求超過允許大小' })
  }

  const stream = getRequestWebStream(event)
  if (!stream) return {}
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of Readable.fromWeb(stream as never)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.length
    if (received > maxBytes) {
      throw createError({ statusCode: 413, message: '留言請求超過允許大小' })
    }
    chunks.push(buffer)
  }

  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('JSON object required')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw createError({ statusCode: 400, message: '留言 JSON 格式不正確' })
  }
}
