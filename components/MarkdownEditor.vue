<script setup lang="ts">
const props = withDefaults(defineProps<{
  modelValue: string
  maxlength?: number
  rows?: number
  placeholder?: string
  fieldId?: string
  required?: boolean
}>(), {
  maxlength: 2000,
  rows: 10,
  placeholder: '',
  fieldId: 'markdown-message',
  required: false
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

type Mode = 'write' | 'preview' | 'split'

const textarea = ref<HTMLTextAreaElement | null>(null)
const mode = ref<Mode>('write')
const canSplit = ref(false)
let wideScreen: MediaQueryList | null = null

// NFC 之後才量長度，跟伺服器端的驗證同一把尺（見 server/utils/validation.ts 的 safeText）。
// 少了這一步，畫面顯示「還可以再寫 20 字」但送出被擋，使用者完全找不到原因。
const length = computed(() => props.modelValue.normalize('NFC').length)
const remaining = computed(() => props.maxlength - length.value)

const toolbar = [
  { key: 'bold', label: '粗體', icon: 'B', hint: '粗體（Ctrl/⌘+B）' },
  { key: 'italic', label: '斜體', icon: 'I', hint: '斜體（Ctrl/⌘+I）' },
  { key: 'heading', label: '小標', icon: 'H', hint: '插入小標題' },
  { key: 'list', label: '清單', icon: '≔', hint: '項目清單' },
  { key: 'quote', label: '引言', icon: '❝', hint: '引言區塊' },
  { key: 'link', label: '連結', icon: '🔗', hint: '插入連結' }
] as const

type ToolbarKey = typeof toolbar[number]['key']

function applyEdit(next: string, selectionStart: number, selectionEnd: number) {
  emit('update:modelValue', next)
  // 等 v-model 把新值寫回 textarea 之後再還原選取範圍，否則游標會被沖到最後面，
  // 連續套用兩個格式（先粗體再斜體）就變得不可能。
  nextTick(() => {
    const element = textarea.value
    if (!element) return
    element.focus()
    element.setSelectionRange(selectionStart, selectionEnd)
  })
}

function wrapSelection(token: string, placeholder: string) {
  const element = textarea.value
  if (!element) return
  const { selectionStart: start, selectionEnd: end } = element
  const value = props.modelValue
  const selected = value.slice(start, end) || placeholder
  const next = `${value.slice(0, start)}${token}${selected}${token}${value.slice(end)}`
  applyEdit(next, start + token.length, start + token.length + selected.length)
}

function prefixLines(prefix: string | ((index: number) => string)) {
  const element = textarea.value
  if (!element) return
  const value = props.modelValue
  const lineStart = value.lastIndexOf('\n', Math.max(0, element.selectionStart - 1)) + 1
  const lineEnd = value.indexOf('\n', element.selectionEnd)
  const blockEnd = lineEnd === -1 ? value.length : lineEnd
  const block = value.slice(lineStart, blockEnd) || ''
  const prefixed = block.split('\n')
    .map((line, index) => `${typeof prefix === 'string' ? prefix : prefix(index)}${line}`)
    .join('\n')
  const next = `${value.slice(0, lineStart)}${prefixed}${value.slice(blockEnd)}`
  applyEdit(next, lineStart, lineStart + prefixed.length)
}

function insertLink() {
  const element = textarea.value
  if (!element) return
  const { selectionStart: start, selectionEnd: end } = element
  const value = props.modelValue
  const label = value.slice(start, end) || '連結文字'
  const snippet = `[${label}](https://)`
  const next = `${value.slice(0, start)}${snippet}${value.slice(end)}`
  // 游標停在網址的位置，貼上網址就完成，不必自己找地方點
  applyEdit(next, start + label.length + 3, start + snippet.length - 1)
}

function runCommand(key: ToolbarKey) {
  if (mode.value === 'preview') mode.value = 'write'
  if (key === 'bold') return wrapSelection('**', '粗體文字')
  if (key === 'italic') return wrapSelection('*', '斜體文字')
  if (key === 'heading') return prefixLines('## ')
  if (key === 'list') return prefixLines('- ')
  if (key === 'quote') return prefixLines('> ')
  return insertLink()
}

function handleShortcut(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return
  const key = event.key.toLowerCase()
  if (key !== 'b' && key !== 'i') return
  event.preventDefault()
  runCommand(key === 'b' ? 'bold' : 'italic')
}

function syncWideScreen(matches: boolean) {
  canSplit.value = matches
  // 視窗縮小到放不下並排時要主動退回單欄，否則使用者會停在一個只剩半截的版面上
  if (!matches && mode.value === 'split') mode.value = 'write'
}

// 具名函式而不是行內箭頭：removeEventListener 認的是同一個函式參照，
// 傳一個新建的箭頭函式等於沒有移除，元件反覆掛載時會累積監聽器。
function handleWideScreenChange(event: MediaQueryListEvent) {
  syncWideScreen(event.matches)
}

onMounted(() => {
  wideScreen = window.matchMedia('(min-width: 960px)')
  syncWideScreen(wideScreen.matches)
  wideScreen.addEventListener('change', handleWideScreenChange)
})
onBeforeUnmount(() => wideScreen?.removeEventListener('change', handleWideScreenChange))

const modes = computed(() => [
  { id: 'write' as const, label: '編輯' },
  { id: 'preview' as const, label: '預覽' },
  ...(canSplit.value ? [{ id: 'split' as const, label: '並排' }] : [])
])
</script>

<template>
  <div class="markdown-editor" :class="`mode-${mode}`">
    <div class="markdown-toolbar">
      <div class="markdown-tools" role="group" aria-label="Markdown 格式">
        <button
          v-for="item in toolbar"
          :key="item.key"
          type="button"
          :title="item.hint"
          :aria-label="item.hint"
          @click="runCommand(item.key)"
        >{{ item.icon }}</button>
      </div>
      <div class="markdown-modes" role="tablist" aria-label="編輯與預覽切換">
        <button
          v-for="item in modes"
          :key="item.id"
          type="button"
          role="tab"
          :class="{ active: mode === item.id }"
          :aria-selected="mode === item.id"
          @click="mode = item.id"
        >{{ item.label }}</button>
      </div>
    </div>

    <div class="markdown-panes">
      <textarea
        v-show="mode !== 'preview'"
        :id="fieldId"
        ref="textarea"
        :value="modelValue"
        :rows="rows"
        :maxlength="maxlength"
        :required="required"
        :placeholder="placeholder"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @keydown="handleShortcut"
      />
      <div v-show="mode !== 'write'" class="markdown-preview" aria-live="polite">
        <MarkdownView v-if="modelValue.trim()" :source="modelValue" />
        <p v-else class="markdown-preview-empty">預覽會顯示在這裡。試試 <code>## 小標</code>、<code>- 清單</code> 或 <code>**重點**</code>。</p>
      </div>
    </div>

    <div class="markdown-footer">
      <small class="markdown-hint">支援 Markdown：<code>**粗體**</code>、<code>*斜體*</code>、<code>## 小標</code>、<code>- 清單</code>、<code>&gt; 引言</code>、<code>[文字](網址)</code></small>
      <small class="counter" :class="{ 'is-over': remaining < 0 }">{{ length }} / {{ maxlength }}</small>
    </div>
  </div>
</template>
