'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')

describe('WebdriverIO second worker', () => {
  it('runs with an active Test Optimization span', () => {
    const activeSpan = tracer.scope().active()

    assert.ok(activeSpan)
    activeSpan.setTag('test.webdriverio.worker', 'second')
  })
})
