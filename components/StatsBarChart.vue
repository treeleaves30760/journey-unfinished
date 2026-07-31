<script setup lang="ts">
interface BarItem {
  label: string
  value: number
}

const props = defineProps<{
  title: string
  summary: string
  items: BarItem[]
  color: string
  unit: string
}>()

const width = 560
const rowHeight = 26
const barHeight = 14
const paddingTop = 8
const paddingBottom = 8
const paddingLeft = 8
const paddingRight = 8
const labelWidth = 64
const valueWidth = 56
const barAreaWidth = width - paddingLeft - labelWidth - valueWidth - paddingRight
const barStartX = paddingLeft + labelWidth

const height = computed(() => Math.max(rowHeight, props.items.length * rowHeight) + paddingTop + paddingBottom)
// 全部項目都是 0（理論上不會發生，GROUP BY 只回傳至少 1 筆的縣市）仍取 1 當分母，避免除以 0。
const maxValue = computed(() => Math.max(1, ...props.items.map(item => item.value)))

function rowY(index: number) {
  return paddingTop + index * rowHeight
}

function barWidth(value: number) {
  return (value / maxValue.value) * barAreaWidth
}
</script>

<template>
  <figure class="stats-chart">
    <figcaption><span class="eyebrow">DISTRIBUTION</span><h3>{{ props.title }}</h3></figcaption>
    <template v-if="props.items.length">
      <div class="chart-visual" role="img" :aria-label="props.summary">
        <svg :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <g v-for="(item, index) in props.items" :key="item.label">
            <text class="row-label" :x="barStartX - 8" :y="rowY(index) + rowHeight / 2" text-anchor="end" dominant-baseline="middle">{{ item.label }}</text>
            <rect class="row-track" :x="barStartX" :y="rowY(index) + (rowHeight - barHeight) / 2" :width="barAreaWidth" :height="barHeight" rx="4" />
            <rect
              class="row-bar" :x="barStartX" :y="rowY(index) + (rowHeight - barHeight) / 2"
              :width="Math.max(barWidth(item.value), item.value > 0 ? 3 : 0)" :height="barHeight" rx="4" :fill="props.color"
            />
            <text class="row-value" :x="width - paddingRight" :y="rowY(index) + rowHeight / 2" text-anchor="end" dominant-baseline="middle">{{ item.value }}</text>
          </g>
        </svg>
      </div>
      <!-- .sr-only 靠 width:1px 隱藏內容，但 <table> 在預設 table-layout:auto 下規格規定
           「已使用寬度」不得小於內容算出來的最小寬度，width:1px 對表格本身不生效，整張表
           會被撐回可讀寬度、把頁面推寬。包一層 div 頂住 width:1px + overflow:hidden，
           表格愛長多寬都會被外層裁掉，不會外洩成版面的水平捲動。 -->
      <div class="sr-only">
        <table>
          <caption>{{ props.title }}，{{ props.summary }}</caption>
          <thead><tr><th scope="col">縣市</th><th scope="col">數量</th></tr></thead>
          <tbody>
            <tr v-for="item in props.items" :key="item.label">
              <th scope="row">{{ item.label }}</th>
              <td>{{ item.value }} {{ props.unit }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else class="chart-empty">目前還沒有旅箋資料。</p>
  </figure>
</template>

<style scoped>
.stats-chart { min-width: 0; }
.stats-chart figcaption { margin-bottom: 14px; }
.stats-chart figcaption h3 { margin: 2px 0 0; font: 700 1.1rem 'Zen Maru Gothic', sans-serif; }
.chart-visual { width: 100%; }
.chart-visual svg { display: block; width: 100%; height: auto; }
.row-label { fill: var(--muted); font-family: 'Noto Sans TC', sans-serif; font-size: 11px; }
.row-value { fill: var(--ink); font-family: 'Noto Sans TC', sans-serif; font-size: 11px; font-weight: 700; }
.row-track { fill: var(--paper-deep); }
.chart-empty { margin: 0; padding: 30px 0; color: var(--muted); font-size: .84rem; text-align: center; }
</style>
