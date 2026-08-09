<template>
  <div class="progress-row">
    <span ref="elapsedElement">0:00</span>
    <input
      ref="progressElement"
      class="progress"
      type="range"
      min="0"
      max="1"
      step="0.1"
      style="--range-progress: 0%"
      aria-label="Playback progress"
      :disabled="transitioning"
      @pointerdown="beginSeek"
      @input="previewSeek"
      @change="commitSeek"
      @pointercancel="cancelSeek"
    />
    <span>{{ formatTime(duration) }}</span>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { playbackFrameScheduler } from '@/features/player/application/playback-frame-scheduler'
import { usePlayerStore } from '@/features/player/application/player-store'

const props = defineProps<{
  duration: number
  transitioning: boolean
}>()

const player = usePlayerStore()
const progressElement = ref<HTMLInputElement | null>(null)
const elapsedElement = ref<globalThis.HTMLElement | null>(null)
const seekPreview = ref<number | null>(null)
let stopFrameSubscription: (() => void) | null = null
let mounted = false
let frameActive = false
let renderedElapsedSecond: number | null = null

function displayedProgress(): number {
  return seekPreview.value ?? (props.transitioning ? 0 : player.progress)
}

function rangeProgress(value: number): number {
  const normalized = Number.isFinite(value) && props.duration > 0 ? value / props.duration : 0
  return Math.min(Math.max(normalized, 0), 1) * 100
}

function renderProgress(value: number): void {
  const normalizedValue = Number.isFinite(value) ? Math.max(value, 0) : 0
  const input = progressElement.value
  if (input !== null) {
    input.valueAsNumber = normalizedValue
    input.style.setProperty('--range-progress', `${rangeProgress(normalizedValue)}%`)
  }

  const elapsed = elapsedElement.value
  const wholeSeconds = Math.floor(normalizedValue)
  if (elapsed !== null && renderedElapsedSecond !== wholeSeconds) {
    elapsed.textContent = formatTime(normalizedValue)
    renderedElapsedSecond = wholeSeconds
  }
}

function syncRangeBounds(): void {
  const input = progressElement.value
  if (input !== null) input.max = String(Math.max(props.duration, 1))
}

function stopFrameClock(): void {
  frameActive = false
  stopFrameSubscription?.()
  stopFrameSubscription = null
}

function playbackClock(): (() => number) | null {
  if (typeof player.playbackClock?.read === 'function') return player.playbackClock.read
  if (typeof player.readPlaybackTime === 'function') return player.readPlaybackTime
  return null
}

function tickProgressFrame(_timestamp: number, currentTime: number): void {
  if (!frameActive || !Number.isFinite(currentTime)) return
  renderProgress(currentTime)
}

function syncFrameClock(): void {
  stopFrameClock()
  if (!mounted || !player.playing || props.transitioning || seekPreview.value !== null) return
  const readTime = playbackClock()
  if (readTime !== null) {
    frameActive = true
    stopFrameSubscription = playbackFrameScheduler.subscribe(tickProgressFrame, readTime)
  }
}

function syncBusinessProgress(): void {
  if (!mounted) return
  syncRangeBounds()
  renderProgress(displayedProgress())
}

function readRangeValue(event: Event): number | null {
  const value = Number((event.target as HTMLInputElement | null)?.value)
  return Number.isFinite(value) ? value : null
}

function beginSeek(event: Event): void {
  seekPreview.value = readRangeValue(event)
  stopFrameClock()
}

function previewSeek(event: Event): void {
  const value = readRangeValue(event)
  if (value === null) return
  seekPreview.value = value
  renderProgress(value)
}

function commitSeek(event: Event): void {
  const value = readRangeValue(event) ?? seekPreview.value
  if (value === null || props.transitioning) {
    seekPreview.value = null
    syncBusinessProgress()
    syncFrameClock()
    return
  }
  player.seek(value)
  seekPreview.value = null
  renderProgress(value)
  syncFrameClock()
  if (player.enabled && !player.playing) void player.togglePlayback()
}

function cancelSeek(): void {
  seekPreview.value = null
  syncBusinessProgress()
  syncFrameClock()
}

watch([() => player.playing, () => props.transitioning, () => seekPreview.value], syncFrameClock)

watch(
  [() => player.progress, () => props.duration, () => props.transitioning, () => seekPreview.value],
  syncBusinessProgress,
)

onMounted(() => {
  mounted = true
  syncBusinessProgress()
  syncFrameClock()
})

onBeforeUnmount(() => {
  mounted = false
  stopFrameClock()
})

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
</script>

<style scoped lang="scss">
.progress-row {
  display: grid;
  grid-template-columns: 32px minmax(110px, 1fr) 32px;
  align-items: center;
  gap: 8px;

  span {
    color: var(--color-text-secondary);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
}

.progress {
  width: 100%;
  height: 14px;
  margin: 0;
  cursor: pointer;
  touch-action: none;
}
</style>
