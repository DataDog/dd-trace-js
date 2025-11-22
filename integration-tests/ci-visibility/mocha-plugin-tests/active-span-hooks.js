'use strict'

const assert = require('node:assert/strict')
let currentTestTraceId

describe('mocha-active-span-in-hooks', function () {
  before(() => {
    assert.strictEqual(global._ddtrace.scope().active(), null)
  })

  after(() => {
    assert.strictEqual(global._ddtrace.scope().active(), null)
  })

  beforeEach(() => {
    currentTestTraceId = global._ddtrace.scope().active().context().toTraceId()
  })

  afterEach(() => {
    assert.strictEqual(currentTestTraceId, global._ddtrace.scope().active().context().toTraceId())
  })

  it('first test', () => {
    assert.strictEqual(currentTestTraceId, global._ddtrace.scope().active().context().toTraceId())
  })

  it('second test', () => {
    assert.strictEqual(currentTestTraceId, global._ddtrace.scope().active().context().toTraceId())
  })
})
