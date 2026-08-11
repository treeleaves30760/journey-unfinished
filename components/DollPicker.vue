<script setup lang="ts">
import type { Doll } from '~/composables/useCheckins'

/**
 * 選一隻娃娃，把它的名稱、作品出處與頭像帶進表單。
 *
 * 選完之後欄位仍然可以改 —— 這一則旅箋想寫別的名字是使用者的自由，改動只影響這一則，
 * 不會回頭修改娃娃檔案本身。「自己填」那一格則是完全不套用檔案的逃生口，
 * 讓還沒建檔、或只帶一次的娃娃不必為了寫一則旅箋而先去建立檔案。
 */
const props = withDefaults(defineProps<{
  modelValue: number | null
  /** 載入草稿時不要自動選 —— 草稿存的是使用者當初的選擇，不該被「上次用的」蓋掉 */
  autoSelect?: boolean
}>(), { autoSelect: true })

const emit = defineEmits<{
  'update:modelValue': [id: number | null]
  select: [doll: Doll | null]
}>()

// lazy：這兩個頁面都在 auth middleware 後面，但 SSR 階段還沒有 session，
// 用一般的 useFetch 會讓匿名的伺服器端渲染直接拿到 401 而讓整頁掛掉。
const { data, status, refresh } = useLazyFetch<{ dolls: Doll[], lastNickname: string | null }>('/api/dolls')
const dolls = computed(() => data.value?.dolls || [])

defineExpose({
  refresh,
  lastNickname: computed(() => data.value?.lastNickname ?? null)
})

function choose(doll: Doll | null) {
  emit('update:modelValue', doll?.id ?? null)
  emit('select', doll)
}

// 清單一到就自動選「最近用過」的那一隻（API 已經照這個順序排好）。
// 只在使用者還沒選過、而且呼叫端允許時才做，載入草稿的情況會關掉這個行為。
watch(dolls, (list) => {
  if (!props.autoSelect || props.modelValue !== null || !list.length) return
  choose(list[0]!)
})
</script>

<template>
  <div class="doll-picker">
    <div class="doll-picker-head">
      <span>選擇旅伴</span>
      <NuxtLink class="text-link" to="/dolls">管理娃娃</NuxtLink>
    </div>

    <p v-if="status === 'pending'" class="picker-status" role="status"><i class="loader small" />載入娃娃…</p>

    <div v-else class="doll-picker-row" role="group" aria-label="選擇旅伴">
      <!-- API 已經把「最近用過」排在最前面，所以第一筆就是上次那一隻，
           不需要在這裡再比一次時間。 -->
      <button
        v-for="(doll, index) in dolls"
        :key="doll.id"
        type="button"
        class="doll-chip"
        :class="{ checked: modelValue === doll.id }"
        :aria-pressed="modelValue === doll.id"
        @click="choose(doll)"
      >
        <DollAvatar :src="doll.avatar" alt="" size="medium" />
        <strong>{{ doll.name }}</strong>
        <small v-if="index === 0 && doll.lastUsedAt">上次用的</small>
        <small v-else-if="doll.checkinCount">{{ doll.checkinCount }} 則旅箋</small>
        <small v-else>還沒出發過</small>
      </button>

      <button
        type="button"
        class="doll-chip ghost"
        :class="{ checked: modelValue === null }"
        :aria-pressed="modelValue === null"
        @click="choose(null)"
      >
        <span class="doll-chip-icon" aria-hidden="true">✎</span>
        <strong>自己填</strong>
        <small>不套用檔案</small>
      </button>

      <NuxtLink class="doll-chip ghost" to="/dolls">
        <span class="doll-chip-icon" aria-hidden="true">＋</span>
        <strong>新增</strong>
        <small>建立娃娃檔案</small>
      </NuxtLink>
    </div>
  </div>
</template>
