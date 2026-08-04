<template>
  <header class="section-heading">
    <h2>{{ title }}</h2>
    <RouterLink :to="to">{{ t('home.seeMore') }}</RouterLink>
  </header>
</template>

<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { useI18n } from 'vue-i18n'

defineProps<{
  title: string
  to: RouteLocationRaw
}>()

const { t } = useI18n()
</script>

<style scoped lang="scss">
.section-heading {
  display: flex;
  margin-bottom: 12px;
  align-items: center;
  justify-content: space-between;

  h2 {
    margin: 0;
    color: var(--color-text);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.03em;
  }

  a {
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 600;
  }
}
</style>
