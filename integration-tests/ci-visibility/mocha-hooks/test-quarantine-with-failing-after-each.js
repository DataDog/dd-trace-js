'use strict'

describe('quarantine tests with failing afterEach', () => {
  afterEach(() => {
    throw new Error('afterEach hook failed')
  })

  it('can quarantine a test whose afterEach hook fails', () => {
    // test passes, but the afterEach will throw
  })
})
