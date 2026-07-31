<script setup lang="ts">
const route = useRoute()
const { user, isAdmin, logout } = useAuth()
const loggingOut = ref(false)
const isHome = computed(() => route.path === '/')

async function signOut() {
  loggingOut.value = true
  try {
    await logout()
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <div class="site-shell">
    <a class="skip-link" href="#main-content">跳到主要內容</a>
    <header class="site-header">
      <div class="site-header-inner">
        <NuxtLink class="brand" to="/" aria-label="未完旅箋首頁">
          <span class="brand-mark" aria-hidden="true">箋</span>
          <span class="brand-copy"><strong>未完旅箋</strong><small>小小的你，世界很大</small></span>
        </NuxtLink>
        <nav class="site-nav" aria-label="主要導覽">
          <NuxtLink class="nav-link" to="/">探索地圖</NuxtLink>
          <NuxtLink v-if="isAdmin" class="nav-link admin-link" to="/admin">管理</NuxtLink>
          <NuxtLink v-if="user" class="nav-link nav-cta" to="/checkins/new"><span aria-hidden="true">＋</span> 寫下旅箋</NuxtLink>
          <NuxtLink v-else class="nav-link nav-cta discord-login" :to="`/login?redirect=${encodeURIComponent(route.fullPath)}`"><span aria-hidden="true">DC</span> 登入</NuxtLink>
          <details v-if="user" class="account-menu">
            <summary :aria-label="`${user.displayName}的帳號選單`"><DollAvatar :src="user.avatarUrl" preset="ocean" alt="" size="small" /></summary>
            <div class="account-popover"><span>Discord 帳號</span><strong>{{ user.displayName }}</strong><small>@{{ user.username }} · {{ isAdmin ? '管理員' : '會員' }}</small><button type="button" :disabled="loggingOut" @click="signOut">{{ loggingOut ? '登出中…' : '登出' }}</button></div>
          </details>
        </nav>
      </div>
    </header>

    <NuxtPage />

    <footer v-if="!isHome" class="site-footer">
      <div class="site-footer-inner">
        <div class="footer-brand"><span class="brand-mark small" aria-hidden="true">箋</span><div><strong>未完旅箋</strong><span>小小的你，世界很大。</span></div></div>
        <p>本站示意內容與頭像皆為原創，不含任何角色授權素材。</p>
        <nav aria-label="頁尾導覽"><NuxtLink to="/">探索故事</NuxtLink><NuxtLink v-if="user" to="/checkins/new">寫下旅箋</NuxtLink><NuxtLink v-else to="/login">Discord 登入</NuxtLink></nav>
      </div>
    </footer>
  </div>
</template>
