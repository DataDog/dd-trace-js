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

  // eslint-disable-next-line mocha/no-pending-tests -- this fixture verifies skipped-test reporting.
  xit('reports a skipped test', () => {})
})
