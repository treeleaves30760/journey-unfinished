import { ReadableStream } from 'node:stream/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientAddress, enforceRateLimit, enforceSameOrigin, rateLimitSubject, readLimitedJson } from '../server/utils/request-security'

vi.mock('h3', async importOriginal => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    getRequestHeader: (event: { headers: Record<string, string> }, name: string) => event.headers[name.toLowerCase()],
    // 複刻 h3 1.15.11 的行為：xForwardedFor 選項取的是可偽造的最左值
    getRequestIP: (event: { socket?: string, headers: Record<string, string> }, opts?: { xForwardedFor?: boolean }) =>
      (opts?.xForwardedFor ? event.headers['x-forwarded-for']?.split(',').shift()?.trim() : undefined) || event.socket,
    getRequestWebStream: (event: { stream?: ReadableStream<Uint8Array> }) => event.stream
  }
})

function eventFor(body: string, contentLength?: number) {
  const data = new TextEncoder().encode(body)
  return {
    headers: {
      'content-type': 'application/json',
      ...(contentLength === undefined ? {} : { 'content-length': String(contentLength) })
    },
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      }
    })
  }
}

function proxyEvent(socket: string, forwardedFor?: string) {
  return {
    socket,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }
  } as never
}

function stubProxyConfig(config: Record<string, unknown>) {
  vi.stubGlobal('useRuntimeConfig', () => config)
}

afterEach(() => vi.unstubAllGlobals())

describe('readLimitedJson', () => {
  it('reads a small JSON object', async () => {
    await expect(readLimitedJson(eventFor('{"nickname":"旅人"}') as never, 1024)).resolves.toEqual({ nickname: '旅人' })
  })

  it('rejects oversized declared and chunked bodies', async () => {
    await expect(readLimitedJson(eventFor('{}', 2048) as never, 1024)).rejects.toMatchObject({ statusCode: 413 })
    await expect(readLimitedJson(eventFor(JSON.stringify({ message: 'x'.repeat(2048) })) as never, 1024)).rejects.toMatchObject({ statusCode: 413 })
  })

  it('rejects non-JSON content types', async () => {
    const event = eventFor('{}')
    event.headers['content-type'] = 'text/plain'
    await expect(readLimitedJson(event as never, 1024)).rejects.toMatchObject({ statusCode: 415 })
  })
})

describe('clientAddress', () => {
  it('ignores a spoofed X-Forwarded-For when no proxy hop is trusted', () => {
    stubProxyConfig({})
    expect(clientAddress(proxyEvent('198.51.100.20', '203.0.113.9, 203.0.113.10'))).toBe('198.51.100.20')
    stubProxyConfig({ trustProxy: false, trustedProxyHops: 0 })
    expect(clientAddress(proxyEvent('198.51.100.20', '203.0.113.9'))).toBe('198.51.100.20')
  })

  it('reads the entry appended by the trusted proxies', () => {
    stubProxyConfig({ trustedProxyHops: 1 })
    expect(clientAddress(proxyEvent('10.0.0.1', '203.0.113.9, 198.51.100.7'))).toBe('198.51.100.7')
    stubProxyConfig({ trustedProxyHops: 2 })
    expect(clientAddress(proxyEvent('10.0.0.1', '203.0.113.9, 198.51.100.7, 10.0.0.9'))).toBe('198.51.100.7')
  })

  it('treats the legacy trustProxy flag as one trusted hop', () => {
    stubProxyConfig({ trustProxy: true })
    expect(clientAddress(proxyEvent('10.0.0.1', '203.0.113.9, 198.51.100.7'))).toBe('198.51.100.7')
  })

  it('falls back to the socket address when the header is shorter than the trusted hops', () => {
    stubProxyConfig({ trustedProxyHops: 2 })
    expect(clientAddress(proxyEvent('198.51.100.20', '203.0.113.9'))).toBe('198.51.100.20')
    expect(clientAddress(proxyEvent('198.51.100.20'))).toBe('198.51.100.20')
    expect(clientAddress(proxyEvent('198.51.100.20', ' , '))).toBe('198.51.100.20')
  })

  it.each([
    'not-an-ip',
    '999.1.1.1',
    '203.0.113.9 203.0.113.10',
    '203.0.113.9/24',
    'unknown',
    '_hidden'
  ])('refuses to trust the malformed forwarded value %s', (forwarded) => {
    stubProxyConfig({ trustedProxyHops: 1 })
    expect(clientAddress(proxyEvent('198.51.100.20', forwarded))).toBe('198.51.100.20')
  })

  it('normalizes ports and IPv6 zone identifiers before validating', () => {
    stubProxyConfig({ trustedProxyHops: 1 })
    expect(clientAddress(proxyEvent('10.0.0.1', '[2001:db8::1]:443'))).toBe('2001:db8::1')
    expect(clientAddress(proxyEvent('10.0.0.1', '203.0.113.9:5555'))).toBe('203.0.113.9')
    expect(clientAddress(proxyEvent('10.0.0.1', 'fe80::1%eth0'))).toBe('fe80::1')
    expect(clientAddress(proxyEvent('10.0.0.1', '::ffff:203.0.113.9'))).toBe('::ffff:203.0.113.9')
  })

  it('clamps out-of-range and malformed hop counts', () => {
    const chain = Array.from({ length: 12 }, (_, index) => `203.0.113.${index + 1}`)
    stubProxyConfig({ trustedProxyHops: 99 })
    expect(clientAddress(proxyEvent('10.0.0.1', chain.join(', ')))).toBe('203.0.113.3')
    stubProxyConfig({ trustedProxyHops: -3 })
    expect(clientAddress(proxyEvent('10.0.0.1', '203.0.113.9'))).toBe('10.0.0.1')
    stubProxyConfig({ trustedProxyHops: 'many' })
    expect(clientAddress(proxyEvent('10.0.0.1', '203.0.113.9'))).toBe('10.0.0.1')
  })
})

describe('enforceRateLimit', () => {
  it('keeps one bucket per socket address while X-Forwarded-For rotates', () => {
    stubProxyConfig({})
    expect(() => enforceRateLimit(proxyEvent('198.51.100.20', '203.0.113.1'), 'spoofed-xff', 1, 60_000)).not.toThrow()
    expect(() => enforceRateLimit(proxyEvent('198.51.100.20', '203.0.113.2'), 'spoofed-xff', 1, 60_000))
      .toThrowError(expect.objectContaining({ statusCode: 429 }))
  })

  it('keeps one bucket while the leftmost forwarded value rotates behind a trusted proxy', () => {
    stubProxyConfig({ trustProxy: true })
    expect(() => enforceRateLimit(proxyEvent('10.0.0.1', '203.0.113.1, 198.51.100.7'), 'rotating-xff', 1, 60_000)).not.toThrow()
    expect(() => enforceRateLimit(proxyEvent('10.0.0.1', '203.0.113.2, 198.51.100.7'), 'rotating-xff', 1, 60_000))
      .toThrowError(expect.objectContaining({ statusCode: 429 }))
  })

  it('separates buckets by forwarded client address behind a trusted proxy', () => {
    stubProxyConfig({ trustedProxyHops: 1 })
    expect(() => enforceRateLimit(proxyEvent('10.0.0.1', '198.51.100.7'), 'trusted-xff', 1, 60_000)).not.toThrow()
    expect(() => enforceRateLimit(proxyEvent('10.0.0.1', '198.51.100.8'), 'trusted-xff', 1, 60_000)).not.toThrow()
    expect(() => enforceRateLimit(proxyEvent('10.0.0.1', '198.51.100.8'), 'trusted-xff', 1, 60_000))
      .toThrowError(expect.objectContaining({ statusCode: 429 }))
  })
})

describe('rateLimitSubject', () => {
  it('leaves IPv4 and non-address fallbacks untouched', () => {
    expect(rateLimitSubject('198.51.100.20')).toBe('198.51.100.20')
    expect(rateLimitSubject('unknown')).toBe('unknown')
  })

  it('collapses every address of an IPv6 /64 into one subject', () => {
    expect(rateLimitSubject('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(rateLimitSubject('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
    expect(rateLimitSubject('2001:0DB8:0001:0002:0:0:0:9')).toBe('2001:db8:1:2::/64')
    expect(rateLimitSubject('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(rateLimitSubject('::1')).toBe('0:0:0:0::/64')
  })

  it('keeps neighbouring /64 networks apart', () => {
    expect(rateLimitSubject('2001:db8:1:3::1')).not.toBe(rateLimitSubject('2001:db8:1:2::1'))
  })

  it('treats an IPv4-mapped IPv6 address as the IPv4 client it is', () => {
    expect(rateLimitSubject('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(rateLimitSubject('::ffff:cb00:7109')).toBe('203.0.113.9')
    expect(rateLimitSubject('0:0:0:0:0:ffff:203.0.113.9')).toBe('203.0.113.9')
  })

  it('does not mistake other embedded-IPv4 forms for a mapped address', () => {
    expect(rateLimitSubject('64:ff9b::203.0.113.9')).toBe('64:ff9b:0:0::/64')
  })
})

describe('enforceRateLimit across IPv6 addresses', () => {
  it('shares one bucket while the client rotates inside its /64', () => {
    stubProxyConfig({})
    expect(() => enforceRateLimit(proxyEvent('2001:db8:7:7::1'), 'rotating-v6', 1, 60_000)).not.toThrow()
    expect(() => enforceRateLimit(proxyEvent('2001:db8:7:7:dead:beef:0:2'), 'rotating-v6', 1, 60_000))
      .toThrowError(expect.objectContaining({ statusCode: 429 }))
    expect(() => enforceRateLimit(proxyEvent('2001:db8:7:8::1'), 'rotating-v6', 1, 60_000)).not.toThrow()
  })

  it('shares one bucket between the IPv4 and IPv4-mapped spellings of a client', () => {
    stubProxyConfig({})
    expect(() => enforceRateLimit(proxyEvent('203.0.113.77'), 'mapped-v4', 1, 60_000)).not.toThrow()
    expect(() => enforceRateLimit(proxyEvent('::ffff:203.0.113.77'), 'mapped-v4', 1, 60_000))
      .toThrowError(expect.objectContaining({ statusCode: 429 }))
  })
})

describe('enforceSameOrigin', () => {
  it('accepts the configured origin and header-less safe methods', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { appUrl: 'https://trip.example.com/app/' } }))
    expect(() => enforceSameOrigin({ headers: { origin: 'https://trip.example.com' }, method: 'POST' } as never)).not.toThrow()
    expect(() => enforceSameOrigin({ headers: {}, method: 'GET' } as never)).not.toThrow()
  })

  it('falls back to the referer origin when the origin header is missing', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { appUrl: 'https://trip.example.com' } }))
    expect(() => enforceSameOrigin({ headers: { referer: 'https://trip.example.com/checkins/7' }, method: 'POST' } as never)).not.toThrow()
    expect(() => enforceSameOrigin({ headers: { referer: 'https://evil.example/attack' }, method: 'POST' } as never))
      .toThrowError(expect.objectContaining({ statusCode: 403 }))
    expect(() => enforceSameOrigin({ headers: { origin: 'https://trip.example.com', referer: 'https://evil.example/attack' }, method: 'POST' } as never)).not.toThrow()
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', undefined])('rejects a %s request without origin and referer', (method) => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { appUrl: 'https://trip.example.com' } }))
    expect(() => enforceSameOrigin({ headers: {}, method } as never)).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it.each([
    'http://trip.example.com',
    'https://trip.example.com:444',
    'https://evil.trip.example.com',
    'https://evil.example',
    'null',
    'not a url'
  ])('rejects mismatched or malformed origin %s', (origin) => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { appUrl: 'https://trip.example.com' } }))
    expect(() => enforceSameOrigin({ headers: { origin } } as never)).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })
})
