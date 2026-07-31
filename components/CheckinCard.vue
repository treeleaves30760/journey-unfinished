<script setup lang="ts">
import type { Checkin } from '~/composables/useCheckins'

defineProps<{ checkin: Checkin }>()
</script>

<template>
  <article class="checkin-card">
    <NuxtLink :to="`/checkins/${checkin.id}`" class="card-photo" :class="`scene-${(checkin.id % 6) + 1}`">
      <img v-if="checkin.photo" :src="checkin.photo" :alt="`${checkin.dollName}在${checkin.location}的照片`" loading="lazy">
      <div v-else class="placeholder-scene" aria-hidden="true"><i class="sun-or-moon" /><i class="hill far" /><i class="hill near" /></div>
      <span class="county-chip">{{ checkin.county }}</span>
    </NuxtLink>
    <div class="card-body">
      <div class="card-author">
        <DollAvatar :src="checkin.avatar" :preset="checkin.avatarPreset" :alt="`${checkin.nickname}的頭像`" size="small" />
        <div><strong>{{ checkin.nickname }}・{{ checkin.dollName }}</strong><time :datetime="checkin.visitedAt">{{ formatDate(checkin.visitedAt) }}</time></div>
      </div>
      <NuxtLink :to="`/checkins/${checkin.id}`"><h3>{{ checkin.location }}</h3></NuxtLink>
      <p>{{ checkin.message }}</p>
      <div class="card-meta"><span>⌖ {{ checkin.county }}</span><span>♡ {{ checkin.commentCount }} 則留言</span></div>
    </div>
  </article>
</template>
