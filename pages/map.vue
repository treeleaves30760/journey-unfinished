<script setup lang="ts">
import type { Checkin } from '~/composables/useCheckins'
import RegionMap from '~/components/RegionMap.vue'

interface FocusTarget {
  lat: number
  lng: number
  zoom?: number
}

useHead({ title: '全螢幕探索地圖｜未完旅箋' })

const { data, status, error, refresh } = await useFetch<{ checkins: Checkin[] }>('/api/checkins')
const checkins = computed(() => data.value?.checkins || [])

const searchTerm = ref('')
const county = ref('全部地區')
const sort = ref<'new' | 'old'>('new')
const selected = ref<Checkin | null>(null)
const focusTarget = ref<FocusTarget | null>(null)
const sidebarCollapsed = ref(false)
const isCompactLayout = ref(false)
const headerOffset = ref(72)
const regionMap = ref<InstanceType<typeof RegionMap> | null>(null)
let headerResizeObserver: ResizeObserver | null = null
let compactMediaQuery: MediaQueryList | null = null

// 側欄收合時要不要整個設成 inert，桌機和手機版是兩回事：桌機收合後側欄寬度歸零、完全不可見，
// 交給旁邊獨立的 .sidebar-reopen 按鈕負責展開，這時把側欄設成 inert 是對的（不然鍵盤使用者會
// tab 到一個寬度 0、看不見對應焦點框的地方）。手機版收合後側欄用 transform 滑到只剩底部一條
// 「把手」，那條把手（含展開用的按鈕）本身仍然可見可點——如果這時還把整個側欄設成 inert，
// 使用者會被鎖在收合狀態，因為手機版刻意不重複做第二顆浮動展開按鈕（見樣式表註解）。
const sidebarInert = computed(() => sidebarCollapsed.value && !isCompactLayout.value)

// 全螢幕頁不套用首頁那組臺灣邊界／縮放限制：這裡刻意不給 bounds（RegionMap 收到 undefined
// 會直接清掉 Leaflet 的 maxBounds），minZoom 也放寬，讓使用者能像 Google Maps 一樣自由拖曳、
// 縮到臺灣以外的範圍；maxZoom 19 對齊 RegionMap 內建的 OSM 圖磚上限，再高瀏覽器也拿不到圖磚。
const region = {
  id: 'taiwan-explore',
  label: '臺灣',
  center: [23.72, 121.0] as [number, number],
  zoom: 8,
  minZoom: 3,
  maxZoom: 19
}

const availableCounties = computed(() => [...new Set(checkins.value.map(item => item.county))])

const filteredCheckins = computed(() => {
  const needle = normalizeSearchText(searchTerm.value.trim())
  const list = checkins.value.filter((item) => {
    if (county.value !== '全部地區' && item.county !== county.value) return false
    if (!needle) return true
    return [item.location, item.county, item.dollName, item.nickname, item.series]
      .some(field => field && normalizeSearchText(field).includes(needle))
  })
  return [...list].sort((a, b) => sort.value === 'new' ? b.visitedAt.localeCompare(a.visitedAt) : a.visitedAt.localeCompare(b.visitedAt))
})

const hasActiveFilters = computed(() => county.value !== '全部地區' || searchTerm.value.trim() !== '')

function clearFilters() {
  county.value = '全部地區'
  searchTerm.value = ''
}

// 側欄清單點擊：開啟摘要並讓地圖飛過去。順手在側欄收合時展開它，不然摘要卡片會被
// 收在寬度 0 的側欄裡，使用者完全看不到剛剛點了什麼。
function focusCheckin(checkin: Checkin) {
  selected.value = checkin
  focusTarget.value = { lat: checkin.latitude, lng: checkin.longitude, zoom: 14 }
  sidebarCollapsed.value = false
}

// 直接點地圖上的頭像：只開摘要，鏡頭已經在那裡了，不需要再 flyTo 一次。
function selectFromMap(checkin: Checkin) {
  selected.value = checkin
  sidebarCollapsed.value = false
}

function closeSelected() {
  selected.value = null
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

// 側欄收合／展開靠 CSS 改變寬度（或手機版的 transform）讓地圖容器跟著 reflow，
// RegionMap 內部既有的 ResizeObserver 理論上就會自動偵測到新尺寸並呼叫 invalidateSize。
// 這裡在 transition 結束時再明確呼叫一次，是避免極端情況下漏掉一次 reflow 導致地圖破圖的保險；
// event.target === currentTarget 是為了不要被側欄內部元素（例如按鈕 hover）冒泡上來的
// transitionend 誤觸發。
function handleSidebarTransitionEnd(event: TransitionEvent) {
  if (event.target === event.currentTarget) regionMap.value?.invalidateSize()
}

watch(filteredCheckins, (items) => {
  if (selected.value && !items.some(item => item.id === selected.value?.id)) selected.value = null
})

// 從首頁按下「全螢幕探索地圖」時，那顆按鈕已經用原生 View Transition API 處理了
// 「地圖卡片展開成全螢幕」的過場動畫（見 pages/index.vue 的 goFullscreenMap）。這裡如果
// 再疊加自己的 CSS 進場動畫，畫面會在 View Transition 收尾那一瞬間看到動畫播到一半的
// 狀態被定格，變成很突兀的閃爍。所以用一個跨頁共享的旗標，這種情況下直接跳過進場動畫，
// 讓 View Transition 自己收尾就好；其他進入方式（直接輸入網址、重新整理、上一頁／下一頁）
// 這個旗標都會是預設值 false，照常播放下面的 CSS 進場動畫。
const enteredViaViewTransition = useState('map-enter-transition', () => false)
const playEnterAnimation = !enteredViaViewTransition.value
function handleCompactLayoutChange(event: MediaQueryListEvent) {
  isCompactLayout.value = event.matches
}

onMounted(() => {
  enteredViaViewTransition.value = false

  // 全螢幕頁刻意蓋過頁尾（footer 在 app.vue 裡，不在本頁可修改範圍內），但保留頂部
  // 站頭導覽可見可互動。用 ResizeObserver 量測真實高度、換算成 CSS 變數，而不是寫死
  // 72px／64px——main.css 目前也有別的 agent 在改，站頭高度隨時可能變。
  const header = document.querySelector<HTMLElement>('.site-header')
  if (header) {
    headerOffset.value = header.getBoundingClientRect().height
    headerResizeObserver = new ResizeObserver(() => {
      headerOffset.value = header.getBoundingClientRect().height
    })
    headerResizeObserver.observe(header)
  }

  // 斷點數字要跟 <style> 裡的 @media (max-width: 480px) 對齊，這裡只是用來決定
  // sidebarInert 的行為，不是另外定義一套版面規則。
  compactMediaQuery = window.matchMedia('(max-width: 480px)')
  isCompactLayout.value = compactMediaQuery.matches
  compactMediaQuery.addEventListener('change', handleCompactLayoutChange)
})
onBeforeUnmount(() => {
  headerResizeObserver?.disconnect()
  compactMediaQuery?.removeEventListener('change', handleCompactLayoutChange)
})

async function goHome() {
  const skipTransition = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || typeof document.startViewTransition !== 'function'
  if (skipTransition) {
    await navigateTo('/')
    return
  }
  document.startViewTransition(async () => {
    await navigateTo('/')
    await nextTick()
  })
}
</script>

<template>
  <main
    id="main-content"
    class="map-page"
    :class="{ 'is-entering': playEnterAnimation, 'sidebar-collapsed': sidebarCollapsed }"
    :style="{ '--map-page-top': `${headerOffset}px` }"
  >
    <aside id="map-explore-sidebar" class="map-sidebar" :inert="sidebarInert" @transitionend="handleSidebarTransitionEnd">
      <div class="map-sidebar-inner">
        <div class="map-sidebar-head">
          <NuxtLink class="back-link" to="/" @click.prevent="goHome"><span aria-hidden="true">‹</span> 回首頁</NuxtLink>
          <div class="map-sidebar-count" aria-live="polite" aria-atomic="true"><strong>{{ filteredCheckins.length }}</strong><span>個地點</span></div>
          <button type="button" class="sidebar-collapse-toggle" :aria-expanded="!sidebarCollapsed" aria-controls="map-explore-sidebar" @click="toggleSidebar">
            <span aria-hidden="true">‹</span><span class="sr-only">收合側欄</span>
          </button>
        </div>

        <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在載入旅箋…</div>
        <div v-else-if="error" class="state-panel error-state" role="alert">
          <strong>地圖暫時迷路了</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button>
        </div>
        <template v-else>
          <div class="map-sidebar-controls">
            <label class="field search-field">
              <span>搜尋</span>
              <input v-model.trim="searchTerm" type="search" maxlength="100" placeholder="地點、娃娃名稱、縣市…">
            </label>
            <div class="filters">
              <label><span>地區</span><select v-model="county"><option>全部地區</option><option v-for="item in availableCounties" :key="item">{{ item }}</option></select></label>
              <label><span>排序</span><select v-model="sort"><option value="new">新到舊</option><option value="old">舊到新</option></select></label>
              <button v-if="hasActiveFilters" type="button" class="clear-filter" @click="clearFilters">清除篩選</button>
            </div>
          </div>

          <div class="map-sidebar-scroll">
            <Transition name="fade" mode="out-in">
              <article v-if="selected" :key="selected.id" class="selected-story">
                <button class="close-story" aria-label="關閉摘要" @click="closeSelected">×</button>
                <div v-if="selected.photo" class="selected-photo">
                  <img :src="selected.photo" :alt="`${selected.dollName}在${selected.location}的照片`" loading="lazy">
                </div>
                <DollAvatar :src="selected.avatar" :preset="selected.avatarPreset" :alt="`${selected.nickname}頭像`" size="large" />
                <span class="county-chip">{{ selected.county }}</span>
                <h3>{{ selected.location }}</h3>
                <small v-if="selected.series" class="card-series">✎ {{ selected.series }}</small>
                <p>「{{ selected.message }}」</p>
                <div class="selected-author">{{ selected.nickname }} 與 {{ selected.dollName }}<span>·</span>{{ formatDate(selected.visitedAt) }}</div>
                <NuxtLink class="primary-button compact" :to="`/checkins/${selected.id}`">閱讀完整故事 <span aria-hidden="true">→</span></NuxtLink>
              </article>
              <div v-else class="story-list">
                <button
                  v-for="item in filteredCheckins"
                  :key="item.id"
                  type="button"
                  :aria-label="`查看 ${item.location} 的故事摘要並移動地圖`"
                  @click="focusCheckin(item)"
                >
                  <span class="result-thumb">
                    <img v-if="item.photo" :src="item.photo" alt="" loading="lazy">
                    <DollAvatar v-else :src="item.avatar" :preset="item.avatarPreset" alt="" size="small" />
                  </span>
                  <span><strong>{{ item.county }} · {{ item.location }}</strong><small>{{ item.dollName }} · {{ formatDate(item.visitedAt) }}</small></span>
                  <i aria-hidden="true">›</i>
                </button>
                <p v-if="!filteredCheckins.length" class="map-side-empty">沒有符合條件的旅箋，換個關鍵字或地區看看吧。</p>
              </div>
            </Transition>
          </div>
        </template>
      </div>
    </aside>

    <button v-if="sidebarCollapsed" type="button" class="sidebar-reopen" aria-controls="map-explore-sidebar" aria-expanded="false" @click="toggleSidebar">
      <span aria-hidden="true">›</span><span class="sr-only">展開側欄</span>
    </button>

    <div class="map-viewport">
      <ClientOnly>
        <RegionMap
          ref="regionMap"
          :checkins="filteredCheckins"
          :selected-id="selected?.id ?? null"
          :region="region"
          :focus-target="focusTarget"
          @select="selectFromMap"
        />
        <template #fallback>
          <div class="map-viewport-loading" role="status"><i class="loader" />正在載入 OpenStreetMap…</div>
        </template>
      </ClientOnly>
    </div>
  </main>
</template>

<style scoped>
/* 全螢幕頁刻意蓋過頁尾（position: fixed + 比它高的 z-index），但 z-index 仍低於
   .site-header 的 800，讓站頭導覽（回首頁、登入狀態）維持在最上層、可以正常互動。
   頂部留白用 --map-page-top（由 JS 量測站頭實際高度後寫入）而不是寫死數字。 */
.map-page {
  position: fixed;
  top: var(--map-page-top, 72px);
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 790;
  display: flex;
  overflow: hidden;
  background: var(--paper);
}

@media (prefers-reduced-motion: no-preference) {
  .map-page.is-entering { animation: map-page-expand .45s cubic-bezier(.2, .8, .2, 1) both; }
}
@keyframes map-page-expand {
  from { opacity: 0; transform: scale(.96); }
  to { opacity: 1; transform: scale(1); }
}

.map-sidebar {
  --sidebar-width: 380px;
  --sidebar-handle: 64px;
  position: relative;
  flex: 0 0 var(--sidebar-width);
  width: var(--sidebar-width);
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: linear-gradient(165deg, rgb(255 255 255 / 92%), rgb(248 237 228 / 92%));
  transition: flex-basis .28s ease, width .28s ease;
}
.map-page.sidebar-collapsed .map-sidebar { flex-basis: 0; width: 0; border-right-color: transparent; }
@media (prefers-reduced-motion: reduce) {
  .map-sidebar, .sidebar-reopen { transition: none; }
}

/* 固定寬度的內層：外層 .map-sidebar 收合時用 overflow: hidden 把它裁掉（清出寬度給地圖），
   內層本身維持原寬度，文字才不會在收合動畫途中被硬擠壓變形，而是乾淨地被裁切。 */
.map-sidebar-inner { display: flex; width: var(--sidebar-width); height: 100%; min-height: 0; flex-direction: column; }

.map-sidebar-head {
  display: flex;
  min-height: var(--sidebar-handle);
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 10px 16px;
  border-bottom: 1px solid var(--line);
}
.map-sidebar-head .back-link { flex: 0 0 auto; margin-bottom: 0; white-space: nowrap; }
.map-sidebar-count { display: grid; flex: 1 1 auto; justify-items: center; line-height: 1.2; color: var(--muted); font-size: .68rem; text-align: center; }
.map-sidebar-count strong { color: var(--ink); font: 700 1rem 'Zen Maru Gothic', sans-serif; }
.sidebar-collapse-toggle {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  color: var(--rose-dark);
  border: 1px solid var(--line);
  border-radius: 50%;
  cursor: pointer;
  background: rgb(255 253 249 / 88%);
  font-size: 1.1rem;
}

.map-sidebar-controls { display: grid; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.map-sidebar-controls .filters { flex-wrap: wrap; justify-content: flex-start; }
.map-sidebar-controls .filters label { min-width: 120px; flex: 1 1 120px; }

.map-sidebar-scroll { flex: 1; min-height: 0; padding: 4px 16px 18px; overflow-y: auto; }
.map-sidebar-scroll .story-list { padding-top: 8px; }

.result-thumb { display: grid; width: 42px; height: 42px; overflow: hidden; place-items: center; border-radius: 10px; background: var(--paper-deep); }
.result-thumb img { width: 100%; height: 100%; object-fit: cover; }

.selected-photo { width: 100%; aspect-ratio: 4 / 3; margin-bottom: 16px; overflow: hidden; border-radius: 16px; background: var(--paper-deep); }
.selected-photo img { width: 100%; height: 100%; object-fit: cover; }
.selected-story .card-series { margin: -5px 0 9px; }

/* 收合時浮在地圖左下角的「展開側欄」按鈕，特意避開左上角（Leaflet 內建的縮放控制項預設也在
   那個角落），才不會兩顆控制項疊在一起。 */
.sidebar-reopen {
  position: absolute;
  bottom: 20px;
  left: 16px;
  z-index: 20;
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  color: var(--rose-dark);
  border: 1px solid var(--line);
  border-radius: 50%;
  cursor: pointer;
  background: rgb(255 253 249 / 94%);
  box-shadow: var(--shadow-soft);
  font-size: 1.2rem;
}

.map-viewport { position: relative; flex: 1; min-width: 0; height: 100%; }
/* :deep() 蓋掉 RegionMap 根節點在 main.css 裡原本給嵌入版用的固定 560px 高度／圓角卡片樣式，
   讓它在這裡改成滿版鋪滿 .map-viewport；RegionMap.vue 本身不用跟著改，首頁嵌入版完全不受影響。 */
.map-viewport :deep(.region-map-shell) { height: 100%; border-radius: 0; }
.map-viewport-loading { display: grid; height: 100%; place-items: center; color: var(--muted); }

@media (max-width: 720px) {
  .map-sidebar { --sidebar-width: 320px; }
}

/* 430px 以下改成抽屜式：地圖固定滿版鋪底，側欄變成從畫面底部升起的卡片，
   收合時靠 transform 平移到只剩頂部那一列（把手＋標題），不是靠寬度歸零，
   這樣手把仍然留在畫面上可以直接點開，而不是徹底消失。 */
@media (max-width: 480px) {
  .map-page { flex-direction: column; }
  .map-viewport { position: absolute; inset: 0; flex: none; }
  .map-sidebar {
    --sidebar-width: 100%;
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 15;
    flex: none;
    width: auto;
    max-height: 68dvh;
    border-right: 0;
    border-top: 1px solid var(--line);
    border-radius: 22px 22px 0 0;
    box-shadow: 0 -14px 34px rgb(56 47 52 / 18%);
    transform: translateY(0);
    transition: transform .28s ease;
  }
  /* width/flex-basis 要在這裡重新蓋回去：桌機版收合是靠寬度歸零（.map-page.sidebar-collapsed
     .map-sidebar 那條規則，selector 特異度跟這條一樣，寫在前面），手機版改靠 transform 平移，
     兩種收合機制不能共用同一個 width: 0——沒有這行，手機版收合時側欄會被桌機那條規則裁成寬度 0，
     把手整個消失且底下量到的位置全部失真（子元素仍回報「看似存在」的座標，實際上已經被
     overflow: hidden 裁光，既不可見也點不到）。 */
  .map-page.sidebar-collapsed .map-sidebar { width: auto; flex-basis: auto; transform: translateY(calc(100% - var(--sidebar-handle))); }
  .map-sidebar-inner { width: 100%; max-height: 68dvh; }
  /* 手機版用側欄自己頂端那一列當抽屜把手，不需要另一顆浮動的展開按鈕 */
  .sidebar-reopen { display: none; }
}
</style>
