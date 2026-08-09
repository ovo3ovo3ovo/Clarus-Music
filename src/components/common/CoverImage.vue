<template>
  <img
    ref="imageElement"
    v-bind="$attrs"
    :src="currentSource"
    :loading="loadingAttribute"
    :data-cover-state="coverState"
    @error="handleError"
    @load="handleLoad"
  />
</template>

<script setup lang="ts">
import { computed, ref, useAttrs, watch } from 'vue'
import {
  coverImageCandidates,
  type CoverImageOptions,
  type CoverImageRole,
} from '@/platform/cover-image'

defineOptions({ inheritAttrs: false })

const attrs = useAttrs()
const EMPTY_COVER_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

const props = defineProps<{
  source: string
  width: number
  height?: number
  options?: CoverImageOptions
  role?: CoverImageRole
  /**
   * Compatibility-only.  Visible artwork deliberately remains on the native
   * browser image lifecycle; this prop must not change its source while a
   * list scrolls or a kept-alive route activates/deactivates.
   */
  viewportUnload?: boolean
}>()

const effectiveOptions = computed<CoverImageOptions>(() => ({
  ...props.options,
  ...(props.role ? { role: props.role } : {}),
}))
const candidates = computed(() =>
  coverImageCandidates(
    props.source,
    props.width,
    props.height ?? props.width,
    effectiveOptions.value,
  ),
)
// Vue may recreate the options object or reactivate a kept-alive tree without
// changing the actual request URLs.  Reset only when the artwork candidate
// sequence changes, so a stable source stays decoded and cacheable.
const candidateSignature = computed(() => candidates.value.join('\n'))
const imageElement = ref<globalThis.HTMLImageElement | null>(null)
const candidateIndex = ref(0)
const retryBudget = ref(1)
const retryAttempt = ref(0)
const failed = ref(false)
const decoded = ref(false)

// Keep the browser's normal lazy-loading behavior while honoring an explicit
// loading value supplied by a caller (for example, the player bar's eager
// artwork).
const loadingAttribute = computed<'lazy' | 'eager'>(() => {
  const value = attrs.loading
  return value === undefined || value === null ? 'lazy' : (String(value) as 'lazy' | 'eager')
})

function withRetryQuery(candidate: string, attempt: number): string {
  if (attempt === 0) return candidate
  try {
    const url = new URL(candidate)
    url.searchParams.set('clarus_retry', String(attempt))
    return url.toString()
  } catch {
    return `${candidate}${candidate.includes('?') ? '&' : '?'}clarus_retry=${attempt}`
  }
}

/**
 * The source is deliberately independent of viewport, scroll, document
 * visibility, and KeepAlive activation state. Vue/browser lifecycle already
 * owns the element; replacing it with a transparent GIF during those events
 * causes WebKit to discard and recreate the decoded image on every return.
 */
const currentSource = computed(() => {
  const candidate = candidates.value[candidateIndex.value]
  // A transparent placeholder is reserved for actually missing or failed
  // artwork.  It is never used as a lifecycle signal.
  if (!candidate || failed.value) return EMPTY_COVER_SRC
  return withRetryQuery(candidate, retryAttempt.value)
})

const coverState = computed(() => {
  if (candidates.value.length === 0 || failed.value) return 'failed'
  return decoded.value ? 'loaded' : 'loading'
})

function reset(): void {
  candidateIndex.value = 0
  retryBudget.value = 1
  retryAttempt.value = 0
  failed.value = false
  decoded.value = false
}

function handleError(): void {
  if (failed.value) return
  decoded.value = false

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
  // Keep a successful retry URL stable. Reverting it to the primary URL here
  // would cause an unnecessary second request even though the image is loaded.
  if (imageElement.value === null || failed.value || currentSource.value.length === 0) return
  decoded.value = true
}

watch(
  candidateSignature,
  () => {
    // A changed source, rendered size, or role budget can change the actual
    // request URLs.  Reset only in that case; scrolling and page lifecycle
    // events never alter this signature.
    reset()
  },
  { flush: 'sync' },
)
</script>
