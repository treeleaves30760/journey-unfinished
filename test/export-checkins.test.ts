import { describe, expect, it } from 'vitest'
import {
  checkinsToCsv,
  checkinsToGeoJson,
  checkinsToJson,
  exportFilename,
  type ExportableCheckin
} from '../utils/exportCheckins'

function checkin(overrides: Partial<ExportableCheckin> = {}): ExportableCheckin {
  return {
    id: 7,
    location: '嵐山竹林小徑',
    countryCode: 'JP',
    county: '京都府',
    latitude: 35.0169,
    longitude: 135.6716,
    dollName: '小柚',
    series: null,
    nickname: '柚子',
    message: '六點的竹林還沒有人，只有風。',
    visitedAt: '2025-11-03',
    createdAt: '2025-11-04 09:00:00',
    commentCount: 2,
    ...overrides
  }
}

function csvRows(text: string) {
  return text.split('\r\n')
}

describe('checkinsToCsv', () => {
  it('第一行是標頭，之後一則旅箋一行，換行用 CRLF', () => {
    const rows = csvRows(checkinsToCsv([checkin(), checkin({ id: 8 })]))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('"日期"')
    expect(rows[0]).toContain('"經度"')
    expect(rows[1]).toContain('"嵐山竹林小徑"')
  })

  it('欄位順序固定，區域名稱由代碼推導而不是原樣輸出代碼', () => {
    const [, row] = csvRows(checkinsToCsv([checkin()]))
    expect(row).toBe(
      '"2025-11-03","嵐山竹林小徑","日本","京都府","35.0169","135.6716","小柚","","柚子",'
      + '"六點的竹林還沒有人，只有風。","2","/checkins/7"'
    )
  })

  it('逗號、雙引號與換行都留在同一個儲存格裡', () => {
    const [, row] = csvRows(checkinsToCsv([checkin({ location: 'café, "the" corner' })]))
    expect(row).toContain('"café, ""the"" corner"')
  })

  it('多行留言壓成單行，欄位不會被換行切斷', () => {
    const text = checkinsToCsv([checkin({ message: '第一行\n\n第二行\n第三行' })])
    expect(csvRows(text)).toHaveLength(2)
    expect(text).toContain('"第一行 第二行 第三行"')
  })

  it('以公式符號開頭的內容前面補單引號（CSV injection）', () => {
    // 這些值都能通過旅箋的內容衛生檢查——它們只是普通的字，
    // 危險的是試算表軟體看到開頭那個字元就把整格當公式執行。
    for (const dangerous of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\tsneaky', '\rsneaky']) {
      const [, row] = csvRows(checkinsToCsv([checkin({ location: dangerous })]))
      expect(row).toContain(`"'${dangerous}"`)
    }
  })

  it('一般開頭的內容不會被加上引號前綴', () => {
    const [, row] = csvRows(checkinsToCsv([checkin({ location: '淡水漁人碼頭' })]))
    expect(row).toContain('"淡水漁人碼頭"')
    expect(row).not.toContain("\"'淡水")
  })

  it('沒有旅箋時仍然輸出標頭，匯出的是一個合法的空檔案', () => {
    expect(csvRows(checkinsToCsv([]))).toHaveLength(1)
  })
})

describe('checkinsToJson', () => {
  it('帶上格式識別與筆數，完整欄位原樣保留', () => {
    const parsed = JSON.parse(checkinsToJson([checkin()])) as {
      format: string, version: number, count: number, checkins: ExportableCheckin[]
    }
    expect(parsed.format).toBe('journey-unfinished/checkins')
    expect(parsed.version).toBe(1)
    expect(parsed.count).toBe(1)
    expect(parsed.checkins[0]).toMatchObject({ id: 7, location: '嵐山竹林小徑', countryCode: 'JP' })
  })
})

describe('checkinsToGeoJson', () => {
  it('座標是 [經度, 緯度]——寫反的話每個點都會落到地球另一邊', () => {
    const parsed = JSON.parse(checkinsToGeoJson([checkin()])) as {
      type: string
      features: { geometry: { coordinates: [number, number] }, properties: Record<string, unknown> }[]
    }
    expect(parsed.type).toBe('FeatureCollection')
    expect(parsed.features[0]!.geometry.coordinates).toEqual([135.6716, 35.0169])
    expect(parsed.features[0]!.properties).toMatchObject({
      name: '嵐山竹林小徑', date: '2025-11-03', region: '日本', county: '京都府', doll: '小柚'
    })
  })

  it('空清單也是一個合法的 FeatureCollection', () => {
    const parsed = JSON.parse(checkinsToGeoJson([])) as { type: string, features: unknown[] }
    expect(parsed).toEqual({ type: 'FeatureCollection', features: [] })
  })
})

describe('exportFilename', () => {
  it('三種格式各自帶正確的副檔名與日期', () => {
    expect(exportFilename('csv', '2026-08-09')).toBe('journey-unfinished-2026-08-09.csv')
    expect(exportFilename('json', '2026-08-09')).toBe('journey-unfinished-2026-08-09.json')
    expect(exportFilename('geojson', '2026-08-09')).toBe('journey-unfinished-2026-08-09.geojson')
  })
})
