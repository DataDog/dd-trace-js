'use strict'

const mockFn = jest.fn()

describe('attempt to fix tests with mock', () => {
  it('resets mock state between retries', () => {
    // eslint-disable-next-line no-console
    console.log('I am running attempt to fix with mock')

    // Call the mock function once
    mockFn()

    // This assertion should pass on every retry because mock state should be reset
    // If mock state is NOT reset, this will fail on the 2nd retry with "Expected: 1, Received: 2"
    expect(mockFn).toHaveBeenCalledTimes(1)
  })
})
