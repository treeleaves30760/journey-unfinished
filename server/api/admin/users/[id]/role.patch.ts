import { createError, type H3Event } from 'h3'
import { isConfigAdmin, requireAdmin, roleForDiscordId, type PublicUser } from '../../../../utils/auth'
import { findUserById, setUserRole, type User } from '../../../../utils/database'
import { enforceRateLimit, enforceSameOrigin, readLimitedJson } from '../../../../utils/request-security'

/**
 * 白名單比對兩個字面值，完全不做型別轉換：
 * 1、true、'Admin'、['admin'] 這類輸入都必須落在 400，不能有任何一種被寬鬆比較認成合法角色。
 */
export function parseRole(value: unknown): 'user' | 'admin' {
  if (value !== 'user' && value !== 'admin') {
    throw createError({ statusCode: 400, message: '權限只能設定為 user 或 admin' })
  }
  return value
}

// 數值規則與 validation.ts 的 parseId 一致，只是那個函式的訊息寫死是旅箋編號，這裡要講使用者。
export function parseUserId(value: string | undefined) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 400, message: '無效的使用者編號' })
  }
  return id
}

export function assertRoleChangeAllowed(event: H3Event, actor: PublicUser, target: User) {
  // 管理員手滑把自己降級後就再也開不了管理頁，得回頭求別人救；直接禁止是最省事的防呆。
  // 這條排在設定管理員檢查之前，因為「你不能改自己」是比較好懂、也比較好處理的說法。
  if (actor.id === target.id) {
    throw createError({ statusCode: 403, message: '不能變更自己的權限，以免把自己鎖在管理頁之外' })
  }
  // 設定管理員的權威在設定檔，網頁沒有權力覆寫；這一層同時是防鎖死的保底，
  // 若連他都能在網頁上被降級，一次誤操作就可能讓整個站再也沒有人進得了管理頁。
  if (isConfigAdmin(event, target.discordId)) {
    throw createError({ statusCode: 403, message: '這位管理員由環境變數指定，請改設定檔調整' })
  }
}

export default defineEventHandler(async (event) => {
  enforceSameOrigin(event)
  const actor = requireAdmin(event)
  // 調整權限是罕見的管理動作，一次處理幾個人就結束，20 次／小時對真人綽綽有餘，
  // 卻能把「管理員 session 被竊用」一小時內能翻動的帳號數壓在可以人工復原的範圍。
  // 刻意排在 requireAdmin 之後：未登入與非管理員的流量都還沒進到計數桶，
  // 別人打不掉真管理員的額度。相對地，下面的 400／404 都已經計入，
  // 讓人無法靠這條路徑大量探測使用者編號是否存在。
  enforceRateLimit(event, 'admin-user-role', 20, 60 * 60 * 1000)

  const id = parseUserId(getRouterParam(event, 'id'))
  const body = await readLimitedJson(event, 8 * 1024)
  const role = parseRole(body.role)

  const target = findUserById(id)
  if (!target) throw createError({ statusCode: 404, message: '找不到這位使用者' })
  assertRoleChangeAllowed(event, actor, target)

  const updated = setUserRole(target.id, role)
  if (!updated) throw createError({ statusCode: 409, message: '權限更新失敗，請重試' })
  return {
    user: {
      id: updated.id,
      discordId: updated.discordId,
      username: updated.username,
      displayName: updated.displayName,
      avatarUrl: updated.avatarUrl,
      // 與 /api/admin/overview 同一組語意：role 是合併後的最終角色，configAdmin 標出不可調整的那一層
      role: roleForDiscordId(event, updated.discordId, updated.role),
      configAdmin: isConfigAdmin(event, updated.discordId)
    }
  }
})
