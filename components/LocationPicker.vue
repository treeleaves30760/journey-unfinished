<script setup lang="ts">
import type { Map as LeafletMap, Marker } from 'leaflet'

export interface PlaceValue {
  location: string
  countryCode: string
  county: string
  latitude: number | null
  longitude: number | null
}

interface GeoPlace {
  id: string
  name: string
  label: string
  latitude: number
  longitude: number
  countryCode: string | null
  county: string | null
}

const props = defineProps<{ modelValue: PlaceValue }>()
const emit = defineEmits<{ 'update:modelValue': [value: PlaceValue] }>()

const mapElement = ref<HTMLElement | null>(null)
const map = shallowRef<LeafletMap | null>(null)
const marker = shallowRef<Marker | null>(null)
let leaflet: typeof import('leaflet') | null = null
let resizeObserver: ResizeObserver | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null
let reverseToken = 0

const query = ref('')
const results = ref<GeoPlace[]>([])
const searching = ref(false)
const searchError = ref('')
const searchNotice = ref('')
const locating = ref(false)
const showManual = ref(false)
const resolving = ref(false)

const hasPoint = computed(() => props.modelValue.latitude !== null && props.modelValue.longitude !== null)

function patch(changes: Partial<PlaceValue>) {
  emit('update:modelValue', { ...props.modelValue, ...changes })
}

// 座標統一取到小數第六位（約 0.1 公尺）：再多的位數對旅遊紀錄沒有意義，
// 只會讓「同一個地點」因為浮點尾數不同而看起來不一樣。
const round = (value: number) => Number(value.toFixed(6))

async function runSearch() {
  const keyword = query.value.trim()
  searchError.value = ''
  searchNotice.value = ''
  if (keyword.length < 2) {
    results.value = []
    return
  }
  searching.value = true
  try {
    const response = await $fetch<{ places: GeoPlace[] }>('/api/geo/search', { query: { q: keyword } })
    results.value = response.places
    if (!response.places.length) searchNotice.value = '找不到符合的地點，換個關鍵字，或直接在地圖上點選。'
  } catch (error) {
    results.value = []
    searchError.value = errorMessage(error, '地點搜尋暫時無法使用，請直接在地圖上點選位置。')
  } finally {
    searching.value = false
  }
}

// 打字時自動搜尋，但一律等使用者停下來。上游 Nominatim 的使用條款是「每秒最多一次」，
// 逐字送出既違規也沒必要——輸入法打中文時每個注音鍵都會觸發一次 input 事件。
function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 700)
}

function submitSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  runSearch()
}

/**
 * 反查地址：使用者在地圖上點一個點之後，自動補上國家與行政區。
 * token 用來丟棄過期的回應——連點三個地方時，先發出的請求可能後到，
 * 沒有這道檢查就會用第一個點的國家覆蓋掉第三個點。
 */
async function resolveAddress(latitude: number, longitude: number, fillLocation: boolean) {
  const token = ++reverseToken
  resolving.value = true
  try {
    const { place } = await $fetch<{ place: GeoPlace | null }>('/api/geo/reverse', {
      query: { lat: latitude, lon: longitude }
    })
    if (token !== reverseToken || !place) return
    patch({
      countryCode: place.countryCode || props.modelValue.countryCode,
      county: place.county || props.modelValue.county,
      // 地點名稱只在使用者還沒填的時候自動帶入：他寫的「和旅伴的祕密基地」
      // 比反查回來的門牌號碼有意義得多，不能被覆蓋。
      location: fillLocation && !props.modelValue.location.trim() ? place.name : props.modelValue.location
    })
  } catch {
    // 反查失敗不是錯誤狀態：座標已經標好了，國家與地區讓使用者自己選就好
    if (token === reverseToken) searchNotice.value = '已標好座標，但自動辨識地區失敗，請確認下方的國家與地區。'
  } finally {
    if (token === reverseToken) resolving.value = false
  }
}

function moveMarker(latitude: number, longitude: number, zoom?: number) {
  if (!map.value || !leaflet) return
  const position: [number, number] = [latitude, longitude]
  if (marker.value) {
    marker.value.setLatLng(position)
  } else {
    marker.value = leaflet.marker(position, {
      draggable: true,
      keyboard: true,
      title: '拖曳可微調位置',
      icon: leaflet.divIcon({
        className: 'picker-marker-shell',
        html: '<span class="picker-marker"></span>',
        iconSize: [30, 40],
        iconAnchor: [15, 38]
      })
    }).addTo(map.value)
    marker.value.on('dragend', () => {
      const { lat, lng } = marker.value!.getLatLng()
      patch({ latitude: round(lat), longitude: round(lng) })
      resolveAddress(lat, lng, false)
    })
  }
  map.value.flyTo(position, zoom ?? Math.max(map.value.getZoom(), 14), { duration: 0.6 })
}

function choosePlace(place: GeoPlace) {
  patch({
    latitude: round(place.latitude),
    longitude: round(place.longitude),
    location: place.name.slice(0, 80),
    countryCode: place.countryCode || props.modelValue.countryCode,
    county: place.county || props.modelValue.county
  })
  results.value = []
  query.value = ''
  searchNotice.value = ''
  moveMarker(place.latitude, place.longitude, 15)
}

function useCurrentLocation() {
  searchError.value = ''
  searchNotice.value = ''
  if (!navigator.geolocation) {
    searchNotice.value = '這個瀏覽器不支援定位，請搜尋地點或在地圖上點選。'
    return
  }
  locating.value = true
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    locating.value = false
    patch({ latitude: round(coords.latitude), longitude: round(coords.longitude) })
    moveMarker(coords.latitude, coords.longitude, 16)
    resolveAddress(coords.latitude, coords.longitude, true)
  }, () => {
    locating.value = false
    searchNotice.value = '無法取得定位權限，請改用搜尋或直接在地圖上點選。'
  }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 })
}

function applyManualCoordinate(field: 'latitude' | 'longitude', value: string) {
  const number = Number(value)
  if (value.trim() === '' || !Number.isFinite(number)) {
    patch({ [field]: null } as Partial<PlaceValue>)
    return
  }
  const limit = field === 'latitude' ? 90 : 180
  patch({ [field]: Math.min(Math.max(number, -limit), limit) } as Partial<PlaceValue>)
}

// 初始化時序與 RegionMap 相同（見該檔的長註解）：綁在 template ref 的 watcher，
// 而不是 onMounted，才不會在 ref 尚未指到 DOM 節點時提早 return 而永遠不重試。
async function initMap(element: HTMLElement) {
  if (map.value) return
  leaflet = await import('leaflet')
  await import('leaflet/dist/leaflet.css')
  if (map.value || mapElement.value !== element) return

  const start: [number, number] = hasPoint.value
    ? [props.modelValue.latitude!, props.modelValue.longitude!]
    : [23.72, 121.0]

  map.value = leaflet.map(element, {
    center: start,
    zoom: hasPoint.value ? 14 : 5,
    minZoom: 2,
    maxZoom: 19,
    zoomControl: true,
    // 全球地圖：拖過換日線時讓圖磚接上，而不是走到空白區域
    worldCopyJump: true
  })

  leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
  }).addTo(map.value)

  map.value.on('click', (event) => {
    const { lat, lng } = event.latlng
    patch({ latitude: round(lat), longitude: round(lng) })
    moveMarker(lat, lng)
    resolveAddress(lat, lng, true)
  })

  if (hasPoint.value) moveMarker(props.modelValue.latitude!, props.modelValue.longitude!, 14)
  requestAnimationFrame(() => map.value?.invalidateSize())
  resizeObserver = new ResizeObserver(() => map.value?.invalidateSize({ pan: false }))
  resizeObserver.observe(element)
}

watch(mapElement, (element) => {
  if (element) initMap(element)
}, { immediate: true, flush: 'post' })

// 外部（例如載入草稿）改動座標時，讓地圖上的圖釘跟上。
// as const 讓解構出來的是 [number | null, number | null] 而不是可能為 undefined 的元素。
watch(() => [props.modelValue.latitude, props.modelValue.longitude] as const, ([latitude, longitude]) => {
  if (latitude === null || longitude === null || !map.value) return
  const current = marker.value?.getLatLng()
  if (current && Math.abs(current.lat - latitude) < 1e-6 && Math.abs(current.lng - longitude) < 1e-6) return
  moveMarker(latitude, longitude)
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  map.value?.remove()
  map.value = null
  marker.value = null
})
</script>

<template>
  <div class="location-picker">
    <div class="picker-search">
      <label class="field search-field">
        <span>搜尋景點 <small>店名、地標或城市都可以</small></span>
        <input
          v-model="query"
          type="search"
          maxlength="80"
          enterkeyhint="search"
          placeholder="例如：東京晴空塔、Reynisfjara、九份老街"
          @input="scheduleSearch"
          @keydown.enter.prevent="submitSearch"
        >
      </label>
      <button type="button" class="secondary-button compact" :disabled="locating" @click="useCurrentLocation">
        {{ locating ? '定位中…' : '◎ 目前位置' }}
      </button>
    </div>

    <p v-if="searching" class="picker-status" role="status"><i class="loader small" />搜尋中…</p>
    <p v-else-if="searchError" class="picker-status is-error" role="alert">{{ searchError }}</p>
    <p v-else-if="searchNotice" class="picker-status" role="status">{{ searchNotice }}</p>

    <ul v-if="results.length" class="picker-results">
      <li v-for="place in results" :key="place.id">
        <button type="button" @click="choosePlace(place)">
          <strong>{{ place.name }}</strong>
          <small>{{ place.label }}</small>
        </button>
      </li>
    </ul>

    <div ref="mapElement" class="picker-map" role="application" aria-label="點選地圖標記旅行地點" />

    <div class="picker-footer">
      <p class="picker-hint">
        <span aria-hidden="true">⌖</span>
        <span v-if="hasPoint">
          已標記 {{ modelValue.latitude?.toFixed(5) }}, {{ modelValue.longitude?.toFixed(5) }}
          <template v-if="resolving">・辨識地區中…</template>
        </span>
        <span v-else>搜尋景點、按「目前位置」，或直接在地圖上點一下。</span>
      </p>
      <button type="button" class="text-link" :aria-expanded="showManual" @click="showManual = !showManual">
        {{ showManual ? '收起座標欄位' : '手動輸入座標' }}
      </button>
    </div>

    <div v-if="showManual" class="field-grid two picker-manual">
      <label class="field">
        <span>緯度</span>
        <input
          :value="modelValue.latitude ?? ''"
          type="number" inputmode="decimal" min="-90" max="90" step="0.000001" placeholder="-90 ～ 90"
          @input="applyManualCoordinate('latitude', ($event.target as HTMLInputElement).value)"
        >
      </label>
      <label class="field">
        <span>經度</span>
        <input
          :value="modelValue.longitude ?? ''"
          type="number" inputmode="decimal" min="-180" max="180" step="0.000001" placeholder="-180 ～ 180"
          @input="applyManualCoordinate('longitude', ($event.target as HTMLInputElement).value)"
        >
      </label>
    </div>
  </div>
</template>
