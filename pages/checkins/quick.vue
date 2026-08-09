<script setup lang="ts">
import type { Draft } from '~/composables/useCheckins'
import type { PlaceValue } from '~/components/LocationPicker.vue'

definePageMeta({ middleware: 'auth' })

/**
 * 手機上的快速記錄：站在景點前面，三個動作就收工——拍照、確認位置、存草稿。
 * 剩下的（作品出處、完整心得、頭像裁切）留到回家用電腦打開同一份草稿慢慢寫。
 * 因此這一頁刻意不要求任何「寫作」欄位，也不做發佈：它的產出永遠是一份草稿。
 */
const { user } = useAuth()

// 必須是 ref 而不是 reactive：v-model 展開成「整個物件重新指派」，
// LocationPicker 每次更新都送回一個新物件，reactive 的 const 綁定接不住這種指派。
const place = ref<PlaceValue>({
  location: '', countryCode: DEFAULT_COUNTRY_CODE, county: '', latitude: null, longitude: null
})
const dollName = ref('')
const note = ref('')
const photo = ref<File | null>(null)
const photoPreview = ref<string | null>(null)
const photoError = ref('')
const saving = ref(false)
const saveError = ref('')
const savedDraft = ref<Draft | null>(null)

const hasLocation = computed(() => place.value.latitude !== null && place.value.longitude !== null)
const canSave = computed(() => Boolean(photo.value) || hasLocation.value)

function choosePhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] || null
  photoError.value = ''
  saveError.value = ''
  if (file && (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) {
    photoError.value = '照片須為 5MB 內的 JPEG、PNG 或 WebP。'
    input.value = ''
    return
  }
  if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
  photo.value = file
  photoPreview.value = file ? URL.createObjectURL(file) : null
}

function todayInput() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

async function saveDraft() {
  if (saving.value || !canSave.value) return
  saving.value = true
  saveError.value = ''
  const body = new FormData()
  // 暱稱與日期在這裡就填好，回到電腦打開草稿時已經是「只剩故事要寫」的狀態
  if (user.value) body.append('nickname', user.value.displayName.slice(0, 30))
  body.append('visitedAt', todayInput())
  body.append('countryCode', place.value.countryCode)
  if (place.value.location.trim()) body.append('location', place.value.location.trim())
  if (place.value.county.trim()) body.append('county', place.value.county.trim())
  if (place.value.latitude !== null) body.append('latitude', String(place.value.latitude))
  if (place.value.longitude !== null) body.append('longitude', String(place.value.longitude))
  if (dollName.value.trim()) body.append('dollName', dollName.value.trim())
  if (note.value.trim()) body.append('message', note.value.trim())
  if (photo.value) body.append('photo', photo.value)

  try {
    const { draft } = await $fetch<{ draft: Draft }>('/api/drafts', { method: 'POST', body })
    savedDraft.value = draft
    if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
    photoPreview.value = null
    photo.value = null
  } catch (error) {
    saveError.value = errorMessage(error, '草稿儲存失敗，請確認網路後再試一次。')
  } finally {
    saving.value = false
  }
}

function recordAnother() {
  savedDraft.value = null
  dollName.value = ''
  note.value = ''
  place.value = { location: '', countryCode: place.value.countryCode, county: '', latitude: null, longitude: null }
}

onBeforeUnmount(() => { if (photoPreview.value) URL.revokeObjectURL(photoPreview.value) })
useHead({ title: '快速記錄｜未完旅箋' })
</script>

<template>
  <main id="main-content" class="quick-page">
    <section class="quick-head">
      <NuxtLink class="back-link" to="/">← 回到探索地圖</NuxtLink>
      <span class="eyebrow">QUICK CAPTURE</span>
      <h1>就在這裡，先記下來</h1>
      <p>拍一張、確認位置，就存成草稿。回家再用電腦把故事寫完。</p>
    </section>

    <div v-if="savedDraft" class="quick-saved" role="status">
      <span class="notice-icon" aria-hidden="true">✓</span>
      <h2>草稿已存好</h2>
      <p>登入同一個帳號，就能在任何裝置上打開它繼續寫。</p>
      <div class="quick-saved-actions">
        <NuxtLink class="primary-button" :to="`/checkins/new?draft=${savedDraft.id}`">現在就寫完 →</NuxtLink>
        <button class="secondary-button" type="button" @click="recordAnother">再記下一個地點</button>
        <NuxtLink class="text-link" to="/drafts">查看我的草稿</NuxtLink>
      </div>
    </div>

    <template v-else>
      <div v-if="saveError" class="alert error-alert" role="alert"><strong>沒能存成草稿</strong><span>{{ saveError }}</span></div>

      <section class="quick-step">
        <h2><span>01</span>拍下這一刻</h2>
        <label class="upload-drop quick-capture" :class="{ 'has-preview': photoPreview, 'has-error': photoError }">
          <!-- capture 讓手機直接開相機，而不是先跳進相簿再找檔案 -->
          <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" @change="choosePhoto">
          <img v-if="photoPreview" :src="photoPreview" alt="剛拍下的照片預覽">
          <span v-if="photoPreview" class="upload-change">重拍或換一張</span>
          <template v-else><span class="upload-icon">▣</span><strong>開啟相機</strong><small>也可以從相簿挑一張</small></template>
        </label>
        <p v-if="photoError" class="field-error" role="alert">{{ photoError }}</p>
      </section>

      <section class="quick-step">
        <h2><span>02</span>標上位置</h2>
        <ClientOnly>
          <LocationPicker v-model="place" />
          <template #fallback>
            <div class="picker-map-loading" role="status"><i class="loader" />正在載入地圖…</div>
          </template>
        </ClientOnly>
      </section>

      <section class="quick-step">
        <h2><span>03</span>順手記兩句 <small>選填</small></h2>
        <div class="field-grid two">
          <label class="field"><span>娃娃名稱</span><input v-model.trim="dollName" maxlength="40" placeholder="例如：暖暖"></label>
          <label class="field"><span>一句話備忘</span><input v-model.trim="note" maxlength="200" placeholder="風很大、夕陽剛好…"></label>
        </div>
      </section>

      <div class="quick-actions">
        <p v-if="!canSave" class="quick-hint">先拍一張照片或標好位置，就可以存草稿了。</p>
        <button class="primary-button" type="button" :disabled="!canSave || saving" @click="saveDraft">
          <i v-if="saving" class="button-loader" />{{ saving ? '儲存中…' : '存成草稿' }}
        </button>
        <NuxtLink class="text-link" to="/checkins/new">或直接寫完整旅箋</NuxtLink>
      </div>
    </template>
  </main>
</template>
