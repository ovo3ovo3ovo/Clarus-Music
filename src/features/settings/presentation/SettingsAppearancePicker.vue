<template>
  <div class="appearance-picker" role="radiogroup" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      class="appearance-option"
      :class="{ selected: option.value === modelValue }"
      type="button"
      role="radio"
      :aria-checked="option.value === modelValue"
      @click="emit('update:modelValue', option.value)"
    >
      <span
        class="appearance-option__preview"
        :class="`appearance-option__preview--${option.value}`"
      />
      <span class="appearance-option__label">{{ option.label }}</span>
      <AppIcon v-if="option.value === modelValue" class="appearance-option__check" name="check" />
    </button>
  </div>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import type { AppTheme } from '../domain/settings'

export interface AppearanceOption {
  readonly value: AppTheme
  readonly label: string
}

defineProps<{
  readonly modelValue: AppTheme
  readonly options: readonly AppearanceOption[]
  readonly label: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: AppTheme]
}>()
</script>

<style scoped lang="scss">
.appearance-picker {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
}

.appearance-option {
  display: flex;
  min-width: 0;
  min-height: 38px;
  padding: 4px 6px;
  border: 0;
  border-radius: 5px;
  align-items: center;
  gap: 7px;
  color: var(--color-text-secondary);
  background: transparent;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  letter-spacing: -0.008em;
  text-align: left;
  transition:
    color var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    transform var(--motion-fast) var(--ease-out);

  &:hover,
  &:focus-visible {
    color: var(--color-text);
    background: var(--color-interactive-hover);
  }

  &:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--color-text) 48%, transparent);
    outline-offset: 2px;
  }

  &:active {
    background: var(--color-interactive-pressed);
    transform: scale(0.985);
  }

  &.selected {
    color: var(--color-text);
  }
}

.appearance-option__preview {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 50%;
  outline: 1px solid rgb(255 255 255 / 16%);
  outline-offset: -1px;

  &--oled {
    background: #000;
  }

  &--light {
    background: linear-gradient(145deg, #fffefa 0%, #e4e1d9 100%);
    outline-color: rgb(23 23 25 / 20%);
  }
}

.appearance-option__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.appearance-option__check {
  width: 14px;
  height: 14px;
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--color-toggle-active);
}
</style>
