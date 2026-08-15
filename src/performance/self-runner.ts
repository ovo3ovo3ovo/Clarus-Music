import { invoke } from '@tauri-apps/api/core'
import type { Router } from 'vue-router'
import type { usePlayerStore } from '@/features/player/application/player-store'
import { validatePerformanceAudioFixture, type PerformanceAudioFixture } from './runtime-config'

export interface PerformanceConfig {
  readonly enabled: boolean
  readonly scenario: 'artist-dfs-v1' | null
  readonly iterations: number
  readonly recoverySeconds: number
  readonly audioUrl: string | null
  /** Fixture metadata is supplied by the runner; old bundles may omit it. */
  readonly audioMimeType: 'audio/mpeg'
  readonly audioSizeBytes: number
}

const CHECKPOINT_SCHEMA_VERSION = 3 as const
export const PERFORMANCE_MIN_RECOVERY_SECONDS = 600
export const PERFORMANCE_MAX_RECOVERY_SECONDS = 900
export const PERFORMANCE_HOME_ROUTE = '/daily/songs'
/**
 * Recovery still checks playback once a second, but a full telemetry report
 * can be tens of kilobytes. Limit the cross-process checkpoint writes so the
 * observer does not become a material part of the measurement.
 */
export const PERFORMANCE_RECOVERY_CHECKPOINT_INTERVAL_SECONDS = 10
const PLAYBACK_GATE_WINDOW_SECONDS = 10
const MIN_PLAYBACK_ADVANCING_SAMPLES = 8
const MAX_PERFORMANCE_TRACE_EVENTS = 256

interface PerformanceImageTelemetry {
  readonly elements: number
  readonly visibleElements: number
  /** Covers that are both declared loaded and have usable decoded pixels. */
  readonly loaded: number
  readonly failed: number
  /** Visible covers that are conclusively unable to show their artwork. */
  readonly blank: number
  /** Distinct visible blank episodes; a normal in-flight image is never one. */
  readonly blankEvents: number
  readonly loadEvents: number
  readonly errorEvents: number
  readonly reloads: number
  readonly activeRequests: number
  readonly requestStarts: number
  readonly requestCompletions: number
  readonly requestFailures: number
}

interface PerformanceRequestTelemetry {
  readonly active: number
  readonly started: number
  readonly completed: number
  readonly failed: number
}

interface PerformancePlaybackTelemetry {
  readonly state: string
  readonly repeatMode: 'off' | 'all' | 'one' | 'unknown'
  readonly sourceKind: 'managed-url' | 'remote' | 'none'
  readonly sourceUrl: string | null
  readonly sourceProvenance: 'performance-fixture' | null
  readonly fallbackReason: string | null
  readonly currentTime: number
  readonly duration: number
  readonly samples: number
  readonly advancingSamples: number
  readonly maximumAdvanceSeconds: number
  readonly firstProgressAt: string | null
  readonly lastProgressAt: string | null
  /** One sample is recorded for every declared recovery second. */
  readonly recoverySamples: number
  /** Samples whose source stayed the exact loopback audio fixture. */
  readonly recoveryExactFixtureSamples: number
  /** Samples whose player state remained `playing`. */
  readonly recoveryPlayingSamples: number
  /** Samples that remained in repeat-one mode. */
  readonly recoveryRepeatOneSamples: number
  /** Forward-moving samples after the first recovery observation. */
  readonly recoveryAdvancingSamples: number
  /** Natural end-to-start transitions inside the fixture. */
  readonly recoveryWraps: number
  /** Non-progressing or invalid backward time movements. */
  readonly recoveryStalledSamples: number
}

interface PerformanceTelemetrySnapshot {
  readonly images: PerformanceImageTelemetry
  readonly requests: PerformanceRequestTelemetry
  readonly playback: PerformancePlaybackTelemetry
  readonly routeTransitions: number
  readonly events: readonly PerformanceTraceEvent[]
}

interface PerformanceTraceEvent {
  readonly at: string
  readonly type: string
  readonly route: string
  readonly detail?: Record<string, string | number | boolean | null>
}

interface PerformanceReport {
  readonly schemaVersion: 3
  readonly scenario: 'artist-dfs-v1'
  readonly phase: 'ready' | 'dfs' | 'recovery' | 'complete' | 'failed'
  readonly startedAt: string
  readonly updatedAt: string
  readonly iterationsRequested: number
  readonly iterationsCompleted: number
  readonly recoverySecondsElapsed: number
  readonly frames: ReturnType<typeof summarizeFrameIntervals>
  readonly runtime: ReturnType<typeof runtimeSnapshot>
  readonly telemetry: PerformanceTelemetrySnapshot
  readonly failure: string | null
}

const PERFORMANCE_ARTIST_FIRST_ID = 900_000
const WAIT_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mapPerformanceConfig(value: unknown): PerformanceConfig {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') {
    throw new Error('Invalid performance configuration')
  }
  if (!value.enabled) {
    return {
      enabled: false,
      scenario: null,
      iterations: 0,
      recoverySeconds: 0,
      audioUrl: null,
      audioMimeType: 'audio/mpeg',
      audioSizeBytes: 1,
    }
  }
  if (
    value.scenario !== 'artist-dfs-v1' ||
    !Number.isSafeInteger(value.iterations) ||
    Number(value.iterations) < 50 ||
    Number(value.iterations) > 100 ||
    !Number.isSafeInteger(value.recoverySeconds) ||
    Number(value.recoverySeconds) < PERFORMANCE_MIN_RECOVERY_SECONDS ||
    Number(value.recoverySeconds) > PERFORMANCE_MAX_RECOVERY_SECONDS ||
    typeof value.audioUrl !== 'string'
  ) {
    throw new Error('Invalid active performance configuration')
  }
  const audioMimeType =
    value.audioMimeType === undefined
      ? 'audio/mpeg'
      : typeof value.audioMimeType === 'string' && value.audioMimeType === 'audio/mpeg'
        ? value.audioMimeType
        : null
  const audioSizeBytes =
    value.audioSizeBytes === undefined
      ? 1
      : Number.isSafeInteger(value.audioSizeBytes) && Number(value.audioSizeBytes) > 0
        ? Number(value.audioSizeBytes)
        : null
  if (audioMimeType === null || audioSizeBytes === null) {
    throw new Error('Invalid performance audio fixture metadata')
  }
  const fixture: PerformanceAudioFixture = {
    url: value.audioUrl,
    mimeType: audioMimeType,
    sizeBytes: audioSizeBytes,
  }
  validatePerformanceAudioFixture(fixture)
  return {
    enabled: true,
    scenario: value.scenario,
    iterations: Number(value.iterations),
    recoverySeconds: Number(value.recoverySeconds),
    audioUrl: fixture.url,
    audioMimeType,
    audioSizeBytes,
  }
}

export async function loadPerformanceConfig(): Promise<PerformanceConfig> {
  return mapPerformanceConfig(await invoke<unknown>('performance_config'))
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
}

export function summarizeFrameIntervals(intervals: readonly number[]) {
  const usable = intervals.filter((value) => Number.isFinite(value) && value > 0 && value < 100)
  const mean = usable.length
    ? usable.reduce((total, value) => total + value, 0) / usable.length
    : null
  return {
    sampleCount: usable.length,
    meanMs: mean,
    p50Ms: percentile(usable, 0.5),
    p95Ms: percentile(usable, 0.95),
    p99Ms: percentile(usable, 0.99),
    over16ms: usable.filter((value) => value > 16.7).length,
    over32ms: usable.filter((value) => value > 33.4).length,
  }
}

function routePath(router?: Router): string {
  const fullPath = router?.currentRoute.value.fullPath
  if (typeof fullPath === 'string' && fullPath.length > 0) return fullPath
  const hash = globalThis.location.hash
  if (hash.length > 0) return hash.startsWith('#') ? hash.slice(1) || '/' : hash
  return `${globalThis.location.pathname}${globalThis.location.search}` || '/'
}

function elementIsVisible(element: Element): boolean {
  if (!(element instanceof globalThis.HTMLElement)) return true
  const rect = element.getBoundingClientRect()
  // Happy DOM and a few older WebKit builds report an all-zero rect while the
  // page is still laying out. Treat connected covers as visible in that case;
  // the stability wait below will run again after the next frames.
  if (rect.width === 0 && rect.height === 0) return element.isConnected
  const root = element.closest<HTMLElement>('.app-content')
  const rootRect = root?.getBoundingClientRect()
  const top = rootRect?.top ?? 0
  const bottom = rootRect?.bottom ?? globalThis.innerHeight
  return rect.bottom > top && rect.top < bottom && rect.width > 0 && rect.height > 0
}

const EMPTY_COVER_PLACEHOLDER_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

type CoverRenderState =
  'loading' | 'failed' | 'transparent-placeholder' | 'decoded-blank' | 'decoded'

type VisibleBlankReason = Exclude<CoverRenderState, 'loading' | 'decoded'>

interface CoverImageAssessment {
  readonly renderState: CoverRenderState
  readonly blankReason: VisibleBlankReason | null
}

function coverImageElements(): HTMLImageElement[] {
  // CoverImage renders a native <img>. Restricting telemetry to this exact
  // surface prevents unrelated data attributes from changing image evidence.
  return [...document.querySelectorAll<HTMLImageElement>('img[data-cover-state]')]
}

function isTransparentCoverPlaceholder(source: string): boolean {
  return source.trim() === EMPTY_COVER_PLACEHOLDER_SRC
}

/**
 * A loading CoverImage is intentionally not a blank failure. Its source may
 * be in the middle of a normal browser request/decode, so only a terminal
 * state or a completed image without intrinsic pixels is reported as blank.
 */
function assessCoverImage(image: HTMLImageElement): CoverImageAssessment {
  const state = image.getAttribute('data-cover-state') ?? 'loading'
  const source = image.getAttribute('src') ?? ''

  if (state === 'failed') {
    return { renderState: 'failed', blankReason: 'failed' }
  }
  if (state !== 'loaded') {
    return { renderState: 'loading', blankReason: null }
  }
  if (isTransparentCoverPlaceholder(source)) {
    return { renderState: 'transparent-placeholder', blankReason: 'transparent-placeholder' }
  }
  if (!image.complete) {
    return { renderState: 'loading', blankReason: null }
  }
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return { renderState: 'decoded-blank', blankReason: 'decoded-blank' }
  }
  return { renderState: 'decoded', blankReason: null }
}

function isTerminalCoverState(state: string): boolean {
  return state === 'loaded' || state === 'failed'
}

interface CoverLifecycleState {
  readonly state: string
  readonly source: string
  /** The full route on which this element/source was last observed. */
  readonly route: string
  /** Null unless this element is currently a visible terminal blank. */
  readonly visibleBlank: VisibleBlankReason | null
}

export interface PerformancePlayerTelemetrySource {
  readonly state?: unknown
  readonly playing?: unknown
  readonly currentTrack?: { readonly id?: unknown }
  readonly repeatMode?: unknown
  readonly sourceKind?: unknown
  readonly sourceUrl?: unknown
  readonly sourceProvenance?: unknown
  readonly progress?: unknown
  readonly duration?: unknown
  readonly readPlaybackTime?: () => number
  readonly cycleRepeatMode?: () => void
}

type PerformanceRepeatMode = PerformancePlaybackTelemetry['repeatMode']

function normalizePerformanceRepeatMode(value: unknown): PerformanceRepeatMode {
  return value === 'off' || value === 'all' || value === 'one' ? value : 'unknown'
}

/**
 * A repeat-one wrap must come from near the end of the known media duration
 * back to its opening window. This deliberately does not treat an arbitrary
 * backwards seek as proof that the fixture kept playing.
 */
function isNaturalPlaybackWrap(previous: number, current: number, duration: number): boolean {
  if (!Number.isFinite(duration) || duration <= 0 || current >= previous) return false
  const window = Math.min(30, Math.max(1, duration * 0.1))
  return previous >= duration - window && current <= window
}

/**
 * The self-driven fixture is the only caller of this helper. It intentionally
 * uses the player's existing public control instead of adding a hidden repeat
 * setter, so normal user playback preferences and behavior remain unchanged.
 */
export function configurePerformanceRepeatOne(player: PerformancePlayerTelemetrySource): void {
  if (typeof player.cycleRepeatMode !== 'function') {
    throw new Error('Performance player does not expose repeat-mode control')
  }
  for (let attempts = 0; attempts < 3; attempts += 1) {
    if (player.repeatMode === 'one') return
    player.cycleRepeatMode()
  }
  if (player.repeatMode !== 'one') {
    throw new Error('Performance player could not enter repeat-one mode')
  }
}

/**
 * Lightweight, app-owned evidence collection for the self-driven scenario.
 * It observes the public CoverImage state rather than changing the image
 * implementation, so the performance harness can detect reloads and visible
 * blank slots without affecting browser image lifecycle behavior.
 */
export class PerformanceTelemetry {
  private readonly coverStates = new WeakMap<Element, CoverLifecycleState>()
  private readonly trackedElements = new Set<Element>()
  /**
   * Source removals are scoped to the current route visit. A later route
   * transition clears the records, so returning to an artist cannot be
   * mistaken for a same-page virtual-list remount.
   */
  private readonly removedSources = new Map<string, Map<string, number>>()
  private readonly eventLog: PerformanceTraceEvent[] = []
  private observer: MutationObserver | null = null
  private currentRouter: Router | undefined
  private lastRoute = ''
  private routeChanges = 0
  private imageLoadEvents = 0
  private imageErrorEvents = 0
  private imageBlankEvents = 0
  private imageReloads = 0
  private requestStarts = 0
  private requestCompletions = 0
  private requestFailures = 0
  private activeImageRequests = 0
  private activeBusyRequests = 0
  private previousBusyRequests = 0
  private nativeRequestStarts = 0
  private nativeRequestCompletions = 0
  private playbackSamples = 0
  private playbackAdvancingSamples = 0
  private playbackMaximumAdvance = 0
  private previousPlaybackTime: number | null = null
  private firstProgressAt: string | null = null
  private lastProgressAt: string | null = null
  private playbackSourceKind: PerformancePlaybackTelemetry['sourceKind'] = 'none'
  private playbackSourceUrl: string | null = null
  private playbackSourceProvenance: PerformancePlaybackTelemetry['sourceProvenance'] = null
  private playbackFallbackReason: string | null = null
  private playbackRepeatMode: PerformanceRepeatMode = 'unknown'
  private recoveryPlaybackSamples = 0
  private recoveryExactFixtureSamples = 0
  private recoveryPlayingSamples = 0
  private recoveryRepeatOneSamples = 0
  private recoveryAdvancingSamples = 0
  private recoveryWraps = 0
  private recoveryStalledSamples = 0
  private previousRecoveryPlaybackTime: number | null = null

  private readPlayback(player: PerformancePlayerTelemetrySource): {
    currentTime: number
    duration: number
  } {
    const rawTime = player.readPlaybackTime?.() ?? Number(player.progress ?? 0)
    return {
      currentTime: Number.isFinite(rawTime) && rawTime >= 0 ? rawTime : 0,
      duration:
        Number.isFinite(Number(player.duration)) && Number(player.duration) >= 0
          ? Number(player.duration)
          : 0,
    }
  }

  private syncPlaybackSource(player: PerformancePlayerTelemetrySource): void {
    const sourceKind = player.sourceKind
    if (sourceKind !== 'managed-url' && sourceKind !== 'remote' && sourceKind !== 'none') return
    this.playbackSourceKind = sourceKind
    this.playbackSourceUrl = typeof player.sourceUrl === 'string' ? player.sourceUrl : null
    this.playbackSourceProvenance =
      player.sourceProvenance === 'performance-fixture' ? 'performance-fixture' : null
    this.playbackRepeatMode = normalizePerformanceRepeatMode(player.repeatMode)
  }

  start(router?: Router): void {
    this.scan(router)
    if (typeof globalThis.MutationObserver === 'function') {
      this.observer = new globalThis.MutationObserver(() => this.scan())
      this.observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-cover-state', 'src'],
        childList: true,
        subtree: true,
      })
    }
  }

  stop(): void {
    this.observer?.disconnect()
    this.observer = null
  }

  record(type: string, route: string, detail?: PerformanceTraceEvent['detail']): void {
    const event: PerformanceTraceEvent = {
      at: new Date().toISOString(),
      type,
      route,
      ...(detail === undefined ? {} : { detail }),
    }
    this.eventLog.push(event)
    if (this.eventLog.length > MAX_PERFORMANCE_TRACE_EVENTS) this.eventLog.shift()
  }

  setPlaybackSource(
    sourceKind: PerformancePlaybackTelemetry['sourceKind'],
    sourceUrl: string | null = null,
    provenance: PerformancePlaybackTelemetry['sourceProvenance'] = null,
    reason: string | null = null,
  ): void {
    this.playbackSourceKind = sourceKind
    this.playbackSourceUrl = sourceUrl
    this.playbackSourceProvenance = provenance
    this.playbackFallbackReason = reason
    this.record('playback-source', this.lastRoute, {
      sourceKind,
      sourceUrl,
      provenance,
      reason,
    })
  }

  private rememberRemovedSource(route: string, source: string): void {
    if (source.length === 0) return
    const sources = this.removedSources.get(route) ?? new Map<string, number>()
    sources.set(source, (sources.get(source) ?? 0) + 1)
    this.removedSources.set(route, sources)
  }

  private consumeRemovedSource(route: string, source: string): boolean {
    if (source.length === 0) return false
    const sources = this.removedSources.get(route)
    const count = sources?.get(source) ?? 0
    if (count === 0 || !sources) return false
    if (count === 1) {
      sources.delete(source)
      if (sources.size === 0) this.removedSources.delete(route)
    } else {
      sources.set(source, count - 1)
    }
    return true
  }

  private recordImageReload(
    route: string,
    detail: Record<string, string | number | boolean | null>,
  ): void {
    this.imageReloads += 1
    this.record('image-reload', route, detail)
  }

  private recordVisibleBlank(
    image: HTMLImageElement,
    route: string,
    source: string,
    previous: CoverLifecycleState | undefined,
  ): VisibleBlankReason | null {
    if (!elementIsVisible(image)) return null
    const assessment = assessCoverImage(image)
    const reason = assessment.blankReason
    // `blankEvents` is an episode counter: it advances only when a cover
    // first becomes visibly terminal-and-blank, after having loaded normally,
    // been hidden, or moved to a new route. A transient loading state never
    // creates permanent failure evidence.
    if (reason !== null && (previous?.visibleBlank !== reason || previous.route !== route)) {
      this.imageBlankEvents += 1
      this.record('image-blank', route, {
        source,
        reason,
        coverState: image.getAttribute('data-cover-state') ?? null,
        src: image.getAttribute('src') ?? null,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      })
    }
    return reason
  }

  private removeInactiveElements(activeElements: ReadonlySet<Element>, route: string): void {
    // Process removals before additions. This lets a virtualized item that is
    // removed and recreated between two scans retain its same-route identity.
    for (const element of this.trackedElements) {
      if (activeElements.has(element)) continue
      const previous = this.coverStates.get(element)
      if (previous?.route === route) {
        this.rememberRemovedSource(previous.route, previous.source)
      }
      if (previous?.state === 'loading') {
        this.activeImageRequests = Math.max(0, this.activeImageRequests - 1)
        this.requestFailures += 1
        this.record('image-request-aborted', previous.route)
      }
      this.coverStates.delete(element)
      this.trackedElements.delete(element)
    }
  }

  scan(router?: Router): void {
    if (router) this.currentRouter = router
    const route = routePath(this.currentRouter)
    if (this.lastRoute !== '' && route !== this.lastRoute) {
      this.routeChanges += 1
      this.record('route-change', route, { previousRoute: this.lastRoute })
      // A source removed before navigation belongs to the prior route visit.
      // Do not let it match a fresh element after a navigation (including a
      // later return to the same artist path).
      this.removedSources.clear()
    }
    this.lastRoute = route
    const elements = coverImageElements()
    const activeElements = new Set<Element>(elements)
    this.removeInactiveElements(activeElements, route)
    for (const element of elements) {
      const state = element.getAttribute('data-cover-state') ?? 'idle'
      const declaredSource =
        element.getAttribute('src') ?? element.getAttribute('data-source') ?? ''
      const source =
        declaredSource.startsWith('data:image/gif') || declaredSource === ''
          ? (element.getAttribute('aria-label') ?? '')
          : declaredSource
      const previous = this.coverStates.get(element)
      if (!previous) {
        // Consume a removal even when the element is already terminal; that
        // remount has happened and must not leave stale evidence for a later,
        // unrelated element that happens to share the URL.
        const remountedSource = this.consumeRemovedSource(route, source)
        const visibleBlank = this.recordVisibleBlank(element, route, source, undefined)
        this.coverStates.set(element, { state, source, route, visibleBlank })
        this.trackedElements.add(element)
        if (state === 'loading') {
          this.requestStarts += 1
          this.activeImageRequests += 1
          if (remountedSource) {
            this.recordImageReload(route, { source, cause: 'same-route-remount' })
          }
        }
        if (state === 'loaded') {
          this.imageLoadEvents += 1
          this.record('image-load', route, { source })
        }
        if (state === 'failed') {
          this.imageErrorEvents += 1
          this.requestFailures += 1
        }
        continue
      }
      if (previous.state !== state) {
        if (state === 'loading') {
          this.requestStarts += 1
          this.activeImageRequests += 1
          if (
            previous.route === route &&
            previous.source === source &&
            isTerminalCoverState(previous.state)
          ) {
            this.recordImageReload(route, {
              source,
              previousState: previous.state,
              cause: 'same-route-state-transition',
            })
          }
        } else if (previous.state === 'loading') {
          this.activeImageRequests = Math.max(0, this.activeImageRequests - 1)
          this.requestCompletions += 1
        }
        if (state === 'loaded') {
          this.imageLoadEvents += 1
          this.record('image-load', route, { source })
        }
        if (state === 'failed') {
          this.imageErrorEvents += 1
          this.requestFailures += 1
          this.record('image-error', route, { source })
        }
      }
      // A route/source change updates the identity but is never, by itself, a
      // reload. This covers Vue reusing an image DOM node across artist routes.
      const visibleBlank = this.recordVisibleBlank(element, route, source, previous)
      this.coverStates.set(element, { state, source, route, visibleBlank })
    }
    // The current blank count is computed from the live DOM in snapshot();
    // transitions are retained as bounded trace events instead.
    // Keep the active count bounded even when a DOM node disappears mid-load.
    this.activeImageRequests = Math.min(this.activeImageRequests, activeElements.size)
    const busyRequests = document.querySelectorAll('[aria-busy="true"]').length
    if (busyRequests > this.previousBusyRequests) {
      this.nativeRequestStarts += busyRequests - this.previousBusyRequests
    } else if (busyRequests < this.previousBusyRequests) {
      this.nativeRequestCompletions += this.previousBusyRequests - busyRequests
    }
    this.previousBusyRequests = busyRequests
    this.activeBusyRequests = busyRequests
  }

  samplePlayback(player: PerformancePlayerTelemetrySource, router?: Router): void {
    this.scan(router)
    this.syncPlaybackSource(player)
    const { currentTime } = this.readPlayback(player)
    this.playbackSamples += 1
    if (this.previousPlaybackTime !== null) {
      const delta = currentTime - this.previousPlaybackTime
      if (delta > 0.01) {
        this.playbackAdvancingSamples += 1
        this.playbackMaximumAdvance = Math.max(this.playbackMaximumAdvance, delta)
        this.firstProgressAt ??= new Date().toISOString()
        this.lastProgressAt = new Date().toISOString()
      }
    }
    this.previousPlaybackTime = currentTime
  }

  /**
   * Recovery is the period intended to reveal retained resources.  Sampling
   * playback here, rather than merely checking its final snapshot, prevents a
   * 300-second fixture from appearing healthy after it has silently stopped.
   */
  sampleRecoveryPlayback(
    player: PerformancePlayerTelemetrySource,
    expectedAudioUrl: string,
    router?: Router,
  ): void {
    this.samplePlayback(player, router)
    this.recoveryPlaybackSamples += 1

    const exactFixture =
      player.sourceKind === 'remote' &&
      player.sourceUrl === expectedAudioUrl &&
      player.sourceProvenance === 'performance-fixture'
    const playing = player.state === 'playing'
    const repeatOne = player.repeatMode === 'one'

    if (exactFixture) this.recoveryExactFixtureSamples += 1
    if (playing) this.recoveryPlayingSamples += 1
    if (repeatOne) this.recoveryRepeatOneSamples += 1

    // A source/state/repeat-mode violation breaks continuity. Reset the
    // timing baseline so a later recovery cannot manufacture a false wrap.
    if (!exactFixture || !playing || !repeatOne) {
      this.previousRecoveryPlaybackTime = null
      return
    }

    const { currentTime, duration } = this.readPlayback(player)
    const previous = this.previousRecoveryPlaybackTime
    if (previous !== null) {
      const delta = currentTime - previous
      if (delta > 0.01) {
        this.recoveryAdvancingSamples += 1
      } else if (isNaturalPlaybackWrap(previous, currentTime, duration)) {
        this.recoveryWraps += 1
        this.record('playback-wrap', routePath(router), {
          previousTime: previous,
          currentTime,
          duration,
        })
      } else {
        this.recoveryStalledSamples += 1
      }
    }
    this.previousRecoveryPlaybackTime = currentTime
  }

  snapshot(
    player: PerformancePlayerTelemetrySource,
    router?: Router,
  ): PerformanceTelemetrySnapshot {
    this.samplePlayback(player, router)
    const { currentTime, duration } = this.readPlayback(player)
    const elements = coverImageElements()
    const visible = elements.filter(elementIsVisible)
    const loaded = elements.filter((element) => assessCoverImage(element).renderState === 'decoded')
    const failed = elements.filter(
      (element) => element.getAttribute('data-cover-state') === 'failed',
    )
    const blank = visible.filter((element) => assessCoverImage(element).blankReason !== null)
    const state =
      typeof player.state === 'string' ? player.state : player.playing ? 'playing' : 'idle'
    return {
      images: {
        elements: elements.length,
        visibleElements: visible.length,
        loaded: loaded.length,
        failed: failed.length,
        blank: blank.length,
        blankEvents: this.imageBlankEvents,
        loadEvents: this.imageLoadEvents,
        errorEvents: this.imageErrorEvents,
        reloads: this.imageReloads,
        activeRequests: this.activeImageRequests,
        requestStarts: this.requestStarts,
        requestCompletions: this.requestCompletions,
        requestFailures: this.requestFailures,
      },
      requests: {
        active: this.activeImageRequests + this.activeBusyRequests,
        started: this.requestStarts + this.nativeRequestStarts,
        completed: this.requestCompletions + this.nativeRequestCompletions,
        failed: this.requestFailures,
      },
      playback: {
        state,
        repeatMode: this.playbackRepeatMode,
        sourceKind: this.playbackSourceKind,
        sourceUrl: this.playbackSourceUrl,
        sourceProvenance: this.playbackSourceProvenance,
        fallbackReason: this.playbackFallbackReason,
        currentTime,
        duration,
        samples: this.playbackSamples,
        advancingSamples: this.playbackAdvancingSamples,
        maximumAdvanceSeconds: this.playbackMaximumAdvance,
        firstProgressAt: this.firstProgressAt,
        lastProgressAt: this.lastProgressAt,
        recoverySamples: this.recoveryPlaybackSamples,
        recoveryExactFixtureSamples: this.recoveryExactFixtureSamples,
        recoveryPlayingSamples: this.recoveryPlayingSamples,
        recoveryRepeatOneSamples: this.recoveryRepeatOneSamples,
        recoveryAdvancingSamples: this.recoveryAdvancingSamples,
        recoveryWraps: this.recoveryWraps,
        recoveryStalledSamples: this.recoveryStalledSamples,
      },
      routeTransitions: this.routeChanges,
      events: [...this.eventLog],
    }
  }
}

function runtimeSnapshot(router?: Router) {
  const covers = coverImageElements()
  return {
    domNodes: document.getElementsByTagName('*').length,
    imageElements: document.images.length,
    mediaElements: document.querySelectorAll('audio, video').length,
    coverElements: covers.length,
    loadedCoverElements: covers.filter((cover) => assessCoverImage(cover).renderState === 'decoded')
      .length,
    failedCoverElements: covers.filter(
      (cover) => cover.getAttribute('data-cover-state') === 'failed',
    ).length,
    route: routePath(router),
  }
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

async function waitFor(predicate: () => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Performance scenario timed out')
    await nextFrame()
  }
}

function visibleCoverElements(): HTMLImageElement[] {
  return coverImageElements().filter(elementIsVisible)
}

async function waitForVisibleCoverTerminal(telemetry: PerformanceTelemetry): Promise<void> {
  await waitFor(() => {
    telemetry.scan()
    const covers = visibleCoverElements()
    return (
      covers.length > 0 &&
      covers.every((element) => assessCoverImage(element).renderState !== 'loading')
    )
  })
}

async function waitForArtistStable(
  artistId: number,
  telemetry: PerformanceTelemetry,
): Promise<void> {
  let stableFrames = 0
  let previousSignature = ''
  await waitFor(() => {
    telemetry.scan()
    const view = document.querySelector<HTMLElement>('.artist-view')
    const similar = document.querySelector('.similar-artists a[href*="artist/"]')
    const signature = [
      view?.dataset.artistId ?? '',
      view?.getAttribute('aria-busy') ?? '',
      document.querySelectorAll('img[data-cover-state]').length,
      document.querySelector<HTMLElement>('.app-content')?.scrollHeight ?? 0,
      similar ? 'similar' : '',
    ].join('|')
    if (
      view?.dataset.artistId === String(artistId) &&
      view.getAttribute('aria-busy') !== 'true' &&
      similar !== null &&
      signature === previousSignature
    ) {
      stableFrames += 1
    } else {
      stableFrames = 0
    }
    previousSignature = signature
    return stableFrames >= 2
  })
  await waitForVisibleCoverTerminal(telemetry)
}

async function scrollArtistPage(
  frameIntervals: number[],
  telemetry: PerformanceTelemetry,
): Promise<void> {
  const scroller = document.querySelector<HTMLElement>('.app-content')
  if (!scroller) throw new Error('Application scroller was missing')
  scroller.scrollTop = 0
  await nextFrame()
  const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const durationMs = Math.max(1_200, Math.min(2_500, maximum / 1.2))
  telemetry.record('scroll-start', globalThis.location.hash, {
    maximum: Math.round(maximum),
  })
  const started = performance.now()
  let previousFrame = started
  while (true) {
    const timestamp = await nextFrame()
    frameIntervals.push(timestamp - previousFrame)
    previousFrame = timestamp
    const progress = Math.min(1, (timestamp - started) / durationMs)
    // Smoothstep avoids a synthetic one-frame teleport and exercises the same
    // incremental image/virtual-row lifecycle as a fast trackpad gesture.
    const eased = progress * progress * (3 - 2 * progress)
    scroller.scrollTop = maximum * eased
    if (progress >= 1) break
  }
  scroller.scrollTop = maximum
  await nextFrame()
  if (Math.abs(scroller.scrollTop - maximum) > 2) {
    throw new Error('Artist page did not reach its scroll boundary')
  }
  telemetry.record('scroll-complete', globalThis.location.hash, {
    scrollTop: Math.round(scroller.scrollTop),
    maximum: Math.round(maximum),
  })
  await waitForVisibleCoverTerminal(telemetry)
}

function report(
  startedAt: string,
  phase: PerformanceReport['phase'],
  config: PerformanceConfig & { readonly scenario: 'artist-dfs-v1' },
  frameIntervals: readonly number[],
  iterationsCompleted: number,
  recoverySecondsElapsed: number,
  telemetry: PerformanceTelemetry,
  player: PerformancePlayerTelemetrySource,
  router: Router,
  failure: string | null = null,
): PerformanceReport {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    scenario: config.scenario,
    phase,
    startedAt,
    updatedAt: new Date().toISOString(),
    iterationsRequested: config.iterations,
    iterationsCompleted,
    recoverySecondsElapsed,
    frames: summarizeFrameIntervals(frameIntervals),
    runtime: runtimeSnapshot(router),
    telemetry: telemetry.snapshot(player, router),
    failure,
  }
}

async function checkpoint(value: PerformanceReport): Promise<void> {
  await invoke('performance_checkpoint', { report: value })
}

/**
 * The completion report below is the single final write. Avoid emitting an
 * otherwise identical recovery report immediately before it.
 */
export function shouldWriteRecoveryCheckpoint(
  recoverySecondsElapsed: number,
  recoverySeconds: number,
): boolean {
  return (
    recoverySecondsElapsed > 0 &&
    recoverySecondsElapsed < recoverySeconds &&
    recoverySecondsElapsed % PERFORMANCE_RECOVERY_CHECKPOINT_INTERVAL_SECONDS === 0
  )
}

function artistIdFromHref(href: string | null): number | null {
  if (!href) return null
  const match = /(?:#\/|\/)artist\/(\d+)(?:$|[?#])/.exec(href)
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : null
}

async function playDailyFixture(
  player: PerformancePlayerTelemetrySource,
  telemetry: PerformanceTelemetry,
  expectedAudioUrl: string,
): Promise<void> {
  await waitFor(() => {
    telemetry.scan()
    const view = document.querySelector<HTMLElement>('.daily-songs-view')
    return view?.getAttribute('aria-busy') !== 'true' && view?.querySelector('.play-track') !== null
  })
  const button = document.querySelector<HTMLButtonElement>('.daily-songs-view .play-track')
  if (!button) throw new Error('Daily fixture track play button was missing')
  button.click()
  await waitFor(() => {
    telemetry.scan()
    return (
      Number(player.currentTrack?.id) === 999_000 &&
      player.sourceKind === 'remote' &&
      player.sourceUrl === expectedAudioUrl &&
      player.sourceProvenance === 'performance-fixture' &&
      player.state === 'playing'
    )
  })
  telemetry.setPlaybackSource('remote', expectedAudioUrl, 'performance-fixture', null)
}

function findSimilarArtistLinks(currentArtistId: number): readonly {
  link: HTMLAnchorElement
  targetArtistId: number
}[] {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.similar-artists a')]
  const result: { link: HTMLAnchorElement; targetArtistId: number }[] = []
  for (const link of links) {
    const targetArtistId = artistIdFromHref(link.getAttribute('href'))
    if (targetArtistId !== null && targetArtistId !== currentArtistId)
      result.push({ link, targetArtistId })
  }
  return result
}

async function clickSimilarArtist(
  router: Router,
  currentArtistId: number,
  targetArtistId: number,
  telemetry: PerformanceTelemetry,
): Promise<number> {
  const edge = findSimilarArtistLinks(currentArtistId).find(
    ({ targetArtistId: candidate }) => candidate === targetArtistId,
  )
  if (!edge) throw new Error('Similar artist DFS edge was missing after a complete scroll')
  if (!elementIsVisible(edge.link)) {
    edge.link.scrollIntoView({ block: 'center', behavior: 'auto' })
    await nextFrame()
  }
  if (!elementIsVisible(edge.link)) throw new Error('Similar artist DFS edge was not visible')
  telemetry.record('similar-navigation-start', routePath(router), {
    fromArtistId: currentArtistId,
    toArtistId: edge.targetArtistId,
  })
  edge.link.click()
  await waitFor(() => router.currentRoute.value.path === `/artist/${edge.targetArtistId}`)
  await waitForArtistStable(edge.targetArtistId, telemetry)
  telemetry.record('similar-navigation-complete', routePath(router), {
    fromArtistId: currentArtistId,
    toArtistId: edge.targetArtistId,
  })
  return edge.targetArtistId
}

async function waitForPlaybackProgress(
  player: PerformancePlayerTelemetrySource,
  telemetry: PerformanceTelemetry,
  expectedAudioUrl: string,
): Promise<void> {
  const deadline = performance.now() + PLAYBACK_GATE_WINDOW_SECONDS * 1_000
  let samples = 0
  while (performance.now() < deadline) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000))
    samples += 1
    const snapshot = telemetry.snapshot(player)
    if (
      player.sourceKind !== 'remote' ||
      player.sourceUrl !== expectedAudioUrl ||
      player.sourceProvenance !== 'performance-fixture'
    ) {
      throw new Error('Playback source changed away from the exact performance fixture')
    }
    if (snapshot.playback.fallbackReason !== null) {
      throw new Error('Performance playback reported a fallback source')
    }
  }
  const advancingSamples = telemetry.snapshot(player).playback.advancingSamples
  if (samples < PLAYBACK_GATE_WINDOW_SECONDS) {
    throw new Error('Playback progress verification ended before the gate window')
  }
  if (advancingSamples < MIN_PLAYBACK_ADVANCING_SAMPLES) {
    throw new Error('Playback progress did not continuously advance during the gate window')
  }
}

async function waitForHomeRoute(router: Router, telemetry: PerformanceTelemetry): Promise<void> {
  await router.replace(PERFORMANCE_HOME_ROUTE)
  await waitFor(() => router.currentRoute.value.path === PERFORMANCE_HOME_ROUTE)
  // The normal home route may legitimately show an unauthenticated error
  // state; the route and app shell are the equivalence contract, not a private
  // performance-only component.
  await waitFor(() => document.querySelector('.app-content') !== null)
  telemetry.record('home-route-ready', routePath(router))
}

export async function runPerformanceScenario(
  router: Router,
  player: ReturnType<typeof usePlayerStore>,
  input: PerformanceConfig,
): Promise<void> {
  if (!input.enabled || input.scenario !== 'artist-dfs-v1' || !input.audioUrl) return
  const config: PerformanceConfig & {
    readonly scenario: 'artist-dfs-v1'
    readonly audioUrl: string
  } = { ...input, scenario: input.scenario, audioUrl: input.audioUrl }
  const startedAt = new Date().toISOString()
  const frameIntervals: number[] = []
  const telemetry = new PerformanceTelemetry()
  let iterationsCompleted = 0
  let recoverySecondsElapsed = 0
  let currentArtistId = PERFORMANCE_ARTIST_FIRST_ID
  const playerSource = player as unknown as PerformancePlayerTelemetrySource
  telemetry.start(router)
  try {
    await checkpoint(
      report(
        startedAt,
        'ready',
        config,
        frameIntervals,
        0,
        recoverySecondsElapsed,
        telemetry,
        playerSource,
        router,
      ),
    )
    await invoke('performance_wait_for_start')
    await checkpoint(
      report(
        startedAt,
        'dfs',
        config,
        frameIntervals,
        0,
        recoverySecondsElapsed,
        telemetry,
        playerSource,
        router,
      ),
    )
    const dfsStack: Array<{
      readonly artistId: number
      neighborIds: readonly number[]
      nextNeighborIndex: number
    }> = [{ artistId: currentArtistId, neighborIds: [], nextNeighborIndex: 0 }]
    const visited = new Set<number>([currentArtistId])
    while (iterationsCompleted < config.iterations && dfsStack.length > 0) {
      const frame = dfsStack[dfsStack.length - 1]
      if (!frame) break
      currentArtistId = frame.artistId
      if (router.currentRoute.value.path !== `/artist/${currentArtistId}`) {
        await router.replace(`/artist/${currentArtistId}`)
      }
      await waitForArtistStable(currentArtistId, telemetry)
      await scrollArtistPage(frameIntervals, telemetry)
      const links = findSimilarArtistLinks(currentArtistId)
      frame.neighborIds = links.map(({ targetArtistId }) => targetArtistId)
      while (
        frame.nextNeighborIndex < frame.neighborIds.length &&
        visited.has(frame.neighborIds[frame.nextNeighborIndex] ?? -1)
      ) {
        frame.nextNeighborIndex += 1
      }
      iterationsCompleted += 1
      await checkpoint(
        report(
          startedAt,
          'dfs',
          config,
          frameIntervals,
          iterationsCompleted,
          recoverySecondsElapsed,
          telemetry,
          playerSource,
          router,
        ),
      )

      if (iterationsCompleted >= config.iterations) break
      const nextArtistId = frame.neighborIds[frame.nextNeighborIndex]
      if (nextArtistId !== undefined) {
        frame.nextNeighborIndex += 1
        visited.add(nextArtistId)
        await clickSimilarArtist(router, currentArtistId, nextArtistId, telemetry)
        dfsStack.push({ artistId: nextArtistId, neighborIds: [], nextNeighborIndex: 0 })
        continue
      }

      dfsStack.pop()
      const parent = dfsStack[dfsStack.length - 1]
      if (parent) {
        telemetry.record('dfs-backtrack', routePath(router), {
          fromArtistId: currentArtistId,
          toArtistId: parent.artistId,
        })
        await router.replace(`/artist/${parent.artistId}`)
        await waitForArtistStable(parent.artistId, telemetry)
      }
    }
    if (iterationsCompleted < config.iterations) {
      throw new Error(`DFS graph ended after ${iterationsCompleted} steps`)
    }

    await waitForHomeRoute(router, telemetry)
    await playDailyFixture(playerSource, telemetry, config.audioUrl)
    configurePerformanceRepeatOne(playerSource)
    telemetry.record('performance-repeat-one', routePath(router), {
      repeatMode: normalizePerformanceRepeatMode(playerSource.repeatMode),
    })
    await waitForPlaybackProgress(playerSource, telemetry, config.audioUrl)
    await checkpoint(
      report(
        startedAt,
        'recovery',
        config,
        frameIntervals,
        iterationsCompleted,
        recoverySecondsElapsed,
        telemetry,
        playerSource,
        router,
      ),
    )
    while (recoverySecondsElapsed < config.recoverySeconds) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000))
      recoverySecondsElapsed += 1
      telemetry.sampleRecoveryPlayback(playerSource, config.audioUrl, router)
      if (shouldWriteRecoveryCheckpoint(recoverySecondsElapsed, config.recoverySeconds)) {
        await checkpoint(
          report(
            startedAt,
            'recovery',
            config,
            frameIntervals,
            iterationsCompleted,
            recoverySecondsElapsed,
            telemetry,
            playerSource,
            router,
          ),
        )
      }
    }
    await checkpoint(
      report(
        startedAt,
        'complete',
        config,
        frameIntervals,
        iterationsCompleted,
        recoverySecondsElapsed,
        telemetry,
        playerSource,
        router,
      ),
    )
  } catch (reason) {
    const failure = reason instanceof Error ? reason.message : String(reason)
    await checkpoint(
      report(
        startedAt,
        'failed',
        config,
        frameIntervals,
        iterationsCompleted,
        recoverySecondsElapsed,
        telemetry,
        playerSource,
        router,
        failure,
      ),
    ).catch(() => undefined)
    throw reason
  } finally {
    telemetry.stop()
  }
}
