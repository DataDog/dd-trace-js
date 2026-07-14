'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

const VitestPlugin = require('../src')

const testErrorCh = channel('ci:vitest:test:error')

describe('VitestPlugin', () => {
  let plugin

  before(() => {
    plugin = new VitestPlugin({}, {})
    plugin.configure({ enabled: true }, false)
  })

  after(() => {
    plugin.configure(false, false)
  })

  for (const [duration, adjustedDuration] of [
    [0, 0],
    [1, 0],
    [4, 0],
    [5, 0],
    [100, 95],
  ]) {
    it(`finishes failed tests with a non-negative duration for ${duration} ms`, () => {
      const span = createSpan()

      testErrorCh.publish({ duration, span })

      assert.deepStrictEqual(span.finish.args, [[span._startTime + adjustedDuration]])
    })
  }

  for (const duration of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`uses clock time for invalid duration ${duration}`, () => {
      const span = createSpan()

      testErrorCh.publish({ duration, span })

      assert.deepStrictEqual(span.finish.args, [[]])
    })
  }
})

function createSpan () {
  const spanContext = {
    _trace: {
      started: [],
    },
    getTags: () => ({}),
  }
  const span = {
    _startTime: 100,
    context: () => spanContext,
    finish: sinon.spy(),
    setTag: sinon.spy(),
  }
  spanContext._trace.started.push(span)
  return span
}
