import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import sharp from 'sharp'
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

function uploadDir() {
  return tempDirs.at(-1)!
}

function storedFile(url: string | null) {
  return fs.readFileSync(path.join(uploadDir(), path.basename(url!)))
}

function upload(type: string, data: Buffer): MultiPartData {
  return { name: 'photo', filename: 'trip', type, data }
}

// 模擬手機拍出來的照片：精確座標、拍攝時間、機型全都在 EXIF 裡。
const CAMERA_EXIF = {
  IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro' },
  IFD2: { DateTimeOriginal: '2026:07:31 10:30:00' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '25/1 10/1 5439/100',
    GPSLongitudeRef: 'E',
    GPSLongitude: '121/1 24/1 3200/100'
  }
}

function canvas(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } })
}

function photoWithExif(width: number, height: number, orientation = 1) {
  return canvas(width, height)
    .withMetadata({ orientation })
    .withExif({ ...CAMERA_EXIF, IFD0: { ...CAMERA_EXIF.IFD0, Orientation: String(orientation) } })
    .jpeg()
    .toBuffer()
}

function pngChunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0)
  return Buffer.concat([head, body, crc])
}

// 完全合法、可正常解碼的 8-bit 灰階 PNG，每條掃描線都是 filter 0 加上整排零，
// 所以幾十 KB 就能宣告幾千萬像素。刻意做成「合法」而不是「損毀」，
// 這樣擋下它的必定是 limitInputPixels，而不是解碼失敗那條路徑。
function decompressionBomb(width: number, height: number) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(height * (width + 1)))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('saveImage', () => {
  it('stores a valid image with a generated filename', async () => {
    const { saveImage } = await loadUploads()

    const url = await saveImage(upload('image/jpeg', await photoWithExif(60, 40)), 'photo')
    expect(url).toMatch(/^\/uploads\/photo-[a-f0-9]+\.jpg$/)
    expect(fs.existsSync(path.join(uploadDir(), path.basename(url!)))).toBe(true)
  })

  it('strips EXIF GPS, capture time and camera identifiers before storing', async () => {
    const { saveImage } = await loadUploads()
    const original = await photoWithExif(60, 40)
    expect((await sharp(original).metadata()).exif).toBeDefined()
    expect(original.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(true)

    const stored = storedFile(await saveImage(upload('image/jpeg', original), 'photo'))

    const metadata = await sharp(stored).metadata()
    expect(metadata.exif).toBeUndefined()
    expect(metadata.xmp).toBeUndefined()
    expect(metadata.iptc).toBeUndefined()
    // APP1 是 JPEG 裡承載 EXIF 的區段，整段不該存在。
    expect(stored.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false)
    const text = stored.toString('latin1')
    expect(text).not.toContain('GPS')
    expect(text).not.toContain('iPhone')
    expect(text).not.toContain('2026:07:31')
  })

  it('strips metadata from PNG and WebP uploads too', async () => {
    const { saveImage } = await loadUploads()
    const exif = { IFD3: CAMERA_EXIF.IFD3 }

    const png = await canvas(40, 30).withExif(exif).png().toBuffer()
    const webp = await canvas(40, 30).withExif(exif).webp().toBuffer()
    expect((await sharp(png).metadata()).exif).toBeDefined()
    expect((await sharp(webp).metadata()).exif).toBeDefined()

    const pngUrl = await saveImage(upload('image/png', png), 'photo')
    const webpUrl = await saveImage(upload('image/webp', webp), 'avatar')

    // 重新編碼不能改變 MIME 與副檔名的對應關係。
    expect(pngUrl).toMatch(/^\/uploads\/photo-[a-f0-9]+\.png$/)
    expect(webpUrl).toMatch(/^\/uploads\/avatar-[a-f0-9]+\.webp$/)
    expect((await sharp(storedFile(pngUrl)).metadata()).exif).toBeUndefined()
    expect((await sharp(storedFile(webpUrl)).metadata()).exif).toBeUndefined()
  })

  it('applies EXIF orientation before the tag is dropped', async () => {
    const { saveImage } = await loadUploads()
    // 直向照片常見的存法：畫素其實是橫的 60x40，靠 orientation=6 告訴檢視器轉 90 度。
    const original = await photoWithExif(60, 40, 6)
    expect(await sharp(original).metadata()).toMatchObject({ width: 60, height: 40, orientation: 6 })

    const stored = storedFile(await saveImage(upload('image/jpeg', original), 'photo'))

    const metadata = await sharp(stored).metadata()
    expect(metadata.orientation).toBeUndefined()
    // 沒有先 rotate() 就剝 metadata 的話，這裡會退化成 60x40，直向照片會躺平。
    expect(metadata.width).toBe(40)
    expect(metadata.height).toBe(60)
  })

  it('downscales images past the output edge cap and never enlarges small ones', async () => {
    const { saveImage } = await loadUploads()

    const wide = storedFile(await saveImage(upload('image/jpeg', await canvas(5000, 2500).jpeg().toBuffer()), 'photo'))
    expect(await sharp(wide).metadata()).toMatchObject({ width: 4096, height: 2048 })

    const small = storedFile(await saveImage(upload('image/jpeg', await canvas(30, 20).jpeg().toBuffer()), 'photo'))
    expect(await sharp(small).metadata()).toMatchObject({ width: 30, height: 20 })
  })

  it('rejects a decompression bomb that passes the byte cap', async () => {
    const { saveImage } = await loadUploads()
    // 8000x6400 = 51.2 MP，剛好越過 50 MP 上限，但只有 ~49 KB，位元組上限完全攔不到。
    const bomb = decompressionBomb(8000, 6400)
    expect(bomb.length).toBeLessThan(64 * 1024)
    // 這張圖是合法的：sharp 預設 268 MP 上限下讀得出正確尺寸，所以下面的失敗只可能來自我們的上限。
    expect(await sharp(bomb).metadata()).toMatchObject({ format: 'png', width: 8000, height: 6400 })

    await expect(saveImage(upload('image/png', bomb), 'photo')).rejects.toMatchObject({ statusCode: 415 })
    expect(fs.readdirSync(uploadDir())).toHaveLength(0)
  })

  it('rejects corrupt payloads that still carry valid magic bytes', async () => {
    const { saveImage } = await loadUploads()
    const corrupt = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, ...Array(20).fill(0)])

    // 415 而不是 500，而且訊息不能夾帶 sharp 的堆疊或伺服器路徑。
    await expect(saveImage(upload('image/jpeg', corrupt), 'photo')).rejects.toMatchObject({
      statusCode: 415,
      message: '無法處理這張圖片，可能檔案已損毀或尺寸過大'
    })
    expect(fs.readdirSync(uploadDir())).toHaveLength(0)
  })

  it('rejects unsupported MIME types and oversized payloads', async () => {
    const { saveImage } = await loadUploads()
    await expect(saveImage(upload('image/svg+xml', Buffer.from('<svg/>')), 'photo'))
      .rejects.toMatchObject({ statusCode: 415 })

    await expect(saveImage(upload('image/jpeg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5_242_878)])), 'photo'))
      .rejects.toMatchObject({ statusCode: 413 })

    // MIME 說是 PNG 但 magic bytes 是 JPEG，仍要在進到解碼器前就擋下。
    await expect(saveImage(upload('image/png', await canvas(20, 20).jpeg().toBuffer()), 'photo'))
      .rejects.toMatchObject({ statusCode: 415 })

    expect(fs.readdirSync(uploadDir())).toHaveLength(0)
  })

  it('ignores empty and missing parts', async () => {
    const { saveImage } = await loadUploads()
    expect(await saveImage(undefined, 'avatar')).toBeNull()
    expect(await saveImage(upload('image/jpeg', Buffer.alloc(0)), 'avatar')).toBeNull()
  })
})
