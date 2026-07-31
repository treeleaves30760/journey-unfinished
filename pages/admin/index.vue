<script setup lang="ts">
import type { Checkin } from '~/composables/useCheckins'

interface AdminUser {
  id: number
  discordId: string
  username: string
  displayName: string
  avatarUrl: string | null
  role: 'user' | 'admin'
  // 權限來自 NUXT_ADMIN_DISCORD_IDS 的那一層：資料庫裡沒有這個身分，網頁上也就改不動
  configAdmin: boolean
  createdAt: string
  lastLoginAt: string
}

// 變更角色的回應只帶身分相關欄位，沒有 createdAt／lastLoginAt，所以更新時要合併回原本那一列而不是整筆取代
type AdminUserRole = Pick<AdminUser, 'id' | 'discordId' | 'username' | 'displayName' | 'avatarUrl' | 'role' | 'configAdmin'>

definePageMeta({ middleware: 'admin' })
// useAuth() 內部呼叫 useFetch，必須在頂層 await 之前取得，否則會離開 Nuxt 的 setup context。
const { user: currentUser } = useAuth()
const { data, status, error, refresh } = await useFetch<{ users: AdminUser[], checkins: Checkin[] }>('/api/admin/overview')
const deletingId = ref<number | null>(null)
const actionError = ref('')
const roleUpdatingId = ref<number | null>(null)
// 每位會員各記各的錯誤，切換 A 失敗不會蓋掉 B 的訊息
const roleErrors = reactive<Record<number, string>>({})

/**
 * 回傳「為什麼這一列不能切換」，空字串代表可以切換。
 *
 * 這些判斷純粹是 UX：頁面守衛（middleware: 'admin'）和這裡的規則全都跑在使用者控制得了的
 * 瀏覽器裡，任何人都能自己送 PATCH /api/admin/users/:id/role。真正的權限判定在伺服器端
 * （requireAdmin + assertRoleChangeAllowed），前端擋住不等於擋得住，兩邊的規則要一起維護。
 */
function roleLockReason(item: AdminUser) {
  if (currentUser.value?.id === item.id) return '不能變更自己的權限，避免把自己鎖在管理中心外面。'
  if (item.configAdmin) return '權限由環境變數 NUXT_ADMIN_DISCORD_IDS 指定，請改設定後重新部署。'
  return ''
}

function roleActionLabel(item: AdminUser) {
  if (roleUpdatingId.value === item.id) return '更新中…'
  return item.role === 'admin' ? '取消管理員' : '設為管理員'
}

// 顯示名稱是會員自己填的字串，而原生 confirm 沒辦法逐字轉義；
// 先把換行壓成空白再截短，避免有人用假的對話框文案誘導管理員按下確定。
function confirmName(value: string) {
  const flattened = value.replace(/\s+/g, ' ').trim()
  return flattened.length > 40 ? `${flattened.slice(0, 40)}…` : flattened
}

async function toggleRole(item: AdminUser) {
  if (roleUpdatingId.value !== null || roleLockReason(item)) return
  const nextRole = item.role === 'admin' ? 'user' : 'admin'
  // 提權等於把「刪任何人的旅箋」和「改別人權限」一起交出去，確認視窗要把後果列完；
  // 降級只是收回權限、隨時能再給回去，用一句提醒說明對方會被擋在管理中心外就夠了。
  const confirmText = nextRole === 'admin'
    ? `確定要把「${confirmName(item.displayName)}」設為管理員嗎？\n\n對方將可以：\n・刪除任何人的旅箋\n・查看所有會員資料與 Discord ID\n・變更其他人的權限，包含取消你的管理員身分`
    : `確定要取消「${confirmName(item.displayName)}」的管理員權限嗎？對方將無法再進入管理中心。`
  if (!window.confirm(confirmText)) return
  roleUpdatingId.value = item.id
  roleErrors[item.id] = ''
  try {
    // 路徑只帶資料庫流水號；discordId 屬於識別資訊，不放進 URL 以免被寫進伺服器日誌或 Referer
    const response = await $fetch<{ user: AdminUserRole }>(`/api/admin/users/${item.id}/role`, { method: 'PATCH', body: { role: nextRole } })
    const overview = data.value
    // Nuxt 4 的 useFetch data 預設是 shallowRef，改巢狀屬性不會觸發重繪，所以整包換掉最外層物件。
    // 就地補這一列而不重抓 overview，畫面不會整張表閃一下。
    if (overview) data.value = { ...overview, users: overview.users.map(row => (row.id === item.id ? { ...row, ...response.user } : row)) }
  } catch (error) {
    roleErrors[item.id] = errorMessage(error, '權限更新失敗，請稍後再試。')
  } finally {
    roleUpdatingId.value = null
  }
}

async function removeCheckin(checkin: Checkin) {
  if (!window.confirm(`確定要刪除「${checkin.location}」這則旅箋嗎？此操作無法復原。`)) return
  deletingId.value = checkin.id
  actionError.value = ''
  try {
    await $fetch(`/api/admin/checkins/${checkin.id}`, { method: 'DELETE' })
    if (data.value) data.value.checkins = data.value.checkins.filter(item => item.id !== checkin.id)
  } catch (error) {
    actionError.value = errorMessage(error, '刪除失敗，請稍後再試。')
  } finally {
    deletingId.value = null
  }
}

useHead({ title: '管理中心｜未完旅箋' })
</script>

<template>
  <main id="main-content" class="admin-page">
    <div class="admin-heading"><div><span class="eyebrow">ADMIN CONSOLE</span><h1>管理中心</h1><p>檢視 Discord 會員、調整管理員權限與管理公開旅箋。</p></div><NuxtLink class="primary-button" to="/checkins/new">＋ 寫下旅箋</NuxtLink></div>
    <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在載入管理資料…</div>
    <div v-else-if="error" class="state-panel error-state" role="alert"><strong>管理資料讀取失敗</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button></div>
    <template v-else-if="data">
      <section class="admin-stats" aria-label="網站管理統計"><article><span>公開旅箋</span><strong>{{ data.checkins.length }}</strong></article><article><span>Discord 會員</span><strong>{{ data.users.length }}</strong></article><article><span>管理員</span><strong>{{ data.users.filter(user => user.role === 'admin').length }}</strong></article></section>
      <div v-if="actionError" class="alert error-alert" role="alert">{{ actionError }}</div>
      <section class="admin-section">
        <div class="admin-section-heading"><div><span class="eyebrow">MEMBERS</span><h2>會員帳號</h2></div><span>{{ data.users.length }} 位</span></div>
        <div class="admin-table-wrap"><table><thead><tr><th>會員</th><th>Discord ID</th><th>角色</th><th>最近登入</th><th>權限調整</th></tr></thead><tbody><tr v-for="item in data.users" :key="item.id"><td><div class="admin-user"><DollAvatar :src="item.avatarUrl" preset="cloud" alt="" size="small" /><span><strong>{{ item.displayName }}</strong><small>@{{ item.username }}</small></span></div></td><td><code>{{ item.discordId }}</code></td><td><div class="admin-role-cell"><span class="role-badge" :class="item.role">{{ item.role === 'admin' ? '管理員' : '會員' }}</span> <span v-if="item.configAdmin" class="role-badge config">設定管理員</span></div></td><td>{{ formatCommentDate(item.lastLoginAt) }}</td><td><button class="secondary-button compact admin-role-toggle" type="button" :disabled="Boolean(roleLockReason(item)) || roleUpdatingId === item.id" :aria-label="`${roleActionLabel(item)}：${item.displayName}`" :aria-describedby="roleLockReason(item) ? `role-lock-${item.id}` : undefined" @click="toggleRole(item)">{{ roleActionLabel(item) }}</button><small v-if="roleLockReason(item)" :id="`role-lock-${item.id}`" class="admin-role-note">{{ roleLockReason(item) }}</small><div v-if="roleErrors[item.id]" class="inline-error" role="alert">{{ roleErrors[item.id] }}</div></td></tr></tbody></table></div>
      </section>
      <section class="admin-section">
        <div class="admin-section-heading"><div><span class="eyebrow">JOURNEY NOTES</span><h2>旅箋管理</h2></div><span>{{ data.checkins.length }} 則</span></div>
        <div class="admin-checkins"><article v-for="item in data.checkins" :key="item.id"><DollAvatar :src="item.avatar" :preset="item.avatarPreset" alt="" size="small" /><div><strong>{{ item.location }}</strong><span>{{ item.nickname }} 與 {{ item.dollName }} · {{ formatDate(item.visitedAt) }}</span></div><NuxtLink class="text-link" :to="`/checkins/${item.id}`">查看</NuxtLink><button class="danger-button" type="button" :disabled="deletingId === item.id" @click="removeCheckin(item)">{{ deletingId === item.id ? '刪除中…' : '刪除' }}</button></article></div>
      </section>
    </template>
  </main>
</template>
