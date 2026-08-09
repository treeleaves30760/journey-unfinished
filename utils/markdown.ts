/**
 * 旅途留言的 Markdown 子集解析器：輸出一棵資料樹，交給 MarkdownView.vue 用 Vue 的
 * `h()` 渲染成真正的節點。
 *
 * 為什麼不用現成的 Markdown 套件？因為它們的輸出是 HTML 字串，要顯示就得走 `v-html`，
 * 於是整條路徑的安全性取決於「有沒有正確接上 sanitizer」——而使用者留言是完全不可信的
 * 輸入。這裡改成「永遠不產生 HTML 字串」：解析結果只有節點型別與純文字，渲染端把文字
 * 當成文字節點插入，就算有人寫 `<script>` 或 `<img onerror=...>`，也只會原樣顯示成字，
 * 因為從頭到尾沒有任何一段字串被當成 HTML 解析過。
 *
 * 支援的語法刻意保持在「遊記寫得順手」的範圍：標題、清單、引言、粗體／斜體／刪除線、
 * 行內程式碼、程式碼區塊、分隔線、連結。刻意不支援圖片（照片走上傳流程，外部圖片會
 * 被 CSP 擋下，還會把讀者的 IP 洩漏給第三方）與原始 HTML。
 */

export type MarkdownInline =
  | { type: 'text', value: string }
  | { type: 'strong', children: MarkdownInline[] }
  | { type: 'em', children: MarkdownInline[] }
  | { type: 'del', children: MarkdownInline[] }
  | { type: 'code', value: string }
  | { type: 'link', href: string, children: MarkdownInline[] }
  | { type: 'break' }

export type MarkdownBlock =
  | { type: 'heading', level: 2 | 3 | 4, children: MarkdownInline[] }
  | { type: 'paragraph', children: MarkdownInline[] }
  | { type: 'list', ordered: boolean, start: number, items: MarkdownInline[][] }
  | { type: 'quote', children: MarkdownBlock[] }
  | { type: 'code', value: string }
  | { type: 'divider' }

// 只放行這三種 scheme。javascript:、data:、vbscript: 都會被擋在外面，
// 也不替沒有 scheme 的字串補上 https://——猜錯目標比不做連結更糟。
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])
const ESCAPABLE = new Set(['\\', '`', '*', '_', '~', '[', ']', '(', ')', '#', '-', '+', '.', '!', '>'])
// 引言可以包引言，但每一層只吃掉一個 '>'。沒有上限的話，一行 2000 個 '>' 就是一次
// 2000 層的遞迴，足以把呼叫堆疊打爆。三層對遊記來說遠遠夠用。
const MAX_QUOTE_DEPTH = 3
// 行內語法同理：**粗體裡的*斜體*** 這種正常寫法一兩層就夠，超過就當普通文字。
const MAX_INLINE_DEPTH = 6

export function safeHref(raw: string): string | null {
  const value = raw.trim()
  if (!value || /[\s<>"']/.test(value)) return null
  // 站內相對路徑（單斜線開頭）。`//host` 是協定相對網址，會跳去外站，不放行。
  if (value.startsWith('/') && !value.startsWith('//')) return value
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  return scheme && SAFE_SCHEMES.has(scheme) ? value : null
}

// 自動連結時常把句末標點吃進網址；括號要成對才算數，才不會讓「（詳見 https://a.example）」
// 把全形以外的收尾括號誤收進去。
function trimUrlTail(url: string) {
  let end = url.length
  while (end > 0) {
    const char = url[end - 1]!
    if ('.,;:!?、。，；：！？'.includes(char)) { end -= 1; continue }
    if (char === ')') {
      const slice = url.slice(0, end)
      const opens = (slice.match(/\(/g) || []).length
      const closes = (slice.match(/\)/g) || []).length
      if (closes > opens) { end -= 1; continue }
    }
    break
  }
  return url.slice(0, end)
}

const BARE_URL = /https?:\/\/[^\s<>"'`]+/g

/** 純文字片段裡的裸網址也做成連結；使用者不會為了貼一個網址特地寫 `[]()`。 */
function autolink(text: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = []
  let lastIndex = 0
  BARE_URL.lastIndex = 0
  for (let match = BARE_URL.exec(text); match; match = BARE_URL.exec(text)) {
    const url = trimUrlTail(match[0])
    const href = safeHref(url)
    if (!href) continue
    if (match.index > lastIndex) nodes.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    nodes.push({ type: 'link', href, children: [{ type: 'text', value: url }] })
    lastIndex = match.index + url.length
    BARE_URL.lastIndex = lastIndex
  }
  if (lastIndex < text.length) nodes.push({ type: 'text', value: text.slice(lastIndex) })
  return nodes
}

/**
 * 行內語法用手寫掃描器而不是正則：巢狀的量詞很容易寫出會回溯爆炸的樣式，
 * 而這段程式碼要處理的是任何人都能送進來的字串。掃描器每個字元只看一次，
 * 最壞情況是線性的。找不到成對的結束符號時，該符號就當普通文字，不會吃掉後面的內容。
 */
function parseInline(source: string, depth = 0): MarkdownInline[] {
  const nodes: MarkdownInline[] = []
  let buffer = ''
  let index = 0

  const flush = () => {
    if (!buffer) return
    nodes.push(...autolink(buffer))
    buffer = ''
  }
  const nested = (inner: string) => depth >= MAX_INLINE_DEPTH
    ? [{ type: 'text', value: inner } as MarkdownInline]
    : parseInline(inner, depth + 1)

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (char === '\\' && next && ESCAPABLE.has(next)) {
      buffer += next
      index += 2
      continue
    }

    if (char === '`') {
      const close = source.indexOf('`', index + 1)
      if (close > index) {
        flush()
        nodes.push({ type: 'code', value: source.slice(index + 1, close) })
        index = close + 1
        continue
      }
    }

    const marker = (char === '*' || char === '_') && next === char
      ? { token: char + char, type: 'strong' as const }
      : char === '~' && next === '~'
        ? { token: '~~', type: 'del' as const }
        : (char === '*' || char === '_')
          ? { token: char, type: 'em' as const }
          : null

    if (marker) {
      const close = source.indexOf(marker.token, index + marker.token.length)
      const inner = close > index ? source.slice(index + marker.token.length, close) : ''
      // 內容不能是空的，否則 `****` 這種輸入會產生空節點；也不能以空白開頭，
      // 那通常是乘號或底線本身，不是強調語法。
      if (close > index && inner.trim() && !/^\s/.test(inner)) {
        flush()
        nodes.push({ type: marker.type, children: nested(inner) })
        index = close + marker.token.length
        continue
      }
    }

    if (char === '[') {
      const labelEnd = source.indexOf(']', index + 1)
      if (labelEnd > index && source[labelEnd + 1] === '(') {
        const hrefEnd = source.indexOf(')', labelEnd + 2)
        if (hrefEnd > labelEnd) {
          const label = source.slice(index + 1, labelEnd)
          const href = safeHref(source.slice(labelEnd + 2, hrefEnd))
          if (href && label.trim()) {
            flush()
            nodes.push({ type: 'link', href, children: nested(label) })
            index = hrefEnd + 1
            continue
          }
        }
      }
    }

    buffer += char
    index += 1
  }

  flush()
  return nodes
}

/** 段落內的單一換行保留成 <br>：旅人寫遊記時的分行就是他要的分行，不該被合併掉。 */
function parseParagraphLines(lines: string[]): MarkdownInline[] {
  return lines.flatMap((line, index) => index === 0
    ? parseInline(line)
    : [{ type: 'break' } as MarkdownInline, ...parseInline(line)])
}

const HEADING = /^(#{1,6})\s+(.*)$/
const DIVIDER = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const BULLET = /^[-*+]\s+(.*)$/
const ORDERED = /^(\d{1,9})[.)]\s+(.*)$/
const FENCE = /^```/

function parseBlocks(lines: string[], depth: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!
    const trimmed = line.trim()

    if (!trimmed) { index += 1; continue }

    if (FENCE.test(trimmed)) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index]!.trim())) {
        body.push(lines[index]!)
        index += 1
      }
      // 沒有收尾的 ``` 一樣成立（等於「寫到最後」），不然使用者打到一半就會看到整段跑掉
      index += 1
      blocks.push({ type: 'code', value: body.join('\n') })
      continue
    }

    if (DIVIDER.test(trimmed)) {
      blocks.push({ type: 'divider' })
      index += 1
      continue
    }

    const heading = HEADING.exec(trimmed)
    if (heading) {
      // 頁面上的 <h1> 是旅箋地點，使用者寫的 # 從 h2 起跳，標題階層才不會斷層。
      const level = Math.min(heading[1]!.length + 1, 4) as 2 | 3 | 4
      blocks.push({ type: 'heading', level, children: parseInline(heading[2]!.trim()) })
      index += 1
      continue
    }

    if (trimmed.startsWith('>')) {
      const body: string[] = []
      while (index < lines.length && lines[index]!.trim().startsWith('>')) {
        body.push(lines[index]!.trim().replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(depth >= MAX_QUOTE_DEPTH
        ? { type: 'paragraph', children: parseParagraphLines(body) }
        : { type: 'quote', children: parseBlocks(body, depth + 1) })
      continue
    }

    const bullet = BULLET.exec(trimmed)
    const ordered = ORDERED.exec(trimmed)
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered)
      const start = ordered ? Number(ordered[1]) : 1
      const items: MarkdownInline[][] = []
      while (index < lines.length) {
        const current = lines[index]!.trim()
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current)
        if (!match) break
        items.push(parseInline((isOrdered ? match[2] : match[1])!.trim()))
        index += 1
      }
      blocks.push({ type: 'list', ordered: isOrdered, start, items })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index]!
      const currentTrimmed = current.trim()
      if (!currentTrimmed || HEADING.test(currentTrimmed) || DIVIDER.test(currentTrimmed)
        || FENCE.test(currentTrimmed) || currentTrimmed.startsWith('>')
        || BULLET.test(currentTrimmed) || ORDERED.test(currentTrimmed)) break
      paragraph.push(currentTrimmed)
      index += 1
    }
    blocks.push({ type: 'paragraph', children: parseParagraphLines(paragraph) })
  }

  return blocks
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const text = String(source ?? '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return []
  return parseBlocks(text.split('\n'), 0)
}

function inlineText(nodes: MarkdownInline[]): string {
  return nodes.map((node) => {
    if (node.type === 'text' || node.type === 'code') return node.value
    if (node.type === 'break') return ' '
    return inlineText(node.children)
  }).join('')
}

function blockText(blocks: MarkdownBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'divider') return ''
    if (block.type === 'code') return block.value
    if (block.type === 'list') return block.items.map(inlineText).join('　')
    if (block.type === 'quote') return blockText(block.children)
    return inlineText(block.children)
  }).filter(Boolean).join('\n')
}

/**
 * 卡片摘要、地圖提示與 <meta description> 用的純文字版本。
 * 這些地方要的是「一段可讀的句子」，直接塞原始 Markdown 會看到 `##`、`**` 之類的符號。
 */
export function markdownToPlainText(source: string, limit = 0): string {
  const text = blockText(parseMarkdown(source)).replace(/\s+/g, ' ').trim()
  if (!limit || text.length <= limit) return text
  return `${text.slice(0, limit).trimEnd()}…`
}
