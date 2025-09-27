'use strict'

const assert = require('assert')

describe('jest-hook-failure', () => {
  beforeEach(() => {
    throw new Error('hey, hook error before')
  })

  it('will not run', () => {
    assert.strictEqual(true, true)
  })
})

describe('jest-hook-failure-after', () => {
  afterEach(() => {
    throw new Error('hey, hook error after')
  })

  it('will not run', () => {
    assert.strictEqual(true, true)
  })
})
