import { describe, expect, it } from 'vitest'
import {
  COUNTRY_CODES, COUNTRY_GROUPS, COUNTRY_NAMES, isCountryCode, regionName
} from '../utils/countries'

describe('區域對照表', () => {
  it('never lists the same code twice', () => {
    // 重複的代碼會讓 <select> 出現兩個一樣的選項，也會讓 Object.fromEntries 靜默丟掉其中一筆
    const codes = COUNTRY_GROUPS.flatMap(group => group.countries.map(([code]) => code))
    expect(codes).toHaveLength(COUNTRY_CODES.size)
  })

  it('uses well-formed ISO 3166-1 alpha-2 codes and non-empty names', () => {
    for (const [code, name] of Object.entries(COUNTRY_NAMES)) {
      expect(code).toMatch(/^[A-Z]{2}$/)
      expect(name.trim()).not.toBe('')
    }
  })

  it('covers the destinations the seed data and tests rely on', () => {
    expect(regionName('TW')).toBe('臺灣')
    expect(regionName('JP')).toBe('日本')
    expect(regionName('IS')).toBe('冰島')
  })

  it('accepts a lowercase code and rejects anything outside the table', () => {
    expect(isCountryCode('jp')).toBe(true)
    expect(isCountryCode('ZZ')).toBe(false)
    expect(isCountryCode('')).toBe(false)
    expect(isCountryCode(null)).toBe(false)
  })

  it('falls back to the code itself rather than showing a blank', () => {
    // 這份表之後若被縮減，畫面顯示 JP 也遠比顯示空白有用
    expect(regionName('ZZ')).toBe('ZZ')
    expect(regionName(null)).toBe('')
  })

  // 介面刻意不顯示國旗：國旗是最強烈的主權符號，而這個站要說的只是「去過哪裡」。
  // 這條測試守著「不要有人為了好看又把它加回來」。
  it('exposes no flag helper at all', async () => {
    const module = await import('../utils/countries')
    expect(Object.keys(module).some(name => /flag/i.test(name))).toBe(false)
  })
})
