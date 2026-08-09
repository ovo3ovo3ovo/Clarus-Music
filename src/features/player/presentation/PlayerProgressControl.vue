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
import { usePlayerStore } from '@/features/player/application/player-store'

const props = defineProps<{
  duration: number
  transitioning: boolean
}>()

const player = usePlayerStore()
const progressElement = ref<HTMLInputElement | null>(null)
const elapsedElement = ref<globalThis.HTMLElement | null>(null)
const seekPreview = ref<number | null>(null)
let frameId: number | null = null
let mounted = false
let renderedElapsedSecond = -1

function displayedProgress(): number {
  return seekPreview.value ?? (props.transitioning ? 0 : player.progress)
}

function renderProgress(value: number): void {
  const current = Number.isFinite(value) ? Math.max(value, 0) : 0
  const input = progressElement.value
  if (input !== null) {
    input.valueAsNumber = current
    const ratio = props.duration > 0 ? current / props.duration : 0
    const percentage = Math.min(Math.max(ratio, 0), 1) * 100
    input.style.setProperty('--range-progress', `${percentage}%`)
  }

  const wholeSeconds = Math.floor(current)
  if (elapsedElement.value !== null && wholeSeconds !== renderedElapsedSecond) {
    elapsedElement.value.textContent = formatTime(current)
    renderedElapsedSecond = wholeSeconds
  }
}

function stopFrameClock(): void {
  if (frameId !== null) globalThis.cancelAnimationFrame(frameId)
  frameId = null
}

function shouldRunFrameClock(): boolean {
  return mounted && player.playing && !props.transitioning && seekPreview.value === null
}

function scheduleFrame(): void {
  if (frameId === null && shouldRunFrameClock()) {
    frameId = globalThis.requestAnimationFrame(renderFrame)
  }
}

function renderFrame(): void {
  frameId = null
  if (!shouldRunFrameClock()) return
  renderProgress(player.readPlaybackTime())
  scheduleFrame()
}

function sync(): void {
  const input = progressElement.value
  if (input !== null) input.max = String(Math.max(props.duration, 1))
  renderProgress(displayedProgress())
  stopFrameClock()
  scheduleFrame()
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
  seekPreview.value = null
  if (value !== null && !props.transitioning) {
    player.seek(value)
    renderProgress(value)
    if (player.enabled && !player.playing) void player.togglePlayback()
  }
  scheduleFrame()
}

function cancelSeek(): void {
  seekPreview.value = null
  sync()
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

watch(
  [() => player.playing, () => player.progress, () => props.duration, () => props.transitioning],
  sync,
)

onMounted(() => {
  mounted = true
  sync()
})

onBeforeUnmount(() => {
  mounted = false
  stopFrameClock()
})
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

  &:disabled {
    opacity: 0.42;
  }
}
</style>
