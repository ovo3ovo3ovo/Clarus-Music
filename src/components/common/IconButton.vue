<template>
  <button class="icon-button" type="button" :title="title" :aria-label="title" :disabled="disabled">
    <span class="icon-glyph" aria-hidden="true">
      <AppIcon :name="icon" />
    </span>
  </button>
</template>

<script setup lang="ts">
import AppIcon from './AppIcon.vue'

defineProps<{ icon: string; title: string; disabled?: boolean }>()
</script>

<style scoped lang="scss">
.icon-button {
  display: inline-flex;
  position: relative;
  z-index: 0;
  width: 32px;
  height: 32px;
  padding: 7px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  color: var(--color-secondary);
  background: transparent;
  opacity: 0.82;
  isolation: isolate;
  transition:
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease;

  .icon-glyph {
    display: inline-flex;
    width: 1em;
    height: 1em;
    flex: 0 0 1em;
    align-items: center;
    justify-content: center;
    transform-origin: center;
    transition: transform var(--motion-hover-emphasis) var(--ease-out);
    pointer-events: none;
  }

  &:hover:not(:disabled) {
    color: var(--color-text);
    background: transparent;
    opacity: 1;

    .icon-glyph {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:focus-visible:not(:disabled):not(:hover) {
    color: var(--color-text);
    background: transparent;
    opacity: 1;

    .icon-glyph {
      transform: none;
    }
  }

  &:active:not(:disabled) {
    background: transparent;
    /* Keep pressed and hovered states on one transform path: no bump on release. */

    .icon-glyph {
      transform: scale(var(--scale-hover-icon));
    }
  }

  &:disabled {
    cursor: default;
    opacity: 0.3;

    .icon-glyph {
      transform: none;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .icon-button {
    transition: none;

    .icon-glyph {
      transition: none;
    }

    &:hover:not(:disabled),
    &:focus-visible:not(:disabled),
    &:active:not(:disabled) {
      .icon-glyph {
        transform: none;
      }
    }
  }
}
</style>
