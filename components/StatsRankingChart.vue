<script setup lang="ts">
interface RankingItem {
  id: number | string
  label: string
  value: number
}

const props = defineProps<{
  title: string
  description: string
  items: RankingItem[]
  color: string
  unit: string
}>()

// 全部項目都是 0 時仍取 1 當分母，避免除以 0；每一列另外保留最小可視寬度，
// 讓數值很小但確實 > 0 的作者也看得到一小截色塊，而不是被四捨五入成 0 寬度消失。
const maxValue = computed(() => Math.max(1, ...props.items.map(item => item.value)))

function barWidth(value: number) {
  if (value <= 0) return 0
  return Math.max(4, (value / maxValue.value) * 100)
}
</script>

<template>
  <figure class="stats-chart">
    <figcaption><span class="eyebrow">RANKING</span><h3>{{ props.title }}</h3></figcaption>
    <template v-if="props.items.length">
      <!-- 排行榜本身就是可讀文字（名次、名稱、次數），螢幕閱讀器可以直接逐項讀出，
           不需要像折線／長條圖那樣另外準備一份隱藏表格；這段引言只補充圖表的整體脈絡。 -->
      <p class="sr-only">{{ props.description }}</p>
      <ol class="ranking-list" :aria-label="props.title">
        <li v-for="(item, index) in props.items" :key="item.id">
          <span class="rank" :class="{ top: index < 3 }">{{ index + 1 }}</span>
          <span class="rank-name">{{ item.label }}</span>
          <svg class="rank-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
            <rect class="rank-track" x="0" y="0" width="100" height="10" rx="3" />
            <rect x="0" y="0" :width="barWidth(item.value)" height="10" rx="3" :fill="props.color" />
          </svg>
          <span class="rank-value">{{ item.value }} {{ props.unit }}</span>
        </li>
      </ol>
    </template>
    <p v-else class="chart-empty">目前還沒有作者資料。</p>
  </figure>
</template>

<style scoped>
.stats-chart { min-width: 0; }
.stats-chart figcaption { margin-bottom: 14px; }
.stats-chart figcaption h3 { margin: 2px 0 0; font: 700 1.1rem 'Zen Maru Gothic', sans-serif; }
.ranking-list { display: grid; gap: 11px; margin: 0; padding: 0; list-style: none; }
.ranking-list li { display: grid; grid-template-columns: 24px minmax(0, 1fr) minmax(48px, 84px) 56px; align-items: center; gap: 9px; }
.rank { display: grid; width: 24px; height: 24px; place-items: center; color: var(--muted); border-radius: 50%; background: var(--paper-deep); font-size: .68rem; font-weight: 800; }
.rank.top { color: white; background: var(--gold); }
.rank-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .82rem; font-weight: 700; }
.rank-bar { display: block; width: 100%; height: 10px; }
.rank-track { fill: var(--paper-deep); }
.rank-value { flex: 0 0 auto; color: var(--muted); font-size: .72rem; text-align: right; font-variant-numeric: tabular-nums; }
.chart-empty { margin: 0; padding: 30px 0; color: var(--muted); font-size: .84rem; text-align: center; }
</style>
