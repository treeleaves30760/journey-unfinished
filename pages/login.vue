<script setup lang="ts">
import { safeReturnPath } from '~/utils/safeReturnPath'

const route = useRoute()
const { session, user, loginPath } = useAuth()
const returnTo = computed(() => {
  const value = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  return safeReturnPath(value)
})
const message = computed(() => ({
  state: '登入驗證已失效，請重新嘗試。',
  denied: '你取消了 Discord 授權。',
  discord: 'Discord 暫時無法完成登入，請稍後再試。'
}[String(route.query.error)] || ''))

useHead({ title: 'Discord 登入｜未完旅箋' })
</script>

<template>
  <main id="main-content" class="auth-page">
    <section class="auth-card">
      <div class="auth-art" aria-hidden="true"><span>箋</span><i /><b>DC</b></div>
      <div class="auth-copy">
        <NuxtLink class="back-link" to="/">← 回到探索地圖</NuxtLink>
        <span class="eyebrow">MEMBER ACCESS</span>
        <h1>登入後，繼續寫下你的旅箋</h1>
        <p>使用 Discord 安全登入，不需要另外記一組密碼。登入後即可新增旅程，管理員也會使用同一套身分驗證。</p>
        <div v-if="message" class="inline-error" role="alert">{{ message }}</div>
        <div v-if="user" class="signed-in-card"><DollAvatar :src="user.avatarUrl" preset="ocean" :alt="`${user.displayName}的 Discord 頭像`" size="medium" /><div><span>目前登入</span><strong>{{ user.displayName }}</strong></div><NuxtLink class="primary-button compact" :to="returnTo">繼續前往 →</NuxtLink></div>
        <a v-else-if="session.discordConfigured" class="discord-button" :href="loginPath(returnTo)"><span aria-hidden="true">DC</span><strong>使用 Discord 登入</strong></a>
        <div v-else class="setup-notice"><strong>Discord 登入尚未設定</strong><p>請先在環境變數加入 Discord Client ID、Secret 與公開網址。</p></div>
        <p class="auth-note">我們只會取得 Discord 的基本公開身分，不會讀取私人訊息、伺服器內容或密碼。</p>
      </div>
    </section>
  </main>
</template>
