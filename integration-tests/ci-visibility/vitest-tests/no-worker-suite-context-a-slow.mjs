import { describe, expect, test } from 'vitest'

describe('no-worker suite context slow', () => {
  test('reports the slow suite test', async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(1 + 2).toBe(3)
  })
})
