import { describe, expect, test } from 'vitest'

describe('string setup file', () => {
  test('keeps the configured setup file', () => {
    expect(globalThis.__ddStringSetupFileLoaded).toBe(true)
  })
})
