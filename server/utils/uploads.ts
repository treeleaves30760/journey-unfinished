import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createError, type MultiPartData } from 'h3'
import sharp from 'sharp'

const IMAGE_TYPES: Record<string, { extension: string, signatures: number[][] }> = {
  'image/jpeg': { extension: 'jpg', signatures: [[0xff, 0xd8, 0xff]] },
  'image/png': { extension: 'png', signatures: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  'image/webp': { extension: 'webp', signatures: [[0x52, 0x49, 0x46, 0x46]] }
}

// 位元組上限擋不住 decompression bomb：一張 5 MiB 的 PNG 可以解出數 GB 的點陣資料，
// 所以解碼前先設像素上限。5 MiB 以內的真實照片遠低於 50 MP，會被擋下的幾乎只有惡意檔案。
const MAX_INPUT_PIXELS = 50_000_000
// 輸出最長邊。網頁上的旅遊照片不需要比這更大，同時把重新編碼的記憶體與時間成本壓住。
const MAX_OUTPUT_EDGE = 4096
// 82 對照片來說肉眼幾乎看不出損失，再往上只會讓檔案變大而看不出差別。
const IMAGE_QUALITY = 82

function hasSignature(buffer: Buffer, mime: string) {
  if (mime === 'image/webp') {
    return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
  }
  return IMAGE_TYPES[mime]?.signatures.some(signature =>
    signature.every((byte, index) => buffer[index] === byte)
  )
}

function reencodeWithoutMetadata(data: Buffer, mime: string) {
  // 這裡是隱私修補的核心：這個網站會公開分享照片，而使用者原始檔的 EXIF 帶著小數點後六位的
  // GPS 座標、拍攝時間與相機／手機序號。sharp 預設就不保留任何 metadata（除非明確呼叫
  // .withMetadata() / .keepExif()），所以「解碼再重新編碼」本身就把 EXIF、XMP、IPTC 整組丟掉。
  // 這正是我們要的行為，因此刻意不呼叫 .withMetadata()。
  const pipeline = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
    // 必須先套用 EXIF Orientation 再剝除 metadata，否則直向照片失去 orientation 旗標後會躺平變成橫的。
    // 順序也有意義：sharp 要求 rotate() 排在 resize() 之前才會拿到正確的邊長。
    .rotate()
    .resize({ width: MAX_OUTPUT_EDGE, height: MAX_OUTPUT_EDGE, fit: 'inside', withoutEnlargement: true })

  // 依原始 MIME 輸出對應格式，維持與 IMAGE_TYPES 副檔名的對應關係不變。
  if (mime === 'image/png') return pipeline.png({ compressionLevel: 9 }).toBuffer()
  if (mime === 'image/webp') return pipeline.webp({ quality: IMAGE_QUALITY }).toBuffer()
  return pipeline.jpeg({ quality: IMAGE_QUALITY, mozjpeg: true }).toBuffer()
}

export function multipartFields(parts: MultiPartData[]) {
  const fields: Record<string, string> = {}
  const files = new Map<string, MultiPartData>()
  for (const part of parts) {
    if (!part.name) continue
    if (part.filename) {
      if (files.has(part.name)) throw createError({ statusCode: 400, message: `欄位 ${part.name} 只能上傳一個檔案` })
      files.set(part.name, part)
    } else {
      fields[part.name] = part.data.toString('utf8')
    }
  }
  return { fields, files }
}

export async function saveImage(part: MultiPartData | undefined, prefix: 'photo' | 'avatar') {
  if (!part || !part.data.length) return null
  const config = useRuntimeConfig()
  const maxBytes = Number(config.maxUploadBytes)
  if (part.data.length > maxBytes) {
    throw createError({ statusCode: 413, message: `圖片不可超過 ${Math.round(maxBytes / 1024 / 1024)}MB` })
  }
  const mime = String(part.type || '').toLowerCase()
  const image = IMAGE_TYPES[mime]
  // MIME 與 magic bytes 仍是第一道防線：先擋掉 SVG 這種會把 XML 解析器（外部實體、遠端資源）
  // 拉進解碼流程的格式，不讓它有機會走到 sharp。
  if (!image || !hasSignature(part.data, mime)) {
    throw createError({ statusCode: 415, message: '只接受有效的 JPEG、PNG 或 WebP 圖片' })
  }

  let encoded: Buffer
  try {
    encoded = await reencodeWithoutMetadata(part.data, mime)
  } catch {
    // magic bytes 對但內容損毀、或超過像素上限時，sharp 的原始例外會帶著堆疊與檔案路徑，不能外流。
    throw createError({ statusCode: 415, message: '無法處理這張圖片，可能檔案已損毀或尺寸過大' })
  }
  // 重新編碼理論上只會變小，但 PNG 這種無損格式仍可能因為原檔壓縮得更好而長大。
  if (encoded.length > maxBytes) {
    throw createError({ statusCode: 413, message: `圖片處理後仍超過 ${Math.round(maxBytes / 1024 / 1024)}MB，請改用較小的圖片` })
  }

  const uploadDir = path.resolve(String(config.uploadDir))
  fs.mkdirSync(uploadDir, { recursive: true })
  const filename = `${prefix}-${randomBytes(18).toString('hex')}.${image.extension}`
  fs.writeFileSync(path.join(uploadDir, filename), encoded, { flag: 'wx', mode: 0o600 })
  return `/uploads/${filename}`
}

export function removeSavedImage(url: string | null) {
  if (!url) return
  try {
    const filename = path.basename(url)
    fs.unlinkSync(path.resolve(String(useRuntimeConfig().uploadDir), filename))
  } catch {
    // Best-effort rollback when the database insert fails.
  }
}
