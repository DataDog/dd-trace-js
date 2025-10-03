'use strict'

let retryCounter = 0

describe('attempt to fix snapshot', () => {
  it('is flaky', () => {
    if (process.env.SHOULD_PASS_ALWAYS) {
      expect(3).toMatchSnapshot()
    } else {
      const sum = ++retryCounter > 2 ? 3 : 4
      expect(sum).toMatchSnapshot()
    }
    expect('a').toMatchSnapshot()
  })
})
