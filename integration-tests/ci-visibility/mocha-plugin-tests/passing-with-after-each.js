'use strict'

const assert = require('assert')

describe('mocha-reporter-hook-end', () => {
  afterEach(() => {})

  it('can pass', () => {
    assert.strictEqual(true, true)
  })
})

describe('mocha-reporter-hook-end-outer', () => {
  afterEach(() => {})

  describe('mocha-reporter-hook-end-inner', () => {
    afterEach(() => {})

    it('can pass after an inner hook reporter error', () => {
      assert.strictEqual(true, true)
    })
  })
})
