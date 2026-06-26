import { describe, expect, test } from 'vitest'

describe('string setup file', () => {
  test('runs existing string setup file', () => {
    expect(globalThis.__ddTestOptStringSetupFileLoaded).toBe(true)
  })
})
