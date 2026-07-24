'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')

let attempt = 0

describe('WebdriverIO Mocha retries', () => {
  it('reports every Mocha attempt', () => {
    const activeSpan = tracer.scope().active()

    assert.ok(activeSpan)
    activeSpan.setTag('test.webdriverio.worker', 'retry')
    attempt++
    assert.strictEqual(attempt, 2)
  })
})
