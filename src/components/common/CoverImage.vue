<template>
  <img
    ref="imageElement"
    v-bind="$attrs"
    :src="currentSource"
    :data-cover-state="coverState"
    @error="handleError"
    @load="handleLoad"
  />
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from 'vue'
import {
  coverImageCandidates,
  type CoverImageOptions,
  type CoverImageRole,
} from '@/platform/cover-image'

defineOptions({ inheritAttrs: false })

const EMPTY_COVER_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

type VisibilitySubscriber = () => void
const visibilitySubscribers = new Set<VisibilitySubscriber>()
let visibilityListenerInstalled = false

function dispatchDocumentVisibility(): void {
  for (const subscriber of visibilitySubscribers) subscriber()
}

function subscribeDocumentVisibility(subscriber: VisibilitySubscriber): () => void {
  visibilitySubscribers.add(subscriber)
  if (!visibilityListenerInstalled) {
    globalThis.document.addEventListener('visibilitychange', dispatchDocumentVisibility)
    visibilityListenerInstalled = true
  }
  return () => {
    visibilitySubscribers.delete(subscriber)
    if (visibilitySubscribers.size === 0 && visibilityListenerInstalled) {
      globalThis.document.removeEventListener('visibilitychange', dispatchDocumentVisibility)
      visibilityListenerInstalled = false
    }
  }
}

const props = defineProps<{
  source: string
  width: number
  height?: number
  options?: CoverImageOptions
  role?: CoverImageRole
  /**
   * Keep the DOM/layout slot, but detach the decoded image when it is well
   * outside the application scroller.  This is opt-in because header artwork
   * is intentionally persistent while dense result lists are not.
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
const imageElement = ref<globalThis.HTMLImageElement | null>(null)
const candidateIndex = ref(0)
const retryBudget = ref(1)
const failed = ref(false)
const retryAttempt = ref(0)
const pageActive = ref(true)
const documentVisible = ref(
  typeof globalThis.document === 'undefined' || globalThis.document.visibilityState !== 'hidden',
)
const withinViewportBudget = ref(!props.viewportUnload)
let observer: globalThis.IntersectionObserver | null = null
let unsubscribeVisibility: (() => void) | null = null

const canRenderSource = computed(
  () => pageActive.value && documentVisible.value && withinViewportBudget.value,
)
const currentSource = computed(() => {
  if (!canRenderSource.value) return EMPTY_COVER_SRC
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
  !canRenderSource.value
    ? 'idle'
    : failed.value || candidates.value.length === 0
      ? 'failed'
      : 'loading',
)

function reset(): void {
  candidateIndex.value = 0
  retryBudget.value = 1
  retryAttempt.value = 0
  failed.value = false
}

function handleError(): void {
  if (failed.value || !canRenderSource.value) return

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

function disconnectObserver(): void {
  observer?.disconnect()
  observer = null
}

/**
 * WKWebView keeps decoded remote images in compositor memory longer than the
 * element's Vue lifetime. Clearing the element synchronously gives its image
 * and GPU backing store a release point when a detail page is discarded or a
 * kept-alive page leaves the screen.
 */
function detachDecodedImage(): void {
  const element = imageElement.value
  if (element === null) return
  element.src = EMPTY_COVER_SRC
}

function handleDocumentVisibilityChange(): void {
  const visible = globalThis.document.visibilityState !== 'hidden'
  documentVisible.value = visible
  if (!visible) {
    disconnectObserver()
    detachDecodedImage()
    return
  }
  void refreshViewportObservation()
}

function resolveScrollRoot(element: globalThis.HTMLImageElement): globalThis.Element | null {
  return element.closest('.app-content')
}

function isNearViewport(
  element: globalThis.HTMLImageElement,
  root: globalThis.Element | null,
): boolean {
  const elementRect = element.getBoundingClientRect()
  const rootRect = root?.getBoundingClientRect()
  const top = rootRect?.top ?? 0
  const bottom = rootRect?.bottom ?? window.innerHeight
  const margin = Math.max(rootRect?.height ?? window.innerHeight, 1)
  return elementRect.bottom >= top - margin && elementRect.top <= bottom + margin
}

function observeViewport(): void {
  disconnectObserver()
  if (!props.viewportUnload || !pageActive.value) {
    withinViewportBudget.value = true
    return
  }

  const element = imageElement.value
  if (element === null) return
  const root = resolveScrollRoot(element)
  if (typeof globalThis.IntersectionObserver === 'undefined') {
    // Older WebKit builds should retain the existing eager behaviour rather
    // than ever leaving a visible cover blank.
    withinViewportBudget.value = true
    return
  }

  withinViewportBudget.value = isNearViewport(element, root)
  observer = new globalThis.IntersectionObserver(
    (entries) => {
      const entry = entries[0]
      if (entry) withinViewportBudget.value = entry.isIntersecting
    },
    // Keep one half-screen of look-ahead so scrolling remains eager without
    // decoding every card in a long, non-virtualized grid.
    { root, rootMargin: '50% 0px', threshold: 0 },
  )
  observer.observe(element)
}

async function refreshViewportObservation(): Promise<void> {
  await nextTick()
  observeViewport()
}

watch(
  [
    () => props.source,
    () => props.width,
    () => props.height,
    () => props.role,
    () => props.options?.allowOriginalFallback,
    () => props.options?.exact,
    () => props.options?.maxWidth,
    () => props.options?.minWidth,
    () => props.options?.pixelRatio,
    () => props.options?.role,
  ],
  () => {
    // Replace the old source only after its decoded backing store has an
    // explicit release point.  This matters when a single CoverImage instance
    // is reused for successive route IDs or tracks.
    detachDecodedImage()
    reset()
  },
  { flush: 'sync' },
)
watch(
  () => props.viewportUnload,
  () => void refreshViewportObservation(),
)

onMounted(() => {
  unsubscribeVisibility = subscribeDocumentVisibility(handleDocumentVisibilityChange)
  void refreshViewportObservation()
})
onActivated(() => {
  pageActive.value = true
  void refreshViewportObservation()
})
onDeactivated(() => {
  pageActive.value = false
  withinViewportBudget.value = false
  disconnectObserver()
  detachDecodedImage()
})
onBeforeUnmount(() => {
  disconnectObserver()
  detachDecodedImage()
  unsubscribeVisibility?.()
  unsubscribeVisibility = null
})
</script>
