<script setup lang="ts">
import type { Draft } from '~/composables/useCheckins'

definePageMeta({ middleware: 'auth' })

const { data, status, error, refresh } = await useFetch<{ drafts: Draft[] }>('/api/drafts')
const drafts = computed(() => data.value?.drafts || [])
const removing = ref<number | null>(null)
const actionError = ref('')

// 「還缺什麼才能發佈」直接列在卡片上，使用者不必打開草稿才知道自己少填了哪一項。
// 這份清單與 server/utils/validation.ts 的 validateCheckin 必填欄位一致。
function missingFields(draft: Draft) {
  return [
    !draft.photo && '照片',
    !draft.location && '地點名稱',
    (draft.latitude === null || draft.longitude === null) && '座標',
    !draft.county && '行政區',
    !draft.nickname && '暱稱',
    !draft.dollName && '娃娃名稱',
    !draft.message && '旅途留言',
    !draft.visitedAt && '抵達日期'
  ].filter((value): value is string => Boolean(value))
}

function placeText(draft: Draft) {
  const region = draft.countryCode ? regionName(draft.countryCode) : ''
  return [region, draft.county, draft.location].filter(Boolean).join('・') || '尚未標記地點'
}

async function removeDraft(draft: Draft) {
  if (removing.value) return
  if (!window.confirm(`確定要刪除這份草稿嗎？${draft.photo ? '照片也會一併移除，' : ''}此操作無法復原。`)) return
  removing.value = draft.id
  actionError.value = ''
  try {
    await $fetch(`/api/drafts/${draft.id}`, { method: 'DELETE' })
    await refresh()
  } catch (requestError) {
    actionError.value = errorMessage(requestError, '刪除失敗，請稍後再試。')
  } finally {
    removing.value = null
  }
}

useHead({ title: '我的草稿｜未完旅箋' })
</script>

<template>
  <main id="main-content" class="drafts-page">
    <section class="form-intro">
      <NuxtLink class="back-link" to="/">← 回到探索地圖</NuxtLink>
      <span class="eyebrow">UNFINISHED PAGES</span>
      <h1>我的草稿</h1>
      <p>在手機上拍好、標好的地點都留在這裡，換到電腦登入同一個帳號就能接著寫完。</p>
      <div class="form-intro-links">
        <NuxtLink class="text-link" to="/checkins/quick"><span aria-hidden="true">⚡</span> 快速記錄新地點</NuxtLink>
        <NuxtLink class="text-link" to="/checkins/new"><span aria-hidden="true">✎</span> 寫完整旅箋</NuxtLink>
      </div>
    </section>

    <AccountNav current="drafts" />

    <div v-if="actionError" class="alert error-alert" role="alert"><strong>操作失敗</strong><span>{{ actionError }}</span></div>

    <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在翻出未完成的頁面…</div>
    <div v-else-if="error" class="state-panel error-state" role="alert">
      <strong>讀不到草稿</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button>
    </div>
    <div v-else-if="!drafts.length" class="state-panel empty-state">
      <strong>還沒有草稿</strong>
      <p>下次出門時，用手機在景點前拍一張、標好位置，回家再慢慢寫。</p>
      <NuxtLink class="primary-button" to="/checkins/quick">試試快速記錄</NuxtLink>
    </div>

    <ul v-else class="draft-list">
      <li v-for="draft in drafts" :key="draft.id" class="draft-card">
        <div class="draft-thumb">
          <img v-if="draft.photo" :src="draft.photo" alt="草稿照片" loading="lazy">
          <span v-else aria-hidden="true">▧</span>
        </div>
        <div class="draft-body">
          <strong>{{ placeText(draft) }}</strong>
          <small class="draft-time">最後更新 {{ formatCommentDate(draft.updatedAt) }}</small>
          <p v-if="draft.message" class="draft-excerpt">{{ markdownToPlainText(draft.message, 80) }}</p>
          <p v-if="missingFields(draft).length" class="draft-missing">
            還缺：{{ missingFields(draft).join('、') }}
          </p>
          <p v-else class="draft-ready">所有欄位都齊了，隨時可以發佈。</p>
        </div>
        <div class="draft-actions">
          <NuxtLink class="primary-button compact" :to="`/checkins/new?draft=${draft.id}`">繼續寫 →</NuxtLink>
          <button type="button" class="text-button danger" :disabled="removing === draft.id" @click="removeDraft(draft)">
            {{ removing === draft.id ? '刪除中…' : '刪除' }}
          </button>
        </div>
      </li>
    </ul>
  </main>
</template>
