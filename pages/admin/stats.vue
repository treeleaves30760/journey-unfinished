<script setup lang="ts">
interface DailyPoint { date: string, newCheckins: number, newUsers: number }
interface WeeklyPoint { weekStart: string, newCheckins: number, newUsers: number }

interface RecentCheckin {
  id: number
  location: string
  nickname: string
  county: string
  dollName: string
  avatar: string | null
  avatarPreset: string
  visitedAt: string
  createdAt: string
}

interface RecentComment {
  id: number
  checkinId: number
  checkinLocation: string
  nickname: string
  message: string
  createdAt: string
}

interface AdminStatsResponse {
  totals: { checkins: number, checkinsWithPhoto: number, users: number, comments: number }
  timeSeries: { daily: DailyPoint[], weekly: WeeklyPoint[] }
  countyDistribution: Array<{ county: string, count: number }>
  topAuthors: Array<{ userId: number, displayName: string, avatarUrl: string | null, checkinCount: number }>
  recentActivity: { checkins: RecentCheckin[], comments: RecentComment[] }
}

definePageMeta({ middleware: 'admin' })
const { data, status, error, refresh } = await useFetch<AdminStatsResponse>('/api/admin/stats')

const trendMode = ref<'daily' | 'weekly'>('daily')

// 折線圖拿到的日期字串已經是 server 端換算好的台北時間日曆日期，這裡純粹是顯示格式化，
// 固定用 timeZone: 'UTC' 讀出年月日——若省略，Intl 會改用瀏覽器所在時區再位移一次，
// 對台灣以外時區的訪客（例如 UTC-5）就可能把日期顯示錯一天。
function shortDate(value: string) {
  return new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
}

const trendPoints = computed<Array<DailyPoint | WeeklyPoint>>(() => {
  if (!data.value) return []
  return trendMode.value === 'daily' ? data.value.timeSeries.daily : data.value.timeSeries.weekly
})

const trendCategories = computed(() => {
  if (!data.value) return []
  return trendMode.value === 'daily'
    ? data.value.timeSeries.daily.map(point => shortDate(point.date))
    : data.value.timeSeries.weekly.map(point => shortDate(point.weekStart))
})

const trendSeries = computed(() => [
  { key: 'checkins', label: '新增旅箋', color: 'var(--rose-dark)', unit: '則', values: trendPoints.value.map(point => point.newCheckins) },
  { key: 'users', label: '新增會員', color: 'var(--forest)', unit: '人', values: trendPoints.value.map(point => point.newUsers) }
])

const trendSummary = computed(() => {
  const points = trendPoints.value
  const totalCheckins = points.reduce((sum, point) => sum + point.newCheckins, 0)
  const totalUsers = points.reduce((sum, point) => sum + point.newUsers, 0)
  const span = trendMode.value === 'daily' ? `近 ${points.length} 天` : `近 ${points.length} 週`
  return `折線圖顯示${span}每日新增旅箋與新會員的數量，${span}總計新增 ${totalCheckins} 則旅箋、${totalUsers} 位新會員。`
})

const countyItems = computed(() => data.value?.countyDistribution.map(row => ({ label: row.county, value: row.count })) ?? [])
const countySummary = computed(() => {
  const items = countyItems.value
  if (!items.length) return '長條圖目前沒有任何旅箋資料可以顯示。'
  const top = items[0]!
  return `長條圖顯示各縣市的旅箋數量，共 ${items.length} 個縣市留下足跡，最多的是${top.label}，有 ${top.value} 則。`
})

const authorItems = computed(() => data.value?.topAuthors.map(row => ({ id: row.userId, label: row.displayName, value: row.checkinCount })) ?? [])
const authorSummary = computed(() => {
  const items = authorItems.value
  if (!items.length) return '目前還沒有會員留下旅箋，排行榜是空的。'
  const top = items[0]!
  return `依旅箋數排序的作者排行榜，共 ${items.length} 位上榜，寫最多的是${top.label}，共 ${top.value} 則。`
})

useHead({ title: '統計數據｜未完旅箋管理中心' })
</script>

<template>
  <main id="main-content" class="admin-page">
    <NuxtLink class="back-link" to="/admin">← 回到管理中心</NuxtLink>
    <div class="admin-heading">
      <div><span class="eyebrow">ADMIN CONSOLE</span><h1>統計數據</h1><p>掌握旅箋、會員與留言的成長趨勢，一眼看懂目前站況。</p></div>
    </div>

    <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在載入統計資料…</div>
    <div v-else-if="error" class="state-panel error-state" role="alert"><strong>統計資料讀取失敗</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button></div>
    <template v-else-if="data">
      <section class="admin-stats stats-summary" aria-label="網站總量統計">
        <article><span>旅箋數</span><strong>{{ data.totals.checkins }}</strong></article>
        <article><span>會員數</span><strong>{{ data.totals.users }}</strong></article>
        <article><span>留言數</span><strong>{{ data.totals.comments }}</strong></article>
        <article><span>有照片的旅箋</span><strong>{{ data.totals.checkinsWithPhoto }}</strong></article>
      </section>

      <section class="admin-section">
        <div class="admin-section-heading">
          <div><span class="eyebrow">GROWTH</span><h2>成長趨勢</h2></div>
          <div class="trend-toggle" role="group" aria-label="切換折線圖區間">
            <button type="button" class="secondary-button compact" :class="{ active: trendMode === 'daily' }" :aria-pressed="trendMode === 'daily'" @click="trendMode = 'daily'">每日</button>
            <button type="button" class="secondary-button compact" :class="{ active: trendMode === 'weekly' }" :aria-pressed="trendMode === 'weekly'" @click="trendMode = 'weekly'">每週</button>
          </div>
        </div>
        <StatsLineChart
          :title="trendMode === 'daily' ? '近 30 天每日新增' : '近 12 週每週新增'"
          :summary="trendSummary"
          :categories="trendCategories"
          :series="trendSeries"
        />
      </section>

      <div class="stats-grid-2">
        <section class="admin-section">
          <div class="admin-section-heading"><div><span class="eyebrow">COUNTIES</span><h2>縣市分布</h2></div><span>{{ data.countyDistribution.length }} 個縣市</span></div>
          <StatsBarChart title="各縣市旅箋數" :summary="countySummary" :items="countyItems" color="var(--rose)" unit="則" />
        </section>
        <section class="admin-section">
          <div class="admin-section-heading"><div><span class="eyebrow">AUTHORS</span><h2>最活躍作者</h2></div><span>前 {{ data.topAuthors.length }} 名</span></div>
          <StatsRankingChart title="旅箋數排行" :description="authorSummary" :items="authorItems" color="var(--gold)" unit="則" />
        </section>
      </div>

      <div class="stats-grid-2">
        <section class="admin-section">
          <div class="admin-section-heading"><div><span class="eyebrow">JOURNEY NOTES</span><h2>最新旅箋</h2></div><span>{{ data.recentActivity.checkins.length }} 則</span></div>
          <div v-if="data.recentActivity.checkins.length" class="admin-checkins">
            <article v-for="item in data.recentActivity.checkins" :key="item.id">
              <DollAvatar :src="item.avatar" :preset="item.avatarPreset" alt="" size="small" />
              <div><strong>{{ item.location }}</strong><span>{{ item.nickname }} 與 {{ item.dollName }} · {{ formatDate(item.visitedAt) }}</span></div>
              <NuxtLink class="recent-checkin-link" :to="`/checkins/${item.id}`">查看</NuxtLink>
            </article>
          </div>
          <p v-else class="chart-empty">目前還沒有旅箋。</p>
        </section>
        <section class="admin-section">
          <div class="admin-section-heading"><div><span class="eyebrow">COMMENTS</span><h2>最新留言</h2></div><span>{{ data.recentActivity.comments.length }} 則</span></div>
          <div v-if="data.recentActivity.comments.length" class="comment-list">
            <article v-for="(item, index) in data.recentActivity.comments" :key="item.id">
              <span class="comment-avatar" :class="`tone-${index % 4}`">{{ item.nickname.slice(0, 1) }}</span>
              <div>
                <header><strong>{{ item.nickname }}</strong><time :datetime="item.createdAt">{{ formatCommentDate(item.createdAt) }}</time></header>
                <p>{{ item.message }}</p>
                <NuxtLink class="comment-context" :to="`/checkins/${item.checkinId}`">於「{{ item.checkinLocation }}」</NuxtLink>
              </div>
            </article>
          </div>
          <p v-else class="chart-empty">目前還沒有留言。</p>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
/* .admin-stats 原本是給 3 張卡片設計的 3 欄格線，這裡多一張「有照片的旅箋」變成 4 張，
   沿用同一個 class 拿卡片本身的外觀（邊框、陰影、字級），格線欄數用這個更精確的
   選擇器覆寫——屬性選擇器讓它的權重蓋過 main.css 裡（含 max-width media query 內）
   同樣只有單一 class 的規則，所以下面兩個斷點務必自己補齊，否則窄螢幕會被沿用成 4 欄。 */
.stats-summary { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 900px) { .stats-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } }
@media (max-width: 560px) { .stats-summary { grid-template-columns: 1fr; } }

.trend-toggle { display: flex; flex: 0 0 auto; gap: 8px; }
.trend-toggle .active { color: white; border-color: var(--rose-dark); background: var(--rose-dark); }

.stats-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin-top: 22px; }
@media (max-width: 900px) { .stats-grid-2 { grid-template-columns: 1fr; gap: 16px; } }

.chart-empty { margin: 0; padding: 30px 0; color: var(--muted); font-size: .84rem; text-align: center; }
.comment-context { display: inline-block; margin-top: 6px; color: var(--rose-dark); font-size: .72rem; font-weight: 700; text-decoration: none; }
.comment-context:hover { text-decoration: underline; }

/* main.css 在 ≤720px 會把 .admin-checkins .text-link 整個藏起來——那是給「查看＋刪除」
   雙按鈕版面設計的，行動裝置上讓使用者優先看到刪除鍵。這個唯讀列表只有「查看」一個
   動作，藏起來就等於整列在小螢幕上完全點不進去，所以刻意不用 .text-link，改用自己的
   class 保留視覺一致但不繼承那條隱藏規則。 */
.recent-checkin-link { display: inline-flex; flex: 0 0 auto; min-height: 42px; align-items: center; padding: 7px 2px; color: var(--rose-dark); text-decoration: none; font-size: .82rem; font-weight: 800; }
.recent-checkin-link:hover { text-decoration: underline; }
</style>
