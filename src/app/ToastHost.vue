<template>
  <Transition name="toast-fade">
    <div v-if="toast.visible" class="toast" role="status" aria-live="polite">
      {{ toast.message }}
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { onUnmounted } from 'vue'
import { useToastStore } from './toast-store'

const toast = useToastStore()

onUnmounted(() => toast.dispose())
</script>

<style scoped lang="scss">
.toast {
  position: fixed;
  z-index: var(--z-overlay);
  bottom: calc(var(--player-height) + 16px);
  left: 50%;
  max-width: min(480px, calc(100vw - 32px));
  padding: 9px 14px;
  transform: translateX(-50%);
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  background: var(--color-surface-raised);
  box-shadow: var(--floating-shadow);
  font-size: 14px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  text-align: center;
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 160ms ease;
}

.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
}
</style>
