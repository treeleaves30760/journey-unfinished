import { describe, expect, it } from 'vitest'
import { markdownToPlainText, parseMarkdown, safeHref, type MarkdownBlock, type MarkdownInline } from '../utils/markdown'

// 解析結果是一棵資料樹，斷言直接比對節點型別與文字內容——不是比對 HTML 字串。
// 這個差別就是整條 Markdown 路徑的安全前提：從解析到渲染都沒有任何一段字串被當成 HTML。
function text(nodes: MarkdownInline[]): string {
  return nodes.map(node => node.type === 'text' || node.type === 'code'
    ? node.value
    : node.type === 'break' ? '\n' : text(node.children)).join('')
}

function types(blocks: MarkdownBlock[]) {
  return blocks.map(block => block.type)
}

describe('parseMarkdown 區塊語法', () => {
  it('parses headings, paragraphs, lists, quotes, code fences and dividers', () => {
    const blocks = parseMarkdown([
      '# 竹林的清晨',
      '',
      '六點的竹林還沒有人。',
      '',
      '- 廣角鏡',
      '- 底片兩捲',
      '',
      '1. 先到渡月橋',
      '2. 再走竹林',
      '',
      '> 下次想在秋天再來。',
      '',
      '```',
      'ls -al',
      '```',
      '',
      '---'
    ].join('\n'))

    expect(types(blocks)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code', 'divider'])
  })

  it('starts user headings at h2 so the page keeps a single h1', () => {
    // 頁面上的 <h1> 是旅箋地點。使用者寫的 # 若也渲染成 h1，一頁會出現兩個一級標題，
    // 標題階層對輔助科技就失去意義了。
    const [first, second, third] = parseMarkdown('# 一級\n\n## 二級\n\n#### 四級')
    expect(first).toMatchObject({ type: 'heading', level: 2 })
    expect(second).toMatchObject({ type: 'heading', level: 3 })
    expect(third).toMatchObject({ type: 'heading', level: 4 })
  })

  it('keeps single line breaks inside a paragraph', () => {
    // 旅人寫遊記時的分行就是他要的分行，合併成一整段會破壞他排的節奏
    const [block] = parseMarkdown('第一行\n第二行')
    expect(block).toMatchObject({ type: 'paragraph' })
    expect(text((block as Extract<MarkdownBlock, { type: 'paragraph' }>).children)).toBe('第一行\n第二行')
  })

  it('keeps an ordered list start number', () => {
    const [block] = parseMarkdown('3. 第三站\n4. 第四站')
    expect(block).toMatchObject({ type: 'list', ordered: true, start: 3 })
  })

  it('treats an unterminated code fence as running to the end', () => {
    const [block] = parseMarkdown('```\nnpm run dev')
    expect(block).toMatchObject({ type: 'code', value: 'npm run dev' })
  })

  it('returns nothing for blank input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('   \n  \n')).toEqual([])
  })
})

describe('parseMarkdown 行內語法', () => {
  const inline = (source: string) => {
    const [block] = parseMarkdown(source)
    return (block as Extract<MarkdownBlock, { type: 'paragraph' }>).children
  }

  it('parses strong, em, del and inline code', () => {
    expect(inline('**粗** *斜* ~~刪~~ `碼`').map(node => node.type))
      .toEqual(['strong', 'text', 'em', 'text', 'del', 'text', 'code'])
  })

  it('leaves an unmatched marker as plain text instead of swallowing the rest', () => {
    // 找不到成對的結束符號時把後面整段吃掉，是自製解析器最常見的失敗模式
    expect(text(inline('2 * 3 = 6'))).toBe('2 * 3 = 6')
    expect(inline('2 * 3 = 6').every(node => node.type === 'text')).toBe(true)
    expect(text(inline('**沒有收尾'))).toBe('**沒有收尾')
  })

  it('honours backslash escapes', () => {
    expect(text(inline('\\*不要斜體\\*'))).toBe('*不要斜體*')
  })

  it('parses links and autolinks bare URLs', () => {
    const [link] = inline('[官網](https://example.com)')
    expect(link).toMatchObject({ type: 'link', href: 'https://example.com' })

    const bare = inline('詳見 https://example.com/a 這篇').find(node => node.type === 'link')
    expect(bare).toMatchObject({ type: 'link', href: 'https://example.com/a' })
  })

  it('does not eat trailing punctuation into an autolinked URL', () => {
    const nodes = inline('去了 https://example.com/a。')
    expect(nodes.find(node => node.type === 'link')).toMatchObject({ href: 'https://example.com/a' })
    expect(text(nodes)).toBe('去了 https://example.com/a。')
  })
})

// 這一組是安全回歸測試。留言是完全不可信的輸入，而解析器的輸出會直接進到渲染端。
describe('parseMarkdown 安全性', () => {
  it('never produces a node type that could carry raw HTML', () => {
    const blocks = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    // HTML 沒有被解析成任何結構，只是兩個普通段落——渲染端會把它當文字節點插入
    expect(types(blocks)).toEqual(['paragraph', 'paragraph'])
    expect(markdownToPlainText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
  })

  it.each([
    ['javascript:', '[點我](javascript:alert(1))'],
    ['大小寫混合的 javascript:', '[點我](JaVaScRiPt:alert(1))'],
    ['data:', '[點我](data:text/html;base64,PHNjcmlwdD4=)'],
    ['vbscript:', '[點我](vbscript:msgbox(1))'],
    ['協定相對網址', '[點我](//evil.example/x)']
  ])('refuses to build a link for %s', (_label, source) => {
    const [block] = parseMarkdown(source)
    const children = (block as Extract<MarkdownBlock, { type: 'paragraph' }>).children
    expect(children.some(node => node.type === 'link')).toBe(false)
    // 危險的 scheme 不是被消音，而是整段保留成文字，讀者仍然看得到原文
    expect(text(children)).toBe(source)
  })

  it('allows http, https, mailto and same-site paths only', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a')
    expect(safeHref('http://example.com')).toBe('http://example.com')
    expect(safeHref('mailto:hi@example.com')).toBe('mailto:hi@example.com')
    expect(safeHref('/checkins/12')).toBe('/checkins/12')
    expect(safeHref('//evil.example')).toBeNull()
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('example.com')).toBeNull()
    expect(safeHref('')).toBeNull()
  })

  it('bounds nesting instead of recursing until the stack overflows', () => {
    // 一行 2000 個 '>' 若每層遞迴一次就是 2000 層呼叫堆疊；上限讓它退化成普通段落
    expect(() => parseMarkdown('>'.repeat(2000) + ' 深巢狀')).not.toThrow()
    expect(() => parseMarkdown('*'.repeat(1000) + '文字' + '*'.repeat(1000))).not.toThrow()
  })

  it('parses a full-length message quickly', () => {
    // 沒有巢狀量詞就不會有回溯爆炸。這裡用實際上限的內容確認整體是線性等級。
    const source = '## 標題\n\n- 項目 **重點** 與 `碼` 還有 [連結](https://example.com)\n'.repeat(30)
    const started = performance.now()
    parseMarkdown(source)
    expect(performance.now() - started).toBeLessThan(300)
  })
})

describe('markdownToPlainText', () => {
  it('strips syntax for card excerpts and meta descriptions', () => {
    expect(markdownToPlainText('## 竹林的清晨\n\n六點的竹林**還沒有人**。'))
      .toBe('竹林的清晨 六點的竹林還沒有人。')
  })

  it('truncates with an ellipsis at the requested length', () => {
    const long = markdownToPlainText('走'.repeat(200), 20)
    expect(long).toHaveLength(21)
    expect(long.endsWith('…')).toBe(true)
    expect(markdownToPlainText('短句', 20)).toBe('短句')
  })

  it('keeps list items readable instead of gluing them together', () => {
    // 項目之間先接上全形空白，最後的空白正規化再把它收成一個半形空白——
    // 重點是「廣角鏡底片兩捲」這種黏在一起的結果不會出現在卡片摘要上。
    expect(markdownToPlainText('- 廣角鏡\n- 底片兩捲')).toBe('廣角鏡 底片兩捲')
  })
})
