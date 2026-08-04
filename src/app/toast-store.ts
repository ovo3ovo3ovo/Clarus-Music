import { computed, onScopeDispose, shallowRef } from 'vue'
import { defineStore } from 'pinia'

const DEFAULT_DURATION_MS = 3200

export function createToastStore(storeId = 'toast') {
  return defineStore(storeId, () => {
    const message = shallowRef<string | null>(null)
    const visible = computed(() => message.value !== null)
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null

    function clearTimer(): void {
      if (timer === null) return
      globalThis.clearTimeout(timer)
      timer = null
    }

    function hide(): void {
      clearTimer()
      message.value = null
    }

    function show(nextMessage: string, durationMs = DEFAULT_DURATION_MS): void {
      const normalized = nextMessage.trim()
      if (normalized.length === 0) return
      clearTimer()
      message.value = normalized
      if (durationMs <= 0) return
      const nextTimer = globalThis.setTimeout(() => {
        if (timer !== nextTimer) return
        timer = null
        message.value = null
      }, durationMs)
      timer = nextTimer
    }

    function dispose(): void {
      hide()
    }

    onScopeDispose(dispose)

    return { message, visible, show, hide, dispose }
  })
}

export const useToastStore = createToastStore()
