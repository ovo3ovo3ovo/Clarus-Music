<template>
  <div
    ref="listRoot"
    class="virtual-track-list"
    :class="{ 'is-virtualized': isVirtualized }"
    role="list"
    :style="listStyle"
  >
    <article
      v-for="row in visibleRows"
      :key="String(row.key)"
      v-memo="rowMemo(row)"
      class="track-row"
      :class="{
        playing: tracks[row.index]?.id === activeTrackId,
        unavailable: !tracks[row.index]?.playable,
        'with-count': playCounts !== undefined,
        'with-actions': removable,
      }"
      :style="rowStyle(row)"
      :title="tracks[row.index]?.unavailableReason ?? undefined"
      role="listitem"
      @dblclick="playAt(row.index)"
      @contextmenu.prevent.stop="openContextMenu($event, row.index)"
    >
      <div class="track-number">
        <span
          v-if="tracks[row.index]?.id === busyTrackId || tracks[row.index]?.id === pendingTrackId"
          class="spinner"
          aria-hidden="true"
        ></span>
        <AppIcon
          v-else-if="tracks[row.index]?.id === activeTrackId"
          class="playing-icon"
          name="volume"
        />
        <template v-else>
          <span class="number">{{ row.index + 1 }}</span>
          <button
            class="play-track"
            type="button"
            :title="t('search.playTrack')"
            :aria-label="t('search.playTrack')"
            :disabled="!tracks[row.index]?.playable || busyTrackId !== null"
            @click="playAt(row.index)"
            @dblclick.stop
          >
            <AppIcon name="play" />
          </button>
        </template>
      </div>

      <RouterLink
        v-if="tracks[row.index]"
        class="track-cover"
        :to="`/album/${tracks[row.index]!.album.id}`"
        :aria-label="tracks[row.index]!.album.name"
        @dblclick.stop
      >
        <CoverImage
          :source="tracks[row.index]!.album.coverUrl"
          :width="224"
          :alt="tracks[row.index]!.album.name"
          loading="lazy"
          decoding="async"
        />
      </RouterLink>

      <div v-if="tracks[row.index]" class="track-copy">
        <strong>
          {{ tracks[row.index]!.name }}
          <AppIcon
            v-if="showExplicitAfterTitle && tracks[row.index]!.explicit"
            class="explicit-symbol"
            name="explicit"
          />
          <span v-if="subtitle(tracks[row.index]!)" class="alias">
            ({{ subtitle(tracks[row.index]!) }})
          </span>
        </strong>
        <span class="artists">
          <AppIcon
            v-if="!showExplicitAfterTitle && tracks[row.index]!.explicit"
            class="explicit-symbol before-artist"
            name="explicit"
          />
          <template v-for="(artist, artistIndex) in tracks[row.index]!.artists" :key="artist.id">
            <span v-if="artistIndex > 0">, </span>
            <RouterLink :to="`/artist/${artist.id}`" @dblclick.stop>{{ artist.name }}</RouterLink>
          </template>
        </span>
      </div>

      <RouterLink
        v-if="tracks[row.index]"
        class="track-album"
        :to="`/album/${tracks[row.index]!.album.id}`"
        @dblclick.stop
      >
        {{ tracks[row.index]!.album.name }}
      </RouterLink>
      <span v-if="tracks[row.index] && playCounts" class="track-count">
        {{ playCounts[tracks[row.index]!.id] ?? 0 }}
      </span>
      <time v-if="tracks[row.index]" class="track-time">
        {{ formatDuration(tracks[row.index]!.durationMs) }}
      </time>
      <button
        v-if="removable && tracks[row.index]"
        class="queue-remove"
        type="button"
        :title="removeTitle ?? t('queue.remove')"
        :aria-label="removeTitle ?? t('queue.remove')"
        :disabled="busyTrackId !== null"
        @click="emit('remove', row.index)"
        @dblclick.stop
      >
        <AppIcon name="x" />
      </button>
    </article>
  </div>
  <TrackContextMenu
    :track="contextTrack"
    :position="contextPosition"
    @close="closeContextMenu"
    @play="playFromContext"
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
  shallowRef,
  watch,
} from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useVirtualizer, type VirtualItem } from '@tanstack/vue-virtual'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverImage from '@/components/common/CoverImage.vue'
import { trackSubtitle } from '@/features/catalog/domain/track-subtitle'
import type { Track } from '@/types/music'
import TrackContextMenu from './TrackContextMenu.vue'
import { trackContextPosition } from './track-context-position'

const props = defineProps<{
  tracks: readonly Track[]
  currentTrackId: number | null
  busyTrackId: number | null
  pendingTrackId?: number | null
  showExplicitAfterTitle?: boolean
  playCounts?: Readonly<Record<number, number>>
  removable?: boolean
  removeTitle?: string
  itemKey?: 'id' | 'index'
}>()

const emit = defineEmits<{ play: [track: Track, index: number]; remove: [index: number] }>()
const { t, locale } = useI18n()
type DomElement = NonNullable<ReturnType<typeof document.querySelector>>
type TrackListRow = Pick<VirtualItem, 'key' | 'index' | 'start'>
const listRoot = ref<DomElement | null>(null)
const scrollElement = shallowRef<DomElement | null>(null)
const scrollMargin = ref(0)
const virtualizerActive = ref(true)
const contextTrack = shallowRef<Track | null>(null)
const contextIndex = ref(-1)
const contextPosition = shallowRef<{ x: number; y: number } | null>(null)
const activeTrackId = computed(() => props.pendingTrackId ?? props.currentTrackId)
let resizeObserver: ReturnType<typeof createResizeObserver> | null = null
// Keep this in lockstep with the fixed row height below. A dense list makes
// the virtualizer's estimate especially important for stable scroll offsets.
const TRACK_ROW_HEIGHT = 46
// Below this point, the browser's native flow layout is cheaper than a
// virtualizer and, critically, avoids adding another scroll observer to the
// shared application scroller.  Album discs and the queue commonly contain
// only a few dozen rows, while search/history cohorts can be much larger.
const VIRTUALIZE_TRACKS_AT = 96

const isVirtualized = computed(() => props.tracks.length >= VIRTUALIZE_TRACKS_AT)

function resolveScrollElement(): DomElement | null {
  return (
    listRoot.value?.closest<DomElement>('.app-content') ??
    document.querySelector<DomElement>('.app-content')
  )
}

function subtitle(track: Track): string {
  return trackSubtitle(track)
}

const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.tracks.length,
    enabled: isVirtualized.value,
    // The list can mount after its kept-alive route is activated.  WebKit may
    // miss the ref update in that sequence, leaving the virtualizer without an
    // initial viewport and therefore with zero visible rows.
    getScrollElement: () =>
      virtualizerActive.value ? (scrollElement.value ?? resolveScrollElement()) : null,
    estimateSize: () => TRACK_ROW_HEIGHT,
    getItemKey: (index: number) =>
      props.itemKey === 'index' ? index : (props.tracks[index]?.id ?? index),
    gap: 0,
    overscan: 8,
    scrollMargin: scrollMargin.value,
  })),
)
function trackKey(index: number): string | number {
  return props.itemKey === 'index' ? index : (props.tracks[index]?.id ?? index)
}

const staticRows = computed<readonly TrackListRow[]>(() =>
  props.tracks.map((_track, index) => ({
    key: trackKey(index),
    index,
    start: index * TRACK_ROW_HEIGHT,
  })),
)
const visibleRows = computed<readonly TrackListRow[]>(() =>
  isVirtualized.value ? virtualizer.value.getVirtualItems() : staticRows.value,
)
const listStyle = computed<Record<string, string>>(() => ({
  ...(isVirtualized.value ? { height: `${virtualizer.value.getTotalSize()}px` } : {}),
}))

function updateScrollMargin(): void {
  if (!isVirtualized.value || !virtualizerActive.value) return
  const root = listRoot.value
  const scroller = scrollElement.value
  if (!root || !scroller) return
  scrollMargin.value =
    root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

function createResizeObserver(callback: () => void) {
  return typeof window.ResizeObserver === 'undefined' ? null : new window.ResizeObserver(callback)
}

function refreshVirtualizer(): void {
  if (!isVirtualized.value || !virtualizerActive.value) return
  virtualizer.value._willUpdate()
  updateScrollMargin()
  virtualizer.value.measure()
}

function observeVirtualizerGeometry(): void {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!isVirtualized.value || !virtualizerActive.value) return
  resizeObserver = createResizeObserver(() => {
    updateScrollMargin()
  })
  if (scrollElement.value) resizeObserver?.observe(scrollElement.value)
  if (listRoot.value) resizeObserver?.observe(listRoot.value)
}

function rowStyle(row: TrackListRow): Record<string, string> {
  // Keep virtual positioning composable with the hover scale.  Putting the
  // translate in a custom property prevents a CSS transform from ever
  // replacing the virtualizer's placement.
  if (!isVirtualized.value) return {}
  return { '--track-row-y': `${row.start - scrollMargin.value}px` }
}

function rowMemo(row: TrackListRow): unknown[] {
  const track = props.tracks[row.index]
  const trackId = track?.id
  return [
    isVirtualized.value,
    row.index,
    row.start,
    scrollMargin.value,
    track,
    props.itemKey,
    trackId === activeTrackId.value,
    trackId === props.busyTrackId,
    trackId === props.pendingTrackId,
    props.playCounts?.[trackId ?? -1] ?? null,
    props.removable,
    props.removeTitle,
    props.showExplicitAfterTitle,
    locale.value,
  ]
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function playAt(index: number): void {
  const track = props.tracks[index]
  if (track?.playable) emit('play', track, index)
}

function openContextMenu(event: globalThis.MouseEvent, index: number): void {
  const track = props.tracks[index]
  if (!track) return
  contextTrack.value = track
  contextIndex.value = index
  contextPosition.value = trackContextPosition(
    event.clientX,
    event.clientY,
    window.innerWidth,
    window.innerHeight,
  )
}

function closeContextMenu(): void {
  contextTrack.value = null
  contextIndex.value = -1
  contextPosition.value = null
}

function playFromContext(track: Track): void {
  const index = contextIndex.value
  closeContextMenu()
  if (index >= 0 && track.playable) emit('play', track, index)
}

onMounted(async () => {
  await nextTick()
  scrollElement.value = resolveScrollElement()
  refreshVirtualizer()
  observeVirtualizerGeometry()
})

onActivated(async () => {
  virtualizerActive.value = true
  await nextTick()
  scrollElement.value = resolveScrollElement()
  refreshVirtualizer()
  observeVirtualizerGeometry()
})

onDeactivated(() => {
  virtualizerActive.value = false
  resizeObserver?.disconnect()
  resizeObserver = null
  // Keep cached routes from retaining a scroll listener on the shared app
  // scroller. The active hook rebinds it before the route becomes visible.
  virtualizer.value._willUpdate()
})

watch(
  () => props.tracks.length,
  async () => {
    await nextTick()
    refreshVirtualizer()
    observeVirtualizerGeometry()
  },
)

onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<style scoped lang="scss">
.virtual-track-list {
  position: relative;
  width: 100%;
}

/* Large lists retain only the visible rows and isolate their layout work. */
.virtual-track-list.is-virtualized {
  contain: layout style;
}

.track-row {
  position: absolute;
  z-index: 0;
  top: 0;
  left: 0;
  display: grid;
  width: 100%;
  height: 46px;
  padding: 4px;
  border: 0;
  border-bottom: 0;
  border-radius: 5px;
  grid-template-columns: 28px 36px minmax(0, 1fr) minmax(140px, 0.68fr) 46px;
  align-items: center;
  color: var(--color-text);
  background: transparent;
  contain: layout style;
  transform: translate3d(0, var(--track-row-y), 0);
  user-select: none;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease;

  /* Short lists stay in normal flow: no transform updates or scroll observer. */
  .virtual-track-list:not(.is-virtualized) & {
    position: relative;
    transform: none;
    content-visibility: auto;
    contain-intrinsic-size: 46px;
  }

  &.with-count {
    grid-template-columns: 28px 36px minmax(0, 1fr) minmax(140px, 0.68fr) 60px 46px;
  }

  &.with-actions {
    grid-template-columns: 28px 36px minmax(0, 1fr) minmax(140px, 0.68fr) 46px 32px;
  }

  &.with-count.with-actions {
    grid-template-columns: 28px 36px minmax(0, 1fr) minmax(140px, 0.68fr) 60px 46px 32px;
  }

  &:hover {
    background: transparent;
    z-index: 2;
  }

  &:focus-within:not(:hover) {
    background: transparent;
    z-index: 1;
  }

  &.playing {
    color: var(--color-primary);
    background: transparent;
  }

  &.unavailable {
    opacity: 0.38;
  }
}

.track-number {
  display: grid;
  position: relative;
  width: 28px;
  height: 28px;
  place-items: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;

  .number {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    opacity: 0.58;
    transition: opacity var(--motion-fast) ease;
  }
}

.play-track {
  position: absolute;
  inset: 0;
  display: grid;
  padding: 6px;
  border: 0;
  border-radius: var(--radius-sm);
  place-items: center;
  color: var(--color-primary);
  background: transparent;
  opacity: 0;
  pointer-events: none;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease;

  .app-icon {
    transform-origin: center;
    transition: transform var(--motion-hover-emphasis) var(--ease-out);
    pointer-events: none;
  }

  &:hover:not(:disabled) {
    background: transparent;

    .app-icon {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:focus-visible:not(:disabled):not(:hover) {
    background: transparent;

    .app-icon {
      transform: none;
    }
  }

  &:active:not(:disabled) {
    .app-icon {
      transform: scale(var(--scale-hover-icon));
    }
  }
}

.track-row:hover .track-number .number,
.track-row:focus-within .track-number .number {
  opacity: 0;
}

.track-row:hover .play-track,
.track-row:focus-within .play-track,
.play-track:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.track-cover {
  width: 36px;
  height: 36px;

  img {
    display: block;
    width: 100%;
    height: 100%;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    object-fit: cover;
  }
}

.track-copy {
  display: flex;
  min-width: 0;
  padding: 0 10px;
  flex-direction: column;

  strong,
  .artists {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 13px;
    font-weight: var(--font-weight-regular);
    letter-spacing: -0.012em;
    line-height: 16px;
  }

  .alias {
    margin-left: 3px;
    color: var(--color-text-secondary);
    font-size: 11px;
    font-weight: var(--font-weight-regular);
    opacity: 0.7;
  }

  .artists {
    margin-top: 0;
    font-size: 11px;
    line-height: 14px;
    opacity: 0.68;
  }
}

.track-album,
.track-count,
.track-time {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 16px;
  opacity: 0.68;
}

.queue-remove {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: 0;
  border-radius: 5px;
  place-items: center;
  color: var(--color-text);
  background: transparent;
  opacity: 0.42;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease;

  .app-icon {
    transform-origin: center;
    transition: transform var(--motion-hover-emphasis) var(--ease-out);
    pointer-events: none;
  }

  &:hover:not(:disabled) {
    background: transparent;
    opacity: 1;

    .app-icon {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:focus-visible:not(:disabled):not(:hover) {
    background: transparent;
    opacity: 1;

    .app-icon {
      transform: none;
    }
  }

  &:active:not(:disabled) {
    .app-icon {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:disabled {
    cursor: default;
    opacity: 0.24;
  }
}

.track-count {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.track-time {
  padding-right: 2px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.playing-icon,
.spinner {
  width: 14px;
  height: 14px;
  color: var(--color-primary);
}

.explicit-symbol {
  width: 12px;
  height: 12px;
  margin-left: 3px;
  color: var(--color-text);
  vertical-align: -2px;
  opacity: 0.36;

  &.before-artist {
    margin-right: 4px;
    margin-left: 0;
  }
}

.spinner {
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 600ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}

@media (max-width: 980px) {
  .track-row {
    grid-template-columns: 28px 36px minmax(0, 1fr) 46px;

    &.with-count {
      grid-template-columns: 28px 36px minmax(0, 1fr) 60px 46px;
    }

    &.with-actions {
      grid-template-columns: 28px 36px minmax(0, 1fr) 46px 32px;
    }

    &.with-count.with-actions {
      grid-template-columns: 28px 36px minmax(0, 1fr) 60px 46px 32px;
    }
  }

  .track-album {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .track-row,
  .play-track,
  .queue-remove {
    transition: none;

    &:hover,
    &:focus-within,
    &:focus-visible,
    &:active {
      will-change: auto;
    }
  }

  .play-track,
  .queue-remove {
    .app-icon {
      transition: none;
      transform: none;
    }
  }

  .spinner {
    animation: none;
  }
}
</style>
