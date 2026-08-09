import { regionName } from './countries'

/**
 * 把自己的旅箋匯出成可以帶走的檔案。
 *
 * 為什麼要有這個：這個站是別人家的伺服器上的一個資料夾。使用者累積了幾十個「和娃娃去過
 * 哪裡、哪一天」之後，那份紀錄的價值已經超過這個網站本身——所以它必須有辦法離開這裡，
 * 而且是用其他工具打得開的格式，不是只有這個站看得懂的備份檔。
 *
 * 三種格式各有明確的用途，不是同一件事做三次：CSV 給試算表、JSON 給程式與完整備份、
 * GeoJSON 給地圖工具（Google My Maps、QGIS、geojson.io 都直接吃）。
 */

/** 匯出用的最小欄位集合。刻意用結構型別而不是 import Checkin：這裡只需要這幾個欄位。 */
export interface ExportableCheckin {
  id: number
  location: string
  countryCode: string
  county: string
  latitude: number
  longitude: number
  dollName: string
  series: string | null
  nickname: string
  message: string
  visitedAt: string
  createdAt: string
  commentCount: number
}

const CSV_HEADERS = [
  '日期', '地點', '區域', '行政區', '緯度', '經度', '娃娃', '作品出處', '暱稱', '留言', '留言數', '旅箋連結'
] as const

/**
 * 試算表軟體會把以 `=`、`+`、`-`、`@` 開頭的儲存格當成公式執行（CSV injection）。
 * 匯出的是使用者自己的資料、也只有他自己打開，但這份檔案可能被轉寄給別人，
 * 所以照樣在前面補一個單引號，讓它保證是文字。
 *
 * 前導的 tab 與 CR 一併處理：Excel 對它們的處理與換行相同，同樣能把後面的內容推成公式。
 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  // 逗號、引號與換行都必須包在雙引號裡，內部的雙引號要成對跳脫
  return `"${guarded.replace(/"/g, '""')}"`
}

/** 留言在 CSV 裡壓成單行：多行內容在試算表格子裡只會讓每一列變得極高，反而讀不到。 */
function flatten(text: string) {
  return text.replace(/\s*\n+\s*/g, ' ').trim()
}

export function checkinsToCsv(checkins: ExportableCheckin[]): string {
  const rows = checkins.map(checkin => [
    checkin.visitedAt,
    checkin.location,
    regionName(checkin.countryCode),
    checkin.county,
    checkin.latitude,
    checkin.longitude,
    checkin.dollName,
    checkin.series || '',
    checkin.nickname,
    flatten(checkin.message),
    checkin.commentCount,
    `/checkins/${checkin.id}`
  ].map(csvCell).join(','))

  // CRLF 是 RFC 4180 的規定，也是 Excel 對「這一行結束了」最沒有歧義的解讀
  return [CSV_HEADERS.map(csvCell).join(','), ...rows].join('\r\n')
}

export function checkinsToJson(checkins: ExportableCheckin[]): string {
  return JSON.stringify({
    format: 'journey-unfinished/checkins',
    version: 1,
    count: checkins.length,
    checkins
  }, null, 2)
}

/**
 * GeoJSON FeatureCollection。座標順序是 [經度, 緯度]——與人講話的習慣相反，
 * 但那是規格（RFC 7946 §3.1.1）規定的順序，寫反的話每個點都會落到地球另一邊。
 */
export function checkinsToGeoJson(checkins: ExportableCheckin[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: checkins.map(checkin => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [checkin.longitude, checkin.latitude] },
      properties: {
        name: checkin.location,
        date: checkin.visitedAt,
        region: regionName(checkin.countryCode),
        county: checkin.county,
        doll: checkin.dollName,
        series: checkin.series || '',
        description: flatten(checkin.message),
        url: `/checkins/${checkin.id}`
      }
    }))
  }, null, 2)
}

export type ExportFormat = 'csv' | 'json' | 'geojson'

const EXPORT_BUILDERS: Record<ExportFormat, {
  build: (checkins: ExportableCheckin[]) => string
  mime: string
  extension: string
  /** UTF-8 BOM。只有 CSV 需要：沒有它，Excel 會用系統的舊編碼讀，中文全部變亂碼。 */
  bom: boolean
}> = {
  csv: { build: checkinsToCsv, mime: 'text/csv;charset=utf-8', extension: 'csv', bom: true },
  json: { build: checkinsToJson, mime: 'application/json;charset=utf-8', extension: 'json', bom: false },
  geojson: { build: checkinsToGeoJson, mime: 'application/geo+json;charset=utf-8', extension: 'geojson', bom: false }
}

/** 檔名帶日期，連續匯出好幾次時不會互相覆蓋，之後也看得出哪一份比較新。 */
export function exportFilename(format: ExportFormat, isoDate: string) {
  return `journey-unfinished-${isoDate}.${EXPORT_BUILDERS[format].extension}`
}

export function buildExportBlob(format: ExportFormat, checkins: ExportableCheckin[]): Blob {
  const { build, mime, bom } = EXPORT_BUILDERS[format]
  const body = build(checkins)
  return new Blob(bom ? ['﻿', body] : [body], { type: mime })
}
