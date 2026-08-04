export interface SettingsWriterOptions<T> {
  readonly delayMs?: number
  readonly clone: (value: T) => T
  readonly save: (value: T) => Promise<void>
  readonly onError?: (error: unknown) => void
}

export class CoalescedSettingsWriter<T> {
  private readonly delayMs: number
  private readonly clone: (value: T) => T
  private readonly save: (value: T) => Promise<void>
  private readonly onError: (error: unknown) => void
  private latest: T | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private draining: Promise<void> | null = null
  private disposed = false

  constructor(options: SettingsWriterOptions<T>) {
    this.delayMs = options.delayMs ?? 350
    this.clone = options.clone
    this.save = options.save
    this.onError = options.onError ?? (() => undefined)
  }

  schedule(value: T): void {
    if (this.disposed) throw new Error('Settings writer is disposed')
    this.latest = this.clone(value)
    if (this.timer !== null || this.draining !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.startDrain().catch(this.onError)
    }, this.delayMs)
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.startDrain()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.flush()
  }

  private startDrain(): Promise<void> {
    if (this.draining !== null) return this.draining
    this.draining = this.drain().finally(() => {
      this.draining = null
      if (this.latest !== null && !this.disposed && this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null
          void this.startDrain().catch(this.onError)
        }, this.delayMs)
      }
    })
    return this.draining
  }

  private async drain(): Promise<void> {
    let firstError: unknown
    while (this.latest !== null) {
      const snapshot = this.latest
      this.latest = null
      try {
        await this.save(snapshot)
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError !== undefined) throw firstError
  }
}
