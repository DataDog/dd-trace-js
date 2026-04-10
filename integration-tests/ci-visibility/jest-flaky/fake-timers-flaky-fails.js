'use strict'

const assert = require('assert')

describe('test-fake-timers', () => {
  beforeAll(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    // This pattern (from @testing-library/react's enableFakeTimers helper)
    // clears all pending timers after each test but BEFORE test_done fires.
    // If dd-trace scheduled a setTimeout in test_done, clearAllTimers
    // destroys it, orphaning the promise and deadlocking the process.
    jest.runOnlyPendingTimers()
    jest.clearAllTimers()
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  it('can retry failed tests with fake timers', () => {
    assert.deepStrictEqual(1, 2)
  })
})
