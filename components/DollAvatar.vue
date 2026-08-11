<script setup lang="ts">
const props = withDefaults(defineProps<{
  src?: string | null
  /**
   * 沒有專屬頭像時退而求其次的圖，一般是這則旅箋自己的旅途照片。
   * 只有旅箋看得到這個來源 —— 娃娃檔案與 Discord 頭像沒有可以退的照片，
   * 那些地方會落到空的圓。
   */
  photo?: string | null
  alt?: string
  size?: 'small' | 'medium' | 'large'
}>(), { src: null, photo: null, alt: '', size: 'medium' })

const source = computed(() => props.src || props.photo)
</script>

<template>
  <span class="doll-avatar" :class="`avatar-${props.size}`" :role="!source && props.alt ? 'img' : undefined" :aria-label="!source && props.alt ? props.alt : undefined" :aria-hidden="!source && !props.alt ? 'true' : undefined">
    <img v-if="source" :src="source" :alt="props.alt">
  </span>
</template>
