<script setup lang="ts">
const props = withDefaults(defineProps<{
  src?: string | null
  preset?: string
  alt?: string
  size?: 'small' | 'medium' | 'large'
}>(), { src: null, preset: 'sun', alt: '', size: 'medium' })
</script>

<template>
  <span class="doll-avatar" :class="[avatarClass(props.preset), `avatar-${props.size}`]" :role="!props.src && props.alt ? 'img' : undefined" :aria-label="!props.src && props.alt ? props.alt : undefined" :aria-hidden="!props.src && !props.alt ? 'true' : undefined">
    <img v-if="props.src" :src="props.src" :alt="props.alt">
    <span v-else class="avatar-art" aria-hidden="true">
      <i class="ear left" /><i class="ear right" />
      <b>{{ avatarFace(props.preset) }}</b>
      <i class="eye left" /><i class="eye right" /><i class="smile" />
    </span>
  </span>
</template>
