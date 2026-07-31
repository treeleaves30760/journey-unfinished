import { ReadableStream } from 'node:stream/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enforceSameOrigin, readLimitedJson } from '../server/utils/request-security'

vi.mock('h3', async importOriginal => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    getRequestHeader: (event: { headers: Record<string, string> }, name: string) => event.headers[name.toLowerCase()],
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

describe('enforceSameOrigin', () => {
  it('accepts the configured origin and explicit non-browser requests', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { appUrl: 'https://trip.example.com/app/' } }))
    expect(() => enforceSameOrigin({ headers: { origin: 'https://trip.example.com' } } as never)).not.toThrow()
    expect(() => enforceSameOrigin({ headers: {} } as never)).not.toThrow()
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
