<script setup lang="ts">
import type { Checkin } from '~/composables/useCheckins'

interface AdminUser {
  id: number
  discordId: string
  username: string
  displayName: string
  avatarUrl: string | null
  role: 'user' | 'admin'
  createdAt: string
  lastLoginAt: string
}

definePageMeta({ middleware: 'admin' })
const { data, status, error, refresh } = await useFetch<{ users: AdminUser[], checkins: Checkin[] }>('/api/admin/overview')
const deletingId = ref<number | null>(null)
const actionError = ref('')

async function removeCheckin(checkin: Checkin) {
  if (!window.confirm(`確定要刪除「${checkin.location}」這則旅箋嗎？此操作無法復原。`)) return
  deletingId.value = checkin.id
  actionError.value = ''
  try {
    await $fetch(`/api/admin/checkins/${checkin.id}`, { method: 'DELETE' })
    if (data.value) data.value.checkins = data.value.checkins.filter(item => item.id !== checkin.id)
  } catch (error) {
    actionError.value = errorMessage(error, '刪除失敗，請稍後再試。')
  } finally {
    deletingId.value = null
  }
}

useHead({ title: '管理中心｜未完旅箋' })
</script>

<template>
  <main id="main-content" class="admin-page">
    <div class="admin-heading"><div><span class="eyebrow">ADMIN CONSOLE</span><h1>管理中心</h1><p>檢視 Discord 會員與管理公開旅箋。</p></div><NuxtLink class="primary-button" to="/checkins/new">＋ 寫下旅箋</NuxtLink></div>
    <div v-if="status === 'pending'" class="state-panel" role="status"><i class="loader" />正在載入管理資料…</div>
    <div v-else-if="error" class="state-panel error-state" role="alert"><strong>管理資料讀取失敗</strong><p>{{ errorMessage(error) }}</p><button class="secondary-button" @click="refresh()">再試一次</button></div>
    <template v-else-if="data">
      <section class="admin-stats" aria-label="網站管理統計"><article><span>公開旅箋</span><strong>{{ data.checkins.length }}</strong></article><article><span>Discord 會員</span><strong>{{ data.users.length }}</strong></article><article><span>管理員</span><strong>{{ data.users.filter(user => user.role === 'admin').length }}</strong></article></section>
      <div v-if="actionError" class="alert error-alert" role="alert">{{ actionError }}</div>
      <section class="admin-section">
        <div class="admin-section-heading"><div><span class="eyebrow">MEMBERS</span><h2>會員帳號</h2></div><span>{{ data.users.length }} 位</span></div>
        <div class="admin-table-wrap"><table><thead><tr><th>會員</th><th>Discord ID</th><th>角色</th><th>最近登入</th></tr></thead><tbody><tr v-for="item in data.users" :key="item.id"><td><div class="admin-user"><DollAvatar :src="item.avatarUrl" preset="cloud" alt="" size="small" /><span><strong>{{ item.displayName }}</strong><small>@{{ item.username }}</small></span></div></td><td><code>{{ item.discordId }}</code></td><td><span class="role-badge" :class="item.role">{{ item.role === 'admin' ? '管理員' : '會員' }}</span></td><td>{{ formatCommentDate(item.lastLoginAt) }}</td></tr></tbody></table></div>
      </section>
      <section class="admin-section">
        <div class="admin-section-heading"><div><span class="eyebrow">JOURNEY NOTES</span><h2>旅箋管理</h2></div><span>{{ data.checkins.length }} 則</span></div>
        <div class="admin-checkins"><article v-for="item in data.checkins" :key="item.id"><DollAvatar :src="item.avatar" :preset="item.avatarPreset" alt="" size="small" /><div><strong>{{ item.location }}</strong><span>{{ item.nickname }} 與 {{ item.dollName }} · {{ formatDate(item.visitedAt) }}</span></div><NuxtLink class="text-link" :to="`/checkins/${item.id}`">查看</NuxtLink><button class="danger-button" type="button" :disabled="deletingId === item.id" @click="removeCheckin(item)">{{ deletingId === item.id ? '刪除中…' : '刪除' }}</button></article></div>
      </section>
    </template>
  </main>
</template>
