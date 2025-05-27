'use strict'

let counter = 0

describe('test-flaky-test-retries', () => {
  it('can retry flaky tests', () => {
    expect(++counter).toEqual(3)
  })

  it('will not retry passed tests', () => {
    expect(3).toEqual(3)
  })
})
