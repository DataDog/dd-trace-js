'use strict'

const assert = require('node:assert/strict')
let globalAttempts = 0

describe('describe', function () {
  this.retries(2)

  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('beforeEach')
  })

  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('afterEach')
  })

  it('is not nested', function (done) {
    // eslint-disable-next-line no-console
    console.log('is not nested')
    try {
      assert.strictEqual(process.env.SHOULD_FAIL ? globalAttempts++ : 1, 1)
      done()
    } catch (error) {
      done(error)
    }
  })

  context('context', () => {
    beforeEach(() => {
      // eslint-disable-next-line no-console
      console.log('beforeEach in context')
    })

    afterEach(() => {
      // eslint-disable-next-line no-console
      console.log('afterEach in context')
    })

    it('nested test with retries', function () {
      // eslint-disable-next-line no-console
      console.log('nested test with retries')
      assert.strictEqual(0, 0)
    })
  })
})
