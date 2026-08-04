<template>
  <Teleport to="body">
    <Transition name="floating-dialog">
      <div v-if="request" class="app-dialog-layer" role="presentation" @pointerdown.self="cancel">
        <section
          class="app-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="`app-dialog-title-${request.id}`"
          :aria-describedby="`app-dialog-message-${request.id}`"
          @pointerdown.stop
        >
          <div class="app-dialog__content">
            <div class="app-dialog__icon" :class="request.tone">
              <AppIcon :name="request.tone === 'danger' ? 'logout' : 'settings'" />
            </div>
            <div class="app-dialog__copy">
              <h2 :id="`app-dialog-title-${request.id}`">{{ request.title }}</h2>
              <p :id="`app-dialog-message-${request.id}`">{{ request.message }}</p>
            </div>
          </div>
          <div class="app-dialog__actions">
            <button
              v-if="request.kind === 'confirm'"
              class="flat-action app-dialog__action"
              type="button"
              data-dialog-action="cancel"
              @pointerdown.stop
              @click.stop="cancel"
            >
              {{ request.cancelLabel }}
            </button>
            <button
              class="flat-action app-dialog__action"
              type="button"
              :class="{ danger: request.tone === 'danger' }"
              data-dialog-action="confirm"
              @pointerdown.stop
              @click.stop="confirm"
            >
              {{ request.confirmLabel }}
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { appDialogRequest as request, resolveAppDialog } from '@/platform/app-dialogs'

function cancel(): void {
  resolveAppDialog(false)
}

function confirm(): void {
  resolveAppDialog(true)
}

function handleKeydown(event: globalThis.KeyboardEvent): void {
  if (!request.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    confirm()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))
</script>

<style scoped lang="scss">
.app-dialog-layer {
  position: fixed;
  z-index: var(--z-overlay);
  inset: 0;
  display: grid;
  padding: 20px;
  background: color-mix(in srgb, var(--color-body-bg) 72%, transparent);
  pointer-events: auto;
  place-items: center;
}

.app-dialog {
  width: min(420px, 100%);
  padding: 22px;
  border: 0;
  border-radius: 12px;
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-surface-raised) 92%, var(--color-body-bg));
  box-shadow: none;
  pointer-events: auto;
  text-align: left;
}

.app-dialog__content {
  display: flex;
  align-items: flex-start;
  gap: 13px;
}

.app-dialog__copy {
  min-width: 0;

  h2 {
    margin: 1px 0 0;
    font-size: 17px;
    font-weight: var(--font-weight-medium);
    letter-spacing: -0.015em;
  }

  p {
    margin: 7px 0 0;
    color: var(--color-text-secondary);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-line;
  }
}

.app-dialog__icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  color: var(--color-primary);
  background: transparent;
  place-items: center;

  &.danger {
    color: var(--color-danger);
  }

  .app-icon {
    width: 17px;
    height: 17px;
  }
}

.app-dialog__actions {
  display: flex;
  margin-top: 22px;
  justify-content: flex-end;
  gap: 3px;
}

.app-dialog__action {
  min-width: 86px;
  min-height: 34px;
  padding-inline: 11px;
  border-radius: 6px;
  font-size: 13px;

  &:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--color-text) 64%, transparent);
    outline-offset: 2px;
  }
}
</style>
