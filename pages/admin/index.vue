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

interface BatchDeleteResponse {
  deletedCount: number
  deletedIds: number[]
  notFoundIds: number[]
}

definePageMeta({ middleware: 'admin' })
// useAuth() 內部呼叫 useFetch，必須在頂層 await 之前取得，否則會離開 Nuxt 的 setup context。
const { user: currentUser } = useAuth()
const { data, status, error, refresh } = await useFetch<{ users: AdminUser[], checkins: Checkin[] }>('/api/admin/overview')

const deletingId = ref<number | null>(null)
// 每一則旅箋各記各的刪除錯誤，切換 A 失敗不會蓋掉 B 的訊息，也不會讓整張表因為一筆錯誤就一起顯示警示
const rowErrors = reactive<Record<number, string>>({})
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

// ---------------------------------------------------------------------------
// 旅箋篩選
//
// 註：另一個 agent 正在為旅箋新增「作品」欄位，這裡刻意不碰、也不引用它——
// 等那個功能合併之後再補上作品篩選，避免現在依賴一份還沒定案的欄位。
// ---------------------------------------------------------------------------

const filterCounty = ref('')
// '' = 全部作者；'unclaimed' = 沒有綁定會員帳號的旅箋（userId 為 null）；其餘為會員 id 的字串形式
const filterAuthorId = ref('')
const filterDateFrom = ref('')
const filterDateTo = ref('')
const filterKeyword = ref('')

const hasActiveFilters = computed(() => Boolean(
  filterCounty.value || filterAuthorId.value || filterDateFrom.value || filterDateTo.value || filterKeyword.value.trim()
))

function clearFilters() {
  filterCounty.value = ''
  filterAuthorId.value = ''
  filterDateFrom.value = ''
  filterDateTo.value = ''
  filterKeyword.value = ''
}

/**
 * 作者下拉只列出「真的寫過旅箋」的會員，而且用註冊帳號的顯示名稱，不是旅箋自己填的暱稱欄位——
 * 暱稱是每則旅箋各自填寫的展示用文字，同一個會員每次可以填不同暱稱，用它篩「作者」會對不起帳號本身。
 */
const authorOptions = computed(() => {
  if (!data.value) return []
  const userById = new Map(data.value.users.map(user => [user.id, user]))
  const labels = new Map<number, string>()
  let hasUnclaimed = false
  for (const checkin of data.value.checkins) {
    if (checkin.userId === null) {
      hasUnclaimed = true
      continue
    }
    if (!labels.has(checkin.userId)) {
      labels.set(checkin.userId, userById.get(checkin.userId)?.displayName ?? `會員 #${checkin.userId}`)
    }
  }
  const options = [...labels.entries()]
    .map(([id, label]) => ({ value: String(id), label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'))
  if (hasUnclaimed) options.push({ value: 'unclaimed', label: '（無會員綁定）' })
  return options
})

// NFC 正規化＋小寫化：避免同一個字因為輸入法送出的編碼不同（組合字元 vs 預合成字元）就搜不到，
// 也讓關鍵字比對不分大小寫。這裡自己實作一個極簡版本，而不是共用 composables/useCheckins.ts
// 裡同類的工具函式，是因為那個檔案目前有其他 agent 正在平行修改，這一頁應該避免依賴它尚未定案的內容。
function normalizeSearch(value: string) {
  return value.normalize('NFC').toLowerCase()
}

const filteredCheckins = computed(() => {
  if (!data.value) return []
  const keyword = normalizeSearch(filterKeyword.value.trim())
  return data.value.checkins.filter((item) => {
    if (filterCounty.value && item.county !== filterCounty.value) return false
    if (filterAuthorId.value === 'unclaimed') {
      if (item.userId !== null) return false
    } else if (filterAuthorId.value && String(item.userId) !== filterAuthorId.value) {
      return false
    }
    // visitedAt 固定是 'YYYY-MM-DD'，字典序比較就等於日期比較，不需要多轉一次 Date
    if (filterDateFrom.value && item.visitedAt < filterDateFrom.value) return false
    if (filterDateTo.value && item.visitedAt > filterDateTo.value) return false
    if (keyword && !normalizeSearch(`${item.location} ${item.dollName} ${item.nickname} ${item.message}`).includes(keyword)) {
      return false
    }
    return true
  })
})

const emptyCheckinsMessage = computed(() => (
  !data.value || data.value.checkins.length === 0 ? '目前還沒有任何旅箋。' : '沒有符合篩選條件的旅箋，試著調整篩選條件。'
))

// ---------------------------------------------------------------------------
// 批量選取與刪除
// ---------------------------------------------------------------------------

const selectedIds = ref<Set<number>>(new Set())
const selectAllRef = ref<HTMLInputElement | null>(null)
const cancelBatchRef = ref<HTMLButtonElement | null>(null)
const batchDeleting = ref(false)
const confirmingBatchDelete = ref(false)
const batchError = ref('')
const batchNotice = ref('')

const selectedCount = computed(() => selectedIds.value.size)
// 「全選」只作用在目前篩選出來的列，這也是半選狀態的定義來源：
// 篩選之外被選起來的列不影響這個表頭勾選框的畫面，但仍然算在 selectedCount 與實際送出的 ids 裡。
const allFilteredSelected = computed(() =>
  filteredCheckins.value.length > 0 && filteredCheckins.value.every(item => selectedIds.value.has(item.id))
)
const someFilteredSelected = computed(() =>
  filteredCheckins.value.some(item => selectedIds.value.has(item.id))
)

// <input type="checkbox"> 的「半選」狀態沒有對應的 HTML attribute，只能透過 DOM 屬性設定，
// 所以另外用一個 effect 把算好的布林值同步上去；checked 本身仍走一般的雙向綁定。
watchEffect(() => {
  if (selectAllRef.value) selectAllRef.value.indeterminate = someFilteredSelected.value && !allFilteredSelected.value
})

// 二次確認的第一步只是打開確認面板，把焦點預設放在「返回」而不是刪除鍵上——
// 誤觸 Enter／Space 的後果會是「什麼都沒發生」，而不是「刪光選取的旅箋」。
watch(confirmingBatchDelete, async (open) => {
  if (!open) return
  await nextTick()
  cancelBatchRef.value?.focus()
})

/**
 * 以下選取／批量刪除相關函式裡的 disabled 判斷全部只是 UX：擋得住滑鼠操作，擋不住有人直接呼叫
 * DELETE /api/admin/checkins/batch。真正決定「能不能刪、一次最多刪幾筆」的只有伺服器端
 * enforceSameOrigin → requireAdmin → enforceRateLimit 那一串與 parseBatchIds 的驗證，
 * 前端這裡不重複那份判斷，只負責在使用者用滑鼠操作時給出合理、即時的回饋。
 */
function toggleSelectAll() {
  if (batchDeleting.value) return
  const next = new Set(selectedIds.value)
  if (allFilteredSelected.value) {
    for (const item of filteredCheckins.value) next.delete(item.id)
  } else {
    for (const item of filteredCheckins.value) next.add(item.id)
  }
  selectedIds.value = next
}

function toggleRowSelected(id: number) {
  if (batchDeleting.value) return
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function clearSelection() {
  if (batchDeleting.value) return
  selectedIds.value = new Set()
  confirmingBatchDelete.value = false
  batchError.value = ''
  batchNotice.value = ''
}

function requestBatchDelete() {
  if (selectedCount.value === 0 || batchDeleting.value) return
  batchError.value = ''
  confirmingBatchDelete.value = true
}

function cancelBatchDeleteConfirm() {
  confirmingBatchDelete.value = false
}

async function confirmBatchDelete() {
  if (batchDeleting.value) return
  const ids = [...selectedIds.value]
  if (!ids.length) return
  batchDeleting.value = true
  batchError.value = ''
  batchNotice.value = ''
  try {
    const response = await $fetch<BatchDeleteResponse>('/api/admin/checkins/batch', { method: 'DELETE', body: { ids } })
    const overview = data.value
    if (overview) {
      const deleted = new Set(response.deletedIds)
      data.value = { ...overview, checkins: overview.checkins.filter(item => !deleted.has(item.id)) }
    }
    // 不存在的 id 不會讓整批失敗，但值得讓管理員知道清單有一部分是被別人搶先處理掉的。
    if (response.notFoundIds.length) {
      batchNotice.value = `已刪除 ${response.deletedCount} 則旅箋；其中 ${response.notFoundIds.length} 筆在操作前就已經被移除，清單已一併更新。`
    }
    selectedIds.value = new Set()
    confirmingBatchDelete.value = false
  } catch (fetchError) {
    batchError.value = errorMessage(fetchError, '批量刪除失敗，請稍後再試。')
  } finally {
    batchDeleting.value = false
  }
}

async function removeCheckin(checkin: Checkin) {
  if (deletingId.value !== null || batchDeleting.value) return
  if (!window.confirm(`確定要刪除「${checkin.location}」這則旅箋嗎？此操作無法復原。`)) return
  deletingId.value = checkin.id
  rowErrors[checkin.id] = ''
  try {
    await $fetch(`/api/admin/checkins/${checkin.id}`, { method: 'DELETE' })
    if (data.value) data.value = { ...data.value, checkins: data.value.checkins.filter(item => item.id !== checkin.id) }
    if (selectedIds.value.has(checkin.id)) {
      const next = new Set(selectedIds.value)
      next.delete(checkin.id)
      selectedIds.value = next
    }
  } catch (deleteError) {
    rowErrors[checkin.id] = errorMessage(deleteError, '刪除失敗，請稍後再試。')
  } finally {
    deletingId.value = null
  }
}

useHead({ title: '管理中心｜未完旅箋' })
</script>

<template>
  <main id="main-content" class="admin-page">
    <div class="admin-heading"><div><span class="eyebrow">ADMIN CONSOLE</span><h1>管理中心</h1><p>檢視 Discord 會員、調整管理員權限與管理公開旅箋。</p></div><NuxtLink class="secondary-button" to="/admin/stats">統計數據</NuxtLink><NuxtLink class="primary-button" to="/checkins/new">＋ 寫下旅箋</NuxtLink></div>
    <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在載入管理資料…</div>
    <div v-else-if="error" class="state-panel error-state" role="alert"><strong>管理資料讀取失敗</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button></div>
    <template v-else-if="data">
      <section class="admin-stats" aria-label="網站管理統計"><article><span>公開旅箋</span><strong>{{ data.checkins.length }}</strong></article><article><span>Discord 會員</span><strong>{{ data.users.length }}</strong></article><article><span>管理員</span><strong>{{ data.users.filter(user => user.role === 'admin').length }}</strong></article></section>
      <section class="admin-section">
        <div class="admin-section-heading"><div><span class="eyebrow">MEMBERS</span><h2>會員帳號</h2></div><span>{{ data.users.length }} 位</span></div>
        <div class="admin-table-wrap"><table><thead><tr><th>會員</th><th>Discord ID</th><th>角色</th><th>最近登入</th><th>權限調整</th></tr></thead><tbody><tr v-for="item in data.users" :key="item.id"><td><div class="admin-user"><DollAvatar :src="item.avatarUrl" preset="cloud" alt="" size="small" /><span><strong>{{ item.displayName }}</strong><small>@{{ item.username }}</small></span></div></td><td><code>{{ item.discordId }}</code></td><td><div class="admin-role-cell"><span class="role-badge" :class="item.role">{{ item.role === 'admin' ? '管理員' : '會員' }}</span> <span v-if="item.configAdmin" class="role-badge config">設定管理員</span></div></td><td>{{ formatCommentDate(item.lastLoginAt) }}</td><td><button class="secondary-button compact admin-role-toggle" type="button" :disabled="Boolean(roleLockReason(item)) || roleUpdatingId === item.id" :aria-label="`${roleActionLabel(item)}：${item.displayName}`" :aria-describedby="roleLockReason(item) ? `role-lock-${item.id}` : undefined" @click="toggleRole(item)">{{ roleActionLabel(item) }}</button><small v-if="roleLockReason(item)" :id="`role-lock-${item.id}`" class="admin-role-note">{{ roleLockReason(item) }}</small><div v-if="roleErrors[item.id]" class="inline-error" role="alert">{{ roleErrors[item.id] }}</div></td></tr></tbody></table></div>
      </section>

      <section class="admin-section">
        <div class="admin-section-heading">
          <div><span class="eyebrow">JOURNEY NOTES</span><h2>旅箋管理</h2></div>
          <span>符合 {{ filteredCheckins.length }} / {{ data.checkins.length }} 則</span>
        </div>

        <div class="filters admin-filters">
          <label>
            <span>縣市</span>
            <select v-model="filterCounty" :disabled="batchDeleting">
              <option value="">全部縣市</option>
              <option v-for="item in counties" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label>
            <span>作者</span>
            <select v-model="filterAuthorId" :disabled="batchDeleting">
              <option value="">全部作者</option>
              <option v-for="option in authorOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label>
            <span>抵達日期（起）</span>
            <input v-model="filterDateFrom" type="date" :max="filterDateTo || undefined" :disabled="batchDeleting">
          </label>
          <label>
            <span>抵達日期（迄）</span>
            <input v-model="filterDateTo" type="date" :min="filterDateFrom || undefined" :disabled="batchDeleting">
          </label>
          <label class="admin-filter-keyword">
            <span>關鍵字</span>
            <input v-model="filterKeyword" type="search" placeholder="地點、娃娃名稱、暱稱或心得" :disabled="batchDeleting">
          </label>
          <button type="button" class="clear-filter" :disabled="!hasActiveFilters || batchDeleting" @click="clearFilters">清除篩選</button>
        </div>

        <div v-if="batchError" class="alert error-alert" role="alert"><strong>批量刪除失敗</strong><span>{{ batchError }}</span></div>
        <div v-if="batchNotice" class="alert admin-notice-alert" role="status"><strong>批量刪除完成</strong><span>{{ batchNotice }}</span></div>

        <div v-if="selectedCount > 0" class="admin-batch-bar" aria-live="polite">
          <div class="admin-batch-summary"><strong>已選取 {{ selectedCount }} 筆</strong><span>批量刪除會一併移除照片，且無法復原。</span></div>
          <div class="admin-batch-actions">
            <button type="button" class="secondary-button compact" :disabled="batchDeleting" @click="clearSelection">取消選取</button>
            <button type="button" class="danger-button" :disabled="batchDeleting" @click="requestBatchDelete">{{ batchDeleting ? '刪除中…' : '批量刪除' }}</button>
          </div>
          <div v-if="confirmingBatchDelete" class="admin-batch-confirm" role="alert">
            <p>此操作<strong>無法復原</strong>，選取的 <strong>{{ selectedCount }}</strong> 則旅箋將連同照片一併永久刪除，確定要繼續嗎？</p>
            <div class="admin-batch-confirm-actions">
              <button ref="cancelBatchRef" type="button" class="secondary-button compact" :disabled="batchDeleting" @click="cancelBatchDeleteConfirm">返回</button>
              <button type="button" class="danger-button" :disabled="batchDeleting" @click="confirmBatchDelete">{{ batchDeleting ? '刪除中…' : `確認刪除 ${selectedCount} 筆` }}</button>
            </div>
          </div>
        </div>

        <div class="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th class="admin-select-cell">
                  <input
                    ref="selectAllRef"
                    type="checkbox"
                    :checked="allFilteredSelected"
                    :disabled="batchDeleting || filteredCheckins.length === 0"
                    aria-label="全選／全不選目前篩選出的旅箋"
                    @change="toggleSelectAll"
                  >
                </th>
                <th>地點</th>
                <th>娃娃／暱稱</th>
                <th>日期</th>
                <th>心得</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="filteredCheckins.length === 0">
                <td colspan="6" class="admin-empty-cell">{{ emptyCheckinsMessage }}</td>
              </tr>
              <tr v-for="item in filteredCheckins" :key="item.id" :class="{ 'is-selected': selectedIds.has(item.id) }">
                <td class="admin-select-cell">
                  <input
                    type="checkbox"
                    :checked="selectedIds.has(item.id)"
                    :disabled="batchDeleting || deletingId === item.id"
                    :aria-label="`選取「${item.location}」`"
                    @change="toggleRowSelected(item.id)"
                  >
                </td>
                <td><strong>{{ item.location }}</strong><small>{{ item.county }}</small></td>
                <td><strong>{{ item.dollName }}</strong><small>{{ item.nickname }}</small></td>
                <td>{{ formatDate(item.visitedAt) }}</td>
                <td class="admin-message-cell" :title="item.message">{{ item.message }}</td>
                <td class="admin-actions-cell">
                  <div class="admin-row-actions">
                    <NuxtLink class="text-link" :to="`/checkins/${item.id}`">查看</NuxtLink>
                    <button class="danger-button" type="button" :disabled="deletingId === item.id || batchDeleting" @click="removeCheckin(item)">{{ deletingId === item.id ? '刪除中…' : '刪除' }}</button>
                  </div>
                  <div v-if="rowErrors[item.id]" class="inline-error" role="alert">{{ rowErrors[item.id] }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
/* 篩選列：沿用全站 .filters 的間距與 label／select 樣式，這裡只補兩件事——
   一、允許換行（原本的 .filters 是給探索頁單一下拉選單用的單行 flex，這裡有五個欄位＋一顆按鈕）；
   二、.filters 目前只定義了 select 的外觀，這裡補上 input（日期／關鍵字）讓視覺一致。 */
.admin-filters { flex-wrap: wrap; justify-content: flex-start; row-gap: 12px; }
.admin-filters input {
  min-height: 42px;
  padding: 7px 12px;
  color: var(--ink);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  outline: none;
  background-color: var(--paper-strong);
}
.admin-filters input:focus { border-color: var(--rose); box-shadow: 0 0 0 4px rgb(217 103 126 / 10%); }
.admin-filters input:disabled, .admin-filters select:disabled { cursor: not-allowed; opacity: .6; }
.admin-filter-keyword { flex: 1 1 200px; min-width: 200px; }
.admin-filter-keyword input { width: 100%; }

/* 批量刪除完成的提示：沿用 .alert 的骨架，這裡補一個非錯誤（完成通知）的配色 */
.admin-notice-alert { color: var(--forest-dark); border-color: rgb(63 112 93 / 24%); background: var(--sage); }

.admin-batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 16px;
  padding: 14px 16px;
  border: 1px solid #e6b9c2;
  border-radius: 18px;
  background: rgb(251 228 231 / 55%);
}
.admin-batch-summary { display: grid; gap: 2px; }
.admin-batch-summary strong { font: 700 .95rem 'Zen Maru Gothic', sans-serif; }
.admin-batch-summary span { color: var(--muted); font-size: .74rem; }
.admin-batch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.admin-batch-confirm {
  flex-basis: 100%;
  padding: 13px 15px;
  border: 1px dashed #e6b9c2;
  border-radius: 14px;
  background: rgb(255 253 249 / 85%);
}
.admin-batch-confirm p { margin: 0 0 10px; font-size: .82rem; line-height: 1.6; }
.admin-batch-confirm strong { color: var(--danger); }
.admin-batch-confirm-actions { display: flex; flex-wrap: wrap; gap: 8px; }

/* 旅箋表格 */
.admin-select-cell { width: 40px; text-align: center; }
.admin-select-cell input { width: 18px; height: 18px; accent-color: var(--rose-dark); cursor: pointer; }
.admin-select-cell input:disabled { cursor: not-allowed; }
tr.is-selected td { background: rgb(217 103 126 / 6%); }
.admin-message-cell { max-width: 260px; overflow: hidden; color: var(--muted); font-size: .74rem; text-overflow: ellipsis; white-space: nowrap; }
.admin-row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.admin-actions-cell .inline-error { max-width: 220px; margin-top: 6px; }
.admin-empty-cell { padding: 30px 12px; color: var(--muted); text-align: center; }

@media (max-width: 480px) {
  .admin-batch-bar { flex-direction: column; align-items: stretch; }
  .admin-batch-actions { justify-content: stretch; }
  .admin-batch-actions button { flex: 1 1 auto; }
  .admin-batch-confirm-actions button { flex: 1 1 auto; }
  .admin-filter-keyword { flex-basis: 100%; min-width: 0; }
}
</style>
