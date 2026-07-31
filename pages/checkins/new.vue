<script setup lang="ts">
definePageMeta({ middleware: 'auth' })
const router = useRouter()
const { user } = useAuth()

function taiwanDateInput() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

const today = taiwanDateInput()
const form = reactive({
  nickname: '', location: '', county: '', latitude: null as number | null, longitude: null as number | null,
  dollName: '', message: '', visitedAt: today, avatarPreset: 'sun'
})
const photoInput = ref<HTMLInputElement | null>(null)
const photo = ref<File | null>(null)
const photoPreview = ref<string | null>(null)
const avatar = ref<File | null>(null)
const avatarPreview = ref<string | null>(null)
const submitting = ref(false)
const locating = ref(false)
const submitError = ref('')
const photoError = ref('')
const coordinateStatus = ref('')

const stepCompletion = computed(() => [
  Boolean(form.nickname && form.dollName),
  Boolean(form.location && form.county && form.latitude !== null && form.longitude !== null),
  Boolean(form.visitedAt && form.message && photo.value)
])
const completedSteps = computed(() => stepCompletion.value.filter(Boolean).length)

watch(user, (value) => {
  if (value && !form.nickname) form.nickname = value.displayName.slice(0, 30)
}, { immediate: true })

function choosePhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] || null
  submitError.value = ''
  photoError.value = ''
  if (file && (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) {
    photoError.value = `旅途照片須為 5MB 內的 JPEG、PNG 或 WebP。${photo.value ? '原先選擇的照片仍保留。' : ''}`
    input.value = ''
    return
  }
  if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
  photo.value = file
  photoPreview.value = file ? URL.createObjectURL(file) : null
}

function useCurrentLocation() {
  coordinateStatus.value = ''
  if (!navigator.geolocation) {
    coordinateStatus.value = '這個瀏覽器不支援定位，請手動貼上座標。'
    return
  }
  locating.value = true
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    locating.value = false
    if (coords.latitude < 20 || coords.latitude > 27 || coords.longitude < 118 || coords.longitude > 123) {
      coordinateStatus.value = '目前位置不在可接受的臺灣範圍內，請手動輸入旅途地點。'
      return
    }
    form.latitude = Number(coords.latitude.toFixed(6))
    form.longitude = Number(coords.longitude.toFixed(6))
    coordinateStatus.value = '已帶入目前位置，送出前請確認是照片拍攝的地點。'
  }, () => {
    locating.value = false
    coordinateStatus.value = '無法取得定位權限，請手動貼上座標。'
  }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 })
}

function setAvatar(file: File | null, preview: string | null) {
  avatar.value = file
  avatarPreview.value = preview
}

async function submit() {
  if (submitting.value) return
  submitError.value = ''
  if (!photo.value) {
    photoError.value = '請先選擇一張旅途照片。'
    nextTick(() => photoInput.value?.focus())
    return
  }
  submitting.value = true
  const body = new FormData()
  Object.entries(form).forEach(([key, value]) => body.append(key, String(value)))
  if (photo.value) body.append('photo', photo.value)
  if (avatar.value) body.append('avatar', avatar.value)
  try {
    const response = await $fetch<{ checkin: { id: number } }>('/api/checkins', { method: 'POST', body })
    await router.push(`/checkins/${response.checkin.id}?created=1`)
  } catch (error) {
    const statusCode = (error as { statusCode?: number, response?: { status?: number } })?.statusCode
      || (error as { response?: { status?: number } })?.response?.status
    if (statusCode === 401) {
      await router.push('/login?redirect=/checkins/new')
      return
    }
    submitError.value = errorMessage(error, '旅箋儲存失敗，請確認欄位後重試。')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } finally {
    submitting.value = false
  }
}

onBeforeUnmount(() => { if (photoPreview.value) URL.revokeObjectURL(photoPreview.value) })
useHead({ title: '寫下這一站｜未完旅箋' })
</script>

<template>
  <main id="main-content" class="form-page">
    <section class="form-intro">
      <NuxtLink class="back-link" to="/">← 回到探索地圖</NuxtLink>
      <span class="eyebrow">A NEW PAGE</span>
      <h1>寫下這一站</h1>
      <p>填入你們共同走過的地方、上傳一張照片，讓這一頁出現在旅途地圖上。</p>
    </section>

    <div v-if="submitError" class="alert error-alert" role="alert"><strong>無法寫下旅箋</strong><span>{{ submitError }}</span></div>

    <div class="form-layout">
      <form class="checkin-form" @submit.prevent="submit">
        <section class="form-card">
          <div class="form-card-heading"><span>01</span><div><h2>旅人與娃娃</h2><p>先介紹這趟旅行的主角吧。</p></div></div>
          <div class="field-grid two">
            <label class="field"><span>你的暱稱 <b>*</b></span><input v-model.trim="form.nickname" required maxlength="30" autocomplete="nickname" placeholder="例如：小晴"></label>
            <label class="field"><span>娃娃名稱 <b>*</b></span><input v-model.trim="form.dollName" required maxlength="40" placeholder="例如：暖暖"></label>
          </div>
          <fieldset class="avatar-fieldset">
            <legend>選擇原創頭像 <small>上傳自訂頭像後會優先顯示</small></legend>
            <div class="avatar-options">
              <label v-for="choice in avatarChoices" :key="choice.id" :class="{ checked: form.avatarPreset === choice.id && !avatarPreview }">
                <input v-model="form.avatarPreset" type="radio" :value="choice.id">
                <DollAvatar :preset="choice.id" :alt="choice.label" size="medium" /><small>{{ choice.label }}</small>
              </label>
            </div>
          </fieldset>
          <AvatarCropper @change="setAvatar" />
        </section>

        <section class="form-card">
          <div class="form-card-heading coordinate-heading"><span>02</span><div><h2>旅行地點</h2><p>經緯度會決定頭像在地圖上的位置。</p></div><button class="secondary-button compact" type="button" :disabled="locating" @click="useCurrentLocation">{{ locating ? '定位中…' : '◎ 使用目前位置' }}</button></div>
          <div class="field-grid two">
            <label class="field"><span>地點名稱 <b>*</b></span><input v-model.trim="form.location" required minlength="2" maxlength="80" placeholder="例如：淡水漁人碼頭"></label>
            <label class="field"><span>縣市 <b>*</b></span><select v-model="form.county" required><option value="" disabled>請選擇縣市</option><option v-for="item in counties" :key="item">{{ item }}</option></select></label>
          </div>
          <div class="field-grid two">
            <label class="field"><span>緯度 <b>*</b></span><input v-model.number="form.latitude" type="number" inputmode="decimal" required min="20" max="27" step="0.000001" placeholder="例如：25.167602"><small>臺灣與離島範圍 20–27</small></label>
            <label class="field"><span>經度 <b>*</b></span><input v-model.number="form.longitude" type="number" inputmode="decimal" required min="118" max="123" step="0.000001" placeholder="例如：121.445284"><small>臺灣與離島範圍 118–123</small></label>
          </div>
          <p v-if="coordinateStatus" class="coordinate-status" aria-live="polite">{{ coordinateStatus }}</p>
          <div class="coordinate-tip"><span aria-hidden="true">⌖</span><span><strong>如何取得座標？</strong>在常用地圖服務長按照片拍攝地點，複製經緯度後貼到上方欄位。</span></div>
        </section>

        <section class="form-card">
          <div class="form-card-heading"><span>03</span><div><h2>旅途故事</h2><p>用文字和照片收藏當下的心情。</p></div></div>
          <label class="field"><span>抵達日期 <b>*</b></span><input v-model="form.visitedAt" type="date" required :max="today"></label>
          <label class="field"><span>旅途留言 <b>*</b></span><textarea v-model.trim="form.message" required maxlength="500" rows="5" placeholder="今天和娃娃看見了什麼風景？有什麼想記住的片刻？" /><small class="counter">{{ form.message.length }} / 500</small></label>
          <div class="field"><span>旅途照片 <b>*</b></span>
            <label class="upload-drop" :class="{ 'has-preview': photoPreview, 'has-error': photoError }">
              <input id="travel-photo" ref="photoInput" type="file" accept="image/jpeg,image/png,image/webp" :required="!photo" :aria-invalid="Boolean(photoError)" aria-describedby="travel-photo-help" @change="choosePhoto">
              <img v-if="photoPreview" :src="photoPreview" alt="旅途照片預覽">
              <span v-if="photoPreview" class="upload-change">更換照片</span>
              <template v-else><span class="upload-icon">▧</span><strong>點擊選擇照片</strong><small id="travel-photo-help">JPEG、PNG 或 WebP，最多 5MB</small></template>
            </label>
            <p v-if="photoError" class="field-error" role="alert">{{ photoError }}</p>
          </div>
        </section>

        <div class="form-submit">
          <p>送出即代表你願意將這份原創旅行記錄公開分享。</p>
          <button class="primary-button" type="submit" :disabled="submitting"><i v-if="submitting" class="button-loader" />{{ submitting ? '正在寫入旅箋…' : '寫進未完旅箋 →' }}</button>
        </div>
      </form>

      <aside class="form-aside" aria-label="填寫進度與提醒">
        <div class="form-progress-head"><div class="progress-orb" :style="{ '--progress': `${completedSteps / 3 * 100}%` }"><strong>{{ completedSteps }}</strong><span>/ 3</span></div><div><span class="eyebrow">PAGE CHECK</span><h2>旅箋完成進度</h2></div></div>
        <ol class="progress-list">
          <li :class="{ complete: stepCompletion[0] }"><span>1</span><div><strong>旅人與娃娃</strong><small>暱稱、娃娃名稱與頭像</small></div></li>
          <li :class="{ complete: stepCompletion[1] }"><span>2</span><div><strong>旅行地點</strong><small>景點、縣市與正確座標</small></div></li>
          <li :class="{ complete: stepCompletion[2] }"><span>3</span><div><strong>旅途故事</strong><small>日期、留言與一張照片</small></div></li>
        </ol>
        <div class="privacy-note"><strong>公開分享前請留意</strong><p>照片與精確座標會公開顯示，請避開住家、個資、車牌或未經同意的人臉。</p></div>
      </aside>
    </div>
  </main>
</template>
