import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appShellSource = readFileSync(resolve(process.cwd(), 'src/app/AppShell.vue'), 'utf8')

describe('AppShell lyrics presentation contract', () => {
  it('keeps the lyrics transition opaque and moves it as one full-screen surface', () => {
    expect(appShellSource).toMatch(/<div[^>]*class="lyrics-overlay-shell"[^>]*>/)
    expect(appShellSource).toMatch(
      /\.lyrics-overlay-shell\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?background:\s*var\(--color-body-bg\)/,
    )
    expect(appShellSource).toMatch(
      /\.lyrics-slide-enter-active\s+\.lyrics-overlay,[\s\S]*?\.lyrics-slide-leave-active\s+\.lyrics-overlay\s*\{[\s\S]*?transition:\s*transform 380ms cubic-bezier\(0\.22, 1, 0\.36, 1\);/,
    )
    expect(appShellSource).toMatch(
      /\.lyrics-slide-enter-from\s+\.lyrics-overlay,[\s\S]*?\.lyrics-slide-leave-to\s+\.lyrics-overlay\s*\{[\s\S]*?transform:\s*translate3d\(0, 100%, 0\);/,
    )
    expect(appShellSource).not.toMatch(
      /\.lyrics-slide-enter-active\s+\.lyrics-overlay,[\s\S]*?\.lyrics-slide-leave-active\s+\.lyrics-overlay\s*\{[^}]*opacity:/,
    )
    expect(appShellSource).not.toMatch(
      /\.lyrics-slide-enter-from\s+\.lyrics-overlay,[\s\S]*?\.lyrics-slide-leave-to\s+\.lyrics-overlay\s*\{[^}]*opacity:/,
    )
  })
})
