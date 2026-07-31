import { randomBytes } from 'node:crypto'
import { createError, deleteCookie, getCookie, getQuery, sendRedirect, setCookie } from 'h3'
import { safeReturnPath } from '../../../utils/safeReturnPath'
import { issueSession, OAUTH_RETURN_COOKIE, OAUTH_STATE_COOKIE, roleForDiscordId, secureEqual } from '../../utils/auth'
import { upsertDiscordUser } from '../../utils/database'
import { buildDiscordAuthorizationUrl, exchangeDiscordCode } from '../../utils/discord'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const clientId = String(config.discordClientId || '')
  const clientSecret = String(config.discordClientSecret || '')
  const appUrl = String(config.public.appUrl || '').replace(/\/$/, '')
  const redirectUri = String(config.discordRedirectUri || `${appUrl}/auth/discord`)
  if (!clientId || !clientSecret || !appUrl) {
    throw createError({ statusCode: 503, message: 'Discord 登入尚未完成環境設定' })
  }

  const query = getQuery(event)
  const code = typeof query.code === 'string' ? query.code : ''
  if (!code && !query.error && !query.state) {
    const state = randomBytes(32).toString('base64url')
    const returnTo = safeReturnPath(query.returnTo, '/')
    const secure = appUrl.startsWith('https://')
    setCookie(event, OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure, path: '/auth/discord', maxAge: 600 })
    setCookie(event, OAUTH_RETURN_COOKIE, returnTo, { httpOnly: true, sameSite: 'lax', secure, path: '/auth/discord', maxAge: 600 })
    return sendRedirect(event, buildDiscordAuthorizationUrl({ clientId, redirectUri, state }), 302)
  }

  const expectedState = getCookie(event, OAUTH_STATE_COOKIE) || ''
  const returnedState = typeof query.state === 'string' ? query.state : ''
  const returnTo = safeReturnPath(getCookie(event, OAUTH_RETURN_COOKIE), '/')
  deleteCookie(event, OAUTH_STATE_COOKIE, { path: '/auth/discord' })
  deleteCookie(event, OAUTH_RETURN_COOKIE, { path: '/auth/discord' })
  if (!expectedState || !returnedState || !secureEqual(expectedState, returnedState)) {
    return sendRedirect(event, '/login?error=state', 302)
  }
  if (query.error || !code) return sendRedirect(event, '/login?error=denied', 302)

  try {
    const profile = await exchangeDiscordCode({ clientId, clientSecret, code, redirectUri })
    const user = upsertDiscordUser({
      discordId: profile.discordId,
      username: profile.username,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      role: roleForDiscordId(event, profile.discordId)
    })
    issueSession(event, user.id)
    return sendRedirect(event, returnTo, 302)
  } catch {
    return sendRedirect(event, '/login?error=discord', 302)
  }
})
