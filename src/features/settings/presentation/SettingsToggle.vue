<template>
  <label class="settings-toggle" :class="{ disabled }">
    <input
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      :aria-label="label"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span aria-hidden="true"></span>
  </label>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: boolean
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<style scoped lang="scss">
.settings-toggle {
  position: relative;
  display: inline-flex;
  width: 38px;
  height: 20px;
  flex: 0 0 auto;

  input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    opacity: 0;
  }

  span {
    width: 38px;
    height: 20px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-text) 16%, transparent);
    transition:
      background-color 220ms ease,
      transform 120ms ease;

    &::after {
      position: absolute;
      top: 4px;
      left: 4px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--color-surface-raised);
      content: '';
      transition: transform 240ms cubic-bezier(0.22, 0.9, 0.32, 1.2);
    }
  }

  &:active:not(.disabled) span {
    transform: scale(0.94);
  }

  input:checked + span {
    background: var(--color-primary);

    &::after {
      transform: translateX(18px);
    }
  }

  input:focus-visible + span {
    outline: 2px solid color-mix(in srgb, var(--color-primary) 72%, transparent);
    outline-offset: 2px;
  }

  &.disabled {
    opacity: 0.48;
  }
}
</style>
