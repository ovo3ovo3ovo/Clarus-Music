<template>
  <div class="progress-row">
    <input
      type="range"
      min="0"
      :max="Math.max(duration, 1)"
      step="1"
      :value="displayedProgress"
      :style="rangeStyle(displayedProgress, duration)"
      :aria-label="t('lyrics.progress')"
      @input="previewSeek"
      @change="commitSeek"
      @pointerup="commitSeek"
      @click="commitSeek"
      @blur="commitSeek"
    />
    <div class="progress-times" aria-hidden="true">
      <span>{{ formatPlaybackTime(displayedProgress) }}</span>
      <span>{{ formatPlaybackTime(duration) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePlayerStore } from '@/features/player/application/player-store'

const props = defineProps<{
  duration: number
  transitioning: boolean
}>()

const { t } = useI18n()
const player = usePlayerStore()
const scrubProgress = ref<number | null>(null)
const displayedProgress = computed(
  () => scrubProgress.value ?? (props.transitioning ? 0 : player.progress),
)
let seekCommitFrame: number | null = null

function formatPlaybackTime(value: number): string {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function rangeStyle(value: number, maximum: number): Record<string, string> {
  const normalized = Number.isFinite(value) && maximum > 0 ? value / maximum : 0
  const percentage = Math.min(Math.max(normalized, 0), 1) * 100
  return { '--range-progress': `${percentage}%` }
}

function inputProgress(event: Event): number {
  const value = Number((event.target as HTMLInputElement).value)
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), props.duration) : player.progress
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

onBeforeUnmount(() => {
  if (seekCommitFrame !== null) window.cancelAnimationFrame(seekCommitFrame)
})
</script>

<style scoped lang="scss">
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
</style>
