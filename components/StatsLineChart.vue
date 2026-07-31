<script setup lang="ts">
interface LineSeries {
  key: string
  label: string
  color: string
  // 每一條線各自的單位（旅箋是「則」、會員是「人」），不能共用同一個字串——
  // 兩者硬套同一個單位，字面上兜不攏，SR 使用者逐格聽出來的內容也會是錯的。
  unit: string
  values: number[]
}

const props = defineProps<{
  title: string
  summary: string
  categories: string[]
  series: LineSeries[]
}>()

const width = 640
const height = 240
const paddingLeft = 34
const paddingRight = 12
const paddingTop = 16
const paddingBottom = 26
const plotWidth = width - paddingLeft - paddingRight
const plotHeight = height - paddingTop - paddingBottom

// 所有數列共用同一個 y 軸刻度，最大值取全部數列中的最大值；資料全是 0 時仍取 1，
// 避免除以 0 讓每個點都變成 NaN、整條折線直接消失不畫。
const maxValue = computed(() => Math.max(1, ...props.series.flatMap(line => line.values)))
const stepX = computed(() => plotWidth / Math.max(1, props.categories.length - 1))

function xAt(index: number) {
  return paddingLeft + index * stepX.value
}

function yAt(value: number) {
  return paddingTop + plotHeight - (value / maxValue.value) * plotHeight
}

function pathFor(values: number[]) {
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${xAt(index).toFixed(1)} ${yAt(value).toFixed(1)}`).join(' ')
}

// 類別一多（例如每日 30 個點）每個點都掛 x 軸文字會擠成一團，所以只挑頭尾與中間
// 幾個點顯示文字，折線本身仍然完整描出全部的點，只是刻度文字變稀疏。
const labelIndexes = computed(() => {
  const total = props.categories.length
  if (total <= 7) return props.categories.map((_, index) => index)
  const step = Math.ceil(total / 6)
  const indexes = new Set<number>()
  for (let index = 0; index < total; index += step) indexes.add(index)
  indexes.add(total - 1)
  return [...indexes].sort((a, b) => a - b)
})

const yTicks = computed(() => {
  const max = maxValue.value
  return [0, Math.round(max / 2), max]
})
</script>

<template>
  <figure class="stats-chart">
    <figcaption><span class="eyebrow">TREND</span><h3>{{ props.title }}</h3></figcaption>
    <div class="chart-visual" role="img" :aria-label="props.summary">
      <svg :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <line
          v-for="tick in yTicks" :key="`grid-${tick}`" class="grid-line"
          :x1="paddingLeft" :x2="width - paddingRight" :y1="yAt(tick)" :y2="yAt(tick)"
        />
        <text v-for="tick in yTicks" :key="`tick-${tick}`" class="axis-label" :x="paddingLeft - 6" :y="yAt(tick)" text-anchor="end" dominant-baseline="middle">{{ tick }}</text>
        <text v-for="index in labelIndexes" :key="`x-${index}`" class="axis-label" :x="xAt(index)" :y="height - 6" text-anchor="middle">{{ props.categories[index] }}</text>
        <path v-for="line in props.series" :key="line.key" class="series-line" :d="pathFor(line.values)" fill="none" :stroke="line.color" />
        <g v-for="line in props.series" :key="`${line.key}-dots`">
          <circle v-for="(value, index) in line.values" :key="index" class="series-dot" :cx="xAt(index)" :cy="yAt(value)" :fill="line.color" />
        </g>
      </svg>
    </div>
    <ul class="chart-legend">
      <li v-for="line in props.series" :key="line.key"><i :style="{ background: line.color }" />{{ line.label }}</li>
    </ul>
    <!-- .sr-only 靠 width:1px 隱藏內容，但 <table> 在預設 table-layout:auto 下，
         規格規定「已使用寬度」不得小於內容算出來的最小寬度，width:1px 對表格本身不生效，
         整張表會被撐回可讀寬度、把頁面推寬。包一層 div 頂住 width:1px + overflow:hidden，
         表格愛長多寬都會被外層裁掉，不會外洩成版面的水平捲動。 -->
    <div class="sr-only">
      <table>
        <caption>{{ props.title }}，{{ props.summary }}</caption>
        <thead>
          <tr>
            <th scope="col">日期</th>
            <th v-for="line in props.series" :key="line.key" scope="col">{{ line.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(category, index) in props.categories" :key="category">
            <th scope="row">{{ category }}</th>
            <td v-for="line in props.series" :key="line.key">{{ line.values[index] }} {{ line.unit }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </figure>
</template>

<style scoped>
.stats-chart { min-width: 0; }
.stats-chart figcaption { margin-bottom: 14px; }
.stats-chart figcaption h3 { margin: 2px 0 0; font: 700 1.1rem 'Zen Maru Gothic', sans-serif; }
.chart-visual { width: 100%; }
.chart-visual svg { display: block; width: 100%; height: auto; }
.grid-line { stroke: var(--line); stroke-width: 1; }
.axis-label { fill: var(--muted); font-family: 'Noto Sans TC', sans-serif; font-size: 10px; }
.series-line { stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
.series-dot { r: 3; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 12px 0 0; padding: 0; list-style: none; }
.chart-legend li { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: .76rem; }
.chart-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
</style>
