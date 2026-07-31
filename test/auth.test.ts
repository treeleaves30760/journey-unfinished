import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeReturnPath } from '../utils/safeReturnPath'

const h3Mocks = vi.hoisted(() => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
  getRequestURL: vi.fn(() => new URL('http://localhost:3000'))
}))
const databaseMocks = vi.hoisted(() => ({
  createAuthSession: vi.fn(),
  deleteAuthSession: vi.fn(),
  findUserBySession: vi.fn()
}))

vi.mock('h3', async importOriginal => ({
  ...await importOriginal<typeof import('h3')>(),
  ...h3Mocks
}))
vi.mock('../server/utils/database', () => databaseMocks)

import {
  clearAuthSession,
  getCurrentUser,
  hashToken,
  isConfigAdmin,
  issueSession,
  requireAdmin,
  requireUser,
  roleForDiscordId,
  secureEqual,
  SESSION_COOKIE
} from '../server/utils/auth'

const event = {} as never
let runtimeConfig: Record<string, unknown>

beforeEach(() => {
  runtimeConfig = {
    adminDiscordIds: '',
    sessionDays: 30,
    public: { appUrl: 'http://localhost:3000' }
  }
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.values(h3Mocks).forEach(mock => mock.mockReset())
  Object.values(databaseMocks).forEach(mock => mock.mockReset())
  h3Mocks.getRequestURL.mockReturnValue(new URL('http://localhost:3000'))
})

describe('safeReturnPath', () => {
  it.each([
    [null],
    ['checkins/new'],
    ['//evil.example'],
    ['/\\evil.example'],
    ['/%5cevil.example'],
    ['/%2f%2fevil.example'],
    ['/path\u0000value'],
    [`/${'x'.repeat(2_048)}`],
    ['https://evil.example/path']
  ])('rejects unsafe return value %s', (value) => {
    expect(safeReturnPath(value)).toBe('/')
  })

  it('preserves a normalized same-origin path, query and hash', () => {
    expect(safeReturnPath('/checkins/7?created=1#story')).toBe('/checkins/7?created=1#story')
    expect(safeReturnPath('/a/../checkins/new')).toBe('/checkins/new')
  })
})

describe('authentication helpers', () => {
  it('compares OAuth state in constant-time compatible buffers', () => {
    expect(secureEqual('same-state', 'same-state')).toBe(true)
    expect(secureEqual('same-state', 'other-stat')).toBe(false)
    expect(secureEqual('short', 'longer')).toBe(false)
    expect(secureEqual('', '')).toBe(true)
  })

  it('hashes session tokens deterministically without returning the token', () => {
    expect(hashToken('session')).toBe('3f3af1ecebbd1410ab417ec0d27bbfcb5d340e177ae159b59fc8626c2dfd9175')
    expect(hashToken('session')).not.toContain('session')
  })

  it('accepts only valid configured Discord snowflakes as administrators', () => {
    runtimeConfig.adminDiscordIds = '12345678901234567, 12345678901234567890, invalid, 1234567890123456, 123456789012345678901'
    expect(roleForDiscordId(event, '12345678901234567')).toBe('admin')
    expect(roleForDiscordId(event, '12345678901234567890')).toBe('admin')
    expect(roleForDiscordId(event, '1234567890123456')).toBe('user')
    expect(roleForDiscordId(event, '123456789012345678901')).toBe('user')
  })

  it('returns null without a cookie and clears an invalid session cookie', () => {
    h3Mocks.getCookie.mockReturnValueOnce(undefined)
    expect(getCurrentUser(event)).toBeNull()
    expect(databaseMocks.findUserBySession).not.toHaveBeenCalled()

    h3Mocks.getCookie.mockReturnValueOnce('invalid-token')
    databaseMocks.findUserBySession.mockReturnValueOnce(undefined)
    expect(getCurrentUser(event)).toBeNull()
    expect(h3Mocks.deleteCookie).toHaveBeenCalledWith(event, SESSION_COOKIE, { path: '/' })
  })

  it('projects only public fields and recalculates the current role', () => {
    runtimeConfig.adminDiscordIds = '123456789012345678'
    h3Mocks.getCookie.mockReturnValue('valid-token')
    databaseMocks.findUserBySession.mockReturnValue({
      id: 9,
      discordId: '123456789012345678',
      username: 'traveler',
      displayName: '旅人',
      avatarUrl: null,
      role: 'user',
      createdAt: '2026-01-01',
      lastLoginAt: '2026-01-02',
      sessionExpiresAt: Date.now() + 1000
    })
    expect(getCurrentUser(event)).toEqual({ id: 9, username: 'traveler', displayName: '旅人', avatarUrl: null, role: 'admin' })
  })

  it('continues accepting existing sessions stored under the previous cookie name', () => {
    h3Mocks.getCookie.mockImplementation((_event, name) => name === 'wa-trip-session' ? 'legacy-token' : undefined)
    databaseMocks.findUserBySession.mockReturnValue({
      id: 3,
      discordId: '323456789012345678',
      username: 'returning-traveler',
      displayName: '回訪旅人',
      avatarUrl: null,
      role: 'user',
      createdAt: '2026-01-01',
      lastLoginAt: '2026-01-02',
      sessionExpiresAt: Date.now() + 1000
    })

    expect(getCurrentUser(event)).toMatchObject({ id: 3, displayName: '回訪旅人' })
  })

  it('merges the configured allowlist with the stored role', () => {
    runtimeConfig.adminDiscordIds = '123456789012345678'
    // 設定管理員：資料列說 user 也還是管理員，而且這一層標記成不可由網頁調整
    expect(roleForDiscordId(event, '123456789012345678', 'user')).toBe('admin')
    expect(isConfigAdmin(event, '123456789012345678')).toBe(true)
    // 授權管理員：設定檔沒有他，權限完全來自資料列
    expect(roleForDiscordId(event, '223456789012345678', 'admin')).toBe('admin')
    expect(isConfigAdmin(event, '223456789012345678')).toBe(false)
    // 兩層都不是
    expect(roleForDiscordId(event, '223456789012345678', 'user')).toBe('user')
    // 省略 storedRole 時只認設定檔那一層 —— 判斷不出來就往嚴格的方向倒
    expect(roleForDiscordId(event, '223456789012345678')).toBe('user')
  })

  it('enforces member and administrator authorization', () => {
    h3Mocks.getCookie.mockReturnValue(undefined)
    expect(() => requireUser(event)).toThrowError(expect.objectContaining({ statusCode: 401 }))

    h3Mocks.getCookie.mockReturnValue('member-token')
    databaseMocks.findUserBySession.mockReturnValue({
      id: 2, discordId: '223456789012345678', username: 'member', displayName: '會員', avatarUrl: null,
      role: 'user', createdAt: '', lastLoginAt: '', sessionExpiresAt: Date.now() + 1000
    })
    expect(() => requireAdmin(event)).toThrowError(expect.objectContaining({ statusCode: 403 }))

    // 這筆資料列原本寫的是 role: 'admin' 而斷言期待 403 —— 當時 users.role 完全不影響判斷，
    // 那個斷言等於在保護「登入會覆寫 role」的舊行為。現在資料列正是授權管理員的來源，
    // 所以改成用 'user' 測 403，並在下面補上「資料列說 admin 就過得去」。
    databaseMocks.findUserBySession.mockReturnValue({
      id: 3, discordId: '323456789012345678', username: 'granted', displayName: '受權管理員', avatarUrl: null,
      role: 'admin', createdAt: '', lastLoginAt: '', sessionExpiresAt: Date.now() + 1000
    })
    expect(requireAdmin(event)).toMatchObject({ id: 3, role: 'admin' })
  })

  it('issues a hashed, secure and bounded session while revoking the previous token', () => {
    const now = 1_750_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    runtimeConfig.sessionDays = 120
    runtimeConfig.public = { appUrl: 'https://trip.example.com' }
    h3Mocks.getCookie.mockReturnValue('previous-token')
    h3Mocks.getRequestURL.mockReturnValue(new URL('https://trip.example.com'))

    issueSession(event, 7)

    expect(databaseMocks.deleteAuthSession).toHaveBeenCalledWith(hashToken('previous-token'))
    const setCookieCall = h3Mocks.setCookie.mock.calls[0]
    if (!setCookieCall) throw new Error('Expected session cookie')
    const [, cookieName, token, options] = setCookieCall
    expect(cookieName).toBe(SESSION_COOKIE)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 90 * 86_400 })
    expect(databaseMocks.createAuthSession).toHaveBeenCalledWith(hashToken(token), 7, now + 90 * 86_400_000)
    expect(databaseMocks.createAuthSession.mock.calls[0]![0]).not.toBe(token)
  })

  it('clamps short session durations and clears server and browser state', () => {
    runtimeConfig.sessionDays = -5
    h3Mocks.getCookie.mockReturnValueOnce(undefined)
    issueSession(event, 3)
    expect(h3Mocks.setCookie.mock.calls[0]![3]).toMatchObject({ secure: false, maxAge: 86_400 })

    h3Mocks.getCookie.mockReturnValueOnce('logout-token')
    clearAuthSession(event)
    expect(databaseMocks.deleteAuthSession).toHaveBeenCalledWith(hashToken('logout-token'))
    expect(h3Mocks.deleteCookie).toHaveBeenCalledWith(event, SESSION_COOKIE, { path: '/' })
  })
})
