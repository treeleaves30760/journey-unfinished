<script setup lang="ts">
import type { Doll } from '~/composables/useCheckins'

definePageMeta({ middleware: 'auth' })

const { data, status, error, refresh } = await useFetch<{ dolls: Doll[], lastNickname: string | null }>('/api/dolls')
const dolls = computed(() => data.value?.dolls || [])

const editingId = ref<number | null>(null)
const creating = ref(false)
const saving = ref(false)
const removingId = ref<number | null>(null)
const formError = ref('')
const listError = ref('')

const form = reactive({ name: '', series: '' })
const avatar = ref<File | null>(null)
const storedAvatar = ref<string | null>(null)
// 使用者按了「移除自訂頭像」而檔案裡本來有一張時，要明確告訴伺服器清空 ——
// 不然更新會沿用原圖，畫面上明明已經清掉了卻沒有生效。
const clearAvatar = ref(false)
// AvatarCropper 沒有「載入既有圖片」的能力，換一個 key 就能讓它整個重來，
// 這是最省事也最不會殘留舊狀態的重置方式。
const cropperKey = ref(0)

const isOpen = computed(() => creating.value || editingId.value !== null)

function resetForm() {
  form.name = ''
  form.series = ''
  avatar.value = null
  storedAvatar.value = null
  clearAvatar.value = false
  formError.value = ''
  cropperKey.value += 1
}

function startCreate() {
  resetForm()
  editingId.value = null
  creating.value = true
}

function startEdit(doll: Doll) {
  resetForm()
  creating.value = false
  editingId.value = doll.id
  form.name = doll.name
  form.series = doll.series || ''
  storedAvatar.value = doll.avatar
}

function close() {
  creating.value = false
  editingId.value = null
  resetForm()
}

function setAvatar(file: File | null) {
  avatar.value = file
  if (file) {
    storedAvatar.value = null
    clearAvatar.value = false
  } else if (storedAvatar.value) {
    storedAvatar.value = null
    clearAvatar.value = true
  }
}

async function save() {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  const body = new FormData()
  body.append('name', form.name)
  if (form.series) body.append('series', form.series)
  if (avatar.value) body.append('avatar', avatar.value)
  if (clearAvatar.value && !avatar.value) body.append('clearAvatar', '1')

  try {
    await $fetch(editingId.value ? `/api/dolls/${editingId.value}` : '/api/dolls', {
      method: editingId.value ? 'PUT' : 'POST',
      body
    })
    close()
    await refresh()
  } catch (requestError) {
    formError.value = errorMessage(requestError, '儲存失敗，請確認欄位後重試。')
  } finally {
    saving.value = false
  }
}

async function remove(doll: Doll) {
  if (removingId.value) return
  const note = doll.checkinCount
    ? `已經寫下的 ${doll.checkinCount} 則旅箋不會受影響，它們各自留著當時的名稱與頭像。`
    : ''
  if (!window.confirm(`確定要刪除「${doll.name}」的檔案嗎？${note}`)) return
  removingId.value = doll.id
  listError.value = ''
  try {
    await $fetch(`/api/dolls/${doll.id}`, { method: 'DELETE' })
    if (editingId.value === doll.id) close()
    await refresh()
  } catch (requestError) {
    listError.value = errorMessage(requestError, '刪除失敗，請稍後再試。')
  } finally {
    removingId.value = null
  }
}

useHead({ title: '我的娃娃｜未完旅箋' })
</script>

<template>
  <main id="main-content" class="dolls-page">
    <section class="form-intro">
      <NuxtLink class="back-link" to="/">← 回到探索地圖</NuxtLink>
      <span class="eyebrow">TRAVEL COMPANIONS</span>
      <h1>我的娃娃</h1>
      <p>名稱、作品出處與頭像存一次，之後寫旅箋時直接選，不用每次重打。改這裡的資料不會動到已經寫下的旅箋。</p>
      <div class="form-intro-links">
        <NuxtLink class="text-link" to="/checkins/new"><span aria-hidden="true">✎</span> 寫下旅箋</NuxtLink>
        <NuxtLink class="text-link" to="/checkins/quick"><span aria-hidden="true">⚡</span> 快速記錄</NuxtLink>
      </div>
    </section>

    <AccountNav current="dolls" />

    <div v-if="listError" class="alert error-alert" role="alert"><strong>操作失敗</strong><span>{{ listError }}</span></div>

    <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在點名旅伴…</div>
    <div v-else-if="error" class="state-panel error-state" role="alert">
      <strong>讀不到娃娃清單</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button>
    </div>

    <template v-else>
      <div class="dolls-toolbar">
        <span>{{ dolls.length }} 隻旅伴</span>
        <button v-if="!isOpen" class="primary-button compact" type="button" @click="startCreate">＋ 新增娃娃</button>
      </div>

      <section v-if="isOpen" class="form-card doll-form">
        <div class="form-card-heading"><span>{{ editingId ? '✎' : '＋' }}</span><div><h2>{{ editingId ? '編輯娃娃' : '新增娃娃' }}</h2><p>上傳一張娃娃的照片，裁成方形就是它的頭像。</p></div></div>
        <div v-if="formError" class="field-error" role="alert">{{ formError }}</div>
        <div class="field-grid two">
          <label class="field"><span>娃娃名稱 <b>*</b></span><input v-model.trim="form.name" required maxlength="40" placeholder="例如：暖暖"></label>
          <label class="field"><span>作品出處 <small>原創娃娃可以留空</small></span><input v-model.trim="form.series" maxlength="60" placeholder="這隻娃娃出自哪部作品？"></label>
        </div>
        <div v-if="storedAvatar" class="doll-current-avatar">
          <DollAvatar :src="storedAvatar" alt="目前的自訂頭像" size="large" />
          <span>目前使用這張自訂頭像。重新上傳或按「移除自訂頭像」可以換掉。</span>
        </div>
        <AvatarCropper :key="cropperKey" @change="setAvatar" />
        <div class="form-submit-actions">
          <button class="secondary-button" type="button" :disabled="saving" @click="close">取消</button>
          <button class="primary-button" type="button" :disabled="saving || !form.name" @click="save">
            <i v-if="saving" class="button-loader" />{{ saving ? '儲存中…' : editingId ? '更新' : '建立' }}
          </button>
        </div>
      </section>

      <div v-if="!dolls.length && !isOpen" class="state-panel empty-state">
        <strong>還沒有娃娃檔案</strong>
        <p>建立第一隻之後，寫旅箋時就能直接選，名稱與頭像都不用再重打。</p>
        <button class="primary-button" type="button" @click="startCreate">＋ 新增娃娃</button>
      </div>

      <ul v-else-if="dolls.length" class="doll-list">
        <li v-for="doll in dolls" :key="doll.id" class="doll-card">
          <DollAvatar :src="doll.avatar" :alt="`${doll.name}的頭像`" size="large" />
          <div class="doll-card-body">
            <strong>{{ doll.name }}</strong>
            <small v-if="doll.series" class="card-series">✎ {{ doll.series }}</small>
            <small class="doll-card-meta">
              一起走過 {{ doll.checkinCount }} 個地方<template v-if="doll.lastUsedAt"> · 上次 {{ formatCommentDate(doll.lastUsedAt) }}</template>
            </small>
          </div>
          <div class="doll-card-actions">
            <button class="secondary-button compact" type="button" @click="startEdit(doll)">編輯</button>
            <button class="text-button danger" type="button" :disabled="removingId === doll.id" @click="remove(doll)">
              {{ removingId === doll.id ? '刪除中…' : '刪除' }}
            </button>
          </div>
        </li>
      </ul>
    </template>
  </main>
</template>
