'use strict'

const assert = require('assert')

const sum = require('./dependency')

let count = 0

afterEach(function (done) {
  if (this.currentTest.currentRetry() === 0) {
    this.currentTest._ddShouldWaitForHitProbe = true
  }
  done()
})

describe('dynamic-instrumentation parallel afterEach', () => {
  it('retries with DI after afterEach', function () {
    if (count++ === 0) {
      assert.strictEqual(sum(11, 3), 14)
    }
    assert.strictEqual(sum(1, 3), 4)
  })
})
