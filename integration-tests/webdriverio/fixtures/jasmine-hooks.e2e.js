'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')

describe('WebdriverIO Jasmine per-test hooks', () => {
  let testSpan

  beforeEach(() => {
    testSpan = tracer.scope().active()

    assert.ok(testSpan)
    testSpan.setTag('test.webdriverio.jasmine.before-each', 'active')
  })

  afterEach(() => {
    const activeSpan = tracer.scope().active()

    assert.strictEqual(activeSpan, testSpan)
    activeSpan.setTag('test.webdriverio.jasmine.after-each', 'active')
  })

  it('keeps the test span active', () => {
    assert.strictEqual(tracer.scope().active(), testSpan)
  })
})
