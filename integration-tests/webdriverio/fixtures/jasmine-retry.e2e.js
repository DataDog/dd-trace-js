'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')

let attempt = 0

describe('WebdriverIO Jasmine retries', () => {
  it('reports every Jasmine attempt', () => {
    assert.ok(tracer.scope().active())
    attempt++
    assert.strictEqual(attempt, 2)
  // eslint-disable-next-line no-undef -- Jasmine exposes its timeout through WebdriverIO.
  }, jasmine.DEFAULT_TIMEOUT_INTERVAL, 1)
})
