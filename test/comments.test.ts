import { ReadableStream } from 'node:stream/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 端點檔用的是 Nitro 的自動匯入，vitest 裡沒有那一層，而 defineEventHandler 在模組被求值的
// 當下就會呼叫，所以必須用 vi.hoisted 在 import 之前先把這些全域補上。
const runtime = vi.hoisted(() => {
  const config = {
    trustedProxyHops: 0,
    public: { appUrl: 'https://trip.example.com' }
  }
  Object.assign(globalThis, {
    defineEventHandler: (handler: unknown) => handler,
    getRouterParam: (event: { params: Record<string, string> }, name: string) => event.params[name],
    setResponseStatus: (event: { statusCode: number }, status: number) => {
      event.statusCode = status
    },
    useRuntimeConfig: () => config
  })
  return { config }
})

const databaseMocks = vi.hoisted(() => ({
  findCheckin: vi.fn(),
  createComment: vi.fn()
}))

vi.mock('h3', async importOriginal => ({
  ...await importOriginal<typeof import('h3')>(),
  getRequestHeader: (event: { headers: Record<string, string> }, name: string) => event.headers[name.toLowerCase()],
  getRequestIP: (event: { socket: string }) => event.socket,
  getRequestWebStream: (event: { stream: ReadableStream<Uint8Array> }) => event.stream
}))
vi.mock('../server/utils/database', () => databaseMocks)

import handler from '../server/api/checkins/[id]/comments/index.post'

const APP_ORIGIN = 'https://trip.example.com'
const BASE_TIME = Date.UTC(2026, 6, 1)
const MINUTE = 60_000
const rateLimited = { statusCode: 429, message: '操作太頻繁，請稍後再試' }
const duplicate = { statusCode: 429, message: '剛剛已送出相同內容的留言，請換個說法再試' }

interface RequestOptions {
  socket: string
  id?: string
  nickname?: string
  message?: string
  origin?: string | null
  forwardedFor?: string
}

function commentRequest(options: RequestOptions) {
  const body = JSON.stringify({
    nickname: options.nickname ?? '阿明',
    message: options.message ?? '好可愛！'
  })
  return {
    method: 'POST',
    statusCode: 0,
    socket: options.socket,
    params: { id: options.id ?? '1' },
    headers: {
      'content-type': 'application/json',
      ...(options.origin === null ? {} : { origin: options.origin ?? APP_ORIGIN }),
      ...(options.forwardedFor === undefined ? {} : { 'x-forwarded-for': options.forwardedFor })
    },
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      }
    })
  }
}

function post(options: RequestOptions) {
  return handler(commentRequest(options) as never)
}

// enforceRateLimit 與 assertUniqueComment 的表都是模組層級狀態，且整個檔案共用一份。
// 每個案例改用自己的來源位址來隔離，時間則靠假造的 Date.now 推進，不等真實時鐘。
let now = BASE_TIME
const advanceTo = (offset: number) => {
  now = BASE_TIME + offset
}

beforeEach(() => {
  now = BASE_TIME
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  databaseMocks.findCheckin.mockImplementation((id: number) => ({ id }))
  databaseMocks.createComment.mockImplementation((checkinId: number, nickname: string, message: string) => ({
    id: checkinId * 100,
    nickname,
    message,
    createdAt: '2026-07-01 00:00:00'
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.values(databaseMocks).forEach(mock => mock.mockReset())
})

describe('POST /api/checkins/:id/comments', () => {
  it('stores a validated comment and answers 201', async () => {
    const event = commentRequest({ socket: '198.51.100.1', id: '7', message: ' 好可愛！ ' })
    await expect(handler(event as never)).resolves.toEqual({
      comment: { id: 700, nickname: '阿明', message: '好可愛！', createdAt: '2026-07-01 00:00:00' }
    })
    expect(event.statusCode).toBe(201)
    // 寫進資料庫的是驗證後的值，不是原始 body
    expect(databaseMocks.createComment).toHaveBeenCalledWith(7, '阿明', '好可愛！')
  })

  it('still refuses cross-site posts and unknown check-ins', async () => {
    await expect(post({ socket: '198.51.100.2', origin: 'https://evil.example' }))
      .rejects.toMatchObject({ statusCode: 403 })

    databaseMocks.findCheckin.mockReturnValue(undefined)
    await expect(post({ socket: '198.51.100.2' })).rejects.toMatchObject({ statusCode: 404 })
    expect(databaseMocks.createComment).not.toHaveBeenCalled()
  })
})

describe('分層限流', () => {
  it('lets a minute of five comments through and blocks the burst on the sixth', async () => {
    const socket = '198.51.100.3'
    for (let index = 0; index < 5; index += 1) {
      await expect(post({ socket, message: `第 ${index} 則留言` })).resolves.toBeTruthy()
    }
    await expect(post({ socket, message: '第 5 則留言' })).rejects.toMatchObject(rateLimited)
    expect(databaseMocks.createComment).toHaveBeenCalledTimes(5)
  })

  it('keeps the hourly cap as the outer bound once burst windows roll over', async () => {
    const socket = '198.51.100.4'
    let sent = 0
    // 貼著爆量閘的節奏送：每兩分鐘五則，六輪剛好用滿每小時 30 則
    for (let round = 0; round < 6; round += 1) {
      advanceTo(round * 2 * MINUTE)
      for (let index = 0; index < 5; index += 1) {
        await expect(post({ socket, id: String(round + 1), message: `第 ${sent} 則留言` })).resolves.toBeTruthy()
        sent += 1
      }
    }
    expect(sent).toBe(30)

    // 第 31 則落在全新的爆量視窗，短窗放行，卻已經撞到時量上限
    advanceTo(20 * MINUTE)
    await expect(post({ socket, id: '7', message: '第 30 則留言' })).rejects.toMatchObject(rateLimited)
  })

  it('caps one source per journal entry without touching the others', async () => {
    const socket = '198.51.100.5'
    let sent = 0
    for (let round = 0; round < 2; round += 1) {
      advanceTo(round * (MINUTE + 1_000))
      for (let index = 0; index < 5; index += 1) {
        await expect(post({ socket, id: '42', message: `第 ${sent} 則留言` })).resolves.toBeTruthy()
        sent += 1
      }
    }

    advanceTo(2 * (MINUTE + 1_000))
    await expect(post({ socket, id: '42', message: '第 10 則留言' })).rejects.toMatchObject(rateLimited)
    // 同一個來源、同一個瞬間，換一則旅箋仍然留得了言 —— 證明計數桶的 key 真的含 checkin id
    await expect(post({ socket, id: '43', message: '第 11 則留言' })).resolves.toBeTruthy()
  })

  it('meters each source separately', async () => {
    for (let index = 0; index < 5; index += 1) {
      await expect(post({ socket: '198.51.100.6', message: `第 ${index} 則留言` })).resolves.toBeTruthy()
    }
    await expect(post({ socket: '198.51.100.6', message: '第 5 則留言' })).rejects.toMatchObject(rateLimited)
    await expect(post({ socket: '198.51.100.7', message: '第 5 則留言' })).resolves.toBeTruthy()
  })
})

describe('重複留言偵測', () => {
  it('answers 429 for the very same text sent twice', async () => {
    const socket = '198.51.100.8'
    await expect(post({ socket })).resolves.toBeTruthy()
    await expect(post({ socket })).rejects.toMatchObject(duplicate)
    // 換句話說就過得去，證明擋下來的是重複偵測而不是限流
    await expect(post({ socket, message: '真的好可愛！' })).resolves.toBeTruthy()
  })

  it('follows the same text across journal entries', async () => {
    const socket = '198.51.100.9'
    await expect(post({ socket, id: '11' })).resolves.toBeTruthy()
    await expect(post({ socket, id: '12' })).rejects.toMatchObject(duplicate)
  })

  it('fingerprints the normalized text, not the raw body', async () => {
    const socket = '198.51.100.10'
    await expect(post({ socket, message: '  好可愛！  ' })).resolves.toBeTruthy()
    await expect(post({ socket, message: '好可愛！' })).rejects.toMatchObject(duplicate)
  })

  it('records nothing when validation rejects the comment first', async () => {
    const socket = '198.51.100.11'
    const hidden = `好可愛${String.fromCodePoint(0x200B)}！`
    await expect(post({ socket, message: hidden })).rejects.toMatchObject({ statusCode: 400 })
    // 第二次仍該是 400。若指紋在驗證之前就記下去，這裡會變成 429，
    // 使用者收到的錯誤訊息也會從「內容不合法」變成「你剛剛送過了」
    await expect(post({ socket, message: hidden })).rejects.toMatchObject({ statusCode: 400 })
    expect(databaseMocks.createComment).not.toHaveBeenCalled()
  })

  it('keeps different people behind one NAT address apart', async () => {
    const socket = '198.51.100.12'
    await expect(post({ socket, nickname: '阿明' })).resolves.toBeTruthy()
    await expect(post({ socket, nickname: '小美' })).resolves.toBeTruthy()
    await expect(post({ socket, nickname: '小美' })).rejects.toMatchObject(duplicate)
  })

  it('does not let one visitor block another who happens to write the same words', async () => {
    await expect(post({ socket: '198.51.100.13' })).resolves.toBeTruthy()
    await expect(post({ socket: '198.51.100.14' })).resolves.toBeTruthy()
  })

  it('fingerprints the socket address, not a forwarded header', async () => {
    // 指紋若讀 X-Forwarded-For，改一個 header 就換一組指紋，重複偵測形同虛設
    const socket = '198.51.100.15'
    await expect(post({ socket, forwardedFor: '203.0.113.1' })).resolves.toBeTruthy()
    await expect(post({ socket, forwardedFor: '203.0.113.2' })).rejects.toMatchObject(duplicate)
  })
})

describe('來源識別', () => {
  it('ignores a rotating X-Forwarded-For while no proxy hop is trusted', async () => {
    // 端點若自己去讀 X-Forwarded-For，改一個 header 就換一個限流桶與一組指紋，
    // 三層閘門與重複偵測會同時失效。這裡確認它走的是 clientAddress。
    expect(runtime.config.trustedProxyHops).toBe(0)
    const socket = '198.51.100.16'
    for (let index = 0; index < 5; index += 1) {
      await expect(post({ socket, forwardedFor: `203.0.113.${index}`, message: `第 ${index} 則留言` })).resolves.toBeTruthy()
    }
    await expect(post({ socket, forwardedFor: '203.0.113.99', message: '第 5 則留言' })).rejects.toMatchObject(rateLimited)
    await expect(post({ socket, forwardedFor: '203.0.113.0', message: '第 0 則留言' })).rejects.toMatchObject(rateLimited)
  })
})
