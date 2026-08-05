'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')

suite('WebdriverIO TDD interface', () => {
  test('reports a TDD test', () => {
    const activeSpan = tracer.scope().active()

    assert.ok(activeSpan)
    activeSpan.setTag('test.webdriverio.worker', 'tdd')
  })
})
