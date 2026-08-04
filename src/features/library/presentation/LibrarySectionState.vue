<template>
  <div v-if="loading" class="section-state" role="status">
    <span class="spinner" aria-hidden="true"></span>
    <span>{{ t('library.loading') }}</span>
  </div>
  <div v-else-if="error" class="section-state error" role="alert">
    <span>{{ error }}</span>
    <button type="button" @click="emit('retry')">{{ t('library.retry') }}</button>
  </div>
  <div v-else-if="hasMore" class="section-state">
    <button class="flat-action" type="button" @click="emit('loadMore')">
      <AppIcon name="arrow-down" />
      <span>{{ t('library.loadMore') }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import AppIcon from '@/components/common/AppIcon.vue'

defineProps<{ loading: boolean; error: string | null; hasMore: boolean }>()
const emit = defineEmits<{ retry: []; loadMore: [] }>()
const { t } = useI18n()
</script>

<style scoped lang="scss">
.section-state {
  display: flex;
  min-height: 72px;
  padding: 24px 0;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--color-text);
  font-size: 14px;
  opacity: 0.7;

  .app-icon {
    width: 14px;
    height: 14px;
  }
}

.error {
  color: var(--color-danger);
  opacity: 1;
}

.spinner {
  width: 15px;
  height: 15px;
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
