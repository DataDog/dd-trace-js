'use strict'

const tracer = require('dd-trace')
const assert = require('node:assert/strict')
const dc = require('node:diagnostics_channel')
const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

const started = new Set()
const finished = new Set()
dc.channel('dd-trace:span:start').subscribe(({ span }) => {
  if (span.context()._name === 'mocha.test') started.add(span)
})
dc.channel('dd-trace:span:finish').subscribe(span => {
  if (started.has(span)) finished.add(span)
})

it('body skip', preventFailureSuppression(noAutoRetry(function () { this.skip() })))
// Declaration skips are a lifecycle control for the two runtime skips.
it.skip('declaration skip', preventFailureSuppression(noAutoRetry(() => {})))
describe('beforeEach skip', () => {
  // Runtime hook skips must finish the existing test span.
  beforeEach(function () { this.skip() })
  it('hook skip', preventFailureSuppression(noAutoRetry(() => {
    throw new Error('skipped callback must not execute')
  })))
})
it('live control', () => {})
after(() => {
  assert.strictEqual(started.size, 4, 'exactly one span starts for each test')
  assert.strictEqual(finished.size, 4, 'every started test span finishes')
  assert.strictEqual(tracer._pluginManager._pluginsByName.mocha.activeTestSpan, null)
})
