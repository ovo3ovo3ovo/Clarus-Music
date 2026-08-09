<template>
  <img
    v-bind="$attrs"
    :src="currentSource"
    :data-cover-state="coverState"
    @error="handleError"
    @load="handleLoad"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  coverImageCandidates,
  type CoverImageOptions,
  type CoverImageRole,
} from '@/platform/cover-image'

defineOptions({ inheritAttrs: false })

const EMPTY_COVER_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

const props = defineProps<{
  source: string
  width: number
  height?: number
  options?: CoverImageOptions
  role?: CoverImageRole
}>()

const candidates = computed(() =>
  coverImageCandidates(props.source, props.width, props.height ?? props.width, {
    ...props.options,
    ...(props.role ? { role: props.role } : {}),
  }),
)
const candidateIndex = ref(0)
const retryBudget = ref(1)
const failed = ref(false)
const retryAttempt = ref(0)
const currentSource = computed(() => {
  const candidate = candidates.value[candidateIndex.value]
  if (!candidate || failed.value) return EMPTY_COVER_SRC
  if (retryAttempt.value === 0) return candidate

  try {
    const url = new URL(candidate)
    url.searchParams.set('clarus_retry', String(retryAttempt.value))
    return url.toString()
  } catch {
    return `${candidate}${candidate.includes('?') ? '&' : '?'}clarus_retry=${retryAttempt.value}`
  }
})
const coverState = computed(() =>
  failed.value || candidates.value.length === 0 ? 'failed' : 'loading',
)

function reset(): void {
  candidateIndex.value = 0
  retryBudget.value = 1
  retryAttempt.value = 0
  failed.value = false
}

function handleError(): void {
  if (failed.value) return

  if (retryBudget.value > 0 && candidateIndex.value === 0) {
    retryBudget.value = 0
    retryAttempt.value = 1
    return
  }

  retryAttempt.value = 0
  candidateIndex.value += 1
  if (candidateIndex.value >= candidates.value.length) failed.value = true
}

function handleLoad(): void {
  retryAttempt.value = 0
}

watch(
  [
    () => props.source,
    () => props.width,
    () => props.height,
    () => props.options,
    () => props.role,
  ],
  reset,
)
</script>
