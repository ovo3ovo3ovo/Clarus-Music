<template>
  <div ref="root" class="settings-select" :class="{ open, disabled }">
    <button
      :id="id"
      class="settings-select__trigger"
      type="button"
      :disabled="disabled"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent="openMenu"
      @keydown.esc.prevent="close"
    >
      <span>{{ selectedOption?.label ?? '' }}</span>
      <AppIcon name="dropdown" />
    </button>

    <Transition name="floating-menu">
      <div v-if="open" class="settings-select__menu" role="listbox" :aria-label="label">
        <button
          v-for="option in options"
          :key="String(option.value)"
          class="settings-select__option"
          :class="{ selected: option.value === modelValue }"
          type="button"
          role="option"
          :aria-selected="option.value === modelValue"
          :disabled="option.disabled"
          @click="choose(option)"
        >
          <span>{{ option.label }}</span>
          <AppIcon v-if="option.value === modelValue" name="check" />
        </button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'

export interface SettingsSelectOption {
  readonly value: string | number
  readonly label: string
  readonly disabled?: boolean
}

const props = defineProps<{
  id?: string
  modelValue: string | number
  options: readonly SettingsSelectOption[]
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | number]
}>()

const root = ref<globalThis.HTMLElement | null>(null)
const open = ref(false)
const selectedOption = computed(() =>
  props.options.find((option) => option.value === props.modelValue),
)

function openMenu(): void {
  if (!props.disabled) open.value = true
}

function close(): void {
  open.value = false
}

function toggle(): void {
  if (props.disabled) return
  open.value = !open.value
}

function choose(option: SettingsSelectOption): void {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  close()
}

function handlePointerDown(event: globalThis.PointerEvent): void {
  if (root.value?.contains(event.target as globalThis.Node)) return
  close()
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close()
  },
)

onMounted(() => document.addEventListener('pointerdown', handlePointerDown))
onUnmounted(() => document.removeEventListener('pointerdown', handlePointerDown))
</script>

<style scoped lang="scss">
.settings-select {
  position: relative;
  z-index: 1;
  min-width: 176px;
  max-width: min(360px, 58vw);

  &.open {
    z-index: 20;
  }

  &.disabled {
    opacity: 0.48;
  }
}

.settings-select__trigger {
  display: flex;
  width: 100%;
  min-height: 30px;
  padding: 5px 6px 5px 8px;
  border: 0;
  border-radius: 5px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-text);
  background: transparent;
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  text-align: left;
  transition:
    color 160ms ease,
    background-color 160ms ease,
    transform 120ms ease;

  > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .app-icon {
    width: 14px;
    height: 14px;
    opacity: 0.58;
    transition: transform 180ms ease;
  }

  &:hover:not(:disabled) {
    background: var(--color-interactive-hover);
  }

  &:active:not(:disabled) {
    transform: scale(0.97);
  }
}

.open .settings-select__trigger {
  color: var(--color-primary);
  background: transparent;
  box-shadow: inset 0 -1px currentcolor !important;

  .app-icon {
    transform: rotate(180deg);
  }
}

.settings-select__menu {
  position: absolute;
  top: calc(100% + 7px);
  right: 0;
  width: max(100%, 236px);
  max-height: 280px;
  overflow: auto;
  padding: 4px;
  border: 0;
  border-radius: var(--floating-radius);
  background: var(--color-surface-raised);
  box-shadow: var(--floating-shadow);
  --floating-origin: top right;
}

.settings-select__option {
  display: flex;
  width: 100%;
  min-height: 32px;
  padding: 7px 8px;
  border: 0;
  border-radius: 4px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-text-secondary);
  background: transparent;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  transition:
    color 140ms ease,
    background-color 140ms ease;

  .app-icon {
    width: 15px;
    height: 15px;
    color: var(--color-primary);
  }

  &:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-interactive-hover);
  }

  &.selected {
    color: var(--color-primary);
    background: transparent;
    font-weight: var(--font-weight-medium);
  }

  &:disabled {
    opacity: 0.42;
  }
}
</style>
