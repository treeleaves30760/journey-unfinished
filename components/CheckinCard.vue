<script setup lang="ts">
import type { Checkin } from '~/composables/useCheckins'

const props = defineProps<{ checkin: Checkin }>()

// 卡片上的摘要要的是「一段可讀的句子」：直接印原始 Markdown 會看到 ## 與 ** 這些符號，
// 所以先轉成純文字再截斷。完整排版留給詳情頁的 MarkdownView。
const excerpt = computed(() => markdownToPlainText(props.checkin.message, 110))
const place = computed(() => placeLabel(props.checkin))
</script>

<template>
  <article class="checkin-card">
    <NuxtLink :to="`/checkins/${checkin.id}`" class="card-photo">
      <img v-if="checkin.photo" :src="checkin.photo" :alt="`${checkin.dollName}在${checkin.location}的照片`" loading="lazy">
      <span class="county-chip">{{ place }}</span>
    </NuxtLink>
    <div class="card-body">
      <div class="card-author">
        <DollAvatar :src="checkin.avatar" :photo="checkin.photo" :alt="`${checkin.nickname}的頭像`" size="small" />
        <div><strong>{{ checkin.nickname }}・{{ checkin.dollName }}</strong><time :datetime="checkin.visitedAt">{{ formatDate(checkin.visitedAt) }}</time></div>
      </div>
      <NuxtLink :to="`/checkins/${checkin.id}`"><h3>{{ checkin.location }}</h3></NuxtLink>
      <small v-if="checkin.series" class="card-series">✎ {{ checkin.series }}</small>
      <p>{{ excerpt }}</p>
      <div class="card-meta"><span>⌖ {{ place }}</span><span>♡ {{ checkin.commentCount }} 則留言</span></div>
    </div>
  </article>
</template>
