<script setup lang="ts">
import type { Doll, Draft } from '~/composables/useCheckins'
import type { PlaceValue } from '~/components/LocationPicker.vue'

definePageMeta({ middleware: 'auth' })
const route = useRoute()
const router = useRouter()
const { user } = useAuth()

function todayInput() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

const today = todayInput()
const form = reactive({
  dollId: null as number | null,
  nickname: '', location: '', countryCode: DEFAULT_COUNTRY_CODE, county: '',
  latitude: null as number | null, longitude: null as number | null,
  // avatarPreset 已經沒有選擇器（頭像一律用上傳裁切的那張），但欄位保留：
  // 舊資料與舊娃娃檔案裡存著 leaf／ocean 之類的值，選到那些娃娃時要原樣帶回去，
  // 才不會因為送出 'sun' 而把它們既有的預設頭像默默改掉。
  dollName: '', series: '', message: '', visitedAt: today, avatarPreset: 'sun'
})
const dollPicker = ref<{ lastNickname: string | null } | null>(null)
// 從草稿接手時不要讓選擇器自動選「上次用的」—— 草稿存的是使用者當初的選擇。
const autoSelectDoll = ref(true)

const photoInput = ref<HTMLInputElement | null>(null)
// AvatarCropper 內部的 file input 沒有對外暴露 ref，包一層容器就能在驗證失敗時把焦點送進去
const avatarUpload = ref<HTMLElement | null>(null)
const photo = ref<File | null>(null)
const photoPreview = ref<string | null>(null)
// 從草稿接手時，照片已經在伺服器上了：這裡記住它的網址，讓「照片必填」的檢查通過，
// 使用者不必為了發佈而在電腦上再找一次同一張手機照片。
const storedPhoto = ref<string | null>(null)
const avatar = ref<File | null>(null)
const storedAvatar = ref<string | null>(null)
// 使用者按下「移除自訂頭像」而草稿裡本來有一張時，要明確告訴伺服器「清掉」，
// 否則發佈時會沿用草稿那張，畫面上明明已經切回預設頭像卻沒有生效。
const clearAvatar = ref(false)
const submitting = ref(false)
const savingDraft = ref(false)
const submitError = ref('')
const photoError = ref('')
const avatarError = ref('')
const draftNotice = ref('')
const draftId = ref<number | null>(null)
const loadingDraft = ref(false)

const hasPhoto = computed(() => Boolean(photo.value || storedPhoto.value))
const previewSrc = computed(() => photoPreview.value || storedPhoto.value)
// 這次剛裁好的、娃娃檔案帶進來的、草稿存著的，三種來源都算數：選了有頭像的娃娃時
// 檔案並不會經過這台瀏覽器，storedAvatar 就是那張圖的位址（實際的複製在伺服器做）。
const hasAvatar = computed(() => Boolean(avatar.value || storedAvatar.value))

// LocationPicker 用一個物件收斂五個相關欄位；這裡把它接回扁平的 form，
// 讓送出時的 FormData 組法維持原樣。
const place = computed<PlaceValue>({
  get: () => ({
    location: form.location,
    countryCode: form.countryCode,
    county: form.county,
    latitude: form.latitude,
    longitude: form.longitude
  }),
  set: value => Object.assign(form, value)
})

const stepCompletion = computed(() => [
  Boolean(form.nickname && form.dollName && hasAvatar.value),
  Boolean(form.location && form.county && form.latitude !== null && form.longitude !== null),
  Boolean(form.visitedAt && form.message && hasPhoto.value)
])
const completedSteps = computed(() => stepCompletion.value.filter(Boolean).length)

// 暱稱的預設值：優先用「上一則旅箋填的」，那比 Discord 顯示名稱更貼近他在這個站上
// 習慣怎麼稱呼自己；沒寫過旅箋才退回 Discord 名稱。兩者都只在欄位還空著時才填。
watch(user, (value) => {
  if (value && !form.nickname) form.nickname = value.displayName.slice(0, 30)
}, { immediate: true })
// 使用者一旦自己改過暱稱，就不要再被任何預設值蓋掉
const dirtyNickname = ref(false)
watch(() => dollPicker.value?.lastNickname, (nickname) => {
  if (nickname && !dirtyNickname.value) form.nickname = nickname.slice(0, 30)
})

/** 選了娃娃：把檔案裡的資料帶進表單。帶完仍可自由編輯，改動只影響這一則旅箋。 */
function applyDoll(doll: Doll | null) {
  if (!doll) return
  form.dollName = doll.name
  form.series = doll.series || ''
  form.avatarPreset = doll.avatarPreset
  // 這一則要用的頭像由伺服器依 dollId 從檔案複製一份，所以這裡只負責預覽
  storedAvatar.value = doll.avatar
  avatar.value = null
  clearAvatar.value = false
}

function choosePhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] || null
  submitError.value = ''
  photoError.value = ''
  if (file && (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) {
    photoError.value = `旅途照片須為 5MB 內的 JPEG、PNG 或 WebP。${hasPhoto.value ? '原先選擇的照片仍保留。' : ''}`
    input.value = ''
    return
  }
  if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
  photo.value = file
  photoPreview.value = file ? URL.createObjectURL(file) : null
}

function setAvatar(file: File | null) {
  avatar.value = file
  avatarError.value = ''
  if (file) {
    storedAvatar.value = null
    clearAvatar.value = false
  } else if (storedAvatar.value) {
    storedAvatar.value = null
    clearAvatar.value = true
  }
}

/** 草稿與正式旅箋共用同一份欄位組裝：兩邊的資料形狀必須一致，發佈時才不會少帶欄位。 */
function formData(extra: Record<string, string> = {}) {
  const body = new FormData()
  Object.entries(form).forEach(([key, value]) => {
    if (value === null || value === '') return
    body.append(key, String(value))
  })
  if (photo.value) body.append('photo', photo.value)
  if (avatar.value) body.append('avatar', avatar.value)
  if (clearAvatar.value && !avatar.value) body.append('clearAvatar', '1')
  Object.entries(extra).forEach(([key, value]) => body.append(key, value))
  return body
}

async function loadDraft(id: number) {
  loadingDraft.value = true
  try {
    const { draft } = await $fetch<{ draft: Draft }>(`/api/drafts/${id}`)
    draftId.value = draft.id
    autoSelectDoll.value = false
    form.dollId = draft.dollId
    form.nickname = draft.nickname || form.nickname
    form.location = draft.location || ''
    form.countryCode = draft.countryCode || DEFAULT_COUNTRY_CODE
    form.county = draft.county || ''
    form.latitude = draft.latitude
    form.longitude = draft.longitude
    form.dollName = draft.dollName || ''
    form.series = draft.series || ''
    form.message = draft.message || ''
    form.visitedAt = draft.visitedAt || today
    form.avatarPreset = draft.avatarPreset
    storedPhoto.value = draft.photo
    storedAvatar.value = draft.avatar
    draftNotice.value = `已載入 ${formatCommentDate(draft.updatedAt)} 的草稿，補完後就能發佈。`
  } catch (error) {
    submitError.value = errorMessage(error, '找不到這份草稿，可能已經發佈或刪除。')
  } finally {
    loadingDraft.value = false
  }
}

async function saveDraft() {
  if (savingDraft.value || submitting.value) return
  savingDraft.value = true
  submitError.value = ''
  draftNotice.value = ''
  try {
    const path = draftId.value ? `/api/drafts/${draftId.value}` : '/api/drafts'
    const { draft } = await $fetch<{ draft: Draft }>(path, {
      method: draftId.value ? 'PUT' : 'POST',
      body: formData()
    })
    draftId.value = draft.id
    storedPhoto.value = draft.photo
    storedAvatar.value = draft.avatar
    // 新上傳的檔案已經存進草稿了，清掉本機這份，之後再存才不會重複上傳同一張圖
    if (photoPreview.value) URL.revokeObjectURL(photoPreview.value)
    photo.value = null
    photoPreview.value = null
    avatar.value = null
    draftNotice.value = '草稿已儲存，換裝置登入同一個帳號就能接著寫。'
    if (String(route.query.draft || '') !== String(draft.id)) {
      await router.replace({ query: { ...route.query, draft: String(draft.id) } })
    }
  } catch (error) {
    submitError.value = errorMessage(error, '草稿儲存失敗，請稍後再試。')
  } finally {
    savingDraft.value = false
  }
}

async function submit() {
  if (submitting.value) return
  submitError.value = ''
  // 頭像與照片一樣是必填。沒有頭像的旅箋在列表上只剩一個空的色圓，
  // 這個檢查是為了不再產生那種資料；草稿不受限制，它本來就是還沒寫完的東西。
  if (!hasAvatar.value) {
    avatarError.value = '請上傳一張照片裁成娃娃的頭像，或在上面選一隻已經有頭像的娃娃。'
    nextTick(() => avatarUpload.value?.querySelector('input')?.focus())
    return
  }
  if (!hasPhoto.value) {
    photoError.value = '請先選擇一張旅途照片。'
    nextTick(() => photoInput.value?.focus())
    return
  }
  submitting.value = true
  try {
    const response = await $fetch<{ checkin: { id: number } }>('/api/checkins', {
      method: 'POST',
      body: formData(draftId.value ? { draftId: String(draftId.value) } : {})
    })
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

onMounted(() => {
  const requested = Number(route.query.draft)
  if (Number.isSafeInteger(requested) && requested > 0) loadDraft(requested)
})

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
      <div class="form-intro-links">
        <NuxtLink class="text-link" to="/checkins/quick"><span aria-hidden="true">⚡</span> 手機快速記錄</NuxtLink>
        <NuxtLink class="text-link" to="/drafts"><span aria-hidden="true">✎</span> 我的草稿</NuxtLink>
      </div>
    </section>

    <div v-if="submitError" class="alert error-alert" role="alert"><strong>無法寫下旅箋</strong><span>{{ submitError }}</span></div>
    <div v-else-if="draftNotice" class="alert info-alert" role="status"><span class="notice-icon" aria-hidden="true">✎</span><div><strong>草稿</strong><span>{{ draftNotice }}</span></div></div>
    <div v-if="loadingDraft" class="state-panel" role="status"><i class="loader" />正在載入草稿…</div>

    <div class="form-layout">
      <form class="checkin-form" @submit.prevent="submit">
        <section class="form-card">
          <div class="form-card-heading"><span>01</span><div><h2>旅人與娃娃</h2><p>先介紹這趟旅行的主角吧。</p></div></div>
          <ClientOnly>
            <DollPicker ref="dollPicker" v-model="form.dollId" :auto-select="autoSelectDoll" @select="applyDoll" />
          </ClientOnly>
          <div class="field-grid two">
            <label class="field"><span>你的暱稱 <b>*</b></span><input v-model.trim="form.nickname" required maxlength="30" autocomplete="nickname" placeholder="例如：小晴" @input="dirtyNickname = true"></label>
            <label class="field"><span>娃娃名稱 <b>*</b></span><input v-model.trim="form.dollName" required maxlength="40" placeholder="例如：暖暖"></label>
          </div>
          <label class="field"><span>作品出處 <small>原創娃娃可以留空</small></span><input v-model.trim="form.series" maxlength="60" placeholder="這隻娃娃出自哪部作品？"></label>
          <div ref="avatarUpload" class="field-block">
            <span class="field-block-label">娃娃頭像 <b>*</b></span>
            <!-- 選了有頭像的娃娃時檔案還在伺服器上，裁切器本身載不了既有圖，
                 所以另外顯示一次：否則畫面上只有一個空的上傳框，看起來像還沒填。 -->
            <div v-if="storedAvatar" class="doll-current-avatar">
              <DollAvatar :src="storedAvatar" :preset="form.avatarPreset" alt="這則旅箋要用的頭像" size="large" />
              <span>這則旅箋會用這張頭像。重新上傳可以換掉。</span>
            </div>
            <AvatarCropper @change="setAvatar" />
            <p v-if="avatarError" class="field-error" role="alert">{{ avatarError }}</p>
          </div>
        </section>

        <section class="form-card">
          <div class="form-card-heading"><span>02</span><div><h2>旅行地點</h2><p>搜尋景點或在地圖上點一下，座標會自動補齊。</p></div></div>
          <ClientOnly>
            <LocationPicker v-model="place" />
            <template #fallback>
              <div class="picker-map-loading" role="status"><i class="loader" />正在載入地圖…</div>
            </template>
          </ClientOnly>
          <div class="field-grid two">
            <label class="field">
              <span>所在區域 <b>*</b></span>
              <select v-model="form.countryCode" required>
                <optgroup v-for="group in COUNTRY_GROUPS" :key="group.label" :label="group.label">
                  <option v-for="[code, name] in group.countries" :key="code" :value="code">{{ name }}</option>
                </optgroup>
              </select>
            </label>
            <label class="field">
              <span>行政區 <b>*</b></span>
              <input
                v-model.trim="form.county"
                required
                maxlength="40"
                :list="form.countryCode === 'TW' ? 'taiwan-counties' : undefined"
                placeholder="縣市、州或都道府縣"
              >
              <small>例如：臺北市、京都府、Suðurland</small>
            </label>
          </div>
          <datalist v-if="form.countryCode === 'TW'" id="taiwan-counties">
            <option v-for="item in counties" :key="item" :value="item" />
          </datalist>
          <label class="field"><span>地點名稱 <b>*</b></span><input v-model.trim="form.location" required minlength="2" maxlength="80" placeholder="例如：淡水漁人碼頭"></label>
        </section>

        <section class="form-card">
          <div class="form-card-heading"><span>03</span><div><h2>旅途故事</h2><p>先放上照片，再對著它把心情寫下來。</p></div></div>
          <!-- 照片排在留言前面：寫的人是看著照片回想當下的，先選圖再寫字比較接近實際的順序 -->
          <div class="field"><span>旅途照片 <b>*</b></span>
            <label class="upload-drop" :class="{ 'has-preview': previewSrc, 'has-error': photoError }">
              <input id="travel-photo" ref="photoInput" type="file" accept="image/jpeg,image/png,image/webp" :required="!hasPhoto" :aria-invalid="Boolean(photoError)" aria-describedby="travel-photo-help" @change="choosePhoto">
              <img v-if="previewSrc" :src="previewSrc" alt="旅途照片預覽">
              <span v-if="previewSrc" class="upload-change">更換照片</span>
              <template v-else><span class="upload-icon">▧</span><strong>點擊選擇照片</strong><small id="travel-photo-help">JPEG、PNG 或 WebP，最多 5MB</small></template>
            </label>
            <p v-if="photoError" class="field-error" role="alert">{{ photoError }}</p>
            <p v-else-if="storedPhoto && !photo" class="field-note">目前使用草稿裡的照片，不換也可以直接發佈。</p>
          </div>
          <label class="field"><span>抵達日期 <b>*</b></span><input v-model="form.visitedAt" type="date" required :max="today"></label>
          <div class="field">
            <label :for="'travel-message'"><span>旅途留言 <b>*</b></span></label>
            <MarkdownEditor
              v-model="form.message"
              field-id="travel-message"
              required
              :maxlength="2000"
              :rows="10"
              placeholder="今天和娃娃看見了什麼風景？有什麼想記住的片刻？"
            />
          </div>
        </section>

        <div class="form-submit">
          <p>送出即代表你願意將這份原創旅行記錄公開分享。</p>
          <div class="form-submit-actions">
            <button class="secondary-button" type="button" :disabled="savingDraft || submitting" @click="saveDraft">
              {{ savingDraft ? '儲存中…' : draftId ? '更新草稿' : '存成草稿' }}
            </button>
            <button class="primary-button" type="submit" :disabled="submitting"><i v-if="submitting" class="button-loader" />{{ submitting ? '正在寫入旅箋…' : '寫進未完旅箋 →' }}</button>
          </div>
        </div>
      </form>

      <aside class="form-aside" aria-label="填寫進度與提醒">
        <div class="form-progress-head"><div class="progress-orb" :style="{ '--progress': `${completedSteps / 3 * 100}%` }"><strong>{{ completedSteps }}</strong><span>/ 3</span></div><div><span class="eyebrow">PAGE CHECK</span><h2>旅箋完成進度</h2></div></div>
        <ol class="progress-list">
          <li :class="{ complete: stepCompletion[0] }"><span>1</span><div><strong>旅人與娃娃</strong><small>暱稱、娃娃名稱與頭像</small></div></li>
          <li :class="{ complete: stepCompletion[1] }"><span>2</span><div><strong>旅行地點</strong><small>景點、區域行政區與座標</small></div></li>
          <li :class="{ complete: stepCompletion[2] }"><span>3</span><div><strong>旅途故事</strong><small>一張照片、日期與留言</small></div></li>
        </ol>
        <div class="privacy-note"><strong>公開分享前請留意</strong><p>照片與精確座標會公開顯示，請避開住家、個資、車牌或未經同意的人臉。</p></div>
      </aside>
    </div>

    <!-- 手機版的黏底操作列：長表單捲到一半時，兩個主要動作永遠在拇指構得到的地方 -->
    <div class="mobile-action-bar">
      <button class="secondary-button" type="button" :disabled="savingDraft || submitting" @click="saveDraft">
        {{ savingDraft ? '儲存中…' : '存草稿' }}
      </button>
      <button class="primary-button" type="button" :disabled="submitting" @click="submit">
        {{ submitting ? '發佈中…' : '發佈旅箋' }}
      </button>
    </div>
  </main>
</template>
