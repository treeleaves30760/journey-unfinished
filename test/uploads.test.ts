import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MultiPartData } from 'h3'

const tempDirs: string[] = []

async function loadUploads() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-upload-'))
  tempDirs.push(directory)
  vi.resetModules()
  vi.stubGlobal('useRuntimeConfig', () => ({ uploadDir: directory, maxUploadBytes: 5_242_880 }))
  return import('../server/utils/uploads')
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('saveImage', () => {
  it('stores a valid image with a generated filename', async () => {
    const { saveImage } = await loadUploads()
    const field = {
      name: 'photo',
      filename: 'hello.jpg',
      type: 'image/jpeg',
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, ...Array(20).fill(0)])
    } satisfies MultiPartData

    const url = saveImage(field, 'photo')
    expect(url).toMatch(/^\/uploads\/photo-[a-f0-9]+\.jpg$/)
    expect(fs.existsSync(path.join(tempDirs.at(-1)!, path.basename(url!)))).toBe(true)
  })

  it('rejects unsupported MIME types and oversized payloads', async () => {
    const { saveImage } = await loadUploads()
    expect(() => saveImage({
      name: 'photo', filename: 'payload.svg', type: 'image/svg+xml', data: Buffer.from('<svg/>')
    } as MultiPartData, 'photo')).toThrowError()

    expect(() => saveImage({
      name: 'photo', filename: 'large.jpg', type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5_242_878)])
    } as MultiPartData, 'photo')).toThrowError()
  })
})
