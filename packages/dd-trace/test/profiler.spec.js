'use strict'

const assert = require('node:assert/strict')

const { before, beforeEach, describe, it } = require('mocha')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const configUpdateChannel = dc.channel('datadog:config:update')

describe('profiler', () => {
  let profiler
  let profilingModule
  let ssiHeuristics
  let FakeSSIHeuristics
  let log

  function publishConfig (enabled) {
    configUpdateChannel.publish({ profiling: { DD_PROFILING_ENABLED: enabled } })
  }

  before(() => {
    // profiler.js subscribes to the shared config-update channel once at module load, like it
    // would in production, so it is proxyquired once for the whole suite rather than per test.
    profilingModule = {
      profiler: {
        start: sinon.stub().returns(true),
        stop: sinon.spy(),
        setCustomLabelKeys: sinon.spy(),
        runWithLabels: sinon.stub().callsFake((labels, fn) => fn()),
      },
    }

    FakeSSIHeuristics = sinon.stub().callsFake((config) => {
      ssiHeuristics = {
        config,
        start: sinon.spy(),
        onTriggered: sinon.stub().callsFake((callback) => {
          ssiHeuristics.triggeredCallback = callback
        }),
      }
      return ssiHeuristics
    })

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
    }

    profiler = proxyquire('../src/profiler', {
      './profiling': profilingModule,
      './profiling/ssi-heuristics': { SSIHeuristics: FakeSSIHeuristics },
      './log': log,
    })
  })

  beforeEach(() => {
    profilingModule.profiler.start.resetHistory()
    profilingModule.profiler.start.returns(true)
    profilingModule.profiler.stop.resetHistory()
    FakeSSIHeuristics.resetHistory()
    log.debug.resetHistory()
    log.error.resetHistory()
    ssiHeuristics = undefined

    // profiler.js tracks `started` at module scope; reset it so a prior test's enabled profiler
    // doesn't make this test's start() a no-op.
    publishConfig(false)
    profilingModule.profiler.stop.resetHistory()
  })

  describe('config update', () => {
    it('does not start or stop the profiler on an initial disabled publish', () => {
      publishConfig(false)

      sinon.assert.notCalled(profilingModule.profiler.start)
      sinon.assert.notCalled(profilingModule.profiler.stop)
      assert.strictEqual(profiler.started, false)
    })

    it('starts the profiler when enabled', () => {
      publishConfig('true')

      sinon.assert.calledOnce(profilingModule.profiler.start)
      assert.strictEqual(profiler.started, true)
    })

    it('does not re-start an already-running profiler on a repeated enabled publish', () => {
      publishConfig('true')
      publishConfig('true')

      sinon.assert.calledOnce(profilingModule.profiler.start)
    })

    it('stops a running profiler when a later publish disables it', () => {
      publishConfig('true')
      sinon.assert.notCalled(profilingModule.profiler.stop)

      publishConfig(false)

      sinon.assert.calledOnce(profilingModule.profiler.stop)
      assert.strictEqual(profiler.started, false)
    })

    it('arms the SSI heuristics when set to auto, and starts on trigger', () => {
      publishConfig('auto')

      sinon.assert.notCalled(profilingModule.profiler.start)
      assert.strictEqual(profiler.started, false)
      sinon.assert.calledOnceWithExactly(FakeSSIHeuristics, { profiling: { DD_PROFILING_ENABLED: 'auto' } })
      sinon.assert.calledOnce(ssiHeuristics.start)

      ssiHeuristics.triggeredCallback()

      sinon.assert.calledOnce(profilingModule.profiler.start)
      assert.strictEqual(profiler.started, true)
      // deregisters the trigger callback once it has fired
      sinon.assert.calledTwice(ssiHeuristics.onTriggered)
      assert.strictEqual(ssiHeuristics.onTriggered.secondCall.args[0], undefined)
    })

    it('does not re-arm the SSI heuristics on a repeated auto publish before it triggers', () => {
      publishConfig('auto')
      sinon.assert.calledOnce(FakeSSIHeuristics)

      publishConfig('auto')
      sinon.assert.calledOnce(FakeSSIHeuristics)

      ssiHeuristics.triggeredCallback()
      sinon.assert.calledOnce(profilingModule.profiler.start)
    })

    it('re-arms the SSI heuristics after a prior arming has already triggered', () => {
      publishConfig('auto')
      ssiHeuristics.triggeredCallback()
      sinon.assert.calledOnce(FakeSSIHeuristics)

      publishConfig(false)
      publishConfig('auto')

      sinon.assert.calledTwice(FakeSSIHeuristics)
    })

    it('logs and treats the profiler as not started when starting throws', () => {
      profilingModule.profiler.start.throws(new Error('boom'))

      publishConfig('true')

      assert.strictEqual(profiler.started, false)
      sinon.assert.calledOnce(log.error)
    })
  })

  describe('start/stop/label passthroughs', () => {
    it('start attempts a profiler start and returns its result', () => {
      const config = { profiling: { DD_PROFILING_ENABLED: 'true' } }

      const result = profiler.start(config)

      assert.strictEqual(result, true)
      sinon.assert.calledOnceWithExactly(profilingModule.profiler.start, config)
    })

    it('stop delegates to the profiling layer', () => {
      profiler.stop()

      sinon.assert.calledOnce(profilingModule.profiler.stop)
    })

    it('setCustomLabelKeys delegates to the profiling layer', () => {
      profiler.setCustomLabelKeys(['foo'])

      sinon.assert.calledOnceWithExactly(profilingModule.profiler.setCustomLabelKeys, ['foo'])
    })

    it('runWithLabels delegates to the profiling layer', () => {
      const fn = () => 'result'

      const result = profiler.runWithLabels({ foo: 'bar' }, fn)

      assert.strictEqual(result, 'result')
      sinon.assert.calledOnceWithExactly(profilingModule.profiler.runWithLabels, { foo: 'bar' }, fn)
    })
  })
})
