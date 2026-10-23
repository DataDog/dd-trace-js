'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('SSIHeuristics', () => {
  let clock
  let dc
  let SSIHeuristics

  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    dc = {
      subscribe: sinon.spy(),
      unsubscribe: sinon.spy(),
    }
    const ssiHeuristicsModule = proxyquire('../../src/profiling/ssi-heuristics', {
      'dc-polyfill': dc,
    })
    SSIHeuristics = ssiHeuristicsModule.SSIHeuristics
  })

  afterEach(() => {
    clock.restore()
  })

  it('releases its timer, callback, and channel subscriptions when disabled', () => {
    const heuristics = new SSIHeuristics({ DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD: 100 })
    const onTriggered = sinon.spy()
    heuristics.start()
    heuristics.onTriggered(onTriggered)

    const spanHandler = dc.subscribe.firstCall.args[1]
    const appClosingHandler = dc.subscribe.secondCall.args[1]

    assert.strictEqual(clock.countTimers(), 1)

    heuristics.disable()

    assert.strictEqual(clock.countTimers(), 0)
    assert.strictEqual(heuristics.triggeredCallback, undefined)
    sinon.assert.calledWithExactly(dc.unsubscribe, 'dd-trace:span:start', spanHandler)
    sinon.assert.calledWithExactly(dc.unsubscribe, 'datadog:telemetry:app-closing', appClosingHandler)

    clock.tick(100)
    spanHandler()
    sinon.assert.notCalled(onTriggered)
  })

  it('is safe to disable more than once', () => {
    const heuristics = new SSIHeuristics({})
    heuristics.start()

    heuristics.disable()
    heuristics.disable()

    sinon.assert.callCount(dc.unsubscribe, 2)
  })

  it('disables itself when the application closes', () => {
    const heuristics = new SSIHeuristics({})
    heuristics.start()
    const appClosingHandler = dc.subscribe.secondCall.args[1]

    appClosingHandler()

    assert.strictEqual(clock.countTimers(), 0)
    sinon.assert.calledWithExactly(dc.unsubscribe, 'dd-trace:span:start', dc.subscribe.firstCall.args[1])
    sinon.assert.calledWithExactly(dc.unsubscribe, 'datadog:telemetry:app-closing', appClosingHandler)
  })
})
