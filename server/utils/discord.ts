interface DiscordTokenResponse {
  access_token?: unknown
}

interface DiscordProfileResponse {
  id?: unknown
  username?: unknown
  global_name?: unknown
  avatar?: unknown
}

interface DiscordFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: URLSearchParams
  signal?: AbortSignal
}

export type DiscordFetcher = (url: string, options: DiscordFetchOptions) => Promise<unknown>

export interface DiscordIdentity {
  discordId: string
  username: string
  displayName: string
  avatarUrl: string | null
}

export function buildDiscordAuthorizationUrl(input: {
  clientId: string
  redirectUri: string
  state: string
}) {
  const authorization = new URL('https://discord.com/oauth2/authorize')
  authorization.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: 'identify',
    state: input.state
  }).toString()
  return authorization.toString()
}

export function normalizeDiscordProfile(profile: DiscordProfileResponse): DiscordIdentity {
  const discordId = typeof profile.id === 'string' ? profile.id : ''
  const username = typeof profile.username === 'string' ? profile.username.trim() : ''
  const globalName = typeof profile.global_name === 'string' ? profile.global_name.trim() : ''
  const avatar = typeof profile.avatar === 'string' && /^[a-zA-Z0-9_]+$/.test(profile.avatar) ? profile.avatar : ''
  if (!/^\d{17,20}$/.test(discordId) || !username || username.length > 80) {
    throw new TypeError('Invalid Discord profile')
  }
  return {
    discordId,
    username,
    displayName: (globalName || username).slice(0, 80),
    avatarUrl: avatar ? `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=128` : null
  }
}

export async function exchangeDiscordCode(input: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}, fetcher: DiscordFetcher = (url, options) => $fetch(url, options as never)) {
  const tokenResponse = await fetcher('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri
    }),
    signal: AbortSignal.timeout(10_000)
  }) as DiscordTokenResponse
  const accessToken = typeof tokenResponse?.access_token === 'string' ? tokenResponse.access_token : ''
  if (!accessToken || accessToken.length > 2_048) throw new TypeError('Invalid Discord token')

  const profile = await fetcher('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000)
  }) as DiscordProfileResponse
  return normalizeDiscordProfile(profile)
}
