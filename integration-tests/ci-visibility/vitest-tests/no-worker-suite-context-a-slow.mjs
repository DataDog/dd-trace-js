import { describe, expect, test } from 'vitest'

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('no-worker suite context slow', () => {
  test('uses slow suite', async () => {
    await delay(200)

    expect(true).toBe(true)
  })
})
