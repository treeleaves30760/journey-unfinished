import { createHash } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { BrowserContext, Page } from '@playwright/test'

export const baseURL = 'http://127.0.0.1:3200'
export const identities = {
  admin: { discordId: '123456789012345678', username: 'layout-admin', displayName: '版面管理員', role: 'admin' },
  member: { discordId: '223456789012345678', username: 'layout-member', displayName: '測試旅人', role: 'user' },
  expired: { discordId: '323456789012345678', username: 'expired-member', displayName: '過期旅人', role: 'user' }
} as const
export const sessionTokens = {
  admin: 'admin-session-token-with-enough-entropy-for-e2e',
  member: 'member-session-token-with-enough-entropy-for-e2e',
  expired: 'expired-session-token-with-enough-entropy-for-e2e',
  revocable: 'revocable-session-token-with-enough-entropy-for-e2e'
} as const

function databasePath() {
  const directory = process.env.JOURNEY_UNFINISHED_E2E_DIR
  if (!directory) throw new Error('JOURNEY_UNFINISHED_E2E_DIR is not configured')
  return path.join(directory, 'app.sqlite')
}

export function sessionHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export async function seedApplication() {
  const response = await fetch(`${baseURL}/api/checkins`)
  if (!response.ok) throw new Error(`Unable to initialize app: ${await response.text()}`)

  const db = new Database(databasePath())
  for (const identity of Object.values(identities)) {
    db.prepare(`
      INSERT INTO users (discord_id, username, display_name, role)
      VALUES (@discordId, @username, @displayName, @role)
      ON CONFLICT(discord_id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        role = excluded.role
    `).run(identity)
  }
  const rows = db.prepare('SELECT id, discord_id AS discordId FROM users').all() as Array<{ id: number, discordId: string }>
  const userIds = new Map(rows.map(row => [row.discordId, row.id]))
  const future = Date.now() + 60 * 60 * 1000
  const expired = Date.now() - 1
  const insertSession = db.prepare('INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
  insertSession.run(sessionHash(sessionTokens.admin), userIds.get(identities.admin.discordId), future)
  insertSession.run(sessionHash(sessionTokens.member), userIds.get(identities.member.discordId), future)
  insertSession.run(sessionHash(sessionTokens.expired), userIds.get(identities.expired.discordId), expired)
  insertSession.run(sessionHash(sessionTokens.revocable), userIds.get(identities.member.discordId), future)
  const firstCheckin = db.prepare('SELECT id FROM checkins ORDER BY id LIMIT 1').get() as { id: number }
  db.close()
  return { firstCheckinId: firstCheckin.id }
}

export function deleteSession(token: string) {
  const db = new Database(databasePath())
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sessionHash(token))
  db.close()
}

export function sessionExists(token: string) {
  const db = new Database(databasePath(), { readonly: true })
  const row = db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash = ?').get(sessionHash(token))
  db.close()
  return Boolean(row)
}

export function ownerDiscordId(checkinId: number) {
  const db = new Database(databasePath(), { readonly: true })
  const row = db.prepare(`
    SELECT u.discord_id AS discordId
    FROM checkins c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(checkinId) as { discordId: string | null } | undefined
  db.close()
  return row?.discordId || null
}

export async function authenticate(context: BrowserContext, type: keyof typeof sessionTokens) {
  await context.addCookies([{ name: 'journey-unfinished-session', value: sessionTokens[type], url: baseURL }])
}

export async function waitForHydration(page: Page) {
  await page.waitForFunction(() => Boolean((document.querySelector('#__nuxt') as HTMLElement & { __vue_app__?: unknown })?.__vue_app__))
}
