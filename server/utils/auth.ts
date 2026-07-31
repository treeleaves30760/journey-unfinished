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

export function roleForDiscordId(event: H3Event, discordId: string): 'user' | 'admin' {
  return adminDiscordIds(event).has(discordId) ? 'admin' : 'user'
}

function publicUser(event: H3Event, user: User): PublicUser {
  return {
    id: user.id,
    displayName: user.displayName,
    username: user.username,
    avatarUrl: user.avatarUrl,
    role: roleForDiscordId(event, user.discordId)
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
