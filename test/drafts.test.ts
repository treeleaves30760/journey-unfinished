import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE } from '../server/utils/auth'
import type { Draft } from '../server/utils/database'

const APP_URL = 'https://trip.example.com'
const OWNER_DISCORD_ID = '100000000000000011'
const STRANGER_DISCORD_ID = '200000000000000022'

interface Part { name: string, data: Buffer, filename?: string, type?: string }
interface TestEvent {
  method: string
  headers: Record<string, string>
  cookies: Record<string, string>
  context: { params: Record<string, string> }
  socket: string
  parts: Part[]
  status?: number
}

vi.mock('h3', async importOriginal => ({
  ...await importOriginal<typeof import('h3')>(),
  getRequestHeader: (event: TestEvent, name: string) => event.headers[name.toLowerCase()],
  getRequestIP: (event: TestEvent) => event.socket,
  getCookie: (event: TestEvent, name: string) => event.cookies[name],
  deleteCookie: () => {},
  setCookie: () => {}
}))

// multipart 的串流解析本身有自己的測試（test/multipart.test.ts），這裡要跑的是草稿端點的
// 邏輯，所以直接把已解析好的 parts 交給它。圖片仍然走真正的 saveImage（sharp 重新編碼、
// 剝除 EXIF、寫進上傳目錄），檔案的建立與回收才測得到。
vi.mock('../server/utils/multipart', () => ({
  readLimitedMultipart: async (event: TestEvent) => event.parts
}))

let jpeg: Buffer
let secondJpeg: Buffer

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#d9677e' } }).jpeg().toBuffer()
  secondJpeg = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#3f705d' } }).jpeg().toBuffer()
})

function field(name: string, value: string): Part {
  return { name, data: Buffer.from(value) }
}

function file(name: string, data: Buffer): Part {
  return { name, data, filename: `${name}.jpg`, type: 'image/jpeg' }
}

const temporaryDirectories: string[] = []
let closeCurrentDatabase: (() => void) | undefined

async function loadContext() {
  closeCurrentDatabase?.()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-drafts-'))
  temporaryDirectories.push(root)
  const uploadDir = path.join(root, 'uploads')
  fs.mkdirSync(uploadDir, { recursive: true })

  vi.resetModules()
  vi.stubGlobal('useRuntimeConfig', () => ({
    databasePath: path.join(root, 'app.sqlite'),
    uploadDir,
    maxUploadBytes: 5_242_880,
    adminDiscordIds: '',
    trustedProxyHops: 0,
    sessionDays: 30,
    public: { appUrl: APP_URL }
  }))
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('setResponseStatus', (event: TestEvent, status: number) => { event.status = status })

  const database = await import('../server/utils/database')
  closeCurrentDatabase = database.closeDatabaseForTests
  const auth = await import('../server/utils/auth')

  const handlers = {
    list: (await import('../server/api/drafts/index.get')).default as unknown as (event: TestEvent) => { drafts: Draft[] },
    create: (await import('../server/api/drafts/index.post')).default as unknown as (event: TestEvent) => Promise<{ draft: Draft }>,
    read: (await import('../server/api/drafts/[id].get')).default as unknown as (event: TestEvent) => { draft: Draft },
    update: (await import('../server/api/drafts/[id].put')).default as unknown as (event: TestEvent) => Promise<{ draft: Draft }>,
    remove: (await import('../server/api/drafts/[id].delete')).default as unknown as (event: TestEvent) => { deleted: boolean },
    publish: (await import('../server/api/checkins/index.post')).default as unknown as (event: TestEvent) => Promise<{ checkin: { id: number, photo: string | null, avatar: string | null } }>
  }

  function signIn(discordId: string, displayName: string) {
    const user = database.upsertDiscordUser({ discordId, username: displayName, displayName, avatarUrl: null })
    const token = `session-${discordId}`
    database.createAuthSession(auth.hashToken(token), user.id, Date.now() + 3_600_000)
    return { id: user.id, token }
  }

  function event(options: { token?: string, id?: string | number, parts?: Part[], origin?: string | null } = {}): TestEvent {
    return {
      method: 'POST',
      headers: options.origin === null ? {} : { origin: options.origin ?? APP_URL },
      cookies: options.token ? { [SESSION_COOKIE]: options.token } : {},
      context: { params: { id: String(options.id ?? '') } },
      socket: '198.51.100.20',
      parts: options.parts ?? []
    }
  }

  const uploadedFiles = () => fs.readdirSync(uploadDir)

  return { database, handlers, signIn, event, uploadDir, uploadedFiles }
}

afterEach(() => {
  closeCurrentDatabase?.()
  closeCurrentDatabase = undefined
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('草稿的建立與跨裝置接手', () => {
  it('stores a half-finished draft with its photo and hands it back on another device', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')

    // 手機端：只拍了照片、標了座標
    const { draft } = await handlers.create(event({
      token: owner.token,
      parts: [
        field('countryCode', 'JP'),
        field('county', '京都府'),
        field('latitude', '35.0169'),
        field('longitude', '135.6716'),
        file('photo', jpeg)
      ]
    }))
    expect(draft).toMatchObject({ countryCode: 'JP', county: '京都府', message: null, dollName: null })
    expect(draft.photo).toMatch(/^\/uploads\/photo-[a-f0-9]+\.jpg$/)
    expect(uploadedFiles()).toHaveLength(1)

    // 電腦端：同一個帳號打開同一份草稿
    const reopened = handlers.read(event({ token: owner.token, id: draft.id }))
    expect(reopened.draft).toMatchObject({ id: draft.id, photo: draft.photo })
    expect(handlers.list(event({ token: owner.token })).drafts).toHaveLength(1)
  })

  it('requires a login and a same-origin request', async () => {
    const { handlers, event } = await loadContext()
    expect(() => handlers.list(event())).toThrow(expect.objectContaining({ statusCode: 401 }))
    await expect(handlers.create(event({ origin: null }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('caps how many drafts one account can pile up', async () => {
    const { database, handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const { MAX_DRAFTS_PER_USER } = await import('../server/utils/drafts')
    for (let index = 0; index < MAX_DRAFTS_PER_USER; index += 1) {
      database.createDraft(owner.id, {
        nickname: null, location: `地點 ${index}`, countryCode: null, county: null,
        latitude: null, longitude: null, dollName: null, series: null,
        message: null, visitedAt: null, avatarPreset: 'sun'
      }, null, null)
    }
    // 每份草稿都可能帶著一張 5 MB 的照片，沒有上限就是一條無限制的空間消耗路徑
    await expect(handlers.create(event({ token: owner.token }))).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('草稿的擁有權', () => {
  it('hides another traveller draft behind a 404 rather than a 403', async () => {
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const stranger = signIn(STRANGER_DISCORD_ID, '路過的人')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [field('location', '祕密基地')] }))

    // 403 等於告訴對方「這個編號的草稿存在」，草稿是還沒公開的內容，連存在與否都不該外流
    const notFound = expect.objectContaining({ statusCode: 404 })
    expect(() => handlers.read(event({ token: stranger.token, id: draft.id }))).toThrow(notFound)
    await expect(handlers.update(event({ token: stranger.token, id: draft.id }))).rejects.toMatchObject({ statusCode: 404 })
    expect(() => handlers.remove(event({ token: stranger.token, id: draft.id }))).toThrow(notFound)
    expect(handlers.list(event({ token: stranger.token })).drafts).toHaveLength(0)
  })
})

describe('草稿的圖片生命週期', () => {
  it('keeps the phone photo when the desktop edit only changes text', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [file('photo', jpeg)] }))

    const updated = await handlers.update(event({
      token: owner.token,
      id: draft.id,
      parts: [field('message', '## 竹林的清晨\n\n六點的竹林還沒有人。')]
    }))
    // 沒有帶新檔案就是「保留原圖」。少了這個狀態，手機存好的照片會在桌機按下儲存時被清掉。
    expect(updated.draft.photo).toBe(draft.photo)
    expect(updated.draft.message).toBe('## 竹林的清晨\n\n六點的竹林還沒有人。')
    expect(uploadedFiles()).toHaveLength(1)
  })

  it('replaces the photo and deletes the file it replaced', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [file('photo', jpeg)] }))

    const updated = await handlers.update(event({ token: owner.token, id: draft.id, parts: [file('photo', secondJpeg)] }))
    expect(updated.draft.photo).not.toBe(draft.photo)
    expect(uploadedFiles()).toEqual([path.basename(updated.draft.photo!)])
  })

  it('clears the photo only when explicitly asked to', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [file('photo', jpeg)] }))

    const updated = await handlers.update(event({ token: owner.token, id: draft.id, parts: [field('clearPhoto', '1')] }))
    expect(updated.draft.photo).toBeNull()
    expect(uploadedFiles()).toHaveLength(0)
  })

  it('removes the stored images when the draft is deleted', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [file('photo', jpeg)] }))

    expect(handlers.remove(event({ token: owner.token, id: draft.id }))).toEqual({ deleted: true })
    expect(uploadedFiles()).toHaveLength(0)
    expect(handlers.list(event({ token: owner.token })).drafts).toHaveLength(0)
  })

  it('rolls back only the image this request saved when validation fails', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [file('photo', jpeg)] }))

    // 座標超出地球範圍：驗證擋下之後，草稿原本那張圖必須留著，只回滾這次新存的檔案
    await expect(handlers.update(event({
      token: owner.token,
      id: draft.id,
      parts: [field('latitude', '95'), file('photo', secondJpeg)]
    }))).rejects.toMatchObject({ statusCode: 400 })
    expect(uploadedFiles()).toEqual([path.basename(draft.photo!)])
  })
})

describe('把草稿發佈成旅箋', () => {
  const publishFields = [
    field('nickname', '柚子'),
    field('location', '嵐山竹林小徑'),
    field('countryCode', 'JP'),
    field('county', '京都府'),
    field('latitude', '35.0169'),
    field('longitude', '135.6716'),
    field('dollName', '小柚'),
    field('message', '## 竹林的清晨\n\n六點的竹林還沒有人。'),
    field('visitedAt', '2025-11-03'),
    field('avatarPreset', 'leaf')
  ]

  it('reuses the draft photo, then removes the draft but keeps the file', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [file('photo', jpeg)] }))

    const { checkin } = await handlers.publish(event({
      token: owner.token,
      parts: [...publishFields, field('draftId', String(draft.id))]
    }))
    // 手機上已經上傳、也已經被 sharp 剝過 EXIF 的那張圖直接沿用，不必為了發佈再傳一次幾 MB
    expect(checkin.photo).toBe(draft.photo)
    expect(uploadedFiles()).toEqual([path.basename(draft.photo!)])
    expect(handlers.list(event({ token: owner.token })).drafts).toHaveLength(0)
  })

  it('uses a freshly uploaded photo and cleans up the one the draft was holding', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [file('photo', jpeg)] }))

    const { checkin } = await handlers.publish(event({
      token: owner.token,
      parts: [...publishFields, field('draftId', String(draft.id)), file('photo', secondJpeg)]
    }))
    expect(checkin.photo).not.toBe(draft.photo)
    // 草稿那張已經沒有人引用了，留著就是孤兒檔案
    expect(uploadedFiles()).toEqual([path.basename(checkin.photo!)])
  })

  it('refuses to publish someone else draft', async () => {
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const stranger = signIn(STRANGER_DISCORD_ID, '路過的人')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [file('photo', jpeg)] }))

    await expect(handlers.publish(event({
      token: stranger.token,
      parts: [...publishFields, field('draftId', String(draft.id))]
    }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('still demands a photo when neither the draft nor the request has one', async () => {
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '草稿作者')
    const { draft } = await handlers.create(event({ token: owner.token, parts: [field('location', '只標了地點')] }))

    await expect(handlers.publish(event({
      token: owner.token,
      parts: [...publishFields, field('draftId', String(draft.id))]
    }))).rejects.toMatchObject({ statusCode: 400 })
    // 發佈失敗，草稿必須原封不動地留著
    expect(handlers.list(event({ token: owner.token })).drafts).toHaveLength(1)
  })
})
