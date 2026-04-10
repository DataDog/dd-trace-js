'use strict'

const assert = require('assert')
const sinon = require('sinon')

const sum = require('./dependency')

describe('dynamic-instrumentation-fake-timers', () => {
  let clock

  beforeEach(function () {
    clock = sinon.useFakeTimers()
  })

  afterEach(function () {
    clock.restore()
  })

  it('retries with DI and fake timers', function () {
    assert.strictEqual(sum(11, 3), 14)
  })
})
