<template>
  <main class="next-queue" :aria-busy="player.queueBusy">
    <template v-if="player.currentTrack">
      <section class="queue-section">
        <h1>{{ t('queue.nowPlaying') }}</h1>
        <VirtualTrackList
          :tracks="[player.currentTrack]"
          :current-track-id="player.currentTrack.id"
          :busy-track-id="player.queueLoadingTrackId"
        />
      </section>

      <section v-if="player.playNextQueue.length > 0" class="queue-section">
        <header class="section-heading">
          <h1>{{ t('queue.playNext') }}</h1>
          <button type="button" :disabled="player.queueBusy" @click="player.clearPlayNext">
            {{ t('queue.clear') }}
          </button>
        </header>
        <VirtualTrackList
          :tracks="player.playNextQueue"
          :current-track-id="null"
          :busy-track-id="player.queueLoadingTrackId"
          item-key="index"
          removable
          @play="playInserted"
          @remove="player.removePlayNextAt"
        />
      </section>

      <section class="queue-section">
        <h1>{{ t('queue.nextUp') }}</h1>
        <VirtualTrackList
          v-if="player.upcomingTracks.length > 0"
          :tracks="player.upcomingTracks"
          :current-track-id="null"
          :busy-track-id="player.queueLoadingTrackId"
          @play="playUpcoming"
        />
        <p v-else class="empty-state">{{ t('queue.end') }}</p>
      </section>
    </template>
    <p v-else class="empty-page">{{ t('queue.empty') }}</p>

    <p v-if="player.error" class="queue-error">{{ player.error.message }}</p>
  </main>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import VirtualTrackList from '@/features/search/presentation/VirtualTrackList.vue'
import type { Track } from '@/types/music'
import { usePlayerStore } from './application/player-store'

const player = usePlayerStore()
const { t } = useI18n()

function playInserted(_track: Track, index: number): void {
  void player.playPlayNextAt(index)
}

function playUpcoming(track: Track): void {
  void player.playQueueTrack(track.id)
}
</script>

<style scoped lang="scss">
.next-queue {
  width: min(100%, 1120px);
  min-height: calc(100vh - 64px);
  margin: 0 auto;
  padding: 8px 0 52px;
  color: var(--color-text);
}

.queue-section {
  margin-top: 26px;

  > h1,
  .section-heading h1 {
    margin: 0 0 14px;
    font-size: 21px;
    line-height: 1.2;
  }
}

.section-heading {
  display: flex;
  margin-bottom: 14px;
  align-items: center;
  justify-content: space-between;

  h1 {
    margin-bottom: 0;
  }

  button {
    min-height: 34px;
    padding: 0 14px;
    border: 0;
    border-radius: 8px;
    color: var(--color-text);
    background: transparent;
    font-weight: 500;
    opacity: 0.68;
    transition:
      background 160ms ease,
      opacity 160ms ease,
      transform 120ms ease;

    &:hover:not(:disabled) {
      background: var(--color-secondary-bg);
      opacity: 1;
    }

    &:active:not(:disabled) {
      transform: scale(0.96);
    }

    &:disabled {
      opacity: 0.3;
    }
  }
}

.empty-state,
.empty-page,
.queue-error {
  margin: 0;
  color: var(--color-text);
  opacity: 0.58;
}

.empty-state {
  padding: 18px 8px;
}

.empty-page {
  padding-top: 72px;
  font-size: 16px;
  text-align: center;
}

.queue-error {
  margin-top: 24px;
  color: var(--color-danger);
  opacity: 1;
}

@media (max-width: 720px) {
  .queue-section > h1,
  .queue-section .section-heading h1 {
    font-size: 19px;
  }
}
</style>
