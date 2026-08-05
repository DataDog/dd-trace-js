'use strict'

describe('test-flaky-test-retries', () => {
  test.each([
    ['passing row', true],
    ['failing row', false],
  ])('preserves parameters between retries', (row, shouldPass) => {
    expect(shouldPass).toBe(true)
  })
})
