import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const GEOCODER_URL = 'https://geocoder.example'
const APP_URL = 'https://trip.example.com'

interface FetchCall { url: string, headers: Record<string, string> }

const calls: FetchCall[] = []
let respond: () => Response | Promise<Response>

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const tokyoTower = {
  place_id: 1234,
  osm_type: 'way',
  osm_id: 987,
  lat: '35.6586',
  lon: '139.7454',
  name: '東京鐵塔',
  display_name: '東京鐵塔, 芝公園, 港區, 東京都, 日本',
  address: { country_code: 'jp', province: '東京都', city: '港區' }
}

/**
 * 每個測試都重新載入模組：查詢快取與「下一次可以打上游的時間」都是模組層級狀態，
 * 共用的話前一個測試的快取會讓後一個測試根本沒打到 fetch。
 */
async function loadGeocoding(config: Record<string, unknown> = {}) {
  vi.resetModules()
  vi.stubGlobal('useRuntimeConfig', () => ({
    geocoderUrl: GEOCODER_URL,
    geocoderProvider: 'nominatim',
    geocoderEmail: '',
    geocoderMinIntervalMs: '',
    public: { appUrl: APP_URL },
    ...config
  }))
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers || {}) as Record<string, string>))
    })
    return respond()
  })
  return await import('../server/utils/geocoding')
}

beforeEach(() => {
  calls.length = 0
  respond = () => jsonResponse([tokyoTower])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchPlaces', () => {
  it('normalizes an upstream result into the shape the form needs', async () => {
    const { searchPlaces } = await loadGeocoding()
    const [place] = await searchPlaces('東京鐵塔')
    expect(place).toMatchObject({
      name: '東京鐵塔',
      label: '東京鐵塔, 芝公園, 港區, 東京都, 日本',
      latitude: 35.6586,
      longitude: 139.7454,
      // country_code 上游是小寫，存進資料庫前一律轉成 ISO 的大寫形式
      countryCode: 'JP',
      county: '東京都'
    })
  })

  it('sends an identifiable User-Agent, as the Nominatim terms require', async () => {
    const { searchPlaces } = await loadGeocoding()
    await searchPlaces('東京鐵塔')
    expect(calls[0]!.headers['User-Agent']).toContain('journey-unfinished')
    expect(calls[0]!.headers['User-Agent']).toContain(APP_URL)
    expect(calls[0]!.url).toContain(`${GEOCODER_URL}/search`)
    expect(calls[0]!.url).toContain('addressdetails=1')
  })

  it('serves a repeated query from cache instead of hitting the upstream again', async () => {
    const { searchPlaces } = await loadGeocoding()
    await searchPlaces('東京鐵塔')
    await searchPlaces('東京鐵塔')
    expect(calls).toHaveLength(1)
  })

  it('normalizes Taiwan county names to the official 臺 spelling', async () => {
    // 上游對臺灣的縣市有「台」「臺」兩種寫法，不統一的話篩選器會同時出現兩個看似不同的地區
    respond = () => jsonResponse([{
      ...tokyoTower, name: '台北101', display_name: '台北101, 台北市',
      address: { country_code: 'tw', city: '台北市' }
    }])
    const { searchPlaces } = await loadGeocoding()
    const [place] = await searchPlaces('台北101')
    expect(place).toMatchObject({ countryCode: 'TW', county: '臺北市' })
  })

  it('drops results without a usable coordinate or name', async () => {
    respond = () => jsonResponse([
      { ...tokyoTower, lat: 'not-a-number' },
      { ...tokyoTower, lat: '95', lon: '139' },
      { ...tokyoTower, name: '', display_name: '' },
      tokyoTower
    ])
    const { searchPlaces } = await loadGeocoding()
    expect(await searchPlaces('東京鐵塔')).toHaveLength(1)
  })

  it('leaves countryCode null when the upstream code is not a known ISO code', async () => {
    respond = () => jsonResponse([{ ...tokyoTower, address: { country_code: 'zz', state: '某處' } }])
    const { searchPlaces } = await loadGeocoding()
    expect((await searchPlaces('某處'))[0]).toMatchObject({ countryCode: null, county: '某處' })
  })

  it('turns upstream failures into a friendly 502 without leaking internals', async () => {
    respond = () => { throw new Error(`connect ECONNREFUSED ${GEOCODER_URL}`) }
    const { searchPlaces } = await loadGeocoding()
    await expect(searchPlaces('東京鐵塔')).rejects.toMatchObject({ statusCode: 502 })
    await expect(searchPlaces('東京鐵塔')).rejects.not.toMatchObject({ message: expect.stringContaining('ECONNREFUSED') })
  })

  it('passes an upstream rate limit through as 429', async () => {
    respond = () => new Response('slow down', { status: 429 })
    const { searchPlaces } = await loadGeocoding()
    await expect(searchPlaces('東京鐵塔')).rejects.toMatchObject({ statusCode: 429 })
  })

  it('reports 503 instead of calling anything when the geocoder is switched off', async () => {
    const { searchPlaces } = await loadGeocoding({ geocoderUrl: '' })
    await expect(searchPlaces('東京鐵塔')).rejects.toMatchObject({ statusCode: 503 })
    expect(calls).toHaveLength(0)
  })

  it('paces upstream calls and refuses to queue when too many pile up at once', async () => {
    // 上游條款是「每秒最多一次」。同時湧入的請求會被排到 1.1 秒的間隔上，
    // 排到超過 3 秒的那些寧可回 429，也不要讓使用者對著轉圈等下去。
    // 用假時鐘推進，測的是排程邏輯本身，不需要真的等三秒。
    const { searchPlaces } = await loadGeocoding()
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const inflight = Array.from({ length: 8 }, (_, index) => searchPlaces(`地點${index}`).catch(error => error))
      await vi.advanceTimersByTimeAsync(5_000)
      const outcomes = await Promise.all(inflight)
      const rejected = outcomes.filter(outcome => outcome instanceof Error)
      expect(rejected.length).toBeGreaterThan(0)
      expect(rejected[0]).toMatchObject({ statusCode: 429 })
      // 放行的那幾筆是真的間隔開的，不是一起衝出去
      expect(calls.length).toBe(outcomes.length - rejected.length)
      expect(calls.length).toBeLessThan(8)
    } finally {
      vi.useRealTimers()
    }
  })
})

// 自架的 Photon 是為了擺脫公用 Nominatim 每秒一次的上限。它的回應是 GeoJSON，
// 形狀與 Nominatim 完全不同——連經緯度的順序都是相反的，所以這裡逐項釘住轉換結果。
describe('photon provider', () => {
  const photonConfig = { geocoderProvider: 'photon' }
  const taipei101 = {
    type: 'FeatureCollection',
    features: [{
      // GeoJSON 是 [經度, 緯度]；抄成 [緯度, 經度] 的話臺北會跑到索馬利亞外海而且不會報錯
      geometry: { type: 'Point', coordinates: [121.5644995, 25.0338352] },
      properties: {
        osm_type: 'W', osm_id: 1159328965, name: 'Taipei 101',
        street: 'Section 5, Xinyi Road', housenumber: '7', district: 'Xinyi',
        city: 'Taipei', country: 'Taiwan', countrycode: 'TW'
      }
    }]
  }

  it('reads the GeoJSON coordinate order the right way round', async () => {
    respond = () => jsonResponse(taipei101)
    const { searchPlaces } = await loadGeocoding(photonConfig)
    expect((await searchPlaces('Taipei 101'))[0]).toMatchObject({
      name: 'Taipei 101',
      latitude: 25.0338352,
      longitude: 121.5644995,
      countryCode: 'TW',
      // Photon 回什麼就存什麼，不做翻譯。這裡的 city 是 'Taipei'，
      // 「台→臺」的正規化只在字串真的以「台」開頭時才會發生。
      county: 'Taipei'
    })
  })

  it('calls the photon endpoints with lang=default', async () => {
    respond = () => jsonResponse(taipei101)
    const { searchPlaces, reverseGeocode } = await loadGeocoding(photonConfig)
    await searchPlaces('Taipei 101')
    // Photon 的 lang 只支援 default/de/en/fr，送 zh 會被 400 拒絕；
    // default 代表 OSM 的 name 標籤，也就是當地語言。
    expect(calls[0]!.url).toBe(`${GEOCODER_URL}/api?q=Taipei+101&limit=8&lang=default`)
    await reverseGeocode(25.0338, 121.5645)
    expect(calls[1]!.url).toContain(`${GEOCODER_URL}/reverse?lat=25.0338&lon=121.5645&lang=default`)
  })

  it('builds a readable label without repeating the same place twice', async () => {
    respond = () => jsonResponse({
      type: 'FeatureCollection',
      features: [{
        geometry: { coordinates: [135.6712621, 35.0168123] },
        properties: {
          osm_type: 'W', osm_id: 1, name: 'Bamboo Groves', district: 'Ukyō Ward',
          city: 'Kyoto', state: 'Kyoto Prefecture', country: 'Japan', countrycode: 'JP'
        }
      }]
    })
    const { searchPlaces } = await loadGeocoding(photonConfig)
    expect((await searchPlaces('bamboo'))[0]).toMatchObject({
      name: 'Bamboo Groves',
      label: 'Bamboo Groves, Ukyō Ward, Kyoto, Kyoto Prefecture, Japan',
      county: 'Kyoto Prefecture'
    })
  })

  it('falls back to the street when a result has no name', async () => {
    respond = () => jsonResponse({
      type: 'FeatureCollection',
      features: [{
        geometry: { coordinates: [121.5, 25.0] },
        properties: { osm_type: 'N', osm_id: 2, street: '信義路五段', housenumber: '7', city: 'Taipei', countrycode: 'TW' }
      }]
    })
    const { searchPlaces } = await loadGeocoding(photonConfig)
    expect((await searchPlaces('信義路五段 7'))[0]).toMatchObject({ name: '信義路五段 7' })
  })

  it('treats a photon error object as "nothing found" instead of crashing', async () => {
    // 參數有問題時 Photon 回的是 {"lang":[…]} 而不是 FeatureCollection
    respond = () => jsonResponse({ lang: [{ message: 'Language is not supported.' }] })
    const { searchPlaces } = await loadGeocoding(photonConfig)
    expect(await searchPlaces('東京')).toEqual([])
  })

  it('does not throttle a self-hosted upstream', async () => {
    // 對自己的伺服器節流成每秒一次，等於自願放棄自架換來的整個好處
    respond = () => jsonResponse(taipei101)
    const { searchPlaces } = await loadGeocoding(photonConfig)
    const started = Date.now()
    await Promise.all(Array.from({ length: 6 }, (_, index) => searchPlaces(`地點${index}`)))
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls).toHaveLength(6)
  })

  it('still honours an explicit interval when pointed at someone else public instance', async () => {
    respond = () => jsonResponse(taipei101)
    const { searchPlaces } = await loadGeocoding({ ...photonConfig, geocoderMinIntervalMs: '1100' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const inflight = Array.from({ length: 6 }, (_, index) => searchPlaces(`地點${index}`).catch(error => error))
      await vi.advanceTimersByTimeAsync(5_000)
      const outcomes = await Promise.all(inflight)
      expect(outcomes.filter(outcome => outcome instanceof Error).length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('provider 設定錯誤', () => {
  it('reports a configuration problem rather than pretending nothing was found', async () => {
    // 設定打錯字若表現成「查不到地點」，使用者只會一直換關鍵字，永遠找不到原因
    const { searchPlaces } = await loadGeocoding({ geocoderProvider: 'nominatm' })
    await expect(searchPlaces('東京鐵塔')).rejects.toMatchObject({ statusCode: 503 })
    expect(calls).toHaveLength(0)
  })
})

describe('reverseGeocode', () => {
  it('returns a single place for a coordinate', async () => {
    respond = () => jsonResponse(tokyoTower)
    const { reverseGeocode } = await loadGeocoding()
    expect(await reverseGeocode(35.6586, 139.7454)).toMatchObject({ countryCode: 'JP', county: '東京都' })
    expect(calls[0]!.url).toContain(`${GEOCODER_URL}/reverse`)
  })

  it('caches by rounded coordinate so nudging the pin a few metres costs nothing', async () => {
    respond = () => jsonResponse(tokyoTower)
    const { reverseGeocode } = await loadGeocoding()
    await reverseGeocode(35.65861, 139.74541)
    await reverseGeocode(35.65862, 139.74542)
    expect(calls).toHaveLength(1)
  })

  it('returns null when the upstream has nothing there', async () => {
    respond = () => jsonResponse({ error: 'Unable to geocode' })
    const { reverseGeocode } = await loadGeocoding()
    expect(await reverseGeocode(0, 0)).toBeNull()
  })
})
