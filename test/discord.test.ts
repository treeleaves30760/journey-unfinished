import { describe, expect, it, vi } from 'vitest'
import { buildDiscordAuthorizationUrl, exchangeDiscordCode, normalizeDiscordProfile, type DiscordFetcher } from '../server/utils/discord'

describe('Discord OAuth client', () => {
  it('builds the official authorization-code URL with the minimum identify scope', () => {
    const url = new URL(buildDiscordAuthorizationUrl({
      clientId: 'client-123',
      redirectUri: 'https://trip.example.com/auth/discord',
      state: 'random-state'
    }))
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-123',
      response_type: 'code',
      redirect_uri: 'https://trip.example.com/auth/discord',
      scope: 'identify',
      state: 'random-state'
    })
    expect(url.toString()).not.toContain('secret')
  })

  it('normalizes public identity and custom avatars', () => {
    expect(normalizeDiscordProfile({
      id: '123456789012345678', username: 'traveler', global_name: '漫遊旅人', avatar: 'avatar_hash'
    })).toEqual({
      discordId: '123456789012345678',
      username: 'traveler',
      displayName: '漫遊旅人',
      avatarUrl: 'https://cdn.discordapp.com/avatars/123456789012345678/avatar_hash.png?size=128'
    })
    expect(normalizeDiscordProfile({ id: '123456789012345678', username: 'traveler', global_name: '  ', avatar: null }).displayName).toBe('traveler')
  })

  it.each([
    [{ id: 'not-a-snowflake', username: 'user' }],
    [{ id: '123456789012345678', username: '' }],
    [{ id: '123456789012345678' }],
    [{ id: '123456789012345678', username: 'x'.repeat(81) }]
  ])('rejects malformed provider profile %j', (profile) => {
    expect(() => normalizeDiscordProfile(profile)).toThrow(TypeError)
  })

  it('exchanges a code as form data before requesting the current user', async () => {
    const fetcher = vi.fn<DiscordFetcher>()
      .mockResolvedValueOnce({ access_token: 'discord-access-token' })
      .mockResolvedValueOnce({ id: '123456789012345678', username: 'traveler', global_name: null, avatar: null })
    await expect(exchangeDiscordCode({
      clientId: 'client-id', clientSecret: 'client-secret', code: 'one-time-code', redirectUri: 'https://trip.example.com/auth/discord'
    }, fetcher)).resolves.toMatchObject({ discordId: '123456789012345678', displayName: 'traveler' })

    expect(fetcher).toHaveBeenCalledTimes(2)
    const tokenCall = fetcher.mock.calls[0]!
    const profileCall = fetcher.mock.calls[1]!
    expect(tokenCall[0]).toBe('https://discord.com/api/oauth2/token')
    expect(tokenCall[1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    expect(tokenCall[1].body?.toString()).toContain('grant_type=authorization_code')
    expect(tokenCall[1].body?.toString()).toContain('client_secret=client-secret')
    expect(profileCall[0]).toBe('https://discord.com/api/users/@me')
    expect(profileCall[1].headers).toEqual({ Authorization: 'Bearer discord-access-token' })
    expect(tokenCall[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('fails closed for missing or oversized access tokens', async () => {
    const missing = vi.fn<DiscordFetcher>().mockResolvedValue({})
    await expect(exchangeDiscordCode({ clientId: 'id', clientSecret: 'secret', code: 'code', redirectUri: 'https://example.com' }, missing)).rejects.toThrow(TypeError)
    const oversized = vi.fn<DiscordFetcher>().mockResolvedValue({ access_token: 'x'.repeat(2_049) })
    await expect(exchangeDiscordCode({ clientId: 'id', clientSecret: 'secret', code: 'code', redirectUri: 'https://example.com' }, oversized)).rejects.toThrow(TypeError)
  })
})
