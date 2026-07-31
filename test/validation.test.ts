import { describe, expect, it } from 'vitest'
import { parseId, validateCheckin, validateComment } from '../server/utils/validation'

const validCheckin = {
  nickname: '旅人小花',
  location: '大安森林公園',
  county: '臺北市',
  latitude: '25.033',
  longitude: '121.535',
  dollName: '小櫻',
  message: '今天一起來散步。',
  visitedAt: '2026-03-15',
  avatarPreset: 'sakura'
}

describe('validateCheckin', () => {
  it('normalizes a valid check-in', () => {
    expect(validateCheckin({ ...validCheckin, avatarPreset: 'peach' })).toMatchObject({
      nickname: '旅人小花',
      county: '臺北市',
      latitude: 25.033,
      longitude: 121.535,
      avatarPreset: 'peach'
    })
  })

  it('rejects coordinates outside Taiwan', () => {
    expect(() => validateCheckin({ ...validCheckin, latitude: '35' })).toThrowError()
  })

  it('rejects unknown counties and avatar presets', () => {
    expect(() => validateCheckin({ ...validCheckin, county: '不存在縣市' })).toThrowError()
    expect(() => validateCheckin({ ...validCheckin, avatarPreset: 'javascript:alert(1)' })).toThrowError()
  })
})

describe('validateComment', () => {
  it('accepts and trims valid comments', () => {
    expect(validateComment({ nickname: ' 阿明 ', message: ' 好可愛！ ' })).toEqual({
      nickname: '阿明',
      message: '好可愛！'
    })
  })

  it('rejects empty and overlong comments', () => {
    expect(() => validateComment({ nickname: '', message: '' })).toThrowError()
    expect(() => validateComment({ nickname: '阿明', message: 'a'.repeat(301) })).toThrowError()
  })
})

describe('parseId', () => {
  it('accepts positive integer ids only', () => {
    expect(parseId('42')).toBe(42)
    expect(() => parseId('0')).toThrowError()
    expect(() => parseId('../1')).toThrowError()
  })
})
