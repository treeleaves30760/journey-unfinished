<script setup lang="ts">
import type { Checkin } from '~/composables/useCheckins'

const { data, status, error, refresh } = await useFetch<{ checkins: Checkin[] }>('/api/checkins')
const selected = ref<Checkin | null>(null)
const county = ref('全部地區')
const seriesFilter = ref('全部作品')
const dollNameFilter = ref('全部娃娃')
const keyword = ref('')
const sort = ref<'new' | 'old'>('new')
const homePage = ref<HTMLElement | null>(null)
const heroPanel = ref<HTMLElement | null>(null)
const mapPanel = ref<HTMLElement | null>(null)
const storiesPanel = ref<HTMLElement | null>(null)
const ctaPanel = ref<HTMLElement | null>(null)
const activePanel = ref(0)
const enhanced = ref(false)
const { user } = useAuth()
let panelObserver: IntersectionObserver | null = null

const checkins = computed(() => data.value?.checkins || [])

// 關鍵字要同時比對地點、娃娃名稱、暱稱、作品與心得，任一欄位命中即算符合；
// series 可能是 null（原創娃娃沒有作品出處），跳過空值才不會讓 normalizeSearchText 收到 null。
function matchesKeyword(item: Checkin, needle: string) {
  if (!needle) return true
  return [item.location, item.dollName, item.nickname, item.series, item.message]
    .some(value => value && normalizeSearchText(value).includes(needle))
}

const filtered = computed(() => {
  const needle = normalizeSearchText(keyword.value)
  const list = checkins.value.filter(item =>
    (county.value === '全部地區' || item.county === county.value)
    && (seriesFilter.value === '全部作品' || item.series === seriesFilter.value)
    && (dollNameFilter.value === '全部娃娃' || item.dollName === dollNameFilter.value)
    && matchesKeyword(item, needle)
  )
  return list.sort((a, b) => sort.value === 'new' ? b.visitedAt.localeCompare(a.visitedAt) : a.visitedAt.localeCompare(b.visitedAt))
})

const availableCounties = computed(() => [...new Set(checkins.value.map(item => item.county))])
// 只從「有填作品」的旅箋取值：series 是 null 的原創娃娃不該在下拉選單裡變成一個叫 null 的選項。
const availableSeries = computed(() => [...new Set(checkins.value.map(item => item.series).filter((value): value is string => Boolean(value)))])
const availableDollNames = computed(() => [...new Set(checkins.value.map(item => item.dollName))])
const hasActiveFilters = computed(() =>
  county.value !== '全部地區' || seriesFilter.value !== '全部作品'
  || dollNameFilter.value !== '全部娃娃' || keyword.value !== ''
)
const totalComments = computed(() => checkins.value.reduce((sum, item) => sum + item.commentCount, 0))
const createTarget = computed(() => user.value ? '/checkins/new' : '/login?redirect=/checkins/new')
// 右側分頁導覽：編號旁再補兩個字說明這一段在做什麼，光看 01–04 猜不出用途。
// aria-label 仍然用完整名稱，螢幕閱讀器聽到的會比兩個字更完整。
const panelSections = [
  { short: '首頁', label: '旅箋首頁' },
  { short: '地圖', label: '探索地圖' },
  { short: '旅箋', label: '沿途新頁' },
  { short: '寫下', label: '寫下旅箋' }
]

function selectCheckin(checkin: Checkin) {
  selected.value = checkin
}

// 全螢幕探索頁的入口：支援 View Transitions API 時，用原生 API 把這張地圖卡片「展開」成
// /map 整頁；不支援，或使用者開了「減少動態效果」，就退化成一般導覽，不強行補動畫。
async function goFullscreenMap() {
  const skipTransition = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || typeof document.startViewTransition !== 'function'
  if (skipTransition) {
    await navigateTo('/map')
    return
  }
  // 讓 /map 知道這次進場已經由 View Transition 負責畫面過場，它自己就不會再疊加一次
  // CSS 進場動畫（見 pages/map.vue 開頭對 map-enter-transition 這個 useState 的說明）。
  useState('map-enter-transition', () => false).value = true
  document.startViewTransition(async () => {
    await navigateTo('/map')
    await nextTick()
  })
}

function clearFilters() {
  county.value = '全部地區'
  seriesFilter.value = '全部作品'
  dollNameFilter.value = '全部娃娃'
  keyword.value = ''
}

function scrollToPanel(index: number) {
  const panels = [heroPanel.value, mapPanel.value, storiesPanel.value, ctaPanel.value]
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  panels[index]?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
}

watch(filtered, (items) => {
  if (selected.value && !items.some(item => item.id === selected.value?.id)) selected.value = null
})

onMounted(() => {
  enhanced.value = true
  const panels = [heroPanel.value, mapPanel.value, storiesPanel.value, ctaPanel.value].filter((panel): panel is HTMLElement => Boolean(panel))
  panelObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
    if (visible) activePanel.value = Number((visible.target as HTMLElement).dataset.panel || 0)
  }, { root: homePage.value, threshold: [0.45, 0.65, 0.85] })
  panels.forEach(panel => panelObserver?.observe(panel))
})

onBeforeUnmount(() => panelObserver?.disconnect())
</script>

<template>
  <main id="main-content" ref="homePage" class="home-page" :class="{ 'is-enhanced': enhanced }">
    <section ref="heroPanel" class="home-panel hero-panel" :class="{ 'is-active': activePanel === 0 }" data-panel="0">
      <div class="hero-section">
      <div class="hero-copy panel-enter from-left">
        <span class="eyebrow">JOURNEY, UNFINISHED</span>
        <h1>小小的你，<br><em>世界很大。</em></h1>
        <p class="hero-lead">把與心愛旅伴一起看過的風景，寫進未完的旅箋。每一次抵達，都是下一頁的開始。</p>
        <div class="hero-actions">
          <NuxtLink class="primary-button" :to="createTarget">＋ 寫下這一站</NuxtLink>
          <button class="text-link" type="button" @click="scrollToPanel(1)">翻開旅箋 <span>↓</span></button>
        </div>
        <div class="hero-stats" aria-label="網站統計">
          <span><strong>{{ checkins.length }}</strong>則旅箋</span>
          <span><strong>{{ availableCounties.length }}</strong>個縣市</span>
          <span><strong>{{ totalComments }}</strong>份交流</span>
        </div>
      </div>
      <div class="hero-art panel-enter from-right" aria-hidden="true">
        <div class="postcard back"><i /></div>
        <div class="postcard front"><div class="postcard-scene"><i class="sun" /><i class="mountain one" /><i class="mountain two" /><span class="tiny-doll">娃</span></div><b>JOURNEY</b><small>下一站見！</small></div>
        <span class="spark spark-one">✦</span><span class="spark spark-two">✿</span>
      </div>
      </div>
    </section>

    <section id="map" ref="mapPanel" class="home-panel map-section" :class="{ 'is-active': activePanel === 1 }" data-panel="1">
      <div class="section-shell">
        <div class="section-heading centered panel-enter from-top">
          <span class="eyebrow">EXPLORE THE MAP</span>
          <h2>循著旅箋，去看世界</h2>
          <p>沿著地圖上的小小頭像，翻開旅人與旅伴一起收藏的風景。</p>
        </div>

        <div v-if="checkins.length" class="explore-toolbar panel-enter from-top" aria-label="探索篩選條件">
          <div class="toolbar-summary"><span>目前顯示</span><strong>{{ filtered.length }} 則沿途旅箋</strong></div>
          <div class="filters">
            <label><span>地區</span><select v-model="county"><option>全部地區</option><option v-for="item in availableCounties" :key="item">{{ item }}</option></select></label>
            <label><span>作品</span><select v-model="seriesFilter"><option>全部作品</option><option v-for="item in availableSeries" :key="item">{{ item }}</option></select></label>
            <label><span>娃娃名稱</span><select v-model="dollNameFilter"><option>全部娃娃</option><option v-for="item in availableDollNames" :key="item">{{ item }}</option></select></label>
            <label class="search-field"><span>關鍵字</span><input v-model.trim="keyword" type="search" maxlength="100" placeholder="地點、娃娃、暱稱、作品或心得"></label>
            <label><span>旅行日期</span><select v-model="sort"><option value="new">新到舊</option><option value="old">舊到新</option></select></label>
            <button v-if="hasActiveFilters" type="button" class="clear-filter" @click="clearFilters">清除篩選</button>
          </div>
        </div>

        <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在展開臺灣地圖…</div>
        <div v-else-if="error" class="state-panel error-state" role="alert">
          <strong>地圖暫時迷路了</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button>
        </div>
        <div v-else-if="!checkins.length" class="state-panel empty-state">
          <strong>地圖上還沒有旅箋</strong><p>帶上心愛的小小旅伴，寫下共同抵達的第一站。</p><NuxtLink class="primary-button" :to="createTarget">寫下第一則旅箋</NuxtLink>
        </div>
        <div v-else class="map-layout">
          <div class="map-panel panel-enter from-left">
            <ClientOnly>
              <RegionMap :checkins="filtered" :selected-id="selected?.id" @select="selectCheckin" />
              <template #fallback>
                <div class="map-loading" role="status"><i class="loader" />正在載入 OpenStreetMap…</div>
              </template>
            </ClientOnly>
            <button type="button" class="primary-button map-expand-trigger" @click="goFullscreenMap">
              <span aria-hidden="true">⛶</span> 開啟大地圖
            </button>
            <p class="map-hint"><span aria-hidden="true">◎</span> 點擊地圖上的頭像，翻開旅人寫下的旅箋</p>
          </div>
          <aside class="map-side panel-enter from-right" aria-label="地圖旅箋摘要" aria-live="polite">
            <div class="map-side-title"><span>精選旅箋</span><small>{{ filtered.length }} 個地點</small></div>
            <Transition name="fade" mode="out-in">
              <article v-if="selected" :key="selected.id" class="selected-story">
                <button class="close-story" aria-label="關閉摘要" @click="selected = null">×</button>
                <DollAvatar :src="selected.avatar" :preset="selected.avatarPreset" :alt="`${selected.nickname}頭像`" size="large" />
                <span class="county-chip">{{ selected.county }}</span>
                <h3>{{ selected.location }}</h3>
                <p>「{{ selected.message }}」</p>
                <div class="selected-author">{{ selected.nickname }} 與 {{ selected.dollName }}<span>·</span>{{ formatDate(selected.visitedAt) }}</div>
                <NuxtLink class="primary-button compact" :to="`/checkins/${selected.id}`">閱讀完整故事 <span aria-hidden="true">→</span></NuxtLink>
              </article>
              <div v-else class="story-list">
                <button v-for="item in filtered.slice(0, 4)" :key="item.id" type="button" :aria-label="`查看 ${item.location} 的故事摘要`" @click="selectCheckin(item)">
                  <DollAvatar :src="item.avatar" :preset="item.avatarPreset" alt="" size="small" />
                  <span><strong>{{ item.location }}</strong><small>{{ item.nickname }} 與 {{ item.dollName }}</small></span><i aria-hidden="true">›</i>
                </button>
                <p v-if="!filtered.length" class="map-side-empty">沒有符合篩選條件的旅箋，換個條件看看吧。</p>
              </div>
            </Transition>
          </aside>
        </div>
      </div>
    </section>

    <section ref="storiesPanel" class="home-panel stories-panel" :class="{ 'is-active': activePanel === 2 }" data-panel="2">
      <div class="stories-section">
      <div class="section-heading row-heading panel-enter from-left">
        <div><span class="eyebrow">PAGES ALONG THE WAY</span><h2>沿途寫下的新頁</h2></div>
        <p class="result-count">{{ hasActiveFilters ? '符合篩選' : '全部地區' }} · {{ filtered.length }} 則旅箋</p>
      </div>
      <div v-if="filtered.length" class="card-grid panel-enter from-bottom"><CheckinCard v-for="item in filtered" :key="item.id" :checkin="item" /></div>
      <div v-else class="state-panel empty-state"><strong>沒有符合篩選條件的旅箋</strong><p>試著調整篩選條件，或寫下你們共同抵達的第一站。</p></div>
      </div>
    </section>

    <section ref="ctaPanel" class="home-panel cta-panel" :class="{ 'is-active': activePanel === 3 }" data-panel="3">
      <div class="cta-section">
        <div class="cta-doodle left panel-enter from-left" aria-hidden="true">✿</div>
        <div class="cta-copy panel-enter from-bottom">
          <span class="eyebrow">YOUR NEXT PAGE</span>
          <h2>下一頁，與你一起寫</h2>
          <p>帶上心愛的小小旅伴，去往下一站，把共同看過的風景留在這裡。三個步驟，就能把這一天留成一頁旅箋。</p>
          <ol class="cta-steps">
            <li><b>01</b><strong>選一張旅伴頭像</strong><span>上傳自己拍的照片，或直接挑現成頭像，旅伴就住進地圖裡。</span></li>
            <li><b>02</b><strong>標上抵達的地點</strong><span>在地圖上點一下，或搜尋店名與景點，座標會自動補齊。</span></li>
            <li><b>03</b><strong>寫下當下的心情</strong><span>幾句話、一張合照，都會成為別人翻開這一站時看見的風景。</span></li>
          </ol>
          <div class="cta-actions">
            <NuxtLink class="primary-button light" :to="createTarget">{{ user ? '＋ 寫下這一站' : '使用 Discord 登入' }}</NuxtLink>
            <button type="button" class="cta-ghost-button" @click="scrollToPanel(1)"><span aria-hidden="true">↑</span> 先逛逛地圖</button>
          </div>
          <p class="cta-footnote">
            目前收藏 <strong>{{ checkins.length }}</strong> 則旅箋 · 走過 <strong>{{ availableCounties.length }}</strong> 個縣市 · 留下 <strong>{{ totalComments }}</strong> 份交流
          </p>
        </div>
        <div class="cta-doodle right panel-enter from-right" aria-hidden="true">✦</div>
      </div>
      <footer class="home-panel-footer"><strong>未完旅箋</strong><span>小小的你，世界很大。</span><small>本站示意內容與頭像皆為原創。</small></footer>
    </section>

    <nav class="page-dots" aria-label="首頁分頁導覽">
      <button v-for="(section, index) in panelSections" :key="section.label" type="button" :class="{ active: activePanel === index }" :aria-label="`前往${section.label}`" :aria-current="activePanel === index ? 'page' : undefined" @click="scrollToPanel(index)"><span>{{ String(index + 1).padStart(2, '0') }}</span><em>{{ section.short }}</em><i /></button>
    </nav>
  </main>
</template>

<style scoped>
/* 讓支援 View Transitions API 的瀏覽器把這張地圖卡片「長成」/map 整頁（詳見
   pages/map.vue 同名的 view-transition-name 設定）；不支援的瀏覽器這個屬性單純不會被
   用到，不影響版面。 */
.map-panel { position: relative; view-transition-name: checkin-map-expand; }
/* 前往全螢幕地圖的入口浮在地圖右上角：那個角落沒有 Leaflet 內建控制項（縮放在左上、
   版權在右下），做成實心按鈕才不會被底下的圖磚吃掉，也把原本墊在地圖下方的一整列高度
   還給地圖本身。外圈的白色 ring 是為了在深色圖磚上仍然看得見邊界。 */
.map-expand-trigger {
  position: absolute;
  top: 24px;
  right: 24px;
  z-index: 5;
  min-height: 44px;
  padding: 10px 18px;
  font-size: .88rem;
  box-shadow: 0 12px 26px rgb(74 45 55 / 30%), 0 0 0 4px rgb(255 255 255 / 78%);
}
.map-expand-trigger span { font-size: 1rem; }
</style>
