import { describe, expect, test } from 'vitest'

describe('no-worker suite context fast', () => {
  test('reports the fast suite test', () => {
    expect(1 + 2).toBe(3)
  })
})
