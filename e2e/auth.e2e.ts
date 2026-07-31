import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Browser } from '@playwright/test'
import {
  authenticate,
  baseURL,
  deleteSession,
  identities,
  ownerDiscordId,
  seedApplication,
  sessionExists,
  sessionTokens,
  waitForHydration
} from './fixtures/app'

async function authenticatedContext(browser: Browser, type: keyof typeof sessionTokens) {
  const context = await browser.newContext()
  await authenticate(context, type)
  return context
}

test.beforeEach(async () => {
  await seedApplication()
})

test('page middleware separates anonymous, member and admin access', async ({ browser, page }) => {
  await page.goto('/checkins/new')
  await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('redirect') === '/checkins/new')

  const member = await authenticatedContext(browser, 'member')
  const memberPage = await member.newPage()
  await memberPage.goto('/checkins/new')
  await expect(memberPage).toHaveURL(/\/checkins\/new$/)
  await memberPage.goto('/admin')
  await expect(memberPage).toHaveURL(`${baseURL}/`)
  await member.close()

  const admin = await authenticatedContext(browser, 'admin')
  const adminPage = await admin.newPage()
  await adminPage.goto('/admin')
  await expect(adminPage).toHaveURL(/\/admin$/)
  await admin.close()

  const expired = await authenticatedContext(browser, 'expired')
  const expiredPage = await expired.newPage()
  await expiredPage.goto('/checkins/new')
  await expect(expiredPage).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('redirect') === '/checkins/new')
  await expired.close()
})

test('a revoked hydrated session is refreshed before protected client navigation', async ({ browser }) => {
  const context = await authenticatedContext(browser, 'revocable')
  const page = await context.newPage()
  await page.goto('/checkins/new')
  await waitForHydration(page)
  deleteSession(sessionTokens.revocable)
  await page.locator('.brand').click()
  await expect(page).toHaveURL(`${baseURL}/`)
  await expect(page.locator('.site-nav .nav-cta')).toHaveAttribute('href', '/checkins/new')
  await page.locator('.site-nav .nav-cta').click()
  await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('redirect') === '/checkins/new')
  await context.close()
})

test('protected APIs enforce origin, authentication and role before parsing', async ({ browser, request }) => {
  expect((await request.post('/api/checkins', { headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, data: 'invalid' })).status()).toBe(403)
  expect((await request.post('/api/checkins', { headers: { Origin: baseURL, 'Content-Type': 'text/plain' }, data: 'invalid' })).status()).toBe(401)

  const member = await authenticatedContext(browser, 'member')
  expect((await member.request.post('/api/checkins', { headers: { Origin: baseURL, 'Content-Type': 'text/plain' }, data: 'invalid' })).status()).toBe(415)
  expect((await member.request.delete('/api/admin/checkins/not-an-id', { headers: { Origin: baseURL } })).status()).toBe(403)
  expect((await member.request.get('/api/admin/overview')).status()).toBe(403)

  const admin = await authenticatedContext(browser, 'admin')
  expect((await admin.request.delete('/api/admin/checkins/not-an-id', { headers: { Origin: 'https://evil.example' } })).status()).toBe(403)
  expect((await admin.request.delete('/api/admin/checkins/not-an-id', { headers: { Origin: baseURL } })).status()).toBe(400)
  expect((await admin.request.delete('/api/admin/checkins/99999999', { headers: { Origin: baseURL } })).status()).toBe(404)
  expect((await admin.request.get('/api/admin/overview')).status()).toBe(200)
  await member.close()
  await admin.close()
})

test('authenticated creation stores server-derived ownership and admin deletion removes the file', async ({ browser }) => {
  const member = await authenticatedContext(browser, 'member')
  const response = await member.request.post('/api/checkins', {
    headers: { Origin: baseURL },
    multipart: {
      nickname: 'API 測試旅人',
      dollName: '測試娃',
      location: '完整測試景點',
      county: '臺北市',
      latitude: '25.033',
      longitude: '121.5654',
      message: '驗證登入、檔案與建立者綁定。',
      visitedAt: '2026-01-01',
      avatarPreset: 'sun',
      userId: '999999',
      photo: { name: 'trip.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(32).fill(0)]) }
    }
  })
  const responseBody = await response.json() as { checkin?: { id: number, photo: string }, message?: string }
  expect(response.status(), JSON.stringify(responseBody)).toBe(201)
  const checkin = responseBody.checkin!
  expect(ownerDiscordId(checkin.id)).toBe(identities.member.discordId)
  const uploadPath = path.join(process.env.JOURNEY_UNFINISHED_E2E_DIR!, 'uploads', path.basename(checkin.photo))
  expect(fs.existsSync(uploadPath)).toBe(true)

  const admin = await authenticatedContext(browser, 'admin')
  const deleted = await admin.request.delete(`/api/admin/checkins/${checkin.id}`, { headers: { Origin: baseURL } })
  expect(deleted.status()).toBe(200)
  expect(fs.existsSync(uploadPath)).toBe(false)
  await member.close()
  await admin.close()
})

test('comment and logout mutations reject cross-origin requests', async ({ browser }) => {
  const { firstCheckinId } = await seedApplication()
  const comment = await fetch(`${baseURL}/api/checkins/${firstCheckinId}/comments`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: '跨站', message: '不應建立' })
  })
  expect(comment.status).toBe(403)

  const context = await authenticatedContext(browser, 'revocable')
  expect(sessionExists(sessionTokens.revocable)).toBe(true)
  expect((await context.request.post('/api/auth/logout', { headers: { Origin: 'https://evil.example' } })).status()).toBe(403)
  expect(sessionExists(sessionTokens.revocable)).toBe(true)
  expect((await context.request.post('/api/auth/logout', { headers: { Origin: baseURL } })).status()).toBe(200)
  expect(sessionExists(sessionTokens.revocable)).toBe(false)
  await context.close()
})

test('OAuth initiation and callback enforce state without exposing the client secret', async ({ request }) => {
  const start = await request.get('/auth/discord?returnTo=/checkins/new', { maxRedirects: 0 })
  expect(start.status()).toBe(302)
  const authorization = new URL(start.headers().location!)
  expect(authorization.origin + authorization.pathname).toBe('https://discord.com/oauth2/authorize')
  expect(authorization.searchParams.get('scope')).toBe('identify')
  expect(authorization.searchParams.get('response_type')).toBe('code')
  expect(authorization.toString()).not.toContain('test-secret')
  const state = authorization.searchParams.get('state')!
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(start.headers()['set-cookie']).toContain('HttpOnly')
  expect(start.headers()['set-cookie']).toContain('SameSite=Lax')
  expect(start.headers()['set-cookie']).toContain('Max-Age=600')

  const wrongState = await request.get('/auth/discord?code=fake&state=wrong', { maxRedirects: 0 })
  expect(wrongState.headers().location).toBe('/login?error=state')

  const restart = await request.get('/auth/discord', { maxRedirects: 0 })
  const validState = new URL(restart.headers().location!).searchParams.get('state')!
  const stateOnly = await request.get(`/auth/discord?state=${validState}`, { maxRedirects: 0 })
  expect(stateOnly.headers().location).toBe('/login?error=denied')
  const replay = await request.get(`/auth/discord?error=access_denied&state=${validState}`, { maxRedirects: 0 })
  expect(replay.headers().location).toBe('/login?error=state')
})
