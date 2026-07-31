<script setup lang="ts">
import type { Map as LeafletMap, Marker } from 'leaflet'
import type { Checkin } from '~/composables/useCheckins'

interface RegionView {
  id: string
  label: string
  center: [number, number]
  zoom: number
  minZoom?: number
  maxZoom?: number
  bounds?: [[number, number], [number, number]]
}

// 讓外部（例如全螢幕探索頁的側欄）指定地圖要飛過去的座標。用一般物件而不是 [lat, lng] 陣列，
// 是因為每次點擊都會指派「一個新物件」，watcher 靠參照變化就知道要重新 flyTo —— 就算兩次
// 點的是同一筆旅箋、座標完全相同，也還是會觸發飛行動畫，不必額外設計 id/nonce 欄位。
interface FocusTarget {
  lat: number
  lng: number
  zoom?: number
}

const props = withDefaults(defineProps<{
  checkins: Checkin[]
  selectedId?: number | null
  region?: RegionView
  focusTarget?: FocusTarget | null
}>(), {
  selectedId: null,
  region: () => ({
    id: 'taiwan',
    label: '臺灣',
    center: [23.72, 121.0],
    zoom: 7,
    minZoom: 6,
    maxZoom: 18,
    bounds: [[20.4, 117.7], [26.9, 123.8]]
  }),
  focusTarget: null
})

const emit = defineEmits<{ select: [checkin: Checkin] }>()
const mapElement = ref<HTMLElement | null>(null)
const map = shallowRef<LeafletMap | null>(null)
const markers = new Map<number, Marker>()
let leaflet: typeof import('leaflet') | null = null
let resizeObserver: ResizeObserver | null = null

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
}[character] || character))

function markerHtml(checkin: Checkin, selected: boolean) {
  const image = checkin.avatar
    ? `<img src="${escapeHtml(checkin.avatar)}" alt="" />`
    : `<span>${escapeHtml(checkin.nickname.slice(0, 1))}</span>`
  return `<span class="osm-marker-avatar${selected ? ' is-selected' : ''}">${image}</span><i></i>`
}

function syncMarkers() {
  if (!map.value || !leaflet) return
  const ids = new Set(props.checkins.map(checkin => checkin.id))

  for (const [id, marker] of markers) {
    if (!ids.has(id)) {
      marker.remove()
      markers.delete(id)
    }
  }

  for (const checkin of props.checkins) {
    const icon = leaflet.divIcon({
      className: 'osm-marker-shell',
      html: markerHtml(checkin, props.selectedId === checkin.id),
      iconSize: [48, 58],
      iconAnchor: [24, 55],
      popupAnchor: [0, -52]
    })
    const existing = markers.get(checkin.id)
    if (existing) {
      existing.setLatLng([checkin.latitude, checkin.longitude]).setIcon(icon)
    } else {
      const marker = leaflet.marker([checkin.latitude, checkin.longitude], {
        icon, keyboard: true, title: `${checkin.dollName}在${checkin.location}的旅箋`, alt: `查看${checkin.location}的故事`
      })
        .addTo(map.value)
        .bindTooltip(`${escapeHtml(checkin.dollName)} · ${escapeHtml(checkin.location)}`, {
          direction: 'top', offset: [0, -48], opacity: 0.94
        })
        .on('click', () => emit('select', checkin))
      markers.set(checkin.id, marker)
    }
  }
}

function applyRegion() {
  if (!map.value) return
  map.value.setMinZoom(props.region.minZoom ?? 2)
  map.value.setMaxZoom(props.region.maxZoom ?? 19)
  map.value.setMaxBounds(props.region.bounds)
  map.value.setView(props.region.center, props.region.zoom)
}

/**
 * 初始化綁在 template ref 的 watcher 而不是 onMounted。
 *
 * 這個元件同時被 .client 檔名後綴與外層的 <ClientOnly> 包了兩層 client-only
 * （檔名已改回 RegionMap.vue，只留 <ClientOnly> 這一種機制）。兩層疊在一起時，
 * onMounted 有機會在 mapElement 還沒指到實際 DOM 節點時就跑完，而原本的寫法是
 * `if (!mapElement.value) return` —— 一旦提早 return 就再也不會重試，地圖從此
 * 是死的。實測就是這個症狀：首次載入完全沒有 leaflet 請求，但 SPA 導覽離開再
 * 回來就正常，因為那時 ref 已經就緒。
 *
 * 改成 watcher（flush: 'post' 確保 DOM 已更新、immediate 處理 ref 早就備妥的
 * 情況）之後，不管是哪種掛載時序都會在元素真的出現時初始化。
 */
async function initMap(element: HTMLElement) {
  if (map.value) return
  leaflet = await import('leaflet')
  await import('leaflet/dist/leaflet.css')
  // 等待動態 import 的期間元件可能已被卸載，或元素已被換掉
  if (map.value || mapElement.value !== element) return

  map.value = leaflet.map(element, {
    center: props.region.center,
    zoom: props.region.zoom,
    minZoom: props.region.minZoom ?? 2,
    maxZoom: props.region.maxZoom ?? 19,
    maxBounds: props.region.bounds,
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true
  })

  leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
  }).addTo(map.value)

  syncMarkers()
  requestAnimationFrame(() => map.value?.invalidateSize())
  resizeObserver = new ResizeObserver(() => map.value?.invalidateSize({ pan: false }))
  resizeObserver.observe(element)
}

watch(mapElement, (element) => {
  if (element) initMap(element)
}, { immediate: true, flush: 'post' })

watch(() => props.checkins, syncMarkers, { deep: true })
watch(() => props.selectedId, () => {
  syncMarkers()
  if (props.selectedId) markers.get(props.selectedId)?.openTooltip()
})
watch(() => props.region, applyRegion, { deep: true })
watch(() => props.focusTarget, (target) => {
  if (!target || !map.value) return
  map.value.flyTo([target.lat, target.lng], target.zoom ?? map.value.getZoom(), { duration: 0.85 })
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  map.value?.remove()
  map.value = null
  markers.clear()
})

/**
 * 讓外部（全螢幕探索頁收合／展開側欄時）可以明確要求重新量測地圖容器尺寸。
 * 元件內部的 ResizeObserver 理論上已經會在容器尺寸改變時自動呼叫 invalidateSize，
 * 這裡多開放一個方法純粹是保險，不影響現有任何呼叫方式（首頁完全不需要用到它）。
 */
defineExpose({
  invalidateSize: () => map.value?.invalidateSize()
})
</script>

<template>
  <div class="region-map-shell">
    <div ref="mapElement" class="region-map" role="region" :aria-label="`${region.label} OpenStreetMap 旅箋地圖`" />
    <div v-if="!checkins.length" class="map-empty-overlay">
      <strong>這個範圍還沒有旅箋</strong>
      <span>寫下第一則旅箋，讓小小旅伴出現在地圖上。</span>
    </div>
  </div>
</template>
