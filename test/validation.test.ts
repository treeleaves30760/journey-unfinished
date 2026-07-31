import { describe, expect, it } from 'vitest'
import { assertUniqueComment, parseId, validateCheckin, validateComment } from '../server/utils/validation'

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

// 這裡測的字元全都是看不見的，直接把原字元貼進原始碼的話，經過複製、格式化或編輯器的
// 自動正規化就會被無聲換掉：測試照樣是綠的，卻已經不是在測原本那個碼位。
// 一律從數字碼位組出來，程式碼裡看得到的就是規格本身。
const chars = (...codePoints: number[]) => String.fromCodePoint(...codePoints)
const COMBINING_ACUTE = 0x0301
const badRequest = expect.objectContaining({ statusCode: 400 })
const tooManyRequests = expect.objectContaining({ statusCode: 429 })

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

// 旅箋的自由文字同樣會公開渲染在旅箋頁上。這條路徑有 requireUser 擋著，
// 但 Discord 帳號誰都能註冊，所以套用與留言相同的衛生規則。
describe('validateCheckin 內容衛生', () => {
  // validCheckin 的 avatarPreset 是刻意無效的 'sakura'，直接拿它當基底的話，
  // 每個 throw 都會是頭像驗證先擋下來的，測不到衛生規則本身。
  const okCheckin = { ...validCheckin, avatarPreset: 'peach' }

  it('rejects control characters in single-line fields', () => {
    expect(() => validateCheckin({ ...okCheckin, nickname: `旅人${chars(0x0000)}小花` })).toThrow(badRequest)
    expect(() => validateCheckin({ ...okCheckin, location: `大安${chars(0x000D)}公園` })).toThrow(badRequest)
    expect(() => validateCheckin({ ...okCheckin, dollName: `小${chars(0x0009)}櫻` })).toThrow(badRequest)
    expect(() => validateCheckin({ ...okCheckin, series: `第一${chars(0x0000)}集` })).toThrow(badRequest)
  })

  it('rejects zero-width and bidi override characters', () => {
    expect(() => validateCheckin({ ...okCheckin, nickname: `旅人${chars(0x200B)}小花` })).toThrow(badRequest)
    expect(() => validateCheckin({ ...okCheckin, location: `${chars(0x202E)}大安森林公園` })).toThrow(badRequest)
    expect(() => validateCheckin({ ...okCheckin, dollName: `小${chars(0xFEFF)}櫻` })).toThrow(badRequest)
    expect(() => validateCheckin({ ...okCheckin, series: `${chars(0x200B)}第一集` })).toThrow(badRequest)
  })

  it('keeps line breaks in the message but not carriage returns', () => {
    expect(validateCheckin({ ...okCheckin, message: '第一段\n第二段' }).message).toBe('第一段\n第二段')
    expect(() => validateCheckin({ ...okCheckin, message: `第一段${chars(0x000D)}第二段` })).toThrow(badRequest)
  })

  it('does not kill ZWJ emoji sequences', () => {
    const zwjFamily = `👩${chars(0x200D)}💻`
    expect(validateCheckin({ ...okCheckin, dollName: zwjFamily }).dollName).toBe(zwjFamily)
  })

  it('rejects any link in nickname, location, doll name and series', () => {
    expect(() => validateCheckin({ ...okCheckin, nickname: '追蹤我 www.spam.example' })).toThrow(badRequest)
    expect(() => validateCheckin({ ...okCheckin, location: 'https://spam.example/a' })).toThrow(badRequest)
    expect(() => validateCheckin({ ...okCheckin, dollName: 'buy.shop' })).toThrow(badRequest)
    expect(() => validateCheckin({ ...okCheckin, series: '追蹤我 www.spam.example' })).toThrow(badRequest)
  })

  it('allows up to two links in the message and rejects the third', () => {
    const two = '參考 https://a.example 與 www.b.example'
    expect(validateCheckin({ ...okCheckin, message: two }).message).toBe(two)
    expect(() => validateCheckin({
      ...okCheckin,
      message: 'https://a.example www.b.example c.com'
    })).toThrow(badRequest)
  })

  it('measures message length after composing to NFC', () => {
    // 250 個 'e' + U+0301 在 JS 裡是 500 個 UTF-16 單位，正規化後只有 250 個字元。
    // 不正規化就會被誤判成剛好卡在 500 上限，正規化後才能再多寫 250 字。
    const decomposed = `e${chars(COMBINING_ACUTE)}`.repeat(250)
    expect(validateCheckin({ ...okCheckin, message: decomposed }).message).toHaveLength(250)
    expect(() => validateCheckin({ ...okCheckin, message: `e${chars(COMBINING_ACUTE)}`.repeat(501) }))
      .toThrow(badRequest)
  })
})

// series（作品出處）是唯一的選填自由文字欄位：原創娃娃沒有作品可以填，這裡單獨測
// 「留空／只有空白要正規化成 null」這個其他必填欄位都不需要的行為。內容本身的衛生檢查
// （控制字元、隱藏字元、連結）已經併進上面 `validateCheckin 內容衛生` 的既有案例。
describe('validateCheckin series 欄位（選填）', () => {
  const okCheckin = { ...validCheckin, avatarPreset: 'peach' }

  it('normalizes a missing, empty or whitespace-only series to null', () => {
    expect(validateCheckin(okCheckin).series).toBeNull()
    expect(validateCheckin({ ...okCheckin, series: '' }).series).toBeNull()
    expect(validateCheckin({ ...okCheckin, series: '   ' }).series).toBeNull()
  })

  it('trims a provided series and keeps it', () => {
    expect(validateCheckin({ ...okCheckin, series: '  夏日重現  ' }).series).toBe('夏日重現')
  })

  it('rejects a series longer than 60 characters, measured after composing to NFC', () => {
    // 60 個 'e' + U+0301 在 JS 裡是 120 個 UTF-16 單位，正規化後只剩 60 個字元，剛好卡在上限；
    // 不正規化的話會被誤判成超過上限兩倍，永遠通不過。
    const decomposed = `e${chars(COMBINING_ACUTE)}`.repeat(60)
    expect(validateCheckin({ ...okCheckin, series: decomposed }).series).toHaveLength(60)
    expect(() => validateCheckin({ ...okCheckin, series: `e${chars(COMBINING_ACUTE)}`.repeat(61) }))
      .toThrow(badRequest)
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

describe('validateComment 長度正規化', () => {
  const decomposedAcuteE = `e${chars(COMBINING_ACUTE)}`
  const composedAcuteE = chars(0x00E9)

  // 少了 NFC 這一步，長度上限量到的是碼元數而不是使用者看到的字數：同一段視覺內容會因為
  // 輸入法送出組合字元還是預合成字元而時而過關、時而被擋，上限也不再對應資料庫的 length() 檢查。
  it('measures length after composing to NFC', () => {
    const decomposed = decomposedAcuteE.repeat(300)
    expect(decomposed).toHaveLength(600)
    expect(validateComment({ nickname: '阿明', message: decomposed }).message).toBe(composedAcuteE.repeat(300))
    expect(() => validateComment({ nickname: '阿明', message: decomposedAcuteE.repeat(301) })).toThrowError(badRequest)
  })

  it('applies the same rule to nicknames', () => {
    expect(validateComment({ nickname: decomposedAcuteE.repeat(30), message: '好可愛！' }).nickname).toHaveLength(30)
    expect(() => validateComment({ nickname: decomposedAcuteE.repeat(31), message: '好可愛！' })).toThrowError(badRequest)
  })
})

describe('validateComment 控制字元', () => {
  it('keeps line breaks inside comments but not inside nicknames', () => {
    expect(validateComment({ nickname: '阿明', message: '第一段\n第二段' }).message).toBe('第一段\n第二段')
    expect(() => validateComment({ nickname: '阿\n明', message: '好可愛！' })).toThrowError(badRequest)
  })

  it.each([
    ['U+0000 NUL', 0x0000],
    ['U+0009 TAB', 0x0009],
    ['U+000B VT', 0x000B],
    ['U+000D CR', 0x000D],
    ['U+001B ESC', 0x001B],
    ['U+007F DEL', 0x007F],
    ['U+0085 NEL', 0x0085]
  ])('rejects %s even in the multi-line comment field', (_label, codePoint) => {
    const character = chars(codePoint)
    expect(() => validateComment({ nickname: '阿明', message: `好${character}可愛` })).toThrowError(badRequest)
    expect(() => validateComment({ nickname: `阿${character}明`, message: '好可愛！' })).toThrowError(badRequest)
  })
})

describe('validateComment 隱藏字元', () => {
  it.each([
    ['U+00AD SOFT HYPHEN', 0x00AD],
    ['U+061C ARABIC LETTER MARK', 0x061C],
    ['U+180E MONGOLIAN VOWEL SEPARATOR', 0x180E],
    ['U+200B ZERO WIDTH SPACE', 0x200B],
    ['U+200C ZERO WIDTH NON-JOINER', 0x200C],
    ['U+200E LEFT-TO-RIGHT MARK', 0x200E],
    ['U+200F RIGHT-TO-LEFT MARK', 0x200F],
    ['U+2028 LINE SEPARATOR', 0x2028],
    ['U+2029 PARAGRAPH SEPARATOR', 0x2029],
    ['U+202A LEFT-TO-RIGHT EMBEDDING', 0x202A],
    ['U+202E RIGHT-TO-LEFT OVERRIDE', 0x202E],
    ['U+2060 WORD JOINER', 0x2060],
    ['U+2066 LEFT-TO-RIGHT ISOLATE', 0x2066],
    ['U+2069 POP DIRECTIONAL ISOLATE', 0x2069],
    ['U+FEFF ZERO WIDTH NO-BREAK SPACE', 0xFEFF],
    ['U+FFF9 INTERLINEAR ANNOTATION ANCHOR', 0xFFF9]
  ])('rejects %s', (_label, codePoint) => {
    const character = chars(codePoint)
    expect(() => validateComment({ nickname: `阿${character}明`, message: '好可愛！' })).toThrowError(badRequest)
    expect(() => validateComment({ nickname: '阿明', message: `好${character}可愛` })).toThrowError(badRequest)
  })

  // U+200D 與變體選擇符同樣不可見，卻是日常 emoji 的組成零件，一併封殺等於讓一大批
  // 正常留言送不出去。這幾個案例守的就是那條界線。
  it.each([
    ['ZWJ 串起來的職業 emoji（👩‍💻）', chars(0x1F469, 0x200D, 0x1F4BB)],
    ['ZWJ 加變體選擇符的旗幟（🏳️‍🌈）', chars(0x1F3F3, 0xFE0F, 0x200D, 0x1F308)],
    ['只帶變體選擇符的符號（☀️）', chars(0x2600, 0xFE0F)],
    ['膚色修飾符（👍🏽）', chars(0x1F44D, 0x1F3FD)]
  ])('keeps %s intact', (_label, emoji) => {
    expect(validateComment({ nickname: emoji, message: `和旅伴 ${emoji} 一起` })).toEqual({
      nickname: emoji,
      message: `和旅伴 ${emoji} 一起`
    })
  })
})

describe('validateComment 連結數量', () => {
  it.each([
    ['scheme://', 'https://spam.example/win'],
    ['大寫的 scheme://', 'HTTPS://SPAM.EXAMPLE'],
    ['非 http 的 scheme://', 'ftp://spam.example'],
    ['www.', 'www.spam.example'],
    ['裸網域', 'spam.tw']
  ])('spots a link written as %s', (_label, link) => {
    // 暱稱一個連結都不能有，所以只要 LINK_PATTERN 抓得到這種寫法，這一行就會擋下來
    expect(() => validateComment({ nickname: `旅人${link}`, message: '好可愛！' })).toThrowError(badRequest)
    expect(() => validateComment({ nickname: '旅人', message: `看這裡 ${link} ${link} ${link}` })).toThrowError(badRequest)
  })

  it('does not mistake ordinary punctuation for a link', () => {
    expect(validateComment({ nickname: '旅人 2.0', message: '好可愛！下次見。' }).nickname).toBe('旅人 2.0')
  })

  it('allows up to two links in a comment and rejects the third', () => {
    const twoLinks = '參考這兩篇 https://a.tw 跟 www.b.tw'
    expect(validateComment({ nickname: '旅人', message: twoLinks }).message).toBe(twoLinks)
    expect(() => validateComment({ nickname: '旅人', message: `${twoLinks} 還有 c.tw` })).toThrowError(badRequest)
  })
})

// 指紋表是模組層級狀態，測試之間靠「每個案例用不同的來源位址」隔離，
// 時間一律以 now 參數推進，因此不依賴真實時鐘，也不需要 resetModules。
describe('assertUniqueComment', () => {
  const WINDOW_MS = 10 * 60 * 1000
  const base = 1_800_000_000_000

  it('blocks an identical resubmission inside the window', () => {
    expect(() => assertUniqueComment('203.0.113.1', '阿明', '好可愛！', base)).not.toThrow()
    expect(() => assertUniqueComment('203.0.113.1', '阿明', '好可愛！', base + 1_000)).toThrowError(tooManyRequests)
  })

  it('releases the fingerprint once the window has elapsed', () => {
    assertUniqueComment('203.0.113.2', '阿明', '好可愛！', base)
    expect(() => assertUniqueComment('203.0.113.2', '阿明', '好可愛！', base + WINDOW_MS - 1)).toThrowError(tooManyRequests)

    assertUniqueComment('203.0.113.3', '阿明', '好可愛！', base)
    expect(() => assertUniqueComment('203.0.113.3', '阿明', '好可愛！', base + WINDOW_MS)).not.toThrow()
  })

  it('pushes the window forward on every hit', () => {
    assertUniqueComment('203.0.113.4', '阿明', '好可愛！', base)
    expect(() => assertUniqueComment('203.0.113.4', '阿明', '好可愛！', base + WINDOW_MS - 1)).toThrowError(tooManyRequests)
    // 命中時若不順手把到期時間往後推，這一次就會落在最初的時窗之外被放行，
    // 等於教會洗版者「每十分鐘準時重送一次」就能繞過
    expect(() => assertUniqueComment('203.0.113.4', '阿明', '好可愛！', base + WINDOW_MS + 1)).toThrowError(tooManyRequests)
  })

  it('keys the fingerprint on source, nickname and message together', () => {
    assertUniqueComment('203.0.113.5', '阿明', '好可愛！', base)
    // 同一個 NAT 出口後面的另一個人、或同一個人換句話說，都不該被前一則卡住
    expect(() => assertUniqueComment('203.0.113.6', '阿明', '好可愛！', base)).not.toThrow()
    expect(() => assertUniqueComment('203.0.113.5', '小美', '好可愛！', base)).not.toThrow()
    expect(() => assertUniqueComment('203.0.113.5', '阿明', '好可愛喔！', base)).not.toThrow()
    expect(() => assertUniqueComment('203.0.113.5', '阿明', '好可愛！', base)).toThrowError(tooManyRequests)
  })

  it('falls back to the current clock when no timestamp is given', () => {
    assertUniqueComment('203.0.113.7', '阿明', '好可愛！')
    expect(() => assertUniqueComment('203.0.113.7', '阿明', '好可愛！')).toThrowError(tooManyRequests)
  })

  it('catches resubmissions that only differ before validation normalizes them', () => {
    const first = validateComment({ nickname: ' 阿明 ', message: ` caf${'e'}${chars(COMBINING_ACUTE)} 很可愛 ` })
    const second = validateComment({ nickname: '阿明', message: `caf${chars(0x00E9)} 很可愛` })
    expect(second).toEqual(first)

    assertUniqueComment('203.0.113.8', first.nickname, first.message, base)
    expect(() => assertUniqueComment('203.0.113.8', second.nickname, second.message, base)).toThrowError(tooManyRequests)
  })
})

describe('parseId', () => {
  it('accepts positive integer ids only', () => {
    expect(parseId('42')).toBe(42)
    expect(() => parseId('0')).toThrowError()
    expect(() => parseId('../1')).toThrowError()
  })
})
