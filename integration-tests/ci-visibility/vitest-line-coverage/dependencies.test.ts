import { describe, it, expect } from 'vitest'

import { subtract } from './src/arithmetic.ts'
import './src/no-code.mjs'
import { sharedBody } from './src/shared-body.mjs'
import settings from './src/settings.json'

describe('dependencies', () => {
  it('runs a body defined in another file', sharedBody)

  it('runs a line of its own file', () => {
    expect(subtract(3, 1)).toBe(2)
    expect(settings.name).toBe('fixture')
  })

  it('imports a module of no code', async () => {
    await import('./src/lazy-no-code.mjs')
    const { default: lazySettings } = await import('./src/lazy-settings.json')
    expect(lazySettings.lazy).toBe(true)
  })
})
