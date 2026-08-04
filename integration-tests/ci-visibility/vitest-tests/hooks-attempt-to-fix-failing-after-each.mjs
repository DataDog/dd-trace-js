import { afterEach, describe, expect, test } from 'vitest'

let numAfterEachRuns = 0

describe('attempt to fix tests with failing afterEach', () => {
  afterEach(() => {
    numAfterEachRuns++
    if (numAfterEachRuns === 4) {
      throw new Error('afterEach hook failed')
    }
  })

  test('can attempt to fix a test whose afterEach fails on the last attempt', () => {
    expect(1 + 2).toBe(3)
  })
})
