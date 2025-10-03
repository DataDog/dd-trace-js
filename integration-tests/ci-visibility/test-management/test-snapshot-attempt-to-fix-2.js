'use strict'

let retryCounter = 0

describe('attempt to fix snapshot 2', () => {
  it('is flaky', () => {
    const sum = ++retryCounter > 2 ? 3 : 4

    if (process.env.SHOULD_PASS_ALWAYS) {
      expect(3).toMatchSnapshot()
    } else {
      expect(sum).toMatchSnapshot()
    }
    expect('a').toMatchSnapshot()
  })
})
