<template>
  <Teleport to="body">
    <Transition name="floating-dialog">
      <div
        v-if="open"
        class="description-dialog-layer"
        role="presentation"
        @pointerdown.self="close"
      >
        <section
          ref="dialog"
          class="description-dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          @keydown.esc.stop.prevent="close"
        >
          <header class="description-dialog__header">
            <h2 :id="titleId">{{ title }}</h2>
            <IconButton icon="x" :title="closeLabel" @click="close" />
          </header>
          <div class="description-dialog__body">
            <p>{{ description }}</p>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import IconButton from './IconButton.vue'

const props = defineProps<{
  open: boolean
  title: string
  closeLabel: string
  description: string
}>()

const emit = defineEmits<{ close: [] }>()
const dialog = ref<globalThis.HTMLElement | null>(null)
const titleId = `description-dialog-title-${crypto.randomUUID()}`
let returnFocus: globalThis.HTMLElement | null = null

function close(): void {
  emit('close')
}

function handleKeydown(event: globalThis.KeyboardEvent): void {
  if (props.open && event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      returnFocus =
        document.activeElement instanceof globalThis.HTMLElement ? document.activeElement : null
      await nextTick()
      dialog.value?.focus({ preventScroll: true })
      return
    }

    returnFocus?.focus({ preventScroll: true })
    returnFocus = null
  },
)

onMounted(() => document.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))
</script>

<style scoped lang="scss">
.description-dialog-layer {
  position: fixed;
  z-index: var(--z-overlay);
  inset: 0;
  display: grid;
  padding: 24px;
  background: var(--color-overlay-scrim);
  overscroll-behavior: contain;
  place-items: center;
}

.description-dialog {
  display: flex;
  width: min(620px, calc(100vw - 48px));
  max-height: min(68dvh, 620px);
  padding: 20px 22px 22px;
  flex-direction: column;
  border: 0;
  border-radius: var(--radius-md);
  color: var(--color-text);
  background: var(--color-surface-raised);
  outline: none;
}

.description-dialog__header {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;

  h2 {
    margin: 0;
    font-size: 17px;
    font-weight: var(--font-weight-semibold);
    letter-spacing: -0.018em;
  }
}

.description-dialog__body {
  min-height: 0;
  margin-top: 14px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-color: color-mix(in srgb, var(--color-text) 28%, transparent) transparent;
  scrollbar-width: thin;

  p {
    margin: 0;
    padding-right: 4px;
    color: var(--color-text-secondary);
    font-size: 14px;
    line-height: 1.7;
    white-space: pre-wrap;
  }
}

@media (max-height: 600px) {
  .description-dialog {
    max-height: calc(100dvh - 32px);
  }
}
</style>
