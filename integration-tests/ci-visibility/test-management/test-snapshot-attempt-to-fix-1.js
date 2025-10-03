'use strict'

let retryCounter = 0

describe('attempt to fix snapshot', () => {
  it('is flaky', () => {
    retryCounter++
    const sum = retryCounter > 2 ? 3 : 4

    if (process.env.SHOULD_PASS_ALWAYS) {
      expect(3).toMatchSnapshot()
    } else {
      expect(sum).toMatchSnapshot()
    }
    expect('a').toMatchSnapshot()
  })
})
