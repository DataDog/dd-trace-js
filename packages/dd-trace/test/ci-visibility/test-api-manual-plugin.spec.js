'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { storage } = require('../../../datadog-core')
const SpanContext = require('../../src/opentracing/span_context')

require('../setup/core')

const legacyStorage = storage('legacy')
const subscriptions = []
let plugin
let span

class FakeCiPlugin {
  /**
   * @param {string} name
   * @param {(message: unknown) => void} handler
   */
  addSub (name, handler) {
    const channel = dc.channel(name)
    channel.subscribe(handler)
    subscriptions.push([channel, handler])
  }

  /**
   * @param {object} config
   * @param {boolean} shouldGetEnvironmentData
   */
  configure (config, shouldGetEnvironmentData) {}

  /**
   * @returns {object}
   */
  startTestSpan () {
    return span
  }
}

describe('TestApiManualPlugin', () => {
  beforeEach(() => {
    const context = new SpanContext({})
    span = {
      _duration: undefined,
      addTags: sinon.spy(),
      context: () => context,
      finish () {
        this._duration = 1
      },
      setTag: sinon.spy(),
      tracer: () => ({}),
    }
    const TestApiManualPlugin = proxyquire('../../src/ci-visibility/test-api-manual/test-api-manual-plugin', {
      '../../plugins/ci_plugin': FakeCiPlugin,
      '../../plugins/util/test': {
        TEST_STATUS: 'test.status',
        finishAllTraceSpans: sinon.spy(),
        getTestSuitePath: sinon.stub().returns('suite.js'),
      },
    })
    plugin = new TestApiManualPlugin()
  })

  afterEach(() => {
    for (const [channel, handler] of subscriptions) {
      channel.unsubscribe(handler)
    }
    subscriptions.length = 0
    plugin = undefined
    legacyStorage.enterWith(undefined)
  })

  it('retires the test span after the manual test finishes', () => {
    assert.ok(plugin)
    dc.channel('dd-trace:ci:manual:test:start').publish({
      testName: 'test',
      testSuite: 'suite.js',
    })
    dc.channel('dd-trace:ci:manual:test:addTags').publish({ custom: 'tag' })
    const error = new Error('boom')
    dc.channel('dd-trace:ci:manual:test:finish').publish({
      status: 'pass',
      error,
    })

    sinon.assert.calledWith(span.addTags, { custom: 'tag' })
    sinon.assert.calledWith(span.setTag, 'test.status', 'pass')
    sinon.assert.calledWith(span.setTag, 'error', error)
    assert.notStrictEqual(legacyStorage.getStore().span, span)
    assert.strictEqual(legacyStorage.getStore().span.context()._spanId, span.context()._spanId)
  })
})
