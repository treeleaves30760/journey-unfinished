import { describe, expect, it } from 'vitest'
import {
  COUNTRY_CODES, COUNTRY_GROUPS, COUNTRY_NAMES, countryFlag, countryName, isCountryCode
} from '../utils/countries'

describe('國家／地區對照表', () => {
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
    expect(countryName('TW')).toBe('臺灣')
    expect(countryName('JP')).toBe('日本')
    expect(countryName('IS')).toBe('冰島')
  })

  it('accepts a lowercase code and rejects anything outside the table', () => {
    expect(isCountryCode('jp')).toBe(true)
    expect(isCountryCode('ZZ')).toBe(false)
    expect(isCountryCode('')).toBe(false)
    expect(isCountryCode(null)).toBe(false)
  })

  it('falls back to the code itself rather than showing a blank', () => {
    // 這份表之後若被縮減，畫面顯示 JP 也遠比顯示空白有用
    expect(countryName('ZZ')).toBe('ZZ')
    expect(countryName(null)).toBe('')
  })

  it('builds flags from regional indicator symbols instead of shipping 250 images', () => {
    expect(countryFlag('JP')).toBe(String.fromCodePoint(0x1F1EF, 0x1F1F5))
    expect(countryFlag('tw')).toBe(String.fromCodePoint(0x1F1F9, 0x1F1FC))
    expect(countryFlag('bad-input')).toBe('')
  })
})
