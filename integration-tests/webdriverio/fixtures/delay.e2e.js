'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')

describe('WebdriverIO delayed root suite', () => {
  it('waits for the user and Test Optimization configuration', () => {
    const activeSpan = tracer.scope().active()

    assert.ok(activeSpan)
    activeSpan.setTag('test.webdriverio.worker', 'delay')
  })
})

setTimeout(run, 1_000)
