'use strict'

describe('quarantine tests with beforeAll failure', () => {
  beforeAll(() => {
    throw new Error('beforeAll always fails') // simulates a setup failure
  })

  it('failing quarantined test', () => {
    // this body never runs (beforeAll failed), but the test gets the beforeAll error
  })

  it('another failing quarantined test', () => {
    // same — gets beforeAll error, body never runs
  })
})
