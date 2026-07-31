import { ReadableStream } from 'node:stream/web'
import { describe, expect, it, vi } from 'vitest'
import { readLimitedMultipart } from '../server/utils/multipart'

vi.mock('h3', async importOriginal => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    getRequestHeaders: (event: { headers: Record<string, string> }) => event.headers,
    getRequestWebStream: (event: { stream?: ReadableStream<Uint8Array> }) => event.stream
  }
})

function eventFor(body: string, headers: Record<string, string>) {
  const bytes = new TextEncoder().encode(body)
  return {
    headers,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      }
    })
  }
}

describe('readLimitedMultipart', () => {
  it('parses bounded text fields', async () => {
    const boundary = 'journey-unfinished-boundary'
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="nickname"\r\n\r\n旅人\r\n--${boundary}--\r\n`
    const parts = await readLimitedMultipart(eventFor(body, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(Buffer.byteLength(body))
    }) as never, 1024)
    const [part] = parts
    expect(part).toBeDefined()
    expect(part!.name).toBe('nickname')
    expect(part!.data.toString()).toBe('旅人')
  })

  it('rejects a declared request larger than the hard request cap', async () => {
    await expect(readLimitedMultipart(eventFor('', {
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': String(3 * 1024 * 1024)
    }) as never, 1024 * 1024)).rejects.toMatchObject({ statusCode: 413 })
  })
})
