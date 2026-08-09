<template>
  <section
    class="lyrics-overlay"
    :class="{
      'has-background': backgroundMode !== 'off',
      'dynamic-background': backgroundMode === 'dynamic',
    }"
    :aria-label="t('player.lyrics')"
  >
    <div v-if="backgroundMode !== 'off'" class="background-color" :style="backgroundStyle" />
    <div
      v-if="backgroundMode === 'blur' || backgroundMode === 'dynamic'"
      class="background-texture"
      :style="textureStyle"
    />
    <div v-if="backgroundMode !== 'off'" class="background-shade" />

    <IconButton
      class="close-button"
      icon="arrow-down"
      :title="t('lyrics.close')"
      @click="lyricsStore.close"
    />
    <div class="volume-control" @pointerdown.stop @click.stop @wheel.stop>
      <span class="volume-icon-control" data-no-window-drag aria-hidden="true">
        <AppIcon class="volume-icon" :name="player.volume === 0 ? 'volume-mute' : 'volume'" />
      </span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="player.volume"
        :style="rangeStyle(player.volume, 1)"
        :aria-label="t('lyrics.volume')"
        @input="changeVolume"
      />
    </div>
    <div class="left-side">
      <div class="player-panel">
        <div class="cover-wrap">
          <CoverImage
            class="cover"
            :source="coverSource"
            :width="580"
            role="immersive"
            alt=""
            decoding="async"
          />
          <div class="cover-shadow" :style="coverShadowStyle" />
        </div>

        <div class="track-row">
          <div class="track-copy">
            <div class="track-title-row">
              <strong :title="track?.name">{{ track?.name }}</strong>
              <IconButton
                class="track-like-button"
                :icon="player.liked === true ? 'heart-solid' : 'heart'"
                :title="t(player.liked === true ? 'player.unlike' : 'player.like')"
                :disabled="player.likeBusy"
                @click="toggleLike"
              />
              <button
                v-if="showModeSwitch"
                class="lyric-mode-button"
                type="button"
                :title="
                  t(
                    lyricsStore.mode === 'translation'
                      ? 'lyrics.translation'
                      : 'lyrics.romanization',
                  )
                "
                @click="toggleLyricMode"
              >
                <span>
                  {{
                    t(
                      lyricsStore.mode === 'translation'
                        ? 'lyrics.translationShort'
                        : 'lyrics.romanizationShort',
                    )
                  }}
                </span>
              </button>
            </div>
            <span :title="trackSubtitle">{{ trackSubtitle }}</span>
          </div>
        </div>

        <div class="progress-row">
          <input
            type="range"
            min="0"
            :max="Math.max(trackDuration, 1)"
            step="1"
            :value="displayProgress"
            :style="rangeStyle(displayProgress, trackDuration)"
            :aria-label="t('lyrics.progress')"
            @input="previewSeek"
            @change="commitSeek"
            @pointerup="commitSeek"
            @click="commitSeek"
            @blur="commitSeek"
          />
          <div class="progress-times" aria-hidden="true">
            <span>{{ formatPlaybackTime(displayProgress) }}</span>
            <span>{{ formatPlaybackTime(trackDuration) }}</span>
          </div>
        </div>

        <div class="media-controls">
          <IconButton
            icon="shuffle"
            :title="t('player.shuffle')"
            :class="{ active: player.shuffle }"
            :aria-pressed="player.shuffle"
            @click="player.toggleShuffle"
          />
          <div class="primary-controls">
            <IconButton icon="previous" :title="t('player.previous')" @click="previous" />
            <IconButton
              class="play-button"
              :icon="player.playing ? 'pause' : 'play'"
              :title="t(player.playing ? 'player.pause' : 'player.play')"
              :disabled="isTransitioning"
              @click="player.togglePlayback"
            />
            <IconButton icon="next" :title="t('player.next')" @click="next" />
          </div>
          <IconButton
            :icon="player.repeatMode === 'one' ? 'repeat-1' : 'repeat'"
            :title="t(player.repeatMode === 'one' ? 'player.repeatTrack' : 'player.repeat')"
            :class="{ active: player.repeatMode !== 'off' }"
            :aria-pressed="player.repeatMode !== 'off'"
            @click="player.cycleRepeatMode"
          />
        </div>
      </div>
    </div>

    <div class="right-side">
      <div
        v-if="lyricsStore.lyrics?.lines.length"
        ref="lyricsContainer"
        class="lyrics-container"
        :class="{ 'is-user-scrolling': isUserScrolling }"
        :style="{ '--lyric-font-size': `${settings.lyricFontSize}px` }"
        @wheel="handleLyricsWheel"
        @touchmove="handleLyricsTouchMove"
      >
        <div class="lyrics-track">
          <div class="lyric-line lyric-leading" aria-hidden="true" />
          <button
            v-for="(line, index) in lyricsStore.lyrics.lines"
            :id="`line${index}`"
            :key="`${line.timeMs}:${index}:${line.original}`"
            :ref="(element) => setLyricLineElement(index, element)"
            class="lyric-line"
            :class="lyricStateClass(index)"
            :style="lyricStyle(index)"
            type="button"
            @mouseenter="handleLyricMouseEnter(index)"
            @mouseleave="handleLyricMouseLeave"
            @click="playFromLine(line.timeMs)"
            @contextmenu.prevent="openLyricMenu($event, line, 'original')"
          >
            <span class="lyric-content">
              <span
                v-if="lineWords(line).length > 0"
                class="lyric-word-track"
                @contextmenu.stop.prevent="openLyricMenu($event, line, 'original')"
              >
                <span
                  v-for="(word, wordIndex) in lineWords(line)"
                  :key="`${word.startMs}:${wordIndex}`"
                  :ref="(element) => setLyricWordElement(index, wordIndex, element)"
                  class="lyric-word"
                  >{{ word.text }}</span
                >
              </span>
              <span v-else @contextmenu.stop.prevent="openLyricMenu($event, line, 'original')">
                {{ line.original }}
              </span>
              <small
                v-if="settings.showLyricsTranslation && secondaryLyric(line, lyricsStore.mode)"
                @contextmenu.stop.prevent="openLyricMenu($event, line, 'secondary')"
              >
                {{ secondaryLyric(line, lyricsStore.mode) }}
              </small>
            </span>
          </button>
        </div>
      </div>

      <div v-else class="lyrics-state" role="status">
        <span v-if="lyricsStore.loading" class="spinner" aria-hidden="true" />
        <p v-if="lyricsStore.loading">{{ t('lyrics.loading') }}</p>
        <p v-else-if="lyricsStore.error">{{ lyricsStore.error }}</p>
        <p v-else-if="lyricsStore.lyrics?.instrumental">{{ t('lyrics.instrumental') }}</p>
        <p v-else>{{ t('lyrics.empty') }}</p>
      </div>
    </div>

    <Transition name="floating-menu">
      <div
        v-if="lyricMenu"
        ref="lyricMenuElement"
        class="lyric-menu"
        role="menu"
        :style="{ left: `${lyricMenu.x}px`, top: `${lyricMenu.y}px` }"
      >
        <button type="button" role="menuitem" @click="copySelectedLyric(false)">
          {{ t('lyrics.copy') }}
        </button>
        <button
          v-if="selectedSecondaryLyric"
          type="button"
          role="menuitem"
          @click="copySelectedLyric(true)"
        >
          {{
            t(
              lyricsStore.mode === 'translation'
                ? 'lyrics.copyWithTranslation'
                : 'lyrics.copyWithRomanization',
            )
          }}
        </button>
      </div>
    </Transition>
    <p class="visually-hidden" aria-live="polite">{{ copyFeedback }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import CoverImage from '@/components/common/CoverImage.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import IconButton from '@/components/common/IconButton.vue'
import { usePlayerStore } from '@/features/player/application/player-store'
import { playbackFrameScheduler } from '@/features/player/application/playback-frame-scheduler'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import { coverImageUrl } from '@/platform/cover-image'
import { formatArtists } from '@/types/music'
import { useLyricsStore } from './application/lyrics-store'
import { fallbackCoverGradient } from './domain/cover-gradient'
import { activeLyricIndex, hasRomanization, hasTranslation, secondaryLyric } from './domain/lyrics'
import {
  advanceScrollSpring,
  centeredScrollTarget,
  lineVisualState,
  nearestLyricCenterIndex,
  usableWords,
  wordFillPercent,
} from './domain/lyric-motion'
import { extractCoverGradient } from './infrastructure/cover-gradient'
import type { LyricCenter } from './domain/lyric-motion'
import type { LyricLine, LyricWord } from './domain/lyrics'

const { t } = useI18n()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const lyricsStore = useLyricsStore()
const background = ref('')
const copyFeedback = ref('')
const scrubProgress = ref<number | null>(null)
const lyricMenuElement = ref<globalThis.HTMLElement | null>(null)
const lyricMenu = ref<{
  readonly line: LyricLine
  readonly target: 'original' | 'secondary'
  readonly x: number
  readonly y: number
} | null>(null)
let backgroundController: AbortController | null = null
let copyTimer: number | null = null
let stopLyricSubscription: (() => void) | null = null
let seekCommitFrame: number | null = null

// Keep the lyric surface in step with the player bar: the selected target is
// presented immediately while its stream and lyrics resolve in parallel.
const track = computed(() => player.pendingTrack ?? player.currentTrack)
const coverSource = computed(() => track.value?.album.coverUrl ?? '')
const coverUrl = computed(() => coverImageUrl(coverSource.value, 580, 580, { role: 'immersive' }))
const trackSubtitle = computed(() => {
  if (!track.value) return ''
  const artists = formatArtists(track.value.artists)
  return [artists, track.value.album.name].filter(Boolean).join(' - ')
})
const settings = computed(() => settingsStore.settings)
const backgroundMode = computed(() => settings.value.lyricsBackground)
const isTransitioning = computed(() => player.pendingTrack != null)
const trackDuration = computed(() => {
  const seconds = Math.floor((track.value?.durationMs ?? 0) / 1_000)
  return seconds > 1 ? seconds - 1 : seconds
})
const displayProgress = computed(
  () => scrubProgress.value ?? (isTransitioning.value ? 0 : player.progress),
)
const activeIndex = ref(-1)
const lyricsContainer = ref<globalThis.HTMLElement | null>(null)
const isUserScrolling = ref(false)
const hoveredLyricIndex = ref<number | null>(null)
const manualFocusIndex = ref<number | null>(null)
const reducedMotion = ref(false)
const lyricLineElements = new Map<number, globalThis.HTMLElement>()
let lyricLineCenters: LyricCenter[] = []
const lyricWordElements = new Map<
  string,
  { readonly element: globalThis.HTMLElement; readonly lineIndex: number; readonly word: LyricWord }
>()
const lyricWordElementsByLine = new Map<
  number,
  Map<
    string,
    {
      readonly element: globalThis.HTMLElement
      readonly lineIndex: number
      readonly word: LyricWord
    }
  >
>()
const usableWordsCache = new WeakMap<LyricLine, readonly LyricWord[]>()
// Keep the last value written by the animation clock per live DOM node. The
// browser still receives every changed value on every frame, while redundant
// same-value CSS custom-property writes are avoided.
const wordProgressValues = new WeakMap<globalThis.HTMLElement, string>()
let scrollSpring = { position: 0, velocity: 0 }
let scrollTarget: number | null = null
let scrollTargetIndex = -1
let lastFrameTimestamp: number | null = null
let scrollResumeTimer: number | null = null
let targetMeasureFrame: number | null = null
let manualFocusFrame: number | null = null
let resizeObserver: globalThis.ResizeObserver | null = null
let motionMediaQuery: globalThis.MediaQueryList | null = null
let wordProgressIndex = -1
let expectedScrollTop: number | null = null
let programmaticScrollUntil = 0
const MANUAL_SCROLL_RESUME_MS = 3_000
const showModeSwitch = computed(
  () =>
    settings.value.showLyricsTranslation &&
    lyricsStore.lyrics !== null &&
    hasTranslation(lyricsStore.lyrics) &&
    hasRomanization(lyricsStore.lyrics),
)
const selectedSecondaryLyric = computed(() =>
  lyricMenu.value === null ? null : secondaryLyric(lyricMenu.value.line, lyricsStore.mode),
)
const backgroundStyle = computed(() => ({
  background: background.value || fallbackCoverGradient(track.value?.id ?? 0),
}))
const textureStyle = computed(() => ({
  backgroundImage: coverUrl.value ? `url(${resizedCover(coverUrl.value, 64)})` : 'none',
}))
const coverShadowStyle = computed(() => ({
  backgroundImage: coverUrl.value ? `url(${resizedCover(coverUrl.value, 256)})` : 'none',
}))

function resizedCover(url: string, size: number): string {
  return coverImageUrl(url, size, size, {
    exact: true,
    maxWidth: size,
    minWidth: size,
    pixelRatio: 1,
  })
}

function formatPlaybackTime(value: number): string {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function lyricStateClass(index: number): string {
  const focusIndex = visualFocusIndex()
  if (focusIndex === null) return 'is-idle'
  if (focusIndex === index && index !== activeIndex.value) return 'is-scroll-focus'
  if (activeIndex.value === index) return 'highlight'
  return Math.abs(index - focusIndex) === 1 ? 'is-near' : 'is-far'
}

function visualFocusIndex(): number | null {
  if (hoveredLyricIndex.value !== null) return hoveredLyricIndex.value
  if (isUserScrolling.value && manualFocusIndex.value !== null) return manualFocusIndex.value
  return activeIndex.value >= 0 ? activeIndex.value : null
}

function lyricStyle(index: number): Record<string, string> {
  const visual = lineVisualState(
    index,
    activeIndex.value,
    isUserScrolling.value,
    visualFocusIndex(),
  )
  return {
    '--lyric-opacity': String(visual.opacity),
    '--lyric-blur': `${visual.blurPx}px`,
  }
}

function lineWords(line: LyricLine): readonly LyricWord[] {
  const cached = usableWordsCache.get(line)
  if (cached !== undefined) return cached
  const words = usableWords(line)
  usableWordsCache.set(line, words)
  return words
}

function setLyricLineElement(index: number, element: unknown): void {
  const previous = lyricLineElements.get(index)
  if (element instanceof globalThis.HTMLElement) {
    if (previous === element) return
    if (previous && previous !== element) resizeObserver?.unobserve(previous)
    lyricLineElements.set(index, element)
    resizeObserver?.observe(element)
  } else {
    // Vue may clear an inline function ref during an otherwise harmless
    // re-render. Keep the last element until the next lyrics reset so the
    // observer does not churn when the same node is immediately restored.
  }
}

function wordElementKey(lineIndex: number, wordIndex: number): string {
  return `${lineIndex}:${wordIndex}`
}

function setLyricWordElement(lineIndex: number, wordIndex: number, element: unknown): void {
  const key = wordElementKey(lineIndex, wordIndex)
  const previous = lyricWordElements.get(key)
  const line = lyricsStore.lyrics?.lines[lineIndex]
  const word = line ? lineWords(line)[wordIndex] : undefined
  if (element === null) return
  if (previous && previous.element === element && previous.word === word) return
  if (previous) {
    const previousLine = lyricWordElementsByLine.get(previous.lineIndex)
    previousLine?.delete(key)
    if (previousLine?.size === 0) lyricWordElementsByLine.delete(previous.lineIndex)
    wordProgressValues.delete(previous.element)
  }
  if (element instanceof globalThis.HTMLElement && word) {
    const binding = { element, lineIndex, word }
    lyricWordElements.set(key, binding)
    let lineBindings = lyricWordElementsByLine.get(lineIndex)
    if (!lineBindings) {
      lineBindings = new Map()
      lyricWordElementsByLine.set(lineIndex, lineBindings)
    }
    lineBindings.set(key, binding)
  } else {
    // Non-HTMLElement ref values are not useful for word progress. A null
    // callback returned above keeps the existing binding through re-renders.
    lyricWordElements.delete(key)
  }
}

function clampScrollTop(value: number): number {
  const container = lyricsContainer.value
  if (!container) return Math.max(0, value)
  // jsdom and a just-mounted browser node can report zero layout metrics
  // before the lyric track has been laid out. Preserve the requested anchor;
  // the browser will clamp it once real dimensions are available.
  if (container.scrollHeight === 0) return Math.max(0, value)
  return Math.min(Math.max(0, value), Math.max(0, container.scrollHeight - container.clientHeight))
}

function measureScrollTarget(index = activeIndex.value): number | null {
  const container = lyricsContainer.value
  const line = lyricLineElements.get(index) ?? document.getElementById(`line${index}`)
  if (!container || !line || index < 0) return null
  const containerBounds = container.getBoundingClientRect()
  const lineBounds = line.getBoundingClientRect()
  const lineTop = container.scrollTop + lineBounds.top - containerBounds.top
  const target = centeredScrollTarget(
    container.clientHeight,
    container.scrollHeight,
    lineTop,
    lineBounds.height,
  )
  return clampScrollTop(target)
}

function rebuildLyricLineCenters(): void {
  const container = lyricsContainer.value
  if (!container) {
    lyricLineCenters = []
    return
  }
  const containerBounds = container.getBoundingClientRect()
  lyricLineCenters = [...lyricLineElements.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, line]) => {
      const height = line.offsetHeight
      if (height > 0) return { index, center: line.offsetTop + height / 2 }
      const bounds = line.getBoundingClientRect()
      const center = container.scrollTop + bounds.top - containerBounds.top + bounds.height / 2
      return { index, center }
    })
    .filter(({ center }) => Number.isFinite(center))
}

function findManualFocusIndex(): number | null {
  const container = lyricsContainer.value
  if (!container || lyricLineElements.size === 0) return null
  if (lyricLineCenters.length !== lyricLineElements.size) rebuildLyricLineCenters()
  return nearestLyricCenterIndex(lyricLineCenters, container.scrollTop + container.clientHeight / 2)
}

function updateManualFocus(): void {
  manualFocusFrame = null
  if (!isUserScrolling.value) return
  const nextIndex = findManualFocusIndex()
  if (nextIndex !== manualFocusIndex.value) manualFocusIndex.value = nextIndex
}

function scheduleManualFocus(): void {
  if (manualFocusFrame !== null) return
  manualFocusFrame = window.requestAnimationFrame(updateManualFocus)
}

function scheduleScrollTarget(index = activeIndex.value): void {
  if (isUserScrolling.value || index < 0) return
  scrollTargetIndex = index
  // Measure immediately when the line already exists. The follow-up frame
  // below remeasures after Vue/layout settles, but the synchronous pass keeps
  // playback from waiting for an animation-frame race before it starts moving.
  const measuredNow = measureScrollTarget(index)
  if (measuredNow !== null) {
    scrollTarget = measuredNow
    if (!Number.isFinite(scrollSpring.position)) {
      scrollSpring = { position: measuredNow, velocity: 0 }
    }
    ensureLyricClock()
  }
  ensureLyricClock()
  if (targetMeasureFrame !== null) return
  targetMeasureFrame = window.requestAnimationFrame(() => {
    targetMeasureFrame = null
    if (isUserScrolling.value || scrollTargetIndex !== activeIndex.value) return
    const measured = measureScrollTarget(scrollTargetIndex)
    if (measured === null) return
    scrollTarget = measured
    if (!Number.isFinite(scrollSpring.position)) {
      scrollSpring = { position: measured, velocity: 0 }
    }
    ensureLyricClock()
  })
}

function setContainerScrollTop(value: number): void {
  const container = lyricsContainer.value
  if (!container) return
  const next = clampScrollTop(value)
  programmaticScrollUntil = (globalThis.performance?.now() ?? Date.now()) + 120
  expectedScrollTop = next
  container.scrollTop = next
}

function resumeLyricFollow(): void {
  scrollResumeTimer = null
  isUserScrolling.value = false
  manualFocusIndex.value = null
  hoveredLyricIndex.value = null
  const container = lyricsContainer.value
  if (container) scrollSpring = { position: container.scrollTop, velocity: 0 }
  scheduleScrollTarget()
}

function markUserScrolling(force = false): boolean {
  const container = lyricsContainer.value
  if (
    !force &&
    container &&
    expectedScrollTop !== null &&
    Math.abs(container.scrollTop - expectedScrollTop) < 1
  ) {
    expectedScrollTop = null
    return false
  }
  expectedScrollTop = null
  if (!isUserScrolling.value) {
    isUserScrolling.value = true
    scrollTarget = null
    if (container) scrollSpring = { position: container.scrollTop, velocity: 0 }
  }
  if (scrollResumeTimer !== null) window.clearTimeout(scrollResumeTimer)
  scrollResumeTimer = window.setTimeout(resumeLyricFollow, MANUAL_SCROLL_RESUME_MS)
  return true
}

function handleLyricsWheel(): void {
  markUserScrolling(true)
  manualFocusIndex.value = findManualFocusIndex()
  scheduleManualFocus()
}

function handleLyricsTouchMove(): void {
  markUserScrolling(true)
  manualFocusIndex.value = findManualFocusIndex()
  scheduleManualFocus()
}

function handleLyricsScroll(): void {
  if (
    !isUserScrolling.value &&
    (globalThis.performance?.now() ?? Date.now()) < programmaticScrollUntil
  ) {
    expectedScrollTop = null
    return
  }
  const changedByUser = markUserScrolling()
  if (changedByUser) scheduleManualFocus()
}

function handleLyricMouseEnter(index: number): void {
  hoveredLyricIndex.value = index
  if (isUserScrolling.value) {
    if (scrollResumeTimer !== null) window.clearTimeout(scrollResumeTimer)
    scrollResumeTimer = window.setTimeout(resumeLyricFollow, MANUAL_SCROLL_RESUME_MS)
  }
}

function handleLyricMouseLeave(): void {
  hoveredLyricIndex.value = null
}

function updateWordProgress(timeMs: number, force = false): void {
  const lineIndex = activeIndex.value
  const activeChanged = lineIndex !== wordProgressIndex
  if (!force && !activeChanged) {
    const activeLine = lyricWordElementsByLine.get(lineIndex)
    if (activeLine) {
      for (const binding of activeLine.values()) {
        const value = `${wordFillPercent(binding.word, timeMs)}%`
        if (wordProgressValues.get(binding.element) === value) continue
        binding.element.style.setProperty('--word-progress', value)
        wordProgressValues.set(binding.element, value)
      }
    }
    return
  }
  wordProgressIndex = lineIndex
  for (const binding of lyricWordElements.values()) {
    const value = `${wordFillPercent(binding.word, timeMs)}%`
    if (wordProgressValues.get(binding.element) === value) continue
    binding.element.style.setProperty('--word-progress', value)
    wordProgressValues.set(binding.element, value)
  }
}

function clearLyricElementMaps(): void {
  for (const element of lyricLineElements.values()) resizeObserver?.unobserve(element)
  // The stylesheet supplies the same initial 0% value as the former dynamic
  // Vue style binding. Reset live nodes here before a track/lyrics replacement
  // so reused DOM nodes keep the original transition semantics.
  for (const binding of lyricWordElements.values()) {
    binding.element.style.setProperty('--word-progress', '0%')
    wordProgressValues.delete(binding.element)
  }
  lyricLineElements.clear()
  lyricLineCenters = []
  lyricWordElements.clear()
  lyricWordElementsByLine.clear()
  wordProgressIndex = -1
}

function rangeStyle(value: number, maximum: number): Record<string, string> {
  const normalized = Number.isFinite(value) && maximum > 0 ? value / maximum : 0
  const percentage = Math.min(Math.max(normalized, 0), 1) * 100
  return { '--range-progress': `${percentage}%` }
}

function inputProgress(event: Event): number {
  const value = Number((event.target as HTMLInputElement).value)
  return Number.isFinite(value)
    ? Math.min(Math.max(value, 0), trackDuration.value)
    : player.progress
}

function previewSeek(event: Event): void {
  scrubProgress.value = inputProgress(event)
}

function commitSeek(event: Event): void {
  if (scrubProgress.value === null && event.type === 'blur') return
  const progress = inputProgress(event)
  scrubProgress.value = null
  if (seekCommitFrame !== null) return
  player.seek(progress)
  if (player.enabled && !player.playing) void player.togglePlayback()
  seekCommitFrame = window.requestAnimationFrame(() => {
    seekCommitFrame = null
  })
}

function changeVolume(event: Event): void {
  player.setVolume(Number((event.target as HTMLInputElement).value))
}

function toggleLike(): void {
  void player.toggleLike()
}

function seekToLine(timeMs: number): void {
  player.seek(timeMs / 1_000)
}

async function playFromLine(timeMs: number): Promise<void> {
  seekToLine(timeMs)
  if (!player.playing) await player.togglePlayback()
}

function previous(): void {
  void player.previous()
}

function next(): void {
  void player.next()
}

function toggleLyricMode(): void {
  lyricsStore.switchMode(lyricsStore.mode === 'translation' ? 'romanization' : 'translation')
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Clipboard copy failed')
}

async function copyText(text: string): Promise<void> {
  try {
    await writeClipboard(text)
    copyFeedback.value = t('lyrics.copied')
  } catch {
    copyFeedback.value = t('lyrics.copyFailed')
  }
  if (copyTimer !== null) window.clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copyFeedback.value = ''
    copyTimer = null
  }, 1_500)
}

async function openLyricMenu(
  event: globalThis.MouseEvent,
  line: LyricLine,
  target: 'original' | 'secondary',
): Promise<void> {
  lyricMenu.value = { line, target, x: event.clientX, y: event.clientY }
  await nextTick()
  const bounds = lyricMenuElement.value?.getBoundingClientRect()
  if (!bounds || lyricMenu.value === null) return
  lyricMenu.value = {
    ...lyricMenu.value,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8)),
  }
}

function closeLyricMenu(): void {
  lyricMenu.value = null
}

function copySelectedLyric(withSecondary: boolean): void {
  if (lyricMenu.value === null) return
  const { line, target } = lyricMenu.value
  const secondary = secondaryLyric(line, lyricsStore.mode)
  const selected = target === 'secondary' ? secondary : line.original
  const text = withSecondary && secondary ? `${line.original} ${secondary}` : selected
  closeLyricMenu()
  if (text) void copyText(text)
}

function handlePointerDown(event: globalThis.PointerEvent): void {
  const target = event.target
  if (target instanceof globalThis.Node && lyricMenuElement.value?.contains(target)) return
  closeLyricMenu()
}

function handleKeydown(event: globalThis.KeyboardEvent): void {
  if (!lyricsStore.visible) return
  if (event.key === 'Escape' && lyricMenu.value !== null) {
    event.preventDefault()
    closeLyricMenu()
    return
  }
  if (event.key === 'Escape') {
    lyricsStore.close()
  }
}

watch(
  [() => lyricsStore.visible, coverUrl, backgroundMode],
  ([visible, nextCover, mode]) => {
    backgroundController?.abort('Lyrics background changed')
    backgroundController = null
    background.value = ''
    if (!visible || !nextCover || mode === 'off') return
    const controller = new AbortController()
    backgroundController = controller
    void extractCoverGradient(resizedCover(nextCover, 64), controller.signal)
      .then((value) => {
        if (backgroundController === controller && value !== null) background.value = value
      })
      .catch(() => undefined)
      .finally(() => {
        if (backgroundController === controller) backgroundController = null
      })
  },
  { immediate: true },
)

function currentLyricTimeMs(): number {
  // Use the same clock that drives the visible progress bar. Reading the
  // Howler engine independently can land on a different frame and make the
  // highlighted lyric visibly lag or lead the bar after a seek.
  const currentTime = isTransitioning.value
    ? 0
    : Number.isFinite(player.progress)
      ? player.progress
      : typeof player.readCurrentTime === 'function'
        ? player.readCurrentTime()
        : 0
  return currentTime * 1_000
}

function syncLyricIndex(currentTimeMs = currentLyricTimeMs(), followActiveLine = true): void {
  const lines = lyricsStore.lyrics?.lines ?? []
  const nextIndex = activeLyricIndex(lines, currentTimeMs)
  if (nextIndex !== activeIndex.value) {
    activeIndex.value = nextIndex
    if (nextIndex < 0) {
      scrollTarget = null
      scrollTargetIndex = -1
    } else if (followActiveLine) {
      scheduleScrollTarget(nextIndex)
    }
    updateWordProgress(currentTimeMs, true)
    return
  }
  updateWordProgress(currentTimeMs)
}

watch(
  () => player.pendingTrack?.id ?? player.currentTrack?.id ?? null,
  () => {
    scrubProgress.value = null
    activeIndex.value = -1
    scrollTarget = null
    scrollTargetIndex = -1
    expectedScrollTop = null
    manualFocusIndex.value = null
    hoveredLyricIndex.value = null
    clearLyricElementMaps()
    const container = lyricsContainer.value
    if (container) scrollSpring = { position: container.scrollTop, velocity: 0 }
  },
)

watch(
  () => lyricsStore.lyrics?.lines,
  () => {
    clearLyricElementMaps()
    lyricsStore.setScrollTop(0)
    activeIndex.value = -1
    scrollTarget = null
    scrollTargetIndex = -1
    manualFocusIndex.value = null
    hoveredLyricIndex.value = null
    const container = lyricsContainer.value
    if (container) {
      scrollSpring = { position: container.scrollTop, velocity: 0 }
      setContainerScrollTop(0)
    }
    void nextTick().then(() => {
      if (lyricsStore.lyrics?.lines.length) {
        rebuildLyricLineCenters()
        syncLyricIndex()
      }
    })
  },
  // Clear measurements before Vue replaces the line buttons so the new
  // function refs repopulate the map after the render. Clearing in a
  // post-flush watcher would leave the map empty until the next data change.
  { flush: 'pre' },
)

function advanceLyricScroll(timestamp: number): void {
  const container = lyricsContainer.value
  if (!container || isUserScrolling.value || scrollTarget === null) return
  const elapsed = lastFrameTimestamp === null ? 16 : timestamp - lastFrameTimestamp
  scrollSpring = advanceScrollSpring(scrollSpring, scrollTarget, elapsed, reducedMotion.value)
  const next = clampScrollTop(scrollSpring.position)
  if (Math.abs(container.scrollTop - next) > 0.05) {
    setContainerScrollTop(next)
  }
  if (
    Math.abs(scrollSpring.position - scrollTarget) <= 0.05 &&
    Math.abs(scrollSpring.velocity) <= 0.2
  ) {
    scrollTarget = null
  }
}

function stopLyricClock(): void {
  stopLyricSubscription?.()
  stopLyricSubscription = null
  lastFrameTimestamp = null
}

function ensureLyricClock(): void {
  if (
    stopLyricSubscription !== null ||
    !lyricsStore.visible ||
    document.hidden ||
    (!player.playing && scrollTarget === null)
  ) {
    return
  }
  const playbackClock =
    typeof player.playbackClock?.read === 'function'
      ? player.playbackClock.read
      : typeof player.readCurrentTime === 'function'
        ? player.readCurrentTime
        : null
  stopLyricSubscription = playbackFrameScheduler.subscribe(({ timestamp, currentTime }) => {
    tickLyricClock(timestamp, currentTime)
  }, playbackClock)
}

function tickLyricClock(timestamp: number, currentTimeSeconds = Number.NaN): void {
  const currentTimeMs = Number.isFinite(currentTimeSeconds)
    ? currentTimeSeconds * 1_000
    : currentLyricTimeMs()
  syncLyricIndex(currentTimeMs)
  advanceLyricScroll(timestamp)
  // Keep the previous frame timestamp available while advanceLyricScroll
  // computes its elapsed interval. Updating this before the call makes every
  // frame look like a zero-duration frame, freezing the spring at its initial
  // scrollTop even though a target has been measured.
  lastFrameTimestamp = timestamp
  if (!lyricsStore.visible || document.hidden || (!player.playing && scrollTarget === null)) {
    stopLyricClock()
  }
}

function syncLyricClock(visible: boolean): void {
  stopLyricClock()
  lastFrameTimestamp = null
  if (!visible) {
    closeLyricMenu()
    return
  }
  ensureLyricClock()
}

function handleVisibilityChange(): void {
  syncLyricClock(lyricsStore.visible)
}

watch(() => lyricsStore.visible, syncLyricClock, { immediate: true })

watch(
  () => player.playing,
  (playing) => {
    if (playing) ensureLyricClock()
  },
)

watch(
  () => player.progress,
  () => {
    if (lyricsStore.visible && !player.playing) syncLyricIndex()
  },
)

function handleMotionPreferenceChange(event: globalThis.MediaQueryListEvent): void {
  reducedMotion.value = event.matches
  if (event.matches) {
    const container = lyricsContainer.value
    if (container && scrollTarget !== null) {
      scrollSpring = { position: scrollTarget, velocity: 0 }
      setContainerScrollTop(scrollTarget)
    }
  }
}

function bindLyricsContainer(
  container: globalThis.HTMLElement | null,
  previous: globalThis.HTMLElement | null,
): void {
  if (previous) previous.removeEventListener('scroll', handleLyricsScroll)
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!container) return
  container.addEventListener('scroll', handleLyricsScroll, { passive: true })
  const restoredScrollTop = clampScrollTop(lyricsStore.scrollTop)
  setContainerScrollTop(restoredScrollTop)
  scrollSpring = { position: restoredScrollTop, velocity: 0 }
  if (typeof globalThis.ResizeObserver !== 'undefined') {
    resizeObserver = new globalThis.ResizeObserver(() => {
      rebuildLyricLineCenters()
      scheduleScrollTarget()
    })
    resizeObserver.observe(container)
    for (const line of lyricLineElements.values()) resizeObserver.observe(line)
  }
  // A v-if mount must preserve the exact scroll anchor from the previous
  // presentation. Initialise the active line without immediately snapping to
  // it; normal playback-following resumes when the active line next changes.
  const restored = lyricsStore.scrollTop > 0
  rebuildLyricLineCenters()
  syncLyricIndex(currentLyricTimeMs(), !restored)
  if (!restored) scheduleScrollTarget()
}

watch(lyricsContainer, bindLyricsContainer, { flush: 'post' })

onMounted(() => {
  motionMediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = motionMediaQuery.matches
  motionMediaQuery.addEventListener?.('change', handleMotionPreferenceChange)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('pointerdown', handlePointerDown)
})

onBeforeUnmount(() => {
  const container = lyricsContainer.value
  if (container) lyricsStore.setScrollTop(container.scrollTop)
})

onUnmounted(() => {
  backgroundController?.abort('Lyrics overlay disposed')
  if (copyTimer !== null) window.clearTimeout(copyTimer)
  if (scrollResumeTimer !== null) window.clearTimeout(scrollResumeTimer)
  if (targetMeasureFrame !== null) window.cancelAnimationFrame(targetMeasureFrame)
  if (manualFocusFrame !== null) window.cancelAnimationFrame(manualFocusFrame)
  if (seekCommitFrame !== null) window.cancelAnimationFrame(seekCommitFrame)
  stopLyricClock()
  resizeObserver?.disconnect()
  resizeObserver = null
  lyricLineCenters = []
  motionMediaQuery?.removeEventListener?.('change', handleMotionPreferenceChange)
  motionMediaQuery = null
  lyricsContainer.value?.removeEventListener('scroll', handleLyricsScroll)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('pointerdown', handlePointerDown)
})
</script>

<style scoped lang="scss">
.lyrics-overlay {
  position: absolute;
  z-index: 240;
  inset: 0;
  display: grid;
  overflow: hidden;
  grid-template-columns: minmax(320px, 0.86fr) minmax(0, 1.14fr);
  gap: clamp(18px, 3vw, 64px);
  padding: 0 clamp(24px, 4vw, 76px);
  color: var(--color-text);
  background: var(--color-body-bg);
}

.lyrics-overlay.has-background {
  color: #fff;
  --color-text: #fff;
  --color-text-secondary: rgb(255 255 255 / 82%);
  --color-text-tertiary: rgb(255 255 255 / 64%);
  --color-secondary: rgb(255 255 255 / 90%);
  --color-primary: #fff;
  --color-primary-bg-for-transparent: rgb(255 255 255 / 16%);
  --color-secondary-bg-for-transparent: rgb(255 255 255 / 12%);
}

.background-color,
.background-texture,
.background-shade {
  position: absolute;
  pointer-events: none;
  inset: 0;
}

.background-texture {
  inset: -8vmax;
  background-position: center;
  background-size: cover;
  filter: blur(32px) saturate(0.86);
  opacity: 0.22;
  transform: scale(1.08);
}

.background-shade {
  background: rgb(0 0 0 / 62%);
}

.left-side,
.right-side {
  position: relative;
  z-index: 1;
  min-width: 0;
  min-height: 0;
}

.left-side {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 56px 0 42px;
}

.player-panel {
  width: clamp(300px, min(31vw, 48vh), 580px);
  max-width: 100%;
}

.cover-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
}

.cover,
.cover-shadow {
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 10px;
  object-fit: cover;
}

.cover {
  z-index: 1;
  border: 0;
  user-select: none;
}

.cover-shadow {
  top: 12px;
  z-index: 0;
  background-position: center;
  background-size: cover;
  opacity: 0;
  transform: scale(0.92, 0.96);
}

.track-row {
  display: flex;
  min-width: 0;
  margin-top: 20px;
  align-items: flex-start;
  gap: 12px;
}

.track-copy {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.track-title-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 3px;

  strong {
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    font-size: clamp(16px, 1.05vw, 20px);
    font-weight: var(--font-weight-medium);
    letter-spacing: -0.02em;
    opacity: 1;
  }
}

.track-copy > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  margin-top: 5px;
  color: var(--color-text-secondary);
  font-size: clamp(12px, 0.75vw, 15px);
  opacity: 1;
}

.track-like-button {
  flex: 0 0 auto;
  margin-left: 1px;
}

.track-title-row :deep(.track-like-button.icon-button),
.lyric-mode-button {
  background: transparent;
}

.volume-control {
  --range-track-color: color-mix(in srgb, var(--color-text) 24%, transparent);

  position: fixed;
  z-index: 5;
  top: 20px;
  right: 22px;
  display: flex;
  width: clamp(104px, 10.67vw, 164px);
  min-width: 104px;
  padding: 6px 0;
  background: transparent;
  pointer-events: auto;
  touch-action: none;
  flex: 0 0 auto;
  align-items: center;
  gap: 9px;

  svg {
    width: 18px;
    height: 18px;
  }

  .volume-icon {
    pointer-events: none;
  }

  .volume-icon-control {
    display: inline-flex;
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    transform-origin: center;
    transition: transform var(--motion-hover-emphasis) var(--ease-out);

    &:hover {
      transform: scale(var(--scale-hover-icon));
    }
  }

  input {
    width: auto;
    min-width: 0;
    flex: 1 1 auto;
  }
}

.progress-row {
  --range-track-color: color-mix(in srgb, var(--color-text) 24%, transparent);

  display: grid;
  gap: 6px;
  margin-top: 22px;
  align-items: stretch;

  input {
    width: 100%;
  }
}

.progress-times {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.82;
}

.media-controls {
  display: flex;
  margin-top: 18px;
  align-items: center;
  justify-content: space-between;

  :deep(.icon-button) {
    width: 36px;
    height: 36px;
    padding: 8px;
  }
}

.primary-controls {
  display: flex;
  padding: 0 16px;
  align-items: center;
  justify-content: center;
  gap: 18px;
}

.lyric-mode-button {
  display: inline-flex;
  position: relative;
  z-index: 0;
  min-width: 24px;
  height: 32px;
  padding: 0 3px;
  border: 0;
  color: var(--color-text-secondary);
  background: transparent;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-size: 11px;
  opacity: 0.72;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease;

  > span {
    display: inline-flex;
    pointer-events: none;
    transform-origin: center;
    transition: transform var(--motion-hover-emphasis) var(--ease-out);
    will-change: transform;
  }

  &:hover {
    color: var(--color-text);
    background: transparent;
    z-index: 1;
    opacity: 1;

    > span {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:focus-visible:not(:hover) {
    color: var(--color-text);
    background: transparent;
    opacity: 1;

    > span {
      transform: none;
    }
  }

  &:active {
    color: var(--color-text);
    background: transparent;
    opacity: 1;

    > span {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--color-text) 56%, transparent);
    outline-offset: 2px;
  }
}

:deep(.icon-button.active) {
  color: var(--color-toggle-active);
  background: transparent;
  opacity: 1;
}

:deep(.icon-button.active:hover:not(:disabled)),
:deep(.icon-button.active:focus-visible:not(:disabled)),
:deep(.icon-button.active:active:not(:disabled)) {
  color: var(--color-toggle-active);
  background: transparent;
  opacity: 1;
}

.right-side {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding-right: clamp(0px, 1vw, 18px);
  font-weight: var(--font-weight-medium);
}

.lyrics-container {
  display: block;
  width: min(100%, 820px);
  max-width: 820px;
  min-height: 0;
  flex: 1 1 0;
  height: auto;
  align-self: stretch;
  overflow: hidden auto;
  padding: 0 clamp(18px, 2.4vw, 46px);
  overscroll-behavior: contain;
  scroll-behavior: auto;
  contain: style;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.lyrics-track {
  display: flex;
  min-height: 100%;
  flex: 0 0 auto;
  flex-direction: column;
}

@media (min-width: 1200px) {
  .lyrics-container {
    width: min(100%, 820px);
    max-width: 820px;
  }
}

.lyrics-container .lyric-leading {
  flex: 0 0 auto;
  min-height: 0;
  margin-top: 50vh;
  padding: 0;
  pointer-events: none;
}

.lyrics-container .lyric-line:last-child {
  margin-bottom: calc(50vh - 128px);
}

.lyric-menu {
  position: fixed;
  z-index: 4;
  display: flex;
  min-width: 172px;
  overflow: hidden;
  padding: 4px;
  border: 0;
  border-radius: 6px;
  background: var(--color-surface-raised);
  flex-direction: column;
  --floating-origin: top left;

  button {
    min-height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: 4px;
    color: #fff;
    background: transparent;
    font-size: 13px;
    text-align: left;
    transition: background-color 140ms ease;

    &:hover,
    &:focus-visible {
      background: var(--color-interactive-hover);
    }
  }
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  clip-path: inset(50%);
}

.lyric-line {
  --lyric-opacity: 1;
  --lyric-blur: 0px;

  display: block;
  flex: 0 0 auto;
  min-height: max-content;
  width: 100%;
  margin: 6px 0;
  padding: 10px 0;
  border: 0;
  border-radius: 5px;
  color: inherit;
  background: transparent;
  font-family: var(--font-display);
  font-size: clamp(36px, var(--lyric-font-size), 60px);
  font-weight: var(--font-weight-medium);
  letter-spacing: -0.035em;
  opacity: var(--lyric-opacity);
  filter: blur(var(--lyric-blur));
  text-align: left;
  // Keep compositor hints on the handful of lines that actually animate.
  // Far/idle lines retain the same filter and opacity output without each
  // becoming a long-lived graphics layer.
  will-change: auto;
  transition:
    opacity 240ms ease,
    filter 260ms ease,
    color 220ms ease;

  .lyric-content {
    display: block;
    transform: none;
    transform-origin: center left;
    transition: transform 180ms var(--ease-out);
  }

  .lyric-content > span,
  small {
    display: block;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .lyric-content > span {
    color: color-mix(in srgb, var(--color-text) 72%, transparent);
    opacity: 1;
  }

  .lyric-word-track {
    white-space: pre-wrap;
  }

  .lyric-word {
    --word-progress: 0%;

    color: transparent;
    background: linear-gradient(
      to right,
      color-mix(in srgb, var(--color-text) 98%, transparent) 0 var(--word-progress),
      color-mix(in srgb, var(--color-text) 72%, transparent) var(--word-progress) 100%
    );
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  small {
    margin-top: 6px;
    color: color-mix(in srgb, var(--color-text) 52%, transparent);
    font-size: clamp(14px, calc(var(--lyric-font-size) * 0.38), 23px);
    font-weight: var(--font-weight-regular);
    letter-spacing: 0.01em;
    line-height: 1.2;
    opacity: 1;
  }

  &:hover {
    background: transparent;
  }

  &.highlight,
  &.is-scroll-focus {
    color: color-mix(in srgb, var(--color-text) 98%, transparent);
    font-weight: var(--font-weight-semibold);

    .lyric-content {
      transform: scale(1.018);
    }

    .lyric-content > span {
      color: color-mix(in srgb, var(--color-text) 98%, transparent);
    }

    small {
      color: color-mix(in srgb, var(--color-text) 58%, transparent);
    }
  }

  &.is-near {
    will-change: opacity, filter;

    .lyric-content > span {
      color: color-mix(in srgb, var(--color-text) 80%, transparent);
    }
  }

  &.is-far {
    will-change: auto;

    .lyric-content > span {
      color: color-mix(in srgb, var(--color-text) 58%, transparent);
    }
  }
}

.lyric-line.highlight,
.lyric-line.is-scroll-focus {
  will-change: opacity, filter;
}

.lyrics-state {
  display: flex;
  width: min(100%, 600px);
  height: 100%;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: var(--color-text-secondary);
  opacity: 1;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

.close-button {
  position: fixed;
  z-index: 2;
  /* Keep the collapse control in the same slot as the player-bar lyrics button. */
  right: clamp(18px, 1.8vw, 26px);
  bottom: 20px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .background-texture,
  .spinner {
    animation: none;
  }

  .volume-icon-control {
    transition: none;

    &:hover {
      transform: none;
      will-change: auto;
    }
  }

  .lyric-mode-button > span {
    transition: none;
    transform: none;
  }

  .lyric-line {
    transition: none;
  }
}

@media (max-height: 760px) and (min-aspect-ratio: 10 / 9) {
  .left-side {
    padding-top: 44px;
    padding-bottom: 24px;
  }

  .player-panel {
    width: clamp(260px, min(31vw, 42vh), 460px);
  }

  .track-row {
    margin-top: 14px;
  }

  .progress-row {
    margin-top: 16px;
  }

  .media-controls {
    margin-top: 12px;
  }
}

@media (max-aspect-ratio: 10 / 9) {
  .lyrics-overlay {
    display: block;
  }

  .left-side {
    display: none;
  }

  .right-side,
  .lyrics-container,
  .lyrics-state {
    width: 100%;
    max-width: none;
  }

  .right-side {
    height: 100%;
    margin-right: 0;
  }

  .lyrics-container {
    padding-right: 7vw;
    padding-left: 7vw;
  }
}
</style>
