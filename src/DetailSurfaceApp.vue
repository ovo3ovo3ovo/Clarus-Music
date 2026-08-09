<template>
  <main class="detail-surface-content" data-app-scroll-container data-tauri-drag-region>
    <button class="detail-back" type="button" aria-label="Back" @click="emitDetailBack">
      <AppIcon name="arrow-left" />
    </button>
    <RouterView v-slot="{ Component, route }">
      <component :is="Component" :key="route.fullPath" />
    </RouterView>
  </main>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import { emitDetailBack } from '@/platform/detail-surface'
</script>

<style scoped lang="scss">
.detail-surface-content {
  position: fixed;
  inset: 0;
  overflow: auto;
  padding: 48px 34px 72px;
  color: var(--color-text);
  background: var(--color-surface);
  overscroll-behavior: none;
  scrollbar-gutter: stable;
  scrollbar-color: color-mix(in srgb, var(--color-text) 28%, transparent) transparent;
  scrollbar-width: thin;
  app-region: drag;
  -webkit-app-region: drag;

  :deep(a),
  :deep(button),
  :deep(input),
  :deep(textarea),
  :deep(select),
  :deep(video) {
    app-region: no-drag;
    -webkit-app-region: no-drag;
  }
}

.detail-back {
  position: fixed;
  z-index: var(--z-menu);
  top: 16px;
  left: 18px;
  display: grid;
  width: 34px;
  height: 34px;
  padding: 9px;
  border: 0;
  border-radius: 5px;
  color: var(--color-text);
  background: var(--color-surface);
  place-items: center;
  app-region: no-drag;
  -webkit-app-region: no-drag;

  .app-icon {
    width: 16px;
    height: 16px;
  }
}

@media (max-width: 1336px) {
  .detail-surface-content {
    padding-right: 26px;
    padding-left: 26px;
  }
}
</style>
