<template>
  <div class="settings-page">
    <div class="settings-container">
      <section v-if="authStore.session.user" class="account-card">
        <div class="account-identity">
          <CoverImage
            class="avatar"
            :source="authStore.session.user.avatarUrl"
            :width="88"
            role="avatar"
            alt=""
            decoding="async"
          />
          <div class="account-copy">
            <strong>{{ authStore.session.user.nickname }}</strong>
            <span>{{
              authStore.session.user.vipType > 0
                ? t('settings.account.vip')
                : authStore.session.user.signature
            }}</span>
          </div>
        </div>
      </section>

      <section class="settings-section" :aria-label="t('settings.appearance.label')">
        <div class="settings-section-content">
          <div class="settings-row">
            <label for="settings-appearance">{{ t('settings.appearance.label') }}</label>
            <SettingsSelect
              id="settings-appearance"
              :model-value="settingsStore.settings.appearance"
              :options="appearanceOptions"
              :label="t('settings.appearance.label')"
              @update:model-value="updateAppearance"
            />
          </div>
        </div>
      </section>

      <section class="settings-section" :aria-label="t('settings.language')">
        <div class="settings-section-content">
          <div class="settings-row">
            <label for="settings-locale">{{ t('settings.language') }}</label>
            <SettingsSelect
              id="settings-locale"
              :model-value="settingsStore.settings.locale"
              :options="localeOptions"
              :label="t('settings.language')"
              @update:model-value="updateLocale"
            />
          </div>
        </div>
      </section>

      <section
        v-if="desktop.isDesktop"
        class="settings-section"
        :aria-label="t('settings.window.closeBehavior')"
      >
        <div class="settings-section-content">
          <div class="settings-row">
            <label for="settings-close-option">{{ t('settings.window.closeBehavior') }}</label>
            <SettingsSelect
              id="settings-close-option"
              :model-value="settingsStore.settings.closeAppOption"
              :options="closeAppOptions"
              :label="t('settings.window.closeBehavior')"
              @update:model-value="updateCloseAppOption"
            />
          </div>
        </div>
      </section>

      <section class="settings-section" :aria-label="t('settings.playback.title')">
        <div class="settings-section-content">
          <div class="settings-row">
            <label for="settings-music-quality">{{ t('settings.playback.quality') }}</label>
            <SettingsSelect
              id="settings-music-quality"
              :model-value="settingsStore.settings.musicQuality"
              :options="musicQualityOptions"
              :label="t('settings.playback.quality')"
              @update:model-value="updateMusicQuality"
            />
          </div>

          <div v-if="outputDeviceAvailable" class="settings-row">
            <label for="settings-output-device">{{ t('settings.outputDevice.label') }}</label>
            <SettingsSelect
              id="settings-output-device"
              :model-value="settingsStore.settings.outputDevice"
              :options="outputDeviceOptions"
              :label="t('settings.outputDevice.label')"
              :disabled="outputDeviceBusy"
              @update:model-value="changeOutputDevice"
            />
          </div>
        </div>
      </section>

      <template v-if="desktop.isDesktop">
        <section class="settings-section" :aria-label="t('settings.cache.title')">
          <div class="settings-section-content">
            <div class="settings-row">
              <span>{{ t('settings.cache.automatic') }}</span>
              <SettingsToggle
                :model-value="settingsStore.settings.automaticallyCacheSongs"
                :label="t('settings.cache.automatic')"
                @update:model-value="updateAutomaticCache"
              />
            </div>

            <div class="settings-row">
              <label for="settings-cache-limit">{{ t('settings.cache.limit') }}</label>
              <SettingsSelect
                id="settings-cache-limit"
                :model-value="settingsStore.settings.cacheLimitMb ?? 'none'"
                :options="cacheLimitOptions"
                :label="t('settings.cache.limit')"
                @update:model-value="updateCacheLimit"
              />
            </div>

            <div class="settings-row cache-summary-row">
              <span>{{
                t('settings.cache.summary', {
                  count: cacheStats.trackCount,
                  size: formatCacheBytes(cacheStats.totalBytes),
                })
              }}</span>
              <button
                class="settings-command"
                type="button"
                :disabled="cacheBusy"
                @click="clearCache"
              >
                {{ t('settings.cache.clear') }}
              </button>
            </div>
            <p v-if="cacheError" class="form-feedback error" role="alert">{{ cacheError }}</p>
          </div>
        </section>
      </template>

      <template v-if="desktop.isDesktop">
        <section class="settings-section" :aria-label="t('settings.shortcuts.title')">
          <div class="settings-section-content">
            <div class="settings-row">
              <span>{{ t('settings.shortcuts.global') }}</span>
              <SettingsToggle
                :model-value="settingsStore.settings.enableGlobalShortcut"
                :label="t('settings.shortcuts.global')"
                @update:model-value="updateGlobalShortcut"
              />
            </div>
          </div>
        </section>
      </template>

      <section class="settings-section" :aria-label="t('settings.lyrics.title')">
        <div class="settings-section-content">
          <div class="settings-row">
            <span>{{ t('settings.lyrics.translation') }}</span>
            <SettingsToggle
              :model-value="settingsStore.settings.showLyricsTranslation"
              :label="t('settings.lyrics.translation')"
              @update:model-value="updateLyricsTranslation"
            />
          </div>

          <div class="settings-row">
            <label for="settings-lyric-font-size">{{ t('settings.lyrics.fontSize') }}</label>
            <SettingsSelect
              id="settings-lyric-font-size"
              :model-value="settingsStore.settings.lyricFontSize"
              :options="lyricFontSizeOptions"
              :label="t('settings.lyrics.fontSize')"
              @update:model-value="updateLyricFontSize"
            />
          </div>

          <div class="settings-row">
            <label for="settings-lyrics-background">{{ t('settings.lyrics.background') }}</label>
            <SettingsSelect
              id="settings-lyrics-background"
              :model-value="settingsStore.settings.lyricsBackground"
              :options="lyricsBackgroundOptions"
              :label="t('settings.lyrics.background')"
              @update:model-value="updateLyricsBackground"
            />
          </div>
        </div>
      </section>

      <section class="settings-section" :aria-label="t('settings.network.title')">
        <div class="settings-section-content network-content">
          <form class="network-form" @submit.prevent="applyProxy">
            <div class="settings-row">
              <label for="settings-proxy-protocol">{{ t('settings.network.proxyProtocol') }}</label>
              <SettingsSelect
                id="settings-proxy-protocol"
                :model-value="proxyDraft.protocol"
                :options="proxyProtocolOptions"
                :label="t('settings.network.proxyProtocol')"
                @update:model-value="updateProxyProtocol"
              />
            </div>
            <div class="network-fields" :class="{ disabled: proxyDraft.protocol === 'noProxy' }">
              <input
                v-model="proxyDraft.server"
                type="text"
                autocomplete="off"
                :disabled="proxyDraft.protocol === 'noProxy'"
                :placeholder="t('settings.network.server')"
                :aria-label="t('settings.network.server')"
              />
              <input
                v-model="proxyDraft.port"
                type="number"
                inputmode="numeric"
                min="1"
                max="65535"
                :disabled="proxyDraft.protocol === 'noProxy'"
                :placeholder="t('settings.network.port')"
                :aria-label="t('settings.network.port')"
              />
              <button type="submit" :disabled="networkBusy">{{ t('settings.apply') }}</button>
            </div>
          </form>

          <form class="network-form" @submit.prevent="applyRealIp">
            <div class="settings-row">
              <span>{{ t('settings.network.realIp') }}</span>
              <SettingsToggle v-model="realIpDraft.enabled" :label="t('settings.network.realIp')" />
            </div>
            <div class="network-fields real-ip-fields" :class="{ disabled: !realIpDraft.enabled }">
              <input
                v-model="realIpDraft.value"
                type="text"
                autocomplete="off"
                :disabled="!realIpDraft.enabled"
                :placeholder="t('settings.network.ipAddress')"
                :aria-label="t('settings.network.ipAddress')"
              />
              <button type="submit" :disabled="networkBusy">{{ t('settings.apply') }}</button>
            </div>
          </form>

          <div class="settings-feedback-stack">
            <p
              v-if="feedbackMessage"
              class="form-feedback"
              :class="{ error: feedbackIsError }"
              role="status"
            >
              {{ feedbackMessage }}
            </p>
            <p v-if="settingsStore.persistenceError" class="form-feedback error" role="alert">
              {{ settingsStore.persistenceError }}
            </p>
            <p v-if="outputDeviceError" class="form-feedback error" role="alert">
              {{ outputDeviceError }}
            </p>
            <p v-if="authStore.error" class="form-feedback error" role="alert">
              {{ authStore.error }}
            </p>
          </div>
        </div>
      </section>

      <section v-if="authStore.session.user" class="logout-zone">
        <button
          class="logout-button"
          type="button"
          :disabled="logoutBusy"
          @click="logoutDialogOpen = true"
        >
          <AppIcon name="logout" />
          {{ t('settings.account.logout') }}
        </button>
      </section>
    </div>

    <Teleport to="body">
      <Transition name="floating-dialog">
        <div
          v-if="logoutDialogOpen"
          class="dialog-layer"
          role="presentation"
          @pointerdown.self="closeLogoutDialog"
        >
          <section
            ref="logoutDialog"
            class="dialog-card"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="logoutDialogTitleId"
            tabindex="-1"
            @keydown.esc.stop.prevent="closeLogoutDialog"
          >
            <div class="dialog-icon"><AppIcon name="logout" /></div>
            <h2 :id="logoutDialogTitleId">{{ t('settings.account.logout') }}</h2>
            <p>{{ t('accountMenu.logoutConfirm') }}</p>
            <div class="dialog-actions">
              <button type="button" @click="closeLogoutDialog">
                {{ t('settings.cancel') }}
              </button>
              <button class="danger" type="button" :disabled="logoutBusy" @click="logout">
                {{ t('settings.confirmLogout') }}
              </button>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import CoverImage from '@/components/common/CoverImage.vue'
import { useAuthStore } from '@/features/auth/application/auth-store'
import { formatCacheBytes, type AudioCacheStats } from '@/features/cache/domain/audio-cache'
import { nativeAudioCacheGateway } from '@/features/cache/infrastructure/native-audio-cache'
import { usePlayerStore } from '@/features/player/application/player-store'
import { desktop } from '@/platform/desktop'
import { useSettingsStore } from './application/settings-store'
import { validateProxyDraft, validateRealIpDraft } from './domain/settings-form'
import type {
  AppTheme,
  AppLocale,
  CloseAppOption,
  LyricFontSize,
  LyricsBackground,
  MusicQuality,
  ProxyProtocol,
} from './domain/settings'
import SettingsSelect from './presentation/SettingsSelect.vue'
import SettingsToggle from './presentation/SettingsToggle.vue'

const { t } = useI18n()
const router = useRouter()
const authStore = useAuthStore()
const playerStore = usePlayerStore()
const settingsStore = useSettingsStore()
const logoutBusy = shallowRef(false)
const logoutDialogOpen = shallowRef(false)
const logoutDialog = ref<globalThis.HTMLElement | null>(null)
const logoutDialogTitleId = `settings-logout-dialog-title-${crypto.randomUUID()}`
let logoutReturnFocus: globalThis.HTMLElement | null = null
const outputDeviceBusy = shallowRef(false)
const outputDeviceError = shallowRef('')
const outputDevices = shallowRef<
  readonly Readonly<{ deviceId: string; kind: string; label: string }>[]
>([])
const networkBusy = shallowRef(false)
const cacheBusy = shallowRef(false)
const cacheError = shallowRef('')
const cacheStats = shallowRef<AudioCacheStats>({ trackCount: 0, totalBytes: 0, limitBytes: null })
const feedbackMessage = shallowRef('')
const feedbackIsError = shallowRef(false)

const proxyDraft = reactive<{
  protocol: ProxyProtocol
  server: string
  port: string
}>({
  protocol: settingsStore.settings.proxy.protocol,
  server: settingsStore.settings.proxy.server,
  port: settingsStore.settings.proxy.port?.toString() ?? '',
})

const realIpDraft = reactive({
  enabled: settingsStore.settings.enableRealIp,
  value: settingsStore.settings.realIp ?? '',
})

const mediaDevices = navigator.mediaDevices
const outputDeviceAvailable = computed(
  () => playerStore.outputDeviceSelectionSupported && mediaDevices !== undefined,
)
const savedOutputDeviceMissing = computed(
  () =>
    settingsStore.settings.outputDevice !== 'default' &&
    !outputDevices.value.some((device) => device.deviceId === settingsStore.settings.outputDevice),
)
const localeOptions = computed(() => [
  { value: 'auto', label: t('settings.languageOptions.auto') },
  { value: 'en', label: 'English' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
])
const appearanceOptions = computed(() => [
  { value: 'oled' as const, label: t('settings.appearance.oled') },
  { value: 'light' as const, label: t('settings.appearance.light') },
])
const closeAppOptions = computed(() => [
  { value: 'ask', label: t('settings.window.ask') },
  { value: 'exit', label: t('settings.window.exit') },
  { value: 'minimizeToTray', label: t('settings.window.minimize') },
])
const musicQualityOptions = computed(() => [
  { value: '128000', label: t('settings.playback.qualityOptions.standard') },
  { value: '192000', label: t('settings.playback.qualityOptions.higher') },
  { value: '320000', label: t('settings.playback.qualityOptions.high') },
  { value: 'flac', label: t('settings.playback.qualityOptions.lossless') },
  { value: '999000', label: t('settings.playback.qualityOptions.hires') },
])
const outputDeviceOptions = computed(() => [
  { value: 'default', label: t('settings.outputDevice.default') },
  ...(savedOutputDeviceMissing.value
    ? [
        {
          value: settingsStore.settings.outputDevice,
          label: t('settings.outputDevice.unavailable'),
          disabled: true,
        },
      ]
    : []),
  ...outputDevices.value.map((device) => ({
    value: device.deviceId,
    label: device.label || t('settings.outputDevice.unnamed'),
  })),
])
const cacheLimitOptions = computed(() => [
  { value: 'none', label: t('settings.cache.unlimited') },
  { value: 512, label: '500 MB' },
  { value: 1024, label: '1 GB' },
  { value: 2048, label: '2 GB' },
  { value: 4096, label: '4 GB' },
  { value: 8192, label: '8 GB' },
])
const lyricFontSizeOptions = computed(() => [
  { value: 36, label: `${t('settings.lyrics.fontSizeOptions.small')} - 36px` },
  { value: 44, label: `${t('settings.lyrics.fontSizeOptions.medium')} - 44px` },
  { value: 52, label: `${t('settings.lyrics.fontSizeOptions.large')} - 52px` },
  { value: 60, label: `${t('settings.lyrics.fontSizeOptions.extraLarge')} - 60px` },
])
const lyricsBackgroundOptions = computed(() => [
  { value: 'off', label: t('settings.lyrics.backgroundOptions.off') },
  { value: 'cover', label: t('settings.lyrics.backgroundOptions.cover') },
  { value: 'blur', label: t('settings.lyrics.backgroundOptions.blur') },
  { value: 'dynamic', label: t('settings.lyrics.backgroundOptions.dynamic') },
])
const proxyProtocolOptions = computed(() => [
  { value: 'noProxy', label: t('settings.network.noProxy') },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
])

function updateLocale(value: string | number): void {
  settingsStore.update({ locale: String(value) as AppLocale })
}

function updateAppearance(value: string | number): void {
  settingsStore.update({ appearance: String(value) as AppTheme })
}

function updateCloseAppOption(value: string | number): void {
  settingsStore.update({ closeAppOption: String(value) as CloseAppOption })
}

function updateMusicQuality(value: string | number): void {
  settingsStore.update({ musicQuality: String(value) as MusicQuality })
}

function updateGlobalShortcut(enabled: boolean): void {
  settingsStore.update({ enableGlobalShortcut: enabled })
}

function updateAutomaticCache(enabled: boolean): void {
  settingsStore.update({ automaticallyCacheSongs: enabled })
}

function updateCacheLimit(value: string | number): void {
  settingsStore.update({ cacheLimitMb: value === 'none' ? null : Number(value) })
}

async function refreshCacheStats(): Promise<void> {
  if (!desktop.isDesktop) return
  cacheError.value = ''
  try {
    cacheStats.value = await nativeAudioCacheGateway.stats()
  } catch (reason) {
    cacheError.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function clearCache(): Promise<void> {
  cacheBusy.value = true
  cacheError.value = ''
  try {
    cacheStats.value = await nativeAudioCacheGateway.clear()
  } catch (reason) {
    cacheError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    cacheBusy.value = false
  }
}

function updateLyricsTranslation(enabled: boolean): void {
  settingsStore.update({ showLyricsTranslation: enabled })
}

function updateLyricFontSize(value: string | number): void {
  settingsStore.update({ lyricFontSize: Number(value) as LyricFontSize })
}

function updateLyricsBackground(value: string | number): void {
  settingsStore.update({ lyricsBackground: String(value) as LyricsBackground })
}

function updateProxyProtocol(value: string | number): void {
  proxyDraft.protocol = String(value) as ProxyProtocol
}

async function refreshOutputDevices(): Promise<void> {
  if (!outputDeviceAvailable.value || mediaDevices === undefined) return
  try {
    const devices = await mediaDevices.enumerateDevices()
    outputDevices.value = devices.filter(
      (device, index, all) =>
        device.kind === 'audiooutput' &&
        device.deviceId !== 'default' &&
        all.findIndex((candidate) => candidate.deviceId === device.deviceId) === index,
    )
  } catch (reason) {
    outputDeviceError.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function changeOutputDevice(value: string | number): Promise<void> {
  const deviceId = String(value)
  if (deviceId === settingsStore.settings.outputDevice) return
  outputDeviceBusy.value = true
  outputDeviceError.value = ''
  try {
    await playerStore.setOutputDevice(deviceId)
    settingsStore.update({ outputDevice: deviceId })
    await settingsStore.flush()
  } catch (reason) {
    outputDeviceError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    outputDeviceBusy.value = false
  }
}

function setFeedback(message: string, error = false): void {
  feedbackMessage.value = message
  feedbackIsError.value = error
}

async function applyProxy(): Promise<void> {
  const result = validateProxyDraft(proxyDraft)
  if (!result.ok) {
    setFeedback(t(`settings.network.invalid.${result.field}`), true)
    return
  }
  networkBusy.value = true
  setFeedback('')
  try {
    settingsStore.update({ proxy: result.value })
    await settingsStore.flush()
    setFeedback(t('settings.saved'))
  } catch {
    setFeedback(t('settings.saveFailed'), true)
  } finally {
    networkBusy.value = false
  }
}

async function applyRealIp(): Promise<void> {
  let realIp: string | null = null
  if (realIpDraft.enabled) {
    const result = validateRealIpDraft(realIpDraft.value)
    if (!result.ok) {
      setFeedback(t('settings.network.invalid.realIp'), true)
      return
    }
    realIp = result.value
  } else if (realIpDraft.value.trim().length > 0) {
    const result = validateRealIpDraft(realIpDraft.value)
    if (result.ok) realIp = result.value
  }

  networkBusy.value = true
  setFeedback('')
  try {
    settingsStore.update({ enableRealIp: realIpDraft.enabled, realIp })
    await settingsStore.flush()
    setFeedback(t('settings.saved'))
  } catch {
    setFeedback(t('settings.saveFailed'), true)
  } finally {
    networkBusy.value = false
  }
}

async function logout(): Promise<void> {
  logoutBusy.value = true
  try {
    await authStore.logout()
    logoutDialogOpen.value = false
    await router.replace('/library')
  } finally {
    logoutBusy.value = false
  }
}

function closeLogoutDialog(): void {
  if (logoutBusy.value) return
  logoutDialogOpen.value = false
}

function handleLogoutDialogKeydown(event: globalThis.KeyboardEvent): void {
  if (logoutDialogOpen.value && event.key === 'Escape') {
    event.preventDefault()
    closeLogoutDialog()
  }
}

watch(
  () => logoutDialogOpen.value,
  async (open) => {
    if (open) {
      logoutReturnFocus =
        document.activeElement instanceof globalThis.HTMLElement ? document.activeElement : null
      await nextTick()
      logoutDialog.value?.focus({ preventScroll: true })
      return
    }

    logoutReturnFocus?.focus({ preventScroll: true })
    logoutReturnFocus = null
  },
)

watch(
  () => settingsStore.settings.proxy,
  (proxy) => {
    proxyDraft.protocol = proxy.protocol
    proxyDraft.server = proxy.server
    proxyDraft.port = proxy.port?.toString() ?? ''
  },
)

watch(
  () => [settingsStore.settings.enableRealIp, settingsStore.settings.realIp] as const,
  ([enabled, realIp]) => {
    realIpDraft.enabled = enabled
    realIpDraft.value = realIp ?? ''
  },
)

onMounted(() => {
  void refreshOutputDevices()
  void refreshCacheStats()
  mediaDevices?.addEventListener('devicechange', refreshOutputDevices)
  document.addEventListener('keydown', handleLogoutDialogKeydown)
})

onUnmounted(() => {
  mediaDevices?.removeEventListener('devicechange', refreshOutputDevices)
  document.removeEventListener('keydown', handleLogoutDialogKeydown)
})
</script>

<style scoped lang="scss">
.settings-page {
  position: relative;
  display: flex;
  min-height: 100%;
  justify-content: center;
}

.settings-container {
  width: min(820px, 100%);
  margin: 0 auto;
  padding: 28px clamp(0px, 2vw, 22px) 104px;
}

.account-card {
  display: flex;
  min-height: 72px;
  margin-bottom: 16px;
  padding: 0 0 24px;
  border: 0;
  border-radius: 0;
  align-items: center;
  color: var(--color-text);
  background: transparent;
  box-shadow: none;
}

.account-identity {
  display: flex;
  min-width: 0;
  align-items: center;
}

.avatar {
  width: 56px;
  height: 56px;
  flex: 0 0 auto;
  border-radius: 14px;
  object-fit: cover;
}

.account-copy {
  display: flex;
  min-width: 0;
  margin-left: 14px;
  flex-direction: column;

  strong {
    overflow: hidden;
    color: var(--color-text);
    font-size: 18px;
    font-weight: var(--font-weight-medium);
    letter-spacing: -0.015em;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    overflow: hidden;
    margin-top: 5px;
    color: var(--color-text-secondary);
    font-size: 12px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.settings-section {
  display: block;
  margin: 0;
  padding: 14px 0;
}

.settings-section-content {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.network-fields button,
.settings-command {
  min-height: 30px;
  padding: 6px 8px;
  border: 0;
  border-radius: 5px;
  color: var(--color-text-secondary);
  background: transparent;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  transition:
    color 160ms ease,
    background-color 160ms ease,
    transform 160ms ease;

  &:active:not(:disabled) {
    background: var(--color-interactive-pressed);
    transform: scale(0.98);
  }

  &:disabled {
    opacity: 0.48;
  }
}

.logout-button {
  display: flex;
  min-width: 0;
  min-height: 32px;
  padding: 6px 8px;
  border: 0;
  border-radius: 5px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--color-danger);
  background: transparent;
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  transition:
    color 160ms ease,
    background-color 160ms ease,
    border-color 160ms ease,
    transform 120ms ease;

  .app-icon {
    width: 16px;
    height: 16px;
  }

  &:hover:not(:disabled) {
    color: var(--color-danger);
    background: var(--color-danger-hover);
  }

  &:active:not(:disabled) {
    transform: scale(0.98);
  }

  &:disabled {
    opacity: 0.48;
  }
}

.logout-zone {
  display: flex;
  margin-top: 12px;
  padding: 22px 0 8px;
  border-top: 0;
  justify-content: flex-end;
}

.settings-command {
  min-width: 0;
  padding: 6px 8px;

  &:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-interactive-hover);
  }
}

.cache-summary-row > span {
  overflow-wrap: anywhere;
}

.settings-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-height: 42px;
  margin: 0;
  padding: 5px 0;
  align-items: center;
  gap: 16px;
  color: var(--color-text);

  > label,
  > span {
    min-width: 0;
    color: var(--color-text);
    font-size: 14px;
    font-weight: var(--font-weight-regular);
    letter-spacing: -0.005em;
    line-height: 1.35;
  }
}

.settings-row > .settings-select {
  flex: 0 0 auto;
  margin-left: auto;
}

.network-content {
  gap: 14px;
}

.network-form {
  min-width: 0;
}

.network-form + .network-form {
  margin-top: 4px;
}

input:not([type='checkbox']) {
  min-height: 36px;
  border: 0;
  border-radius: 7px;
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  font-size: 13px;
  font-weight: var(--font-weight-regular);
  transition: background-color 160ms ease;

  &:focus {
    outline: none;
    background: color-mix(in srgb, var(--color-text) 10%, transparent);
  }
}

.network-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 128px auto;
  gap: 8px;
  margin-top: 4px;
  align-items: center;
  transition: opacity 160ms ease;

  &.disabled {
    opacity: 0.47;
  }

  input {
    width: 100%;
    min-width: 0;
    padding: 7px 11px;
  }

  button {
    padding: 7px 12px;
  }
}

.real-ip-fields {
  grid-template-columns: minmax(0, 1fr) auto;
}

.form-feedback {
  margin: 0;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  line-height: 1.4;

  &.error {
    color: var(--color-danger);
  }
}

.settings-feedback-stack {
  display: grid;
  gap: 4px;
  margin-top: 1px;
}

.dialog-layer {
  position: fixed;
  z-index: var(--z-overlay);
  inset: 0;
  display: grid;
  padding: 24px;
  background: var(--color-overlay-scrim);
  place-items: center;
}

.dialog-card {
  width: min(400px, 100%);
  padding: 28px;
  border: 0;
  border-radius: var(--floating-dialog-radius);
  color: var(--color-text);
  background: var(--color-surface-raised);
  box-shadow: var(--floating-dialog-shadow);
  text-align: center;
  transition:
    opacity 220ms ease,
    transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1);

  h2 {
    margin: 16px 0 0;
    padding: 0;
    border: 0;
    font-size: 21px;
  }

  p {
    margin: 8px 0 22px;
    color: var(--color-text-secondary);
    font-size: 14px;
    line-height: 1.45;
  }
}

@media (max-width: 900px) {
  .settings-container {
    padding-inline: 0;
  }

  .settings-section {
    padding-block: 16px;
  }

  .settings-section-content {
    width: 100%;
  }
}

.dialog-icon {
  display: grid;
  width: 36px;
  height: 36px;
  margin: 0 auto;
  color: var(--color-danger);
  background: transparent;
  place-items: center;

  .app-icon {
    width: 24px;
    height: 24px;
  }
}

.dialog-actions {
  display: grid;
  gap: 3px;

  button {
    min-height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: 5px;
    color: var(--color-text-secondary);
    background: transparent;
    font-size: 13px;
    font-weight: var(--font-weight-medium);
    transition:
      background-color 160ms ease,
      transform 120ms ease;

    &:hover:not(:disabled) {
      color: var(--color-text);
      background: var(--color-interactive-hover);
    }

    &:active:not(:disabled) {
      background: var(--color-interactive-pressed);
      transform: scale(0.98);
    }

    &.danger {
      color: var(--color-danger);
      background: transparent;

      &:hover:not(:disabled) {
        color: var(--color-danger);
        background: var(--color-danger-hover);
      }
    }
  }
}

@media (max-width: 900px) {
  .network-fields {
    grid-template-columns: minmax(0, 1fr) 112px auto;
  }
}

@media (max-width: 780px) {
  .network-fields {
    grid-template-columns: minmax(0, 1fr);
  }

  .network-fields button {
    justify-self: start;
  }

  .real-ip-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
