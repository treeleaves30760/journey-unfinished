<script setup lang="ts">
import type { Checkin } from '~/composables/useCheckins'

const { data, status, error, refresh } = await useFetch<{ checkins: Checkin[] }>('/api/checkins')
const selected = ref<Checkin | null>(null)
const county = ref('全部地區')
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
const filtered = computed(() => {
  const list = county.value === '全部地區' ? [...checkins.value] : checkins.value.filter(item => item.county === county.value)
  return list.sort((a, b) => sort.value === 'new' ? b.visitedAt.localeCompare(a.visitedAt) : a.visitedAt.localeCompare(b.visitedAt))
})
const availableCounties = computed(() => [...new Set(checkins.value.map(item => item.county))])
const totalComments = computed(() => checkins.value.reduce((sum, item) => sum + item.commentCount, 0))
const createTarget = computed(() => user.value ? '/checkins/new' : '/login?redirect=/checkins/new')
const panelLabels = ['旅箋首頁', '探索地圖', '沿途新頁', '寫下旅箋']

function selectCheckin(checkin: Checkin) {
  selected.value = checkin
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
            <label><span>旅行日期</span><select v-model="sort"><option value="new">新到舊</option><option value="old">舊到新</option></select></label>
            <button v-if="county !== '全部地區'" type="button" class="clear-filter" @click="county = '全部地區'">清除篩選</button>
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
                <p v-if="!filtered.length" class="map-side-empty">這個地區還沒有旅箋，換個地區看看吧。</p>
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
        <p class="result-count">{{ county === '全部地區' ? '全部地區' : county }} · {{ filtered.length }} 則旅箋</p>
      </div>
      <div v-if="filtered.length" class="card-grid panel-enter from-bottom"><CheckinCard v-for="item in filtered" :key="item.id" :checkin="item" /></div>
      <div v-else class="state-panel empty-state"><strong>這個地區還沒有旅箋</strong><p>換個地區看看，或寫下你們共同抵達的第一站。</p></div>
      </div>
    </section>

    <section ref="ctaPanel" class="home-panel cta-panel" :class="{ 'is-active': activePanel === 3 }" data-panel="3">
      <div class="cta-section">
        <div class="cta-doodle left panel-enter from-left" aria-hidden="true">✿</div>
        <div class="cta-copy panel-enter from-bottom"><span class="eyebrow">YOUR NEXT PAGE</span><h2>下一頁，與你一起寫</h2><p>帶上心愛的小小旅伴，去往下一站，把共同看過的風景留在這裡。</p><NuxtLink class="primary-button light" :to="createTarget">{{ user ? '＋ 寫下這一站' : '使用 Discord 登入' }}</NuxtLink></div>
        <div class="cta-doodle right panel-enter from-right" aria-hidden="true">✦</div>
      </div>
      <footer class="home-panel-footer"><strong>未完旅箋</strong><span>小小的你，世界很大。</span><small>本站示意內容與頭像皆為原創。</small></footer>
    </section>

    <nav class="page-dots" aria-label="首頁分頁導覽">
      <button v-for="(label, index) in panelLabels" :key="label" type="button" :class="{ active: activePanel === index }" :aria-label="`前往${label}`" :aria-current="activePanel === index ? 'page' : undefined" @click="scrollToPanel(index)"><span>{{ String(index + 1).padStart(2, '0') }}</span><i /></button>
    </nav>
  </main>
</template>
