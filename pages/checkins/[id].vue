<script setup lang="ts">
import type { Checkin, CheckinComment } from '~/composables/useCheckins'

const route = useRoute()
const id = computed(() => String(route.params.id))
// useAuth() 內部呼叫 useFetch，必須在頂層 await 之前取得，否則會離開 Nuxt 的 setup context。
const { user } = useAuth()
const { data, status, error, refresh } = await useFetch<{ checkin: Checkin, comments: CheckinComment[] }>(() => `/api/checkins/${id.value}`)
const comment = reactive({ nickname: '', message: '' })
const sending = ref(false)
const commentError = ref('')
const createdNotice = ref(route.query.created === '1')
const deleting = ref(false)
const deleteError = ref('')

// 與伺服器端 assertCheckinDeletable 同一條規則：管理員，或 user_id 確實等於自己的擁有者。
// 種子資料的 userId 是 null，這裡不能讓 null 和任何值比較成功。
const canDelete = computed(() => {
  const checkin = data.value?.checkin
  if (!checkin || !user.value) return false
  return user.value.role === 'admin' || (typeof checkin.userId === 'number' && checkin.userId === user.value.id)
})

async function addComment() {
  if (sending.value) return
  sending.value = true
  commentError.value = ''
  try {
    const response = await $fetch<{ comment: CheckinComment }>(`/api/checkins/${id.value}/comments`, {
      method: 'POST', body: comment
    })
    data.value?.comments.push(response.comment)
    if (data.value) data.value.checkin.commentCount += 1
    comment.message = ''
  } catch (error) {
    commentError.value = errorMessage(error, '留言送出失敗，請稍後再試。')
  } finally {
    sending.value = false
  }
}

async function removeCheckin() {
  if (deleting.value || !data.value) return
  if (!window.confirm(`確定要刪除「${data.value.checkin.location}」這則旅箋嗎？此操作無法復原。`)) return
  deleting.value = true
  deleteError.value = ''
  try {
    await $fetch(`/api/checkins/${id.value}`, { method: 'DELETE' })
    await navigateTo('/')
  } catch (error) {
    deleteError.value = errorMessage(error, '刪除失敗，請稍後再試。')
  } finally {
    deleting.value = false
  }
}

useHead(() => ({ title: data.value ? `${data.value.checkin.location}｜未完旅箋` : '沿途旅箋｜未完旅箋' }))
</script>

<template>
  <main id="main-content" class="detail-page">
    <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在翻開這一頁…</div>
    <div v-else-if="error" class="state-panel error-state" role="alert"><strong>找不到這段旅程</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button><NuxtLink class="text-link" to="/">回到地圖</NuxtLink></div>
    <template v-else-if="data">
      <div v-if="createdNotice" class="alert success-alert" role="status"><span class="notice-icon" aria-hidden="true">✓</span><div><strong>旅箋已寫下！</strong><span>這一頁已經出現在旅途地圖上。</span></div><button aria-label="關閉通知" @click="createdNotice = false">×</button></div>
      <NuxtLink class="back-link" to="/">← 回到探索地圖</NuxtLink>
      <article class="detail-story">
        <div class="detail-photo" :class="`scene-${(data.checkin.id % 6) + 1}`">
          <img v-if="data.checkin.photo" :src="data.checkin.photo" :alt="`${data.checkin.dollName}在${data.checkin.location}的旅途照片`">
          <div v-else class="placeholder-scene large" aria-hidden="true"><i class="sun-or-moon" /><i class="hill far" /><i class="hill near" /><span>JOURNEY<br>NOTES</span></div>
          <span class="photo-tape left" /><span class="photo-tape right" />
        </div>
        <div class="detail-copy">
          <span class="eyebrow">A PAGE ALONG THE WAY</span>
          <span class="county-chip">{{ data.checkin.county }}</span>
          <h1>{{ data.checkin.location }}</h1>
          <div class="detail-author"><DollAvatar :src="data.checkin.avatar" :preset="data.checkin.avatarPreset" :alt="`${data.checkin.nickname}的頭像`" size="medium" /><div><strong>{{ data.checkin.nickname }} 與 {{ data.checkin.dollName }}</strong><time :datetime="data.checkin.visitedAt">{{ formatDate(data.checkin.visitedAt) }}</time></div></div>
          <blockquote>「{{ data.checkin.message }}」</blockquote>
          <dl class="detail-facts"><div><dt>旅行地點</dt><dd>{{ data.checkin.county }}・{{ data.checkin.location }}</dd></div><div><dt>地圖座標</dt><dd>{{ data.checkin.latitude.toFixed(5) }}, {{ data.checkin.longitude.toFixed(5) }}</dd></div><div v-if="data.checkin.series"><dt>作品出處</dt><dd>{{ data.checkin.series }}</dd></div></dl>
          <div v-if="canDelete" class="form-submit">
            <div v-if="deleteError" class="inline-error" role="alert">{{ deleteError }}</div>
            <p v-else>刪除後，這頁的照片與地點座標會一併從網站上移除，且無法復原。</p>
            <button class="danger-button" type="button" :disabled="deleting" @click="removeCheckin">{{ deleting ? '刪除中…' : '刪除這則旅箋' }}</button>
          </div>
        </div>
      </article>

      <section class="comments-section">
        <div class="comments-heading"><div><span class="eyebrow">TRAVEL NOTES</span><h2>旅人留言簿</h2></div><span>{{ data.comments.length }} 則留言</span></div>
        <div class="comments-layout">
          <div class="comments-feed">
            <div v-if="data.comments.length" class="comment-list">
              <article v-for="(item, index) in data.comments" :key="item.id"><span class="comment-avatar" :class="`tone-${index % 4}`">{{ item.nickname.slice(0, 1) }}</span><div><header><strong>{{ item.nickname }}</strong><time :datetime="item.createdAt">{{ formatCommentDate(item.createdAt) }}</time></header><p>{{ item.message }}</p></div></article>
            </div>
            <div v-else class="empty-comments"><span aria-hidden="true">✎</span><strong>還沒有旅人留言</strong><p>寫下第一句溫暖的話吧！</p></div>
          </div>
          <form class="comment-form" @submit.prevent="addComment">
            <span class="eyebrow">LEAVE A NOTE</span><h3>回應這一頁</h3><p>和旅人分享你的感想或旅行靈感。</p>
            <div v-if="commentError" class="inline-error" role="alert">{{ commentError }}</div>
            <label class="field"><span>暱稱</span><input v-model.trim="comment.nickname" required maxlength="30" autocomplete="nickname" placeholder="怎麼稱呼你？"></label>
            <label class="field"><span>留言</span><textarea v-model.trim="comment.message" required maxlength="300" rows="4" placeholder="寫下一句溫暖的話…" /><small class="counter">{{ comment.message.length }} / 300</small></label>
            <button class="primary-button" type="submit" :disabled="sending"><i v-if="sending" class="button-loader" />{{ sending ? '送出中…' : '送出留言 →' }}</button>
          </form>
        </div>
      </section>
    </template>
  </main>
</template>
