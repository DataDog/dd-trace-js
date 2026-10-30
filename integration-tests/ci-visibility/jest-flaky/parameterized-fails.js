'use strict'

describe('test-flaky-test-retries', () => {
  const parameterizedTest = test.each([
    ['passing row', true],
    ['failing row', false],
  ])
  parameterizedTest('preserves parameters between retries', (row, shouldPass) => {
    expect(shouldPass).toBe(true)
  })
})
