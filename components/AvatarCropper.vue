<script setup lang="ts">
const emit = defineEmits<{ change: [file: File | null, preview: string | null] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const source = ref<HTMLImageElement | null>(null)
const preview = ref<string | null>(null)
const zoom = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const filename = ref('')
const error = ref('')

function draw() {
  const ctx = canvas.value?.getContext('2d')
  const image = source.value
  if (!ctx || !image || !canvas.value) return
  const size = canvas.value.width
  ctx.clearRect(0, 0, size, size)
  const base = Math.max(size / image.width, size / image.height)
  const scale = base * zoom.value
  const width = image.width * scale
  const height = image.height * scale
  const maxX = Math.max(0, (width - size) / 2)
  const maxY = Math.max(0, (height - size) / 2)
  const x = (size - width) / 2 + (offsetX.value / 100) * maxX
  const y = (size - height) / 2 + (offsetY.value / 100) * maxY
  ctx.drawImage(image, x, y, width, height)
  canvas.value.toBlob((blob) => {
    if (!blob) return
    if (preview.value) URL.revokeObjectURL(preview.value)
    preview.value = URL.createObjectURL(blob)
    emit('change', new File([blob], 'avatar.webp', { type: 'image/webp' }), preview.value)
  }, 'image/webp', 0.88)
}

function load(event: Event) {
  error.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return reset()
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    error.value = '請選擇 5MB 以內的 JPEG、PNG 或 WebP 圖片。'
    input.value = ''
    return reset(false)
  }
  const image = new Image()
  const objectUrl = URL.createObjectURL(file)
  image.onload = () => {
    URL.revokeObjectURL(objectUrl)
    source.value = image
    filename.value = file.name
    zoom.value = 1
    offsetX.value = 0
    offsetY.value = 0
    nextTick(draw)
  }
  image.onerror = () => {
    URL.revokeObjectURL(objectUrl)
    error.value = '圖片無法讀取，請換一張圖片。'
    reset(false)
  }
  image.src = objectUrl
}

function reset(clearError = true) {
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = null
  source.value = null
  filename.value = ''
  if (clearError) error.value = ''
  emit('change', null, null)
}

watch([zoom, offsetX, offsetY], draw)
onBeforeUnmount(() => { if (preview.value) URL.revokeObjectURL(preview.value) })
</script>

<template>
  <div class="avatar-cropper">
    <div v-if="!source" class="crop-upload">
      <label class="upload-drop compact-upload">
        <input type="file" accept="image/jpeg,image/png,image/webp" @change="load">
        <span class="upload-icon">◎</span><strong>上傳照片製作頭像</strong><small>會在瀏覽器裁切成方形 WebP</small>
      </label>
    </div>
    <div v-else class="crop-editor">
      <div class="crop-canvas-wrap"><canvas ref="canvas" width="320" height="320" aria-label="頭像裁切預覽" /></div>
      <div class="crop-controls">
        <strong>{{ filename }}</strong>
        <label>縮放 <input v-model.number="zoom" type="range" min="1" max="3" step="0.05"></label>
        <label>左右 <input v-model.number="offsetX" type="range" min="-100" max="100" step="1"></label>
        <label>上下 <input v-model.number="offsetY" type="range" min="-100" max="100" step="1"></label>
        <p class="crop-hint">調整滑桿，讓娃娃完整落在方形範圍內。</p>
        <button type="button" class="text-button danger" @click="reset()">移除自訂頭像</button>
      </div>
    </div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
  </div>
</template>
