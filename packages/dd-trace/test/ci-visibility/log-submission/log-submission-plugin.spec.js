'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const { channel } = require('dc-polyfill')
const sinon = require('sinon')

require('../../setup/core')
const LogSubmissionPlugin = require('../../../src/ci-visibility/log-submission/log-submission-plugin')

const configureCh = channel('ci:log-submission:winston:configure')
const addTransportCh = channel('ci:log-submission:winston:add-transport')

// Minimal mock tracer that satisfies Plugin's constructor
const mockTracer = {
  _tracer: { _exporter: {} },
}

// Fake HttpClass constructor used to verify calls
const MockHttpClass = sinon.stub().returns({})

describe('LogSubmissionPlugin', () => {
  let plugin

  beforeEach(() => {
    sinon.resetHistory()
    MockHttpClass.resetBehavior()
    MockHttpClass.returns({})

    plugin = new LogSubmissionPlugin(mockTracer)
    plugin.configure({ enabled: true, ciVisAgentlessLogSubmissionEnabled: true })

    // Provide the HttpClass via the configure channel
    configureCh.publish(MockHttpClass)
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('adds transport exactly once on a single publish', () => {
    const logger = { add: sinon.stub() }
    addTransportCh.publish(logger)
    assert.strictEqual(logger.add.callCount, 1)
  })

  it('does not add transport twice when the same logger is published twice', () => {
    const logger = { add: sinon.stub() }
    addTransportCh.publish(logger)
    addTransportCh.publish(logger)
    assert.strictEqual(logger.add.callCount, 1)
  })

  it('adds transport independently to each distinct logger', () => {
    const logger1 = { add: sinon.stub() }
    const logger2 = { add: sinon.stub() }
    addTransportCh.publish(logger1)
    addTransportCh.publish(logger2)
    assert.strictEqual(logger1.add.callCount, 1)
    assert.strictEqual(logger2.add.callCount, 1)
  })

  it('allows re-injection on a second logger instance even after another was already injected', () => {
    const logger1 = { add: sinon.stub() }
    const logger2 = { add: sinon.stub() }

    // Inject into logger1 twice (second should be ignored)
    addTransportCh.publish(logger1)
    addTransportCh.publish(logger1)

    // logger2 should still be injected once
    addTransportCh.publish(logger2)

    assert.strictEqual(logger1.add.callCount, 1)
    assert.strictEqual(logger2.add.callCount, 1)
  })
})
