'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')

describe('WebdriverIO Jasmine statuses', () => {
  it('reports a passing test with an active span', () => {
    const activeSpan = tracer.scope().active()

    assert.ok(activeSpan)
    activeSpan.setTag('test.webdriverio.worker', 'jasmine')
  })

  it('reports a failing test', () => {
    assert.fail('expected WebdriverIO Jasmine integration failure')
  })

  xit('reports a skipped test', () => {})
})
