<template>
  <div class="progress-row">
    <span>{{ formatTime(displayedProgress) }}</span>
    <input
      class="progress"
      type="range"
      min="0"
      :max="Math.max(duration, 1)"
      step="0.1"
      :value="displayedProgress"
      :style="rangeStyle(displayedProgress, duration)"
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
import { computed, ref } from 'vue'
import { usePlayerStore } from '@/features/player/application/player-store'

const props = defineProps<{
  duration: number
  transitioning: boolean
}>()

const player = usePlayerStore()
const seekPreview = ref<number | null>(null)
const displayedProgress = computed(
  () => seekPreview.value ?? (props.transitioning ? 0 : player.progress),
)

function readRangeValue(event: Event): number | null {
  const value = Number((event.target as HTMLInputElement | null)?.value)
  return Number.isFinite(value) ? value : null
}

function beginSeek(event: Event): void {
  seekPreview.value = readRangeValue(event)
}

function previewSeek(event: Event): void {
  const value = readRangeValue(event)
  if (value !== null) seekPreview.value = value
}

function commitSeek(event: Event): void {
  const value = readRangeValue(event) ?? seekPreview.value
  seekPreview.value = null
  if (value === null || props.transitioning) return
  player.seek(value)
  if (player.enabled && !player.playing) void player.togglePlayback()
}

function cancelSeek(): void {
  seekPreview.value = null
}

function rangeStyle(value: number, maximum: number): Record<string, string> {
  const normalized = Number.isFinite(value) && maximum > 0 ? value / maximum : 0
  const percentage = Math.min(Math.max(normalized, 0), 1) * 100
  return { '--range-progress': `${percentage}%` }
}

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
