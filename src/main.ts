import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import App from './App.vue'
import { i18n } from '@/app/i18n'
import { preloadPrimaryViews, router } from '@/app/router'
import { useSettingsStore } from '@/features/settings/application/settings-store'
import { configureSettingsRuntime } from '@/features/settings/infrastructure/native-settings'
import { configureAuthRuntime, useAuthStore } from '@/features/auth/application/auth-store'
import { configureCatalogRuntime } from '@/features/catalog/infrastructure/native-catalog'
import { configurePlayerRuntime, usePlayerStore } from '@/features/player/application/player-store'
import { desktop } from '@/platform/desktop'
import { installDesktopControls } from '@/platform/desktop-controls'
import { executeWindowCloseAction, resolveWindowCloseAction } from '@/platform/window-close'
import { installNativeTooltipBlocker } from '@/platform/native-tooltips'
import { showAppAlert, showAppConfirm } from '@/platform/app-dialogs'
import {
  loadPerformanceConfig,
  runPerformanceScenario,
  type PerformanceConfig,
} from '@/performance/self-runner'
import { validatedLoopbackOrigin } from '@/performance/runtime-config'
import '@/styles/global.scss'

installNativeTooltipBlocker(document.documentElement)

const pinia = createPinia()
const app = createApp(App).use(pinia).use(router).use(i18n)

const performanceConfig: PerformanceConfig = desktop.isDesktop
  ? await loadPerformanceConfig()
  : {
      enabled: false,
      scenario: null,
      iterations: 0,
      recoverySeconds: 0,
      audioUrl: null,
      audioMimeType: 'audio/mpeg',
      audioSizeBytes: 1,
    }
if (performanceConfig.enabled && performanceConfig.audioUrl !== null) {
  configureCatalogRuntime({
    mode: 'performance',
    audioFixture: {
      url: performanceConfig.audioUrl,
      mimeType: performanceConfig.audioMimeType,
      sizeBytes: performanceConfig.audioSizeBytes,
    },
  })
  configureAuthRuntime({
    mode: 'performance',
    avatarOrigin: validatedLoopbackOrigin(performanceConfig.audioUrl),
  })
  configurePlayerRuntime({
    mode: 'performance',
    audioFixture: {
      url: performanceConfig.audioUrl,
      mimeType: performanceConfig.audioMimeType,
      sizeBytes: performanceConfig.audioSizeBytes,
    },
  })
} else {
  configureCatalogRuntime({ mode: 'normal' })
  configureAuthRuntime({ mode: 'normal' })
  configurePlayerRuntime('normal')
}
configureSettingsRuntime(performanceConfig.enabled ? 'performance' : 'normal')

const settingsStore = useSettingsStore(pinia)
await settingsStore.initialize()
await router.isReady()
if (performanceConfig.enabled) await router.replace('/artist/900000')
else void useAuthStore(pinia).restore()
app.mount('#app')
const player = usePlayerStore(pinia)

if (performanceConfig.enabled) {
  void runPerformanceScenario(router, player, performanceConfig).catch((error: unknown) => {
    console.error('Automated performance scenario failed', error)
  })
}

function preloadPrimaryViewsWhenIdle(): void {
  const preload = () => preloadPrimaryViews()
  if ('requestIdleCallback' in globalThis) {
    globalThis.requestIdleCallback(preload, { timeout: 1_000 })
    return
  }
  globalThis.setTimeout(preload, 180)
}

if (!performanceConfig.enabled) preloadPrimaryViewsWhenIdle()

async function installDesktopControlBridge(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await installDesktopControls(settingsStore, {
    player,
    window: getCurrentWindow(),
    router,
    showAbout: async () => {
      const runtime = await desktop.getRuntimeInfo()
      await showAppAlert({
        title: runtime.appName,
        message: i18n.global.t('dialogs.aboutVersion', { version: runtime.appVersion }),
        confirmLabel: i18n.global.t('dialogs.okay'),
      })
    },
  })
}

async function installSettingsCloseFlush(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const currentWindow = getCurrentWindow()
  let closeFlow: Promise<void> | null = null
  await currentWindow.onCloseRequested((event) => {
    // Intercept synchronously, before waiting for the confirmation dialog.
    // Otherwise the native close request may destroy the window while the
    // asynchronous dialog is still open.
    event.preventDefault()

    // A second close request can arrive while the confirmation is visible.
    // Keep it intercepted until the first request has finished.
    if (closeFlow !== null) {
      return closeFlow
    }

    const flow = (async () => {
      const closeOption = settingsStore.settings.closeAppOption
      const closeAction =
        closeOption === 'ask'
          ? (await showAppConfirm({
              title: i18n.global.t('dialogs.quitTitle'),
              message: i18n.global.t('dialogs.quitMessage'),
              confirmLabel: i18n.global.t('dialogs.quit'),
              cancelLabel: i18n.global.t('dialogs.keepRunning'),
              tone: 'danger',
            }))
            ? 'exit'
            : 'hide'
          : resolveWindowCloseAction(closeOption)

      await executeWindowCloseAction(
        event,
        closeAction,
        () => settingsStore.flush(),
        () => currentWindow.hide(),
        async () => {
          try {
            await invoke('exit_app')
          } catch (error) {
            // A native command failure should not leave the close action stuck.
            // `destroy` bypasses another close-requested event and is the safe
            // last-resort fallback for an already-intercepted request.
            console.error('Failed to invoke the native exit command', error)
            await currentWindow.destroy()
          }
        },
      )
    })().catch((error: unknown) => {
      // Keep a failed confirmation flow from falling through to an accidental close.
      event.preventDefault()
      console.error('Failed to handle the window close request', error)
    })

    closeFlow = flow.finally(() => {
      closeFlow = null
    })
    return closeFlow
  })
}

if (desktop.isDesktop && !performanceConfig.enabled) {
  void installDesktopControlBridge().catch((error: unknown) => {
    console.error('Failed to install desktop controls', error)
  })
  void installSettingsCloseFlush().catch((error: unknown) => {
    console.error('Failed to install the settings close hook', error)
  })
}
