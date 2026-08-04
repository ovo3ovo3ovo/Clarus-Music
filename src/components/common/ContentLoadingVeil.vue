<template>
  <div class="content-loading-veil" role="status" :aria-label="label" :style="veilStyle"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    label?: string
    minHeight?: string
  }>(),
  { label: '正在加载', minHeight: 'clamp(280px, 42vh, 440px)' },
)

const veilStyle = computed(() => ({ '--content-loading-min-height': props.minHeight }))
</script>

<style scoped lang="scss">
.content-loading-veil {
  position: relative;
  min-height: var(--content-loading-min-height);
  overflow: hidden;
  isolation: isolate;
  pointer-events: none;

  &::before,
  &::after {
    position: absolute;
    z-index: 0;
    content: '';
  }

  &::before {
    inset: 0;
    background: radial-gradient(
      72% 56% at 18% 42%,
      color-mix(in srgb, var(--color-text) 3%, transparent),
      transparent 72%
    );
  }

  &::after {
    top: -35%;
    left: -42%;
    width: 44%;
    height: 170%;
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--color-text) 5%, transparent),
      transparent
    );
    opacity: 0;
    transform: translate3d(-10%, 0, 0) rotate(7deg);
    will-change: transform, opacity;
    animation: ambient-loading-sweep 2.6s cubic-bezier(0.22, 0.61, 0.36, 1) infinite;
  }
}

@keyframes ambient-loading-sweep {
  0% {
    opacity: 0;
    transform: translate3d(-10%, 0, 0) rotate(7deg);
  }

  24% {
    opacity: 0.72;
  }

  76% {
    opacity: 0.5;
  }

  100% {
    opacity: 0;
    transform: translate3d(390%, 0, 0) rotate(7deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .content-loading-veil::after {
    opacity: 0.24;
    animation: none;
  }
}
</style>
