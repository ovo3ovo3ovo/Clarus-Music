import { afterEach, describe, expect, it } from 'vitest'
import { installNativeTooltipBlocker } from './native-tooltips'

async function flushMutationObserver(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('native tooltip blocker', () => {
  afterEach(() => document.body.replaceChildren())

  it('removes existing, added, and subsequently updated title attributes', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<button title="Back">Back</button>'
    document.body.append(root)
    const disconnect = installNativeTooltipBlocker(root)

    expect(root.querySelector('button')?.hasAttribute('title')).toBe(false)

    const added = document.createElement('span')
    added.title = 'Album'
    root.append(added)
    await flushMutationObserver()
    expect(added.hasAttribute('title')).toBe(false)

    added.title = 'Updated album'
    await flushMutationObserver()
    expect(added.hasAttribute('title')).toBe(false)
    disconnect()
  })
})
