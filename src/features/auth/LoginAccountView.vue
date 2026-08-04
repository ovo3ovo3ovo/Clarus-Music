<template>
  <section class="account-login" aria-live="polite">
    <div class="login-panel">
      <img class="netease-logo" :src="neteaseMusicLogo" alt="" aria-hidden="true" />
      <h1>{{ t('login.netease') }}</h1>

      <div class="qr-frame" :aria-busy="loading">
        <img v-if="qrImage" :src="qrImage" :alt="t('login.qrAlt')" />
        <div v-else class="qr-placeholder" />
      </div>

      <p :class="{ error: errorMessage }">{{ errorMessage || statusMessage }}</p>
      <button v-if="expired || errorMessage" type="button" @click="startLogin">
        {{ t('login.refresh') }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import QRCode from 'qrcode'
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import neteaseMusicLogo from '@/assets/logos/netease-music.png'
import { desktop } from '@/platform/desktop'
import { useAuthStore } from './application/auth-store'
import { nativeAuthGateway } from './infrastructure/native-auth'

const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()
const qrImage = shallowRef('')
const statusKey = shallowRef('scan')
const statusMessage = computed(() =>
  statusKey.value === 'scan' ? t('login.scan') : t(`login.status.${statusKey.value}`),
)
const errorMessage = shallowRef('')
const expired = shallowRef(false)
const loading = shallowRef(true)
let lifecycleController: AbortController | null = null

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      reject(new DOMException(String(signal.reason ?? 'Polling aborted'), 'AbortError'))
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function poll(key: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await delay(1800, signal)
    const result = await nativeAuthGateway.checkQrLogin(key, signal)
    statusKey.value = result.status
    if (result.status === 'expired') {
      expired.value = true
      return
    }
    if (result.status === 'authorized') {
      const session = await authStore.restore()
      if (!session.authenticated) {
        throw new Error(authStore.error ?? t('login.validationFailed'))
      }
      await router.replace('/library')
      return
    }
  }
}

async function startLogin(): Promise<void> {
  lifecycleController?.abort('QR login restarted')
  const controller = new AbortController()
  lifecycleController = controller
  loading.value = true
  expired.value = false
  errorMessage.value = ''
  qrImage.value = ''
  statusKey.value = 'scan'
  if (!desktop.isDesktop) {
    errorMessage.value = t('login.desktopRequired')
    loading.value = false
    return
  }
  try {
    const login = await nativeAuthGateway.beginQrLogin(controller.signal)
    const svg = await QRCode.toString(login.loginUrl, {
      type: 'svg',
      width: 192,
      margin: 0,
      color: { dark: '#335eea', light: '#00000000' },
      errorCorrectionLevel: 'M',
    })
    if (controller.signal.aborted) return
    qrImage.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    loading.value = false
    await poll(login.key, controller.signal)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
      loading.value = false
    }
  }
}

onMounted(() => void startLogin())
onUnmounted(() => lifecycleController?.abort('QR login view disposed'))
</script>

<style scoped lang="scss">
.account-login {
  display: grid;
  min-height: calc(100vh - 192px);
  place-items: center;
  color: var(--color-text);
}

.login-panel {
  display: flex;
  width: 326px;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.netease-logo {
  width: 64px;
  height: 64px;
}

h1 {
  margin: 18px 0 26px;
  font-size: 24px;
}

.qr-frame {
  display: grid;
  width: 216px;
  height: 216px;
  border-radius: 6px;
  place-items: center;
  background: var(--color-surface-low);

  img,
  .qr-placeholder {
    width: 192px;
    height: 192px;
  }
}

.qr-placeholder {
  border-radius: 4px;
  background: var(--color-secondary-bg);
  animation: pulse 1.2s ease-in-out infinite alternate;
}

p {
  min-height: 22px;
  margin: 18px 0;
  font-size: 12px;
  opacity: 0.72;

  &.error {
    color: var(--color-danger);
    opacity: 1;
  }
}

button {
  min-height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  color: var(--color-text-secondary);
  background: transparent;
  font-size: 12px;
  font-weight: var(--font-weight-medium);

  &:hover:not(:disabled),
  &:focus-visible:not(:disabled) {
    color: var(--color-text);
    background: var(--color-interactive-hover);
  }
}

@keyframes pulse {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 0.85;
  }
}
</style>
