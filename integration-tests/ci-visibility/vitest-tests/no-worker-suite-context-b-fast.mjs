import { describe, expect, test } from 'vitest'

describe('no-worker suite context fast', () => {
  test('uses fast suite', () => {
    expect(true).toBe(true)
  })
})
