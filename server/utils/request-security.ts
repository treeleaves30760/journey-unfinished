import { createError, getRequestHeader, getRequestIP, getRequestWebStream, type H3Event } from 'h3'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const MAX_TRACKED_BUCKETS = 10_000
const MAX_PROXY_HOPS = 10
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function trustedProxyHops(event: H3Event): number {
  const config = useRuntimeConfig(event) as unknown as { trustProxy?: unknown, trustedProxyHops?: unknown }
  const configured = Math.trunc(Number(config.trustedProxyHops))
  if (Number.isFinite(configured) && configured > 0) return Math.min(configured, MAX_PROXY_HOPS)
  // 相容舊設定：NUXT_TRUST_PROXY=true 等同於「應用程式前面剛好一層可信代理」
  return config.trustProxy === true ? 1 : 0
}

function normalizeAddress(value: string | undefined): string | null {
  const raw = (value || '').trim()
  if (!raw) return null
  // 代理可能寫成 [::1]:8080、203.0.113.9:8080 或帶 zone id 的 fe80::1%eth0，驗證前先剝掉外包裝
  const bracketed = /^\[([^\]]+)](?::\d+)?$/.exec(raw)
  let address = bracketed ? bracketed[1]! : raw
  if (!bracketed && address.split(':').length === 2) address = address.slice(0, address.indexOf(':'))
  const zone = address.indexOf('%')
  if (zone !== -1) address = address.slice(0, zone)
  return isIP(address) ? address : null
}

function socketAddress(event: H3Event): string {
  const raw = (getRequestIP(event) || '').trim()
  return normalizeAddress(raw) || raw || 'unknown'
}

/**
 * X-Forwarded-For 的最左值是用戶端自己送進來的，任何以它為準的判斷都可以被逐次改寫繞過，
 * 所以這裡改用「可信 hop 數」：只有最右邊 trustedProxyHops 筆是自家代理附加的，
 * 往左數第 N 筆才是真正的來源；hop 數為 0（安全預設）時完全忽略這個 header。
 */
export function clientAddress(event: H3Event): string {
  const socket = socketAddress(event)
  const hops = trustedProxyHops(event)
  if (hops < 1) return socket

  const forwarded = String(getRequestHeader(event, 'x-forwarded-for') || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
  // 清單比 hop 數短代表 header 被動過手腳，退回 socket 位址而不是採信剩下的值
  return normalizeAddress(forwarded[forwarded.length - hops]) || socket
}

/**
 * 把 IPv6 位址收斂成它所屬的 /64，供限流與重複偵測當「同一個來源」的鍵。
 *
 * ISP 發給一條線路的通常就是一整段 /64（甚至 /56），用戶端可以在裡面任意換位址。
 * 若以完整的 128 位元位址分桶，一台機器就有 2^64 個各自滿額的桶：每換一個位址，
 * 匿名留言的三層限流與重複偵測就全部歸零；同時也能用垃圾鍵塞滿 MAX_TRACKED_BUCKETS，
 * 讓所有新訪客在被限流的端點上拿到 503。
 *
 * IPv4 與 IPv4-mapped IPv6（::ffff:a.b.c.d）是同一個來源，後者還原成 IPv4，
 * 避免同一位訪客因為 socket 的呈現方式不同而拿到兩個桶。
 */
export function rateLimitSubject(address: string): string {
  if (isIP(address) !== 6) return address

  const [head = '', tail] = address.toLowerCase().split('::') as [string, string | undefined]
  const groupsOf = (part: string) => part
    ? part.split(':').flatMap((group) => {
        if (!group.includes('.')) return [parseInt(group, 16)]
        // 內嵌的 IPv4 尾段（::ffff:203.0.113.9、64:ff9b::203.0.113.9）佔兩個 16 位元群組
        const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number)
        return [(a << 8) | b, (c << 8) | d]
      })
    : []
  const headGroups = groupsOf(head)
  const tailGroups = tail === undefined ? [] : groupsOf(tail)
  const groups = tail === undefined
    ? headGroups
    : [...headGroups, ...new Array<number>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill(0), ...tailGroups]
  // isIP 已經驗證過格式，這裡只是防禦：湊不出 8 組就退回原字串，寧可分桶太細也不要把不同來源併在一起
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return address

  const isMapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff
  if (isMapped) return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`

  return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`
}

/** 限流與重複偵測共用的來源鍵：IPv4 是位址本身，IPv6 是它的 /64。 */
export function clientRateKey(event: H3Event): string {
  return rateLimitSubject(clientAddress(event))
}

/**
 * 計數桶只存在單一 process 的記憶體中，因此限流僅在單一 replica 下正確；
 * 本專案的資料層是 SQLite，本來就只能單 replica，這個前提成立。
 * 未來若要橫向擴充成多實例，必須換成共用計數器（例如 Redis），
 * 否則每個實例都會各自放行整份額度。
 */
export function enforceRateLimit(event: H3Event, scope: string, limit: number, windowMs: number) {
  const now = Date.now()
  const key = `${scope}:${clientRateKey(event)}`
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
  // Origin 缺席時退而比對 Referer 的 origin；兩者都沒有就無從判斷來源，
  // 此時只剩 SameSite=Lax cookie 這個單點防禦，所以狀態變更請求一律擋下。
  const source = getRequestHeader(event, 'origin') || getRequestHeader(event, 'referer')
  if (!source) {
    if (SAFE_METHODS.has(String(event.method || '').toUpperCase())) return
    throw createError({ statusCode: 403, message: '拒絕跨站操作' })
  }

  const appUrl = String(useRuntimeConfig(event).public.appUrl || '')
  try {
    if (!appUrl || new URL(source).origin !== new URL(appUrl).origin) {
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
