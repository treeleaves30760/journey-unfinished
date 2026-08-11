import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE } from '../server/utils/auth'
import type { Checkin, Doll } from '../server/utils/database'

const APP_URL = 'https://trip.example.com'
const OWNER_DISCORD_ID = '100000000000000031'
const STRANGER_DISCORD_ID = '200000000000000032'

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

vi.mock('../server/utils/multipart', () => ({
  readLimitedMultipart: async (event: TestEvent) => event.parts
}))

let jpeg: Buffer

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#d9677e' } }).jpeg().toBuffer()
})

const field = (name: string, value: string): Part => ({ name, data: Buffer.from(value) })
const file = (name: string, data: Buffer): Part => ({ name, data, filename: `${name}.jpg`, type: 'image/jpeg' })

const temporaryDirectories: string[] = []
let closeCurrentDatabase: (() => void) | undefined

async function loadContext() {
  closeCurrentDatabase?.()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-unfinished-dolls-'))
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
  // 旅箋的刪除路由用 getRouterParam 取 id（草稿與娃娃用 event.context.params），
  // Nitro 的自動匯入在 vitest 裡不存在，補上等價實作。
  vi.stubGlobal('getRouterParam', (event: TestEvent, name: string) => event.context.params[name])

  const database = await import('../server/utils/database')
  closeCurrentDatabase = database.closeDatabaseForTests
  const auth = await import('../server/utils/auth')

  const handlers = {
    list: (await import('../server/api/dolls/index.get')).default as unknown as (event: TestEvent) => { dolls: Doll[], lastNickname: string | null },
    create: (await import('../server/api/dolls/index.post')).default as unknown as (event: TestEvent) => Promise<{ doll: Doll }>,
    update: (await import('../server/api/dolls/[id].put')).default as unknown as (event: TestEvent) => Promise<{ doll: Doll }>,
    remove: (await import('../server/api/dolls/[id].delete')).default as unknown as (event: TestEvent) => { deleted: boolean },
    publish: (await import('../server/api/checkins/index.post')).default as unknown as (event: TestEvent) => Promise<{ checkin: Checkin }>,
    deleteCheckin: (await import('../server/api/checkins/[id].delete')).default as unknown as (event: TestEvent) => { deleted: boolean }
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
      socket: '198.51.100.30',
      parts: options.parts ?? []
    }
  }

  return { database, handlers, signIn, event, uploadedFiles: () => fs.readdirSync(uploadDir) }
}

afterEach(() => {
  closeCurrentDatabase?.()
  closeCurrentDatabase = undefined
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

// 發佈一則旅箋需要的固定欄位；娃娃相關的部分由各測試自己加。
const publishFields = [
  field('nickname', '柚子'),
  field('location', '嵐山竹林小徑'),
  field('countryCode', 'JP'),
  field('county', '京都府'),
  field('latitude', '35.0169'),
  field('longitude', '135.6716'),
  field('dollName', '小柚'),
  field('message', '六點的竹林還沒有人。'),
  field('visitedAt', '2025-11-03'),
  field('avatarPreset', 'leaf'),
  file('photo', Buffer.alloc(0))
]

describe('娃娃檔案的建立與擁有權', () => {
  it('stores a doll with its cropped avatar and lists it back', async () => {
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')

    const { doll } = await handlers.create(event({
      token: owner.token,
      parts: [field('name', '暖暖'), field('series', '夏日重現'), field('avatarPreset', 'sun'), file('avatar', jpeg)]
    }))
    expect(doll).toMatchObject({ name: '暖暖', series: '夏日重現', avatarPreset: 'sun', checkinCount: 0, lastUsedAt: null })
    expect(doll.avatar).toMatch(/^\/uploads\/avatar-[a-f0-9]+\.jpg$/)
    expect(handlers.list(event({ token: owner.token })).dolls).toHaveLength(1)
  })

  it('hides another traveller doll behind a 404', async () => {
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    const stranger = signIn(STRANGER_DISCORD_ID, '路過的人')
    const { doll } = await handlers.create(event({ token: owner.token, parts: [field('name', '暖暖')] }))

    const notFound = expect.objectContaining({ statusCode: 404 })
    await expect(handlers.update(event({ token: stranger.token, id: doll.id, parts: [field('name', '被偷改的')] })))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(() => handlers.remove(event({ token: stranger.token, id: doll.id }))).toThrow(notFound)
    expect(handlers.list(event({ token: stranger.token })).dolls).toHaveLength(0)
  })

  it('refuses to attach someone else doll to your own note', async () => {
    // 少了這道檢查，任何人都能把別人的頭像套到自己的旅箋上
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    const stranger = signIn(STRANGER_DISCORD_ID, '路過的人')
    const { doll } = await handlers.create(event({ token: owner.token, parts: [field('name', '暖暖'), file('avatar', jpeg)] }))

    await expect(handlers.publish(event({
      token: stranger.token,
      parts: [...publishFields.slice(0, -1), file('photo', jpeg), field('dollId', String(doll.id))]
    }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('caps how many dolls one account can create', async () => {
    const { database, handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    const { MAX_DOLLS_PER_USER } = await import('../server/utils/dolls')
    for (let index = 0; index < MAX_DOLLS_PER_USER; index += 1) {
      database.createDoll(owner.id, { name: `娃娃 ${index}`, series: null, avatarPreset: 'sun' }, null)
    }
    await expect(handlers.create(event({ token: owner.token, parts: [field('name', '再一隻')] })))
      .rejects.toMatchObject({ statusCode: 409 })
  })
})

// 這一組是資料毀損的回歸測試。娃娃的頭像會被套到很多則旅箋上，而刪除旅箋會連它的圖檔
// 一起刪掉 —— 若讓多列共用同一個路徑，刪掉其中一則就會弄壞娃娃檔案與其他所有旅箋。
describe('頭像的歸屬', () => {
  it('gives the note its own copy of the doll avatar', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    const { doll } = await handlers.create(event({ token: owner.token, parts: [field('name', '暖暖'), file('avatar', jpeg)] }))

    const { checkin } = await handlers.publish(event({
      token: owner.token,
      parts: [...publishFields.slice(0, -1), file('photo', jpeg), field('dollId', String(doll.id))]
    }))
    expect(checkin.dollId).toBe(doll.id)
    expect(checkin.avatar).not.toBe(doll.avatar)
    // 娃娃頭像、旅箋自己的頭像副本、旅途照片
    expect(uploadedFiles()).toHaveLength(3)
  })

  it('keeps the doll avatar intact when a note using it is deleted', async () => {
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    const { doll } = await handlers.create(event({ token: owner.token, parts: [field('name', '暖暖'), file('avatar', jpeg)] }))
    const { checkin } = await handlers.publish(event({
      token: owner.token,
      parts: [...publishFields.slice(0, -1), file('photo', jpeg), field('dollId', String(doll.id))]
    }))

    expect(handlers.deleteCheckin({ ...event({ token: owner.token }), method: 'DELETE', context: { params: { id: String(checkin.id) } } }))
      .toEqual({ deleted: true })
    // 娃娃檔案的那張還在
    expect(uploadedFiles()).toContain(path.basename(doll.avatar!))
    expect(handlers.list(event({ token: owner.token })).dolls[0]!.avatar).toBe(doll.avatar)
  })

  it('lets clearAvatar override the doll when the author supplies their own', async () => {
    // 「我選了娃娃，但這一則想用另一張頭像」
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    const { doll } = await handlers.create(event({ token: owner.token, parts: [field('name', '暖暖'), file('avatar', jpeg)] }))

    const { checkin } = await handlers.publish(event({
      token: owner.token,
      parts: [
        ...publishFields.slice(0, -1), file('photo', jpeg), file('avatar', jpeg),
        field('dollId', String(doll.id)), field('clearAvatar', '1')
      ]
    }))
    expect(checkin.avatar).not.toBe(doll.avatar)
    expect(checkin.avatar).not.toBeNull()
    expect(checkin.dollId).toBe(doll.id)
  })

  it('refuses to publish with no avatar at all', async () => {
    // 「預設頭像」已經不存在了，clearAvatar 不再是一條可以什麼都不留的退路。
    const { handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    const { doll } = await handlers.create(event({ token: owner.token, parts: [field('name', '暖暖'), file('avatar', jpeg)] }))
    const before = uploadedFiles()

    await expect(handlers.publish(event({
      token: owner.token,
      parts: [...publishFields.slice(0, -1), file('photo', jpeg), field('dollId', String(doll.id)), field('clearAvatar', '1')]
    }))).rejects.toMatchObject({ statusCode: 400 })
    // 被擋下來的請求不能留下任何檔案，娃娃檔案自己那張也必須完好
    expect(uploadedFiles()).toEqual(before)
  })

  it('refuses to publish without a doll and without an avatar', async () => {
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')

    await expect(handlers.publish(event({
      token: owner.token,
      parts: [...publishFields.slice(0, -1), file('photo', jpeg)]
    }))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('記住上次用的娃娃', () => {
  it('moves the doll used most recently to the front of the list', async () => {
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    const first = (await handlers.create(event({ token: owner.token, parts: [field('name', '暖暖')] }))).doll
    const second = (await handlers.create(event({ token: owner.token, parts: [field('name', '芽芽')] }))).doll

    // 還沒用過任何一隻時，最新建立的排前面
    expect(handlers.list(event({ token: owner.token })).dolls.map(doll => doll.id)).toEqual([second.id, first.id])

    // 這兩隻娃娃都沒有頭像，發佈時得自己帶一張（頭像是必填的）
    await handlers.publish(event({
      token: owner.token,
      parts: [...publishFields.slice(0, -1), file('photo', jpeg), file('avatar', jpeg), field('dollId', String(first.id))]
    }))
    const listed = handlers.list(event({ token: owner.token })).dolls
    expect(listed[0]).toMatchObject({ id: first.id, checkinCount: 1 })
    expect(listed[0]!.lastUsedAt).not.toBeNull()
  })

  it('reports the nickname from the last note so the form can prefill it', async () => {
    const { handlers, signIn, event } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    expect(handlers.list(event({ token: owner.token })).lastNickname).toBeNull()

    await handlers.publish(event({
      token: owner.token,
      parts: [...publishFields.slice(0, -1), file('photo', jpeg), file('avatar', jpeg)]
    }))
    expect(handlers.list(event({ token: owner.token })).lastNickname).toBe('柚子')
  })
})

describe('刪除娃娃檔案', () => {
  it('leaves already written notes untouched', async () => {
    const { database, handlers, signIn, event, uploadedFiles } = await loadContext()
    const owner = signIn(OWNER_DISCORD_ID, '娃娃主人')
    const { doll } = await handlers.create(event({ token: owner.token, parts: [field('name', '暖暖'), file('avatar', jpeg)] }))
    const { checkin } = await handlers.publish(event({
      token: owner.token,
      parts: [...publishFields.slice(0, -1), file('photo', jpeg), field('dollId', String(doll.id))]
    }))

    expect(handlers.remove(event({ token: owner.token, id: doll.id }))).toEqual({ deleted: true })

    // 已經寫下的旅程不該因為「以後不想留這個檔案了」就少掉資訊：
    // 名稱與頭像是它自己那一份副本，只有關聯被設成 null。
    const after = database.findCheckin(checkin.id)!
    expect(after).toMatchObject({ dollName: '小柚', dollId: null })
    expect(after.avatar).toBe(checkin.avatar)
    // 旅箋自己那份頭像副本還在磁碟上；被刪掉的只有娃娃檔案的那一張
    expect(uploadedFiles()).toContain(path.basename(after.avatar!))
    expect(uploadedFiles()).not.toContain(path.basename(doll.avatar!))
  })
})
