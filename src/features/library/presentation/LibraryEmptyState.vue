<template>
  <div class="library-empty-state" aria-live="polite">
    <AppIcon :name="icon" />
    <div>
      <p>{{ title }}</p>
      <span>{{ description }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'

defineProps<{
  icon: string
  title: string
  description: string
}>()
</script>

<style scoped lang="scss">
.library-empty-state {
  display: grid;
  min-height: clamp(280px, 42vh, 420px);
  place-content: center;
  gap: 13px;
  color: var(--color-text-secondary);
  text-align: center;

  .app-icon {
    width: 30px;
    height: 30px;
    margin: 0 auto;
    opacity: 0.28;
  }

  p,
  span {
    display: block;
    margin: 0;
  }

  p {
    color: var(--color-text);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: -0.012em;
    opacity: 0.78;
  }

  span {
    margin-top: 5px;
    font-size: 12px;
    line-height: 1.45;
    opacity: 0.58;
  }
}
</style>
