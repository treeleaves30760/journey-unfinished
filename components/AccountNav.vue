<script setup lang="ts">
/**
 * 個人管理區的分頁列。三個頁面各自管一種東西（旅箋、娃娃、草稿），但對使用者來說
 * 它們是同一件事：「我在這個站上留下的東西」。共用這一列，是為了讓三頁都能互相看見——
 * 不然要刪一隻娃娃，得先想起來娃娃的管理頁在哪個選單底下。
 *
 * 刻意不做成「一頁三個 tab」：三份清單各有自己的載入與錯誤狀態，硬塞在同一頁只會讓
 * 其中一支 API 壞掉時整頁都打不開。分成三個路由，各自壞各自的。
 */
const props = defineProps<{ current: 'checkins' | 'dolls' | 'drafts' }>()

const tabs = [
  { key: 'checkins', to: '/me', icon: '◈', label: '我的旅箋' },
  { key: 'dolls', to: '/dolls', icon: '◍', label: '我的娃娃' },
  { key: 'drafts', to: '/drafts', icon: '✎', label: '我的草稿' }
] as const
</script>

<template>
  <nav class="account-nav" aria-label="個人管理區">
    <NuxtLink
      v-for="tab in tabs"
      :key="tab.key"
      class="account-tab"
      :class="{ current: props.current === tab.key }"
      :to="tab.to"
      :aria-current="props.current === tab.key ? 'page' : undefined"
    >
      <span aria-hidden="true">{{ tab.icon }}</span>{{ tab.label }}
    </NuxtLink>
  </nav>
</template>
