<script setup lang="ts">
/**
 * 點開照片看完整構圖。詳情頁的照片是 object-fit: cover 的裁切結果——直向照片與廣角風景
 * 在版面裡只看得到中間那一塊，想看全張以前只能自己開圖片網址。這個元件補的就是那一步：
 * 整張圖 contain 在畫面裡，不裁切、也不放大超過原尺寸。
 */
const props = withDefaults(defineProps<{
  open: boolean
  src: string
  alt?: string
  caption?: string
}>(), { alt: '', caption: '' })

const emit = defineEmits<{ close: [] }>()

const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLElement | null>(null)
// 開啟前的焦點位置。關閉時要還回去，鍵盤使用者才不會被丟回頁面最上面重新找一次。
let previouslyFocused: HTMLElement | null = null

function close() {
  emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  // 這層裡唯一可聚焦的是關閉鈕，所以「困住 Tab」只需要把它轉回那顆按鈕。
  // 不做的話 Tab 會走到背後那頁的連結上，畫面被遮住卻在操作看不見的東西。
  if (event.key === 'Tab') {
    event.preventDefault()
    closeButton.value?.focus()
  }
}

watch(() => props.open, (open) => {
  if (open) {
    previouslyFocused = document.activeElement as HTMLElement | null
    // 背景不能跟著捲：手機上放大看圖時的滑動應該只作用在圖片層
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeydown)
    nextTick(() => (closeButton.value || dialog.value)?.focus())
  } else {
    document.body.style.overflow = ''
    document.removeEventListener('keydown', onKeydown)
    previouslyFocused?.focus?.()
    previouslyFocused = null
  }
})

// 卸載時（例如還開著就換頁）一定要還原 body 的捲動，否則整個站會停在
// 「捲不動」的狀態，而且從畫面上完全看不出是誰造成的。
onBeforeUnmount(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <ClientOnly>
    <Teleport to="body">
      <Transition name="lightbox">
        <div
          v-if="props.open"
          ref="dialog"
          class="photo-lightbox"
          role="dialog"
          aria-modal="true"
          :aria-label="props.alt || '放大檢視照片'"
          tabindex="-1"
          @click.self="close"
        >
          <button ref="closeButton" class="lightbox-close" type="button" aria-label="關閉放大檢視" @click="close">×</button>
          <img :src="props.src" :alt="props.alt" @click.stop>
          <p v-if="props.caption" class="lightbox-caption">{{ props.caption }}</p>
        </div>
      </Transition>
    </Teleport>
  </ClientOnly>
</template>
