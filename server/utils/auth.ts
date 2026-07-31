import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError, deleteCookie, getCookie, getRequestURL, setCookie, type H3Event } from 'h3'
import { safeReturnPath } from '../../utils/safeReturnPath'
import { createAuthSession, deleteAuthSession, findUserBySession, type User } from './database'

export const SESSION_COOKIE = 'journey-unfinished-session'
export const OAUTH_STATE_COOKIE = 'journey-unfinished-oauth-state'
export const OAUTH_RETURN_COOKIE = 'journey-unfinished-oauth-return'
const LEGACY_SESSION_COOKIE = 'wa-trip-session'
const SESSION_COOKIE_NAMES = [SESSION_COOKIE, LEGACY_SESSION_COOKIE] as const

export interface PublicUser {
  id: number
  displayName: string
  username: string
  avatarUrl: string | null
  role: 'user' | 'admin'
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function adminDiscordIds(event: H3Event) {
  return new Set(String(useRuntimeConfig(event).adminDiscordIds || '')
    .split(',')
    .map(value => value.trim())
    .filter(value => /^\d{17,20}$/.test(value)))
}

/**
 * 「設定管理員」：由 NUXT_ADMIN_DISCORD_IDS 指定的那一層，刻意不開放網頁調整。
 * 兩個理由：設定檔是這層的權威來源，UI 沒有權力覆寫它；而且它是防鎖死的保底 ——
 * 就算有人把資料庫裡的管理員全部移除（誤操作或被入侵後的清場），
 * 設定管理員仍然進得去，可以重新指派其他人。
 */
export function isConfigAdmin(event: H3Event, discordId: string) {
  return adminDiscordIds(event).has(discordId)
}

/**
 * 兩層管理員取聯集：設定管理員（環境變數）或授權管理員（users.role = 'admin'）。
 * storedRole 預設 'user'，讓拿不到資料列的呼叫端只認設定檔那一層 —— 判斷不出來時往嚴格的方向倒。
 */
export function roleForDiscordId(event: H3Event, discordId: string, storedRole: 'user' | 'admin' = 'user'): 'user' | 'admin' {
  return isConfigAdmin(event, discordId) || storedRole === 'admin' ? 'admin' : 'user'
}

function publicUser(event: H3Event, user: User): PublicUser {
  return {
    id: user.id,
    displayName: user.displayName,
    username: user.username,
    avatarUrl: user.avatarUrl,
    // 每次請求都重算，所以在網頁上被降級的管理員不需要等 session 過期就會立刻失去權限
    role: roleForDiscordId(event, user.discordId, user.role)
  }
}

function cookieSecure(event: H3Event) {
  const configuredUrl = String(useRuntimeConfig(event).public.appUrl || '')
  return configuredUrl.startsWith('https://') || getRequestURL(event).protocol === 'https:'
}

export function getCurrentUser(event: H3Event): PublicUser | null {
  for (const cookieName of SESSION_COOKIE_NAMES) {
    const token = getCookie(event, cookieName)
    if (!token) continue
    const user = findUserBySession(hashToken(token))
    if (user) return publicUser(event, user)
    deleteCookie(event, cookieName, { path: '/' })
  }
  return null
}

export function requireUser(event: H3Event) {
  const user = getCurrentUser(event)
  if (!user) throw createError({ statusCode: 401, message: '請先使用 Discord 登入' })
  return user
}

export function requireAdmin(event: H3Event) {
  const user = requireUser(event)
  if (user.role !== 'admin') throw createError({ statusCode: 403, message: '此功能僅限管理員使用' })
  return user
}

export function issueSession(event: H3Event, userId: number) {
  const config = useRuntimeConfig(event)
  const days = Math.min(Math.max(Number(config.sessionDays) || 30, 1), 90)
  const maxAge = days * 24 * 60 * 60
  const previousTokens = new Set(SESSION_COOKIE_NAMES.map(name => getCookie(event, name)).filter(Boolean))
  for (const previousToken of previousTokens) deleteAuthSession(hashToken(previousToken!))
  const token = randomBytes(32).toString('base64url')
  createAuthSession(hashToken(token), userId, Date.now() + maxAge * 1000)
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(event),
    path: '/',
    maxAge
  })
  deleteCookie(event, LEGACY_SESSION_COOKIE, { path: '/' })
}

export function clearAuthSession(event: H3Event) {
  const tokens = new Set(SESSION_COOKIE_NAMES.map(name => getCookie(event, name)).filter(Boolean))
  for (const token of tokens) deleteAuthSession(hashToken(token!))
  for (const cookieName of SESSION_COOKIE_NAMES) deleteCookie(event, cookieName, { path: '/' })
}

export function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
