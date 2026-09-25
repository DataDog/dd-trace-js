import { describe, expect, it } from 'vitest'

if (!process.env.EMPTY_SESSION_SCENARIO.startsWith('empty-file')) {
  describe('synthetic suite', () => {
    const test = process.env.EMPTY_SESSION_SCENARIO === 'skipped' ? it.skip : it
    test('passes', () => {
      expect(1 + 1).toBe(2)
    })
  })
}
