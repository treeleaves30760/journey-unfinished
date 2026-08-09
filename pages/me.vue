<script setup lang="ts">
import type { Checkin, Doll, Draft } from '~/composables/useCheckins'
import type { ExportFormat } from '~/utils/exportCheckins'

definePageMeta({ middleware: 'auth' })

/**
 * 個人管理區的旅箋分頁。
 *
 * 在這頁之前，要刪掉一則寫壞的旅箋得先在地圖上找到它、點進詳情頁、捲到最下面才有刪除鈕——
 * 「管理十則」等於重複那套動作十次。這裡把清單、勾選與刪除放在同一個畫面上，
 * 並附上匯出：紀錄要能離開這個站，才算真的是使用者的。
 */
const { data, status, error, refresh } = await useFetch<{ checkins: Checkin[] }>('/api/me/checkins')
// 這兩份只是拿來顯示數量與提供入口，慢一點沒關係，不該擋住主要清單的算繪
const { data: dollData } = useLazyFetch<{ dolls: Doll[] }>('/api/dolls')
const { data: draftData } = useLazyFetch<{ drafts: Draft[] }>('/api/drafts')

const checkins = computed(() => data.value?.checkins || [])
const keyword = ref('')
const selected = ref(new Set<number>())
const busy = ref(false)
const actionError = ref('')
const actionNotice = ref('')

const filtered = computed(() => {
  const query = normalizeSearchText(keyword.value.trim())
  if (!query) return checkins.value
  return checkins.value.filter(checkin => normalizeSearchText(
    [checkin.location, checkin.county, regionName(checkin.countryCode), checkin.dollName, checkin.visitedAt].join(' ')
  ).includes(query))
})

const regionCount = computed(() => new Set(checkins.value.map(checkin => checkin.countryCode)).size)
const placeCount = computed(() => new Set(checkins.value.map(
  checkin => `${checkin.countryCode}/${checkin.county}/${checkin.location}`
)).size)
const selectedCount = computed(() => selected.value.size)
// 全選只作用在「目前看得到的」那些：搜尋過之後按全選卻連看不到的也一起選走，
// 是使用者最不希望在刪除鈕旁邊發生的事。
const allVisibleSelected = computed(() =>
  filtered.value.length > 0 && filtered.value.every(checkin => selected.value.has(checkin.id)))

function toggle(id: number) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleAllVisible() {
  const next = new Set(selected.value)
  if (allVisibleSelected.value) filtered.value.forEach(checkin => next.delete(checkin.id))
  else filtered.value.forEach(checkin => next.add(checkin.id))
  selected.value = next
}

/** 伺服器端一次最多 30 則（見 server/api/me/checkins.delete.ts），這裡照同一個數字切批。 */
const BATCH_SIZE = 30

async function removeIds(ids: number[], confirmText: string) {
  if (busy.value || !ids.length) return
  if (!window.confirm(confirmText)) return
  busy.value = true
  actionError.value = ''
  actionNotice.value = ''
  let deleted = 0
  try {
    for (let index = 0; index < ids.length; index += BATCH_SIZE) {
      const chunk = ids.slice(index, index + BATCH_SIZE)
      const result = await $fetch<{ deletedCount: number }>('/api/me/checkins', {
        method: 'DELETE',
        body: { ids: chunk }
      })
      deleted += result.deletedCount
    }
    selected.value = new Set()
    actionNotice.value = `已刪除 ${deleted} 則旅箋，照片也一併移除了。`
  } catch (requestError) {
    actionError.value = errorMessage(requestError, '刪除失敗，請稍後再試。')
    // 失敗前可能已經刪掉前幾批，所以無論成敗都要重新拉一次清單，畫面才不會停在舊狀態
  } finally {
    busy.value = false
    await refresh()
  }
}

function removeOne(checkin: Checkin) {
  return removeIds([checkin.id], `確定要刪除「${checkin.location}」這則旅箋嗎？照片會一併移除，且無法復原。`)
}

function removeSelected() {
  return removeIds(
    [...selected.value],
    `確定要刪除勾選的 ${selectedCount.value} 則旅箋嗎？照片會一併移除，且無法復原。`
  )
}

/**
 * 匯出在瀏覽器端組檔案：資料本來就已經在畫面上了，再往伺服器要一次同樣的東西
 * 只是多一支端點要維護、多一條要限流的路徑。
 */
function download(format: ExportFormat) {
  if (!checkins.value.length) return
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date())
  const url = URL.createObjectURL(buildExportBlob(format, checkins.value))
  const link = document.createElement('a')
  link.href = url
  link.download = exportFilename(format, today)
  link.click()
  // 立刻 revoke 會讓部分瀏覽器來不及開始下載，下一輪 event loop 才安全
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

useHead({ title: '個人管理區｜未完旅箋' })
</script>

<template>
  <main id="main-content" class="account-page">
    <section class="form-intro">
      <NuxtLink class="back-link" to="/">← 回到探索地圖</NuxtLink>
      <span class="eyebrow">MY JOURNEY</span>
      <h1>個人管理區</h1>
      <p>你寫下的旅箋、建過的娃娃與還沒寫完的草稿都在這裡，可以直接整理，也可以整份帶走。</p>
    </section>

    <AccountNav current="checkins" />

    <div v-if="actionError" class="alert error-alert" role="alert"><strong>操作失敗</strong><span>{{ actionError }}</span></div>
    <div v-else-if="actionNotice" class="alert success-alert" role="status"><span class="notice-icon" aria-hidden="true">✓</span><div><strong>已完成</strong><span>{{ actionNotice }}</span></div></div>

    <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在翻出你走過的路…</div>
    <div v-else-if="error" class="state-panel error-state" role="alert">
      <strong>讀不到你的旅箋</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button>
    </div>

    <template v-else>
      <ul class="account-stats">
        <li><div class="account-stat"><strong>{{ checkins.length }}</strong><span>則旅箋</span></div></li>
        <li><div class="account-stat"><strong>{{ placeCount }}</strong><span>個打卡點</span></div></li>
        <li><div class="account-stat"><strong>{{ regionCount }}</strong><span>個區域</span></div></li>
        <li><NuxtLink class="account-stat" to="/dolls"><strong>{{ dollData?.dolls.length ?? '—' }}</strong><span>隻娃娃</span></NuxtLink></li>
        <li><NuxtLink class="account-stat" to="/drafts"><strong>{{ draftData?.drafts.length ?? '—' }}</strong><span>份草稿</span></NuxtLink></li>
      </ul>

      <section class="account-export">
        <div>
          <h2>匯出我的打卡紀錄</h2>
          <p>日期、地點、座標與留言都在裡面。CSV 給試算表，JSON 是完整備份，GeoJSON 可以直接丟進地圖工具。</p>
        </div>
        <div class="account-export-actions">
          <button class="secondary-button compact" type="button" :disabled="!checkins.length" @click="download('csv')">CSV</button>
          <button class="secondary-button compact" type="button" :disabled="!checkins.length" @click="download('json')">JSON</button>
          <button class="secondary-button compact" type="button" :disabled="!checkins.length" @click="download('geojson')">GeoJSON</button>
        </div>
      </section>

      <div v-if="!checkins.length" class="state-panel empty-state">
        <strong>還沒有寫下任何旅箋</strong>
        <p>帶著娃娃出門的那一刻，就是這份紀錄的第一頁。</p>
        <NuxtLink class="primary-button" to="/checkins/new">寫下第一則</NuxtLink>
      </div>

      <template v-else>
        <div class="account-toolbar">
          <input
            v-model="keyword"
            class="account-search"
            type="search"
            maxlength="60"
            aria-label="搜尋我的旅箋"
            placeholder="搜尋地點、行政區、娃娃或日期"
          >
          <div class="account-toolbar-actions">
            <button class="text-button" type="button" :disabled="!filtered.length" @click="toggleAllVisible">
              {{ allVisibleSelected ? '取消全選' : '全選這些' }}
            </button>
            <button class="danger-button" type="button" :disabled="!selectedCount || busy" @click="removeSelected">
              {{ busy ? '刪除中…' : `刪除選取的 ${selectedCount} 則` }}
            </button>
          </div>
        </div>

        <p v-if="keyword.trim()" class="account-filter-note">
          符合「{{ keyword.trim() }}」的有 {{ filtered.length }} 則，共 {{ checkins.length }} 則。
        </p>

        <ul v-if="filtered.length" class="account-list">
          <li v-for="checkin in filtered" :key="checkin.id" class="account-row" :class="{ selected: selected.has(checkin.id) }">
            <label class="account-row-check">
              <input type="checkbox" :checked="selected.has(checkin.id)" :aria-label="`選取「${checkin.location}」`" @change="toggle(checkin.id)">
            </label>
            <NuxtLink class="account-row-thumb" :to="`/checkins/${checkin.id}`">
              <img v-if="checkin.photo" :src="checkin.photo" :alt="`${checkin.location}的照片`" loading="lazy">
              <span v-else aria-hidden="true">▧</span>
            </NuxtLink>
            <div class="account-row-body">
              <NuxtLink :to="`/checkins/${checkin.id}`"><strong>{{ checkin.location }}</strong></NuxtLink>
              <small class="account-row-meta">
                <time :datetime="checkin.visitedAt">{{ formatDate(checkin.visitedAt) }}</time>
                · {{ placeLabel(checkin) }} · {{ checkin.dollName }}
                <template v-if="checkin.commentCount"> · {{ checkin.commentCount }} 則留言</template>
              </small>
              <small class="account-row-coords">{{ checkin.latitude.toFixed(4) }}, {{ checkin.longitude.toFixed(4) }}</small>
            </div>
            <div class="account-row-actions">
              <NuxtLink class="secondary-button compact" :to="`/checkins/${checkin.id}`">查看</NuxtLink>
              <button class="text-button danger" type="button" :disabled="busy" @click="removeOne(checkin)">刪除</button>
            </div>
          </li>
        </ul>
        <div v-else class="state-panel empty-state">
          <strong>沒有符合的旅箋</strong>
          <p>換個關鍵字，或清空搜尋看看全部。</p>
          <button class="secondary-button" type="button" @click="keyword = ''">清空搜尋</button>
        </div>
      </template>
    </template>
  </main>
</template>
