<script lang="ts">
import { computed, defineComponent, h, type PropType, type VNode } from 'vue'
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from '~/utils/markdown'

/**
 * 把 parseMarkdown 產出的資料樹渲染成真正的 DOM 節點。
 *
 * 這裡是整條 Markdown 路徑的安全關鍵：全程使用 `h()` 與文字節點，沒有任何一處
 * `v-html` 或 innerHTML。使用者寫的 `<script>` 會被 Vue 當成文字內容輸出，
 * 因此不需要（也不依賴）任何 HTML sanitizer。連結的 href 則在 parseMarkdown 的
 * safeHref 就限定成 http/https/mailto 與站內相對路徑。
 *
 * 寫成 render function 而不是 <template> 的原因很單純：Markdown 是遞迴結構，
 * 用模板要嘛做成互相引用的元件，要嘛回頭用 v-html——前者複雜，後者正是要避免的。
 */
function renderInline(node: MarkdownInline): VNode | string {
  switch (node.type) {
    case 'text': return node.value
    case 'break': return h('br')
    case 'code': return h('code', node.value)
    case 'strong': return h('strong', node.children.map(renderInline))
    case 'em': return h('em', node.children.map(renderInline))
    case 'del': return h('del', node.children.map(renderInline))
    case 'link': {
      // 站內連結留在同一個分頁；外部連結一律新分頁開啟，並補上 noopener（避免被
      // window.opener 反向操作）與 nofollow（旅箋留言不替外站背書）。
      const external = !node.href.startsWith('/')
      return h('a', {
        href: node.href,
        ...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})
      }, node.children.map(renderInline))
    }
  }
}

function renderBlock(block: MarkdownBlock): VNode {
  switch (block.type) {
    case 'heading': return h(`h${block.level}`, block.children.map(renderInline))
    case 'paragraph': return h('p', block.children.map(renderInline))
    case 'divider': return h('hr')
    case 'code': return h('pre', [h('code', block.value)])
    case 'quote': return h('blockquote', block.children.map(renderBlock))
    case 'list': return h(
      block.ordered ? 'ol' : 'ul',
      block.ordered && block.start !== 1 ? { start: block.start } : {},
      block.items.map(item => h('li', item.map(renderInline)))
    )
  }
}

export default defineComponent({
  name: 'MarkdownView',
  props: {
    source: { type: String as PropType<string>, default: '' },
    /** 讓呼叫端補上自己的樣式修飾（例如卡片上的緊湊版） */
    variant: { type: String as PropType<string>, default: '' }
  },
  setup(props) {
    const blocks = computed(() => parseMarkdown(props.source))
    return () => h(
      'div',
      { class: ['markdown-body', props.variant && `markdown-${props.variant}`] },
      blocks.value.map(renderBlock)
    )
  }
})
</script>
