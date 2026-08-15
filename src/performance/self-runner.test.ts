import { describe, expect, it } from 'vitest'
import type { Router } from 'vue-router'
import {
  configurePerformanceRepeatOne,
  mapPerformanceConfig,
  PERFORMANCE_RECOVERY_CHECKPOINT_INTERVAL_SECONDS,
  PerformanceTelemetry,
  shouldWriteRecoveryCheckpoint,
  summarizeFrameIntervals,
} from './self-runner'

function testRouter(fullPath: string): {
  readonly router: Router
  readonly setRoute: (nextRoute: string) => void
} {
  const state = { currentRoute: { value: { fullPath } } }
  return {
    router: state as unknown as Router,
    setRoute: (nextRoute) => {
      state.currentRoute.value.fullPath = nextRoute
    },
  }
}

const EMPTY_COVER_PLACEHOLDER_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

interface CoverImageTestState {
  readonly complete?: boolean
  readonly naturalWidth?: number
  readonly naturalHeight?: number
}

function setCoverState(
  element: HTMLImageElement,
  state: string,
  options: CoverImageTestState = {},
): void {
  const complete = options.complete ?? state !== 'loading'
  const naturalWidth = options.naturalWidth ?? (state === 'loaded' ? 96 : 0)
  const naturalHeight = options.naturalHeight ?? (state === 'loaded' ? 96 : 0)
  element.setAttribute('data-cover-state', state)
  Object.defineProperties(element, {
    complete: { configurable: true, value: complete },
    naturalWidth: { configurable: true, value: naturalWidth },
    naturalHeight: { configurable: true, value: naturalHeight },
  })
}

function cover(state: string, source: string, options: CoverImageTestState = {}): HTMLImageElement {
  const element = document.createElement('img')
  element.setAttribute('src', source)
  setCoverState(element, state, options)
  return element
}

describe('self-driven performance scenario contract', () => {
  it('accepts only the bounded offline artist DFS configuration', () => {
    expect(
      mapPerformanceConfig({
        enabled: true,
        scenario: 'artist-dfs-v1',
        iterations: 50,
        recoverySeconds: 600,
        audioUrl: 'http://127.0.0.1:43123/tone-long-mp3.mp3',
      }),
    ).toMatchObject({ enabled: true, iterations: 50, recoverySeconds: 600 })
    expect(() =>
      mapPerformanceConfig({
        enabled: true,
        scenario: 'artist-dfs-v1',
        iterations: 49,
        recoverySeconds: 600,
        audioUrl: 'http://127.0.0.1:43123/tone.mp3',
      }),
    ).toThrow(/configuration/i)
    expect(() =>
      mapPerformanceConfig({
        enabled: true,
        scenario: 'artist-dfs-v1',
        iterations: 50,
        recoverySeconds: 600,
        audioUrl: 'https://audio.example/tone.mp3',
      }),
    ).toThrow(/audio URL/i)
  })

  it('reports high-refresh frame intervals without hiding long frames', () => {
    const summary = summarizeFrameIntervals([8, 8.2, 8.4, 17, 40])
    expect(summary.sampleCount).toBe(5)
    expect(summary.p50Ms).toBe(8.4)
    expect(summary.p95Ms).toBe(40)
    expect(summary.over16ms).toBe(2)
    expect(summary.over32ms).toBe(1)
  })

  it('enters repeat-one through the player public API without adding a hidden setter', () => {
    let repeatMode: 'off' | 'all' | 'one' = 'off'
    const cycleRepeatMode = (): void => {
      repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'
    }
    const player = {
      get repeatMode() {
        return repeatMode
      },
      cycleRepeatMode,
    }

    configurePerformanceRepeatOne(player)

    expect(repeatMode).toBe('one')
    configurePerformanceRepeatOne(player)
    expect(repeatMode).toBe('one')
  })

  it('keeps per-second recovery playback evidence while throttling full checkpoints', () => {
    expect(PERFORMANCE_RECOVERY_CHECKPOINT_INTERVAL_SECONDS).toBe(10)
    expect(shouldWriteRecoveryCheckpoint(0, 600)).toBe(false)
    expect(shouldWriteRecoveryCheckpoint(1, 600)).toBe(false)
    expect(shouldWriteRecoveryCheckpoint(10, 600)).toBe(true)
    expect(shouldWriteRecoveryCheckpoint(599, 600)).toBe(false)
    // The complete report below is the one final write, so it is not doubled
    // with a recovery-phase checkpoint at the same second.
    expect(shouldWriteRecoveryCheckpoint(600, 600)).toBe(false)

    const checkpoints = Array.from({ length: 600 }, (_, index) => index + 1).filter((second) =>
      shouldWriteRecoveryCheckpoint(second, 600),
    )
    expect(checkpoints).toHaveLength(59)
    expect(checkpoints.at(0)).toBe(10)
    expect(checkpoints.at(-1)).toBe(590)

    // A non-ten-second duration also relies on its one final complete report.
    expect(shouldWriteRecoveryCheckpoint(603, 603)).toBe(false)
  })

  it('records exact fixture playback continuously across a natural repeat-one wrap', () => {
    const { router } = testRouter('/daily/songs')
    const fixtureUrl = 'http://127.0.0.1:43123/tone-long-mp3.mp3'
    const player = {
      state: 'playing',
      repeatMode: 'one',
      sourceKind: 'remote',
      sourceUrl: fixtureUrl,
      sourceProvenance: 'performance-fixture',
      progress: 298,
      duration: 300,
    }
    const telemetry = new PerformanceTelemetry()

    telemetry.sampleRecoveryPlayback(player, fixtureUrl, router)
    player.progress = 299
    telemetry.sampleRecoveryPlayback(player, fixtureUrl, router)
    player.progress = 0.25
    telemetry.sampleRecoveryPlayback(player, fixtureUrl, router)
    player.progress = 1.25
    telemetry.sampleRecoveryPlayback(player, fixtureUrl, router)

    expect(telemetry.snapshot(player, router).playback).toMatchObject({
      repeatMode: 'one',
      sourceKind: 'remote',
      sourceUrl: fixtureUrl,
      sourceProvenance: 'performance-fixture',
      recoverySamples: 4,
      recoveryExactFixtureSamples: 4,
      recoveryPlayingSamples: 4,
      recoveryRepeatOneSamples: 4,
      recoveryAdvancingSamples: 2,
      recoveryWraps: 1,
      recoveryStalledSamples: 0,
    })
  })

  it('does not mistake a fixture that stops at 300 seconds for a continuous recovery', () => {
    const { router } = testRouter('/daily/songs')
    const fixtureUrl = 'http://127.0.0.1:43123/tone-long-mp3.mp3'
    const player = {
      state: 'playing',
      repeatMode: 'one',
      sourceKind: 'remote',
      sourceUrl: fixtureUrl,
      sourceProvenance: 'performance-fixture',
      progress: 299,
      duration: 300,
    }
    const telemetry = new PerformanceTelemetry()

    telemetry.sampleRecoveryPlayback(player, fixtureUrl, router)
    player.progress = 300
    telemetry.sampleRecoveryPlayback(player, fixtureUrl, router)
    player.state = 'ended'
    telemetry.sampleRecoveryPlayback(player, fixtureUrl, router)
    telemetry.sampleRecoveryPlayback(player, fixtureUrl, router)

    expect(telemetry.snapshot(player, router).playback).toMatchObject({
      recoverySamples: 4,
      recoveryExactFixtureSamples: 4,
      recoveryPlayingSamples: 2,
      recoveryRepeatOneSamples: 4,
      recoveryAdvancingSamples: 1,
      recoveryWraps: 0,
      recoveryStalledSamples: 0,
    })
  })

  it('records same-route cover lifecycle reloads and playback progress evidence', () => {
    const { router } = testRouter('/artist/900000')
    const image = cover('loading', 'https://covers.example/900000.jpg')
    document.body.append(image)
    const telemetry = new PerformanceTelemetry()
    const player = { state: 'playing', progress: 0, duration: 300 }
    try {
      telemetry.snapshot(player, router)
      setCoverState(image, 'loaded')
      player.progress = 1
      telemetry.snapshot(player, router)
      setCoverState(image, 'loading')
      player.progress = 2
      const snapshot = telemetry.snapshot(player, router)
      expect(snapshot.images.loadEvents).toBe(1)
      expect(snapshot.images.reloads).toBe(1)
      expect(snapshot.playback.advancingSamples).toBeGreaterThanOrEqual(1)
    } finally {
      image.remove()
    }
  })

  it('does not report a reused element/source as a reload after an artist route change', () => {
    const { router, setRoute } = testRouter('/artist/900000')
    const image = cover('loaded', 'https://covers.example/900000.jpg')
    document.body.append(image)
    const telemetry = new PerformanceTelemetry()
    const player = { state: 'playing', progress: 0, duration: 300 }
    try {
      telemetry.snapshot(player, router)
      setRoute('/artist/900001')
      image.setAttribute('src', 'https://covers.example/900001.jpg')
      setCoverState(image, 'loading')
      const snapshot = telemetry.snapshot(player, router)
      expect(snapshot.routeTransitions).toBe(1)
      expect(snapshot.images.reloads).toBe(0)
      expect(snapshot.images.blank).toBe(0)
      expect(snapshot.images.blankEvents).toBe(0)
      expect(snapshot.events.some((event) => event.type === 'image-reload')).toBe(false)
    } finally {
      image.remove()
    }
  })

  it('does not treat a new element sharing an active URL as a reload', () => {
    const { router } = testRouter('/artist/900000')
    const source = 'https://covers.example/shared.jpg'
    const original = cover('loaded', source)
    const duplicate = cover('loading', source)
    document.body.append(original)
    const telemetry = new PerformanceTelemetry()
    const player = { state: 'playing', progress: 0, duration: 300 }
    try {
      telemetry.snapshot(player, router)
      document.body.append(duplicate)
      const snapshot = telemetry.snapshot(player, router)
      expect(snapshot.images.reloads).toBe(0)
    } finally {
      original.remove()
      duplicate.remove()
    }
  })

  it('reports a same-route source remount after the original element is removed', () => {
    const { router } = testRouter('/artist/900000')
    const source = 'https://covers.example/900000.jpg'
    const original = cover('loaded', source)
    document.body.append(original)
    const telemetry = new PerformanceTelemetry()
    const player = { state: 'playing', progress: 0, duration: 300 }
    let remount: HTMLImageElement | undefined
    try {
      telemetry.snapshot(player, router)
      original.remove()
      telemetry.snapshot(player, router)
      remount = cover('loading', source)
      document.body.append(remount)
      const snapshot = telemetry.snapshot(player, router)
      expect(snapshot.images.reloads).toBe(1)
      expect(snapshot.events).toContainEqual(
        expect.objectContaining({
          type: 'image-reload',
          route: '/artist/900000',
          detail: expect.objectContaining({ cause: 'same-route-remount', source }),
        }),
      )
    } finally {
      original.remove()
      remount?.remove()
    }
  })

  it('counts a transparent placeholder as a visible terminal blank', () => {
    const { router } = testRouter('/artist/900000')
    const image = cover('loaded', EMPTY_COVER_PLACEHOLDER_SRC)
    document.body.append(image)
    const telemetry = new PerformanceTelemetry()
    const player = { state: 'playing', progress: 0, duration: 300 }
    try {
      const snapshot = telemetry.snapshot(player, router)
      expect(snapshot.images).toMatchObject({
        elements: 1,
        visibleElements: 1,
        loaded: 0,
        failed: 0,
        blank: 1,
        blankEvents: 1,
      })
      expect(snapshot.events).toContainEqual(
        expect.objectContaining({
          type: 'image-blank',
          detail: expect.objectContaining({ reason: 'transparent-placeholder' }),
        }),
      )
    } finally {
      image.remove()
    }
  })

  it('counts a failed CoverImage once as a visible terminal blank', () => {
    const { router } = testRouter('/artist/900000')
    const image = cover('failed', 'https://covers.example/failed.jpg', {
      complete: true,
      naturalWidth: 0,
      naturalHeight: 0,
    })
    document.body.append(image)
    const telemetry = new PerformanceTelemetry()
    const player = { state: 'playing', progress: 0, duration: 300 }
    try {
      const first = telemetry.snapshot(player, router)
      const second = telemetry.snapshot(player, router)
      expect(first.images).toMatchObject({ failed: 1, blank: 1, blankEvents: 1, errorEvents: 1 })
      expect(second.images.blankEvents).toBe(1)
      expect(second.events).toContainEqual(
        expect.objectContaining({
          type: 'image-blank',
          detail: expect.objectContaining({ reason: 'failed' }),
        }),
      )
    } finally {
      image.remove()
    }
  })

  it('counts a complete loaded image with no intrinsic pixels as a decoded blank', () => {
    const { router } = testRouter('/artist/900000')
    const image = cover('loaded', 'https://covers.example/empty.jpg', {
      complete: true,
      naturalWidth: 0,
      naturalHeight: 96,
    })
    document.body.append(image)
    const telemetry = new PerformanceTelemetry()
    const player = { state: 'playing', progress: 0, duration: 300 }
    try {
      const snapshot = telemetry.snapshot(player, router)
      expect(snapshot.images).toMatchObject({ loaded: 0, failed: 0, blank: 1, blankEvents: 1 })
      expect(snapshot.events).toContainEqual(
        expect.objectContaining({
          type: 'image-blank',
          detail: expect.objectContaining({ reason: 'decoded-blank', complete: true }),
        }),
      )
    } finally {
      image.remove()
    }
  })

  it('does not turn a legal in-flight CoverImage into permanent blank evidence', () => {
    const { router } = testRouter('/artist/900000')
    const image = cover('loading', 'https://covers.example/loading.jpg', {
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
    })
    document.body.append(image)
    const telemetry = new PerformanceTelemetry()
    const player = { state: 'playing', progress: 0, duration: 300 }
    try {
      const loading = telemetry.snapshot(player, router)
      expect(loading.images).toMatchObject({ loaded: 0, failed: 0, blank: 0, blankEvents: 0 })

      // A state update can arrive before the browser has exposed decoded
      // pixels. That is still an in-flight image, not a terminal blank.
      setCoverState(image, 'loaded', {
        complete: false,
        naturalWidth: 0,
        naturalHeight: 0,
      })
      const awaitingDecode = telemetry.snapshot(player, router)
      expect(awaitingDecode.images).toMatchObject({
        loaded: 0,
        failed: 0,
        blank: 0,
        blankEvents: 0,
      })

      setCoverState(image, 'loaded', {
        complete: true,
        naturalWidth: 96,
        naturalHeight: 96,
      })
      const decoded = telemetry.snapshot(player, router)
      expect(decoded.images).toMatchObject({ loaded: 1, failed: 0, blank: 0, blankEvents: 0 })
      expect(decoded.events.some((event) => event.type === 'image-blank')).toBe(false)
    } finally {
      image.remove()
    }
  })
})
