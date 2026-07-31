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

const props = withDefaults(defineProps<{
  checkins: Checkin[]
  selectedId?: number | null
  region?: RegionView
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
  })
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

onMounted(async () => {
  if (!mapElement.value) return
  leaflet = await import('leaflet')
  await import('leaflet/dist/leaflet.css')
  if (!mapElement.value) return

  map.value = leaflet.map(mapElement.value, {
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
  resizeObserver.observe(mapElement.value)
})

watch(() => props.checkins, syncMarkers, { deep: true })
watch(() => props.selectedId, () => {
  syncMarkers()
  if (props.selectedId) markers.get(props.selectedId)?.openTooltip()
})
watch(() => props.region, applyRegion, { deep: true })

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  map.value?.remove()
  map.value = null
  markers.clear()
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
