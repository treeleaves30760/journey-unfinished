import { createError } from 'h3'
import { isCountryCode } from '../../utils/countries'

export interface GeoPlace {
  id: string
  /** 景點本身的名字，例如「東京晴空塔」 */
  name: string
  /** 完整地址描述，用來讓使用者分辨同名景點 */
  label: string
  latitude: number
  longitude: number
  /** 無法對應到 ISO 3166-1 代碼時為 null，由使用者自己選區域 */
  countryCode: string | null
  /** 次級行政區（縣市／都道府縣／州），拿不到時為 null */
  county: string | null
}

/**
 * 支援兩種上游，因為它們解決的是不同的問題：
 *
 * - `nominatim`：公用的 nominatim.openstreetmap.org。零維運成本，但條款是
 *   「每秒最多一次請求」，多人同時搜尋一定會排隊。適合流量小的時候。
 * - `photon`：自架的 Photon（見 deploy/k3s/geocoder.yaml）。直接下載預建的全球索引，
 *   不需要像 Nominatim 那樣花好幾天匯入，而且沒有任何速率上限。
 *
 * 兩者的回應形狀差很多（Nominatim 是自訂 JSON、Photon 是 GeoJSON，連經緯度的順序都相反），
 * 所以各自有一份 parser，最後都收斂成同一個 GeoPlace 交給前端。
 */
export type GeocoderProvider = 'nominatim' | 'photon'

interface NominatimAddress {
  country_code?: string
  state?: string
  province?: string
  region?: string
  county?: string
  city?: string
  town?: string
  village?: string
  municipality?: string
  city_district?: string
  suburb?: string
}

interface NominatimPlace {
  place_id?: number | string
  osm_type?: string
  osm_id?: number | string
  lat?: string
  lon?: string
  name?: string
  display_name?: string
  address?: NominatimAddress
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] }
  properties?: {
    osm_type?: string
    osm_id?: number | string
    name?: string
    housenumber?: string
    street?: string
    locality?: string
    district?: string
    city?: string
    county?: string
    state?: string
    country?: string
    countrycode?: string
    postcode?: string
  }
}

// 公用 Nominatim 的使用條款要求：可辨識的 User-Agent、每秒最多一次請求、不得大量批次查詢。
// 這些都在這個模組裡集中處理，端點只負責驗參數與授權。
const PUBLIC_NOMINATIM_INTERVAL_MS = 1_100
// 排隊超過這個時間就直接回 429：與其讓使用者對著轉圈等三秒以上，不如告訴他稍後再試。
const MAX_QUEUE_WAIT_MS = 3_000
const UPSTREAM_TIMEOUT_MS = 6_000
const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 200
const MAX_RESULTS = 8

const cache = new Map<string, { expiresAt: number, places: GeoPlace[] }>()
// 下一次「可以」打上游的時間點。讀取與寫入之間沒有 await，因此在 JS 的單執行緒模型下
// 這段更新是不可分割的，多個併發請求會各自拿到不重疊的時段，不會一起衝出去。
let nextUpstreamAt = 0

interface GeocoderSettings {
  provider: GeocoderProvider
  baseUrl: string
  email: string
  minIntervalMs: number
}

function settings(): GeocoderSettings {
  const config = useRuntimeConfig()
  const baseUrl = String(config.geocoderUrl || '').trim().replace(/\/+$/, '')
  if (!baseUrl) {
    throw createError({ statusCode: 503, message: '本站尚未啟用地點搜尋，請手動輸入座標' })
  }

  const provider = String(config.geocoderProvider || 'nominatim').trim().toLowerCase()
  if (provider !== 'nominatim' && provider !== 'photon') {
    // 設定錯誤不該表現成「搜尋不到地點」——那會讓人以為是資料問題而去改關鍵字
    throw createError({ statusCode: 503, message: '地點搜尋服務設定有誤，請聯絡站方' })
  }

  // 節流間隔預設依 provider 而定：公用 Nominatim 有每秒一次的條款，自架的 Photon 沒有
  // ——對自己的伺服器節流成每秒一次，等於自願放棄自架換來的整個好處。
  // 留空＝自動；填數字就以填的為準（例如指到別人的公用 Photon 時要自己收斂）。
  const configured = String(config.geocoderMinIntervalMs ?? '').trim()
  const parsed = Number(configured)
  const minIntervalMs = configured !== '' && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : provider === 'photon' ? 0 : PUBLIC_NOMINATIM_INTERVAL_MS

  return { provider, baseUrl, email: String(config.geocoderEmail || '').trim(), minIntervalMs }
}

function readCache(key: string, now: number) {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expiresAt <= now) {
    cache.delete(key)
    return null
  }
  return hit.places
}

function writeCache(key: string, places: GeoPlace[], now: number) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(entryKey)
    }
    // 清不出過期項目就淘汰最舊的（Map 依插入順序迭代）。快取滿了只是下次要重打上游，
    // 不影響正確性，所以這裡不像限流那樣直接拒絕請求。
    for (const entryKey of cache.keys()) {
      if (cache.size < MAX_CACHE_ENTRIES) break
      cache.delete(entryKey)
    }
  }
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, places })
}

async function pace(minIntervalMs: number) {
  if (minIntervalMs <= 0) return
  const now = Date.now()
  const wait = Math.max(0, nextUpstreamAt - now)
  if (wait > MAX_QUEUE_WAIT_MS) {
    throw createError({ statusCode: 429, message: '地點搜尋目前排隊中，請稍後再試' })
  }
  nextUpstreamAt = Math.max(now, nextUpstreamAt) + minIntervalMs
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
}

/**
 * 次級行政區：不同區域、不同上游放的欄位都不一樣（日本在 province/state、美國在 state、
 * 臺灣多半在 city 或 county），依序取第一個有值的。
 */
function pickRegion(candidates: Array<string | undefined>, countryCode: string | null) {
  const region = candidates.find(value => typeof value === 'string' && value.trim())?.trim()
  if (!region) return null
  // 臺灣的縣市有「台」「臺」兩種寫法，上游回哪一種不固定。統一成官方的「臺」，
  // 篩選器才不會同時出現「台北市」與「臺北市」兩個看似不同的地區。
  const normalized = countryCode === 'TW' ? region.replace(/^台/, '臺') : region
  return normalized.slice(0, 40)
}

function toCountryCode(value: unknown) {
  const upper = String(value || '').trim().toUpperCase()
  return isCountryCode(upper) ? upper : null
}

function usablePlace(place: Omit<GeoPlace, 'label'> & { label: string }): GeoPlace | null {
  if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return null
  if (place.latitude < -90 || place.latitude > 90 || place.longitude < -180 || place.longitude > 180) return null
  if (!place.name) return null
  return { ...place, name: place.name.slice(0, 80), label: place.label.slice(0, 200) }
}

function fromNominatim(raw: NominatimPlace): GeoPlace | null {
  const displayName = String(raw.display_name || '').trim()
  const name = String(raw.name || '').trim() || displayName.split(',')[0]?.trim() || ''
  const countryCode = toCountryCode(raw.address?.country_code)
  return usablePlace({
    id: `${raw.osm_type || 'p'}${raw.osm_id ?? raw.place_id ?? name}`,
    name,
    label: displayName || name,
    latitude: Number(raw.lat),
    longitude: Number(raw.lon),
    countryCode,
    county: pickRegion([
      raw.address?.state, raw.address?.province, raw.address?.region, raw.address?.county,
      raw.address?.city, raw.address?.town, raw.address?.municipality, raw.address?.village,
      raw.address?.city_district, raw.address?.suburb
    ], countryCode)
  })
}

function fromPhoton(feature: PhotonFeature): GeoPlace | null {
  // GeoJSON 的座標順序是 [經度, 緯度]，跟 Nominatim 的 lat/lon 欄位相反。
  // 這一行寫反的話，臺北會跑到索馬利亞外海，而且不會有任何錯誤訊息。
  const [longitude, latitude] = feature.geometry?.coordinates ?? [Number.NaN, Number.NaN]
  const properties = feature.properties ?? {}
  const countryCode = toCountryCode(properties.countrycode)

  // Photon 對「地址」型的結果沒有 name，只有門牌與街名；那時退回組出一個看得懂的名稱。
  const street = [properties.street, properties.housenumber].filter(Boolean).join(' ')
  const name = String(properties.name || '').trim() || street || properties.city || properties.state || ''
  // label 用來分辨同名景點，重複的層級（例如 name 本身就是城市名）去掉才不會變成「台北, 台北, 台灣」
  const label = [...new Set([
    properties.name, street, properties.district, properties.city,
    properties.state, properties.country
  ].filter((value): value is string => Boolean(value && value.trim())))].join(', ')

  return usablePlace({
    id: `${properties.osm_type || 'p'}${properties.osm_id ?? name}`,
    name,
    label: label || name,
    latitude,
    longitude,
    countryCode,
    county: pickRegion([properties.state, properties.county, properties.city, properties.district], countryCode)
  })
}

type UpstreamRequest = { path: string, params: Record<string, string> }

function searchRequest(provider: GeocoderProvider, query: string): UpstreamRequest {
  if (provider === 'photon') {
    // lang 只支援 default/de/en/fr —— 送 zh 會被 Photon 用 400 拒絕。
    // default 代表「OSM 的 name 標籤」，也就是當地語言：臺灣是中文、日本是日文。
    // 對旅遊紀錄來說，看到的就是招牌上的名字，反而比硬翻成中文更貼近現場。
    return { path: 'api', params: { q: query, limit: String(MAX_RESULTS), lang: 'default' } }
  }
  return { path: 'search', params: { q: query, format: 'jsonv2', addressdetails: '1', limit: String(MAX_RESULTS) } }
}

function reverseRequest(provider: GeocoderProvider, latitude: number, longitude: number): UpstreamRequest {
  if (provider === 'photon') {
    return { path: 'reverse', params: { lat: String(latitude), lon: String(longitude), lang: 'default' } }
  }
  return {
    path: 'reverse',
    params: { lat: String(latitude), lon: String(longitude), format: 'jsonv2', addressdetails: '1', zoom: '16' }
  }
}

function parseUpstream(provider: GeocoderProvider, payload: unknown): GeoPlace[] {
  if (provider === 'photon') {
    // 參數有問題時 Photon 回的是 {"lang":[...]} 這種錯誤物件而不是 FeatureCollection，
    // 沒有 features 就當成「查不到」，不要讓它變成解析例外。
    const features = (payload as { features?: unknown })?.features
    if (!Array.isArray(features)) return []
    return features
      .map(feature => fromPhoton((feature || {}) as PhotonFeature))
      .filter((place): place is GeoPlace => place !== null)
  }
  const list = Array.isArray(payload) ? payload : [payload]
  return list
    .map(item => fromNominatim((item || {}) as NominatimPlace))
    .filter((place): place is GeoPlace => place !== null)
}

async function requestPlaces(request: UpstreamRequest): Promise<GeoPlace[]> {
  const config = useRuntimeConfig()
  const { provider, baseUrl, email, minIntervalMs } = settings()

  const url = new URL(`${baseUrl}/${request.path}`)
  for (const [key, value] of Object.entries(request.params)) url.searchParams.set(key, value)
  // Nominatim 建議附上聯絡信箱，被判定濫用時才會先來信而不是直接封鎖。Photon 沒有這個參數。
  if (email && provider === 'nominatim') url.searchParams.set('email', email)

  await pace(minIntervalMs)

  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        // 沒有可辨識的 User-Agent 會被 Nominatim 直接擋掉，這是條款要求的欄位
        'User-Agent': `journey-unfinished/1.0 (${String(config.public.appUrl || 'https://example.invalid')})`,
        'Accept': 'application/json',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.6'
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    })
  } catch {
    // 逾時、DNS 失敗、離線環境都走這裡。原始錯誤含有上游主機與堆疊，不外流。
    throw createError({ statusCode: 502, message: '地點搜尋服務連線失敗，請稍後再試或手動輸入座標' })
  }

  if (!response.ok) {
    throw createError({
      statusCode: response.status === 429 ? 429 : 502,
      message: response.status === 429 ? '地點搜尋太頻繁，請稍後再試' : '地點搜尋服務暫時無法使用'
    })
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw createError({ statusCode: 502, message: '地點搜尋服務回應格式不正確' })
  }

  return parseUpstream(provider, payload).slice(0, MAX_RESULTS)
}

export async function searchPlaces(query: string): Promise<GeoPlace[]> {
  const now = Date.now()
  const key = `search:${query.toLowerCase()}`
  const cached = readCache(key, now)
  if (cached) return cached

  const places = await requestPlaces(searchRequest(settings().provider, query))
  writeCache(key, places, now)
  return places
}

export async function reverseGeocode(latitude: number, longitude: number): Promise<GeoPlace | null> {
  const now = Date.now()
  // 反查用四位小數（約 11 公尺）當快取鍵：使用者在地圖上微調幾公尺不需要重打上游，
  // 但仍足以區分相鄰的兩個景點。
  const key = `reverse:${latitude.toFixed(4)},${longitude.toFixed(4)}`
  const cached = readCache(key, now)
  if (cached) return cached[0] ?? null

  const places = await requestPlaces(reverseRequest(settings().provider, latitude, longitude))
  writeCache(key, places, now)
  return places[0] ?? null
}

export function clearGeocodingCacheForTests() {
  cache.clear()
  nextUpstreamAt = 0
}
