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
        enabled: false,
        start: sinon.stub(),
        stop: sinon.stub(),
        cancelQueuedStart: sinon.stub(),
        getQueuedStart: sinon.stub(),
        setCustomLabelKeys: sinon.spy(),
        runWithLabels: sinon.stub().callsFake((labels, fn) => fn()),
      },
    }

    FakeSSIHeuristics = sinon.stub().callsFake((config) => {
      ssiHeuristics = {
        config,
        start: sinon.spy(),
        disable: sinon.stub().callsFake(() => {
          ssiHeuristics.triggeredCallback = undefined
        }),
        onTriggered: sinon.stub().callsFake((callback) => {
          ssiHeuristics.triggeredCallback = callback
        }),
      }
      return ssiHeuristics
    })

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }

    profiler = proxyquire('../src/profiler', {
      './profiling': profilingModule,
      './profiling/ssi-heuristics': { SSIHeuristics: FakeSSIHeuristics },
      './log': log,
    })
  })

  beforeEach(() => {
    // profiler.js reads `enabled` straight off the profiling layer rather than caching it, so the
    // fakes mirror the real Profiler class's start()/stop() by flipping it themselves.
    profilingModule.profiler.start.reset()
    profilingModule.profiler.start.callsFake(() => {
      profilingModule.profiler.enabled = true
      return true
    })
    profilingModule.profiler.stop.reset()
    profilingModule.profiler.stop.callsFake(() => {
      profilingModule.profiler.enabled = false
    })
    profilingModule.profiler.cancelQueuedStart.reset()
    profilingModule.profiler.getQueuedStart.reset()
    FakeSSIHeuristics.resetHistory()
    log.debug.resetHistory()
    log.error.resetHistory()
    log.warn.resetHistory()

    // profiler.js tracks active heuristics at module scope; reset it so a prior test's state
    // doesn't leak in. Disabling here calls the fake's disable() against whichever
    // `ssiHeuristics` instance is still current, so null the test-local variable only afterwards.
    publishConfig('false')
    ssiHeuristics = undefined
    profilingModule.profiler.stop.resetHistory()
  })

  describe('config update', () => {
    it('does not start or stop the profiler on an initial disabled publish', () => {
      publishConfig('false')

      sinon.assert.notCalled(profilingModule.profiler.start)
      sinon.assert.notCalled(profilingModule.profiler.stop)
      assert.strictEqual(profiler.isStarted(), false)
    })

    it('starts the profiler when enabled', () => {
      publishConfig('true')

      sinon.assert.calledOnce(profilingModule.profiler.start)
      assert.strictEqual(profiler.isStarted(), true)
    })

    it('reflects the profiling layer self-stopping outside of profiler.stop()', () => {
      publishConfig('true')
      assert.strictEqual(profiler.isStarted(), true)

      // e.g. a collection error stopping the native profilers directly, bypassing profiler.stop()
      profilingModule.profiler.enabled = false

      assert.strictEqual(profiler.isStarted(), false)

      publishConfig('true')

      sinon.assert.calledTwice(profilingModule.profiler.start)
    })

    it('does not re-start an already-running profiler on a repeated enabled publish', () => {
      publishConfig('true')
      publishConfig('true')

      sinon.assert.calledOnce(profilingModule.profiler.start)
    })

    it('stops a running profiler when a later publish disables it', () => {
      publishConfig('true')
      sinon.assert.notCalled(profilingModule.profiler.stop)

      publishConfig('false')

      sinon.assert.calledOnce(profilingModule.profiler.stop)
      assert.strictEqual(profiler.isStarted(), false)
    })

    it('cancels a queued restart when disabled again before shutdown settles', () => {
      let stopping = false
      let pendingStart = false
      profilingModule.profiler.start.callsFake(() => {
        if (stopping) {
          pendingStart = true
          return true
        }
        profilingModule.profiler.enabled = true
        return true
      })
      profilingModule.profiler.stop.callsFake(() => {
        pendingStart = false
        if (!profilingModule.profiler.enabled) return
        stopping = true
        profilingModule.profiler.enabled = false
      })

      publishConfig('true')
      publishConfig('false')
      publishConfig('true')
      publishConfig('false')

      // Model the shutdown export settling. The last false publish must have canceled the start
      // queued by the intervening true publish.
      stopping = false
      if (pendingStart) profilingModule.profiler.start({})

      sinon.assert.calledTwice(profilingModule.profiler.start)
      sinon.assert.calledTwice(profilingModule.profiler.stop)
      assert.strictEqual(profilingModule.profiler.enabled, false)
    })

    it('cancels a queued forced start before entering auto mode', () => {
      let stopping = false
      let pendingStart = false
      profilingModule.profiler.start.callsFake(() => {
        if (stopping) {
          pendingStart = true
          return true
        }
        profilingModule.profiler.enabled = true
        return true
      })
      profilingModule.profiler.stop.callsFake(() => {
        pendingStart = false
        if (!profilingModule.profiler.enabled) return
        stopping = true
        profilingModule.profiler.enabled = false
      })
      profilingModule.profiler.cancelQueuedStart.callsFake(() => {
        pendingStart = false
      })

      publishConfig('true')
      publishConfig('false')
      publishConfig('true')
      publishConfig('auto')

      stopping = false
      if (pendingStart) profilingModule.profiler.start({})

      sinon.assert.calledOnce(profilingModule.profiler.cancelQueuedStart)
      sinon.assert.calledOnce(FakeSSIHeuristics)
      sinon.assert.calledTwice(profilingModule.profiler.start)
      assert.strictEqual(profilingModule.profiler.enabled, false)

      ssiHeuristics.triggeredCallback()
      sinon.assert.calledThrice(profilingModule.profiler.start)
      assert.strictEqual(profilingModule.profiler.enabled, true)
    })

    it('preserves an SSI-approved queued start across repeated auto publishes', () => {
      let stopping = false
      let pendingStart
      profilingModule.profiler.start.callsFake((config) => {
        if (stopping) {
          pendingStart = config
          return true
        }
        profilingModule.profiler.enabled = true
        return true
      })
      profilingModule.profiler.stop.callsFake(() => {
        pendingStart = undefined
        if (!profilingModule.profiler.enabled) return
        stopping = true
        profilingModule.profiler.enabled = false
      })
      profilingModule.profiler.cancelQueuedStart.callsFake(() => {
        pendingStart = undefined
      })
      profilingModule.profiler.getQueuedStart.callsFake(() => {
        return pendingStart?.profiling.DD_PROFILING_ENABLED
      })

      publishConfig('true')
      publishConfig('false')
      publishConfig('auto')
      ssiHeuristics.triggeredCallback()
      publishConfig('auto')

      sinon.assert.calledOnce(FakeSSIHeuristics)
      sinon.assert.calledOnce(profilingModule.profiler.cancelQueuedStart)
      sinon.assert.calledTwice(profilingModule.profiler.getQueuedStart)

      stopping = false
      profilingModule.profiler.start(pendingStart)

      assert.strictEqual(profilingModule.profiler.enabled, true)
      sinon.assert.calledThrice(profilingModule.profiler.start)
    })

    it('logs and does not propagate when stopping the profiler throws', () => {
      publishConfig('true')
      // The real Profiler clears its enabled flag before the native stop call that could throw.
      profilingModule.profiler.stop.callsFake(() => {
        profilingModule.profiler.enabled = false
        throw new Error('boom')
      })

      publishConfig('false')

      assert.strictEqual(profiler.isStarted(), false)
      sinon.assert.calledOnce(log.error)
    })

    it('enables the SSI heuristics when set to auto, and starts on trigger', () => {
      publishConfig('auto')

      sinon.assert.notCalled(profilingModule.profiler.start)
      assert.strictEqual(profiler.isStarted(), false)
      sinon.assert.calledOnceWithExactly(FakeSSIHeuristics, { profiling: { DD_PROFILING_ENABLED: 'auto' } })
      sinon.assert.calledOnce(ssiHeuristics.start)

      ssiHeuristics.triggeredCallback()

      sinon.assert.calledOnce(profilingModule.profiler.start)
      assert.strictEqual(profiler.isStarted(), true)
      sinon.assert.calledOnce(ssiHeuristics.disable)
      assert.strictEqual(ssiHeuristics.triggeredCallback, undefined)
    })

    it('warns and does not treat an unexpected value as auto', () => {
      publishConfig('unexpected')

      sinon.assert.notCalled(FakeSSIHeuristics)
      sinon.assert.notCalled(profilingModule.profiler.start)
      sinon.assert.notCalled(profilingModule.profiler.stop)
      sinon.assert.calledOnceWithExactly(
        log.warn,
        'Unexpected DD_PROFILING_ENABLED value: %o',
        'unexpected'
      )
    })

    it('preserves an active auto heuristic when an unexpected value is published', () => {
      publishConfig('auto')
      const activeHeuristics = ssiHeuristics

      publishConfig('unexpected')

      sinon.assert.notCalled(activeHeuristics.disable)
      assert.strictEqual(typeof activeHeuristics.triggeredCallback, 'function')

      activeHeuristics.triggeredCallback()

      sinon.assert.calledOnce(profilingModule.profiler.start)
    })

    it('disables the SSI heuristics when a later publish disables the profiler', () => {
      publishConfig('auto')
      sinon.assert.calledOnce(FakeSSIHeuristics)

      publishConfig('false')

      sinon.assert.calledOnce(ssiHeuristics.disable)
      assert.strictEqual(ssiHeuristics.triggeredCallback, undefined)
    })

    it('disables the SSI heuristics when a later publish unconditionally enables the profiler', () => {
      publishConfig('auto')
      sinon.assert.calledOnce(FakeSSIHeuristics)

      publishConfig('true')

      sinon.assert.calledOnce(ssiHeuristics.disable)
      assert.strictEqual(ssiHeuristics.triggeredCallback, undefined)
      // the profiler was already started by the unconditional 'true' publish
      sinon.assert.calledOnce(profilingModule.profiler.start)
    })

    it('does not re-enable the SSI heuristics on a repeated auto publish before it triggers', () => {
      publishConfig('auto')
      sinon.assert.calledOnce(FakeSSIHeuristics)

      publishConfig('auto')
      sinon.assert.calledOnce(FakeSSIHeuristics)

      ssiHeuristics.triggeredCallback()
      sinon.assert.calledOnce(profilingModule.profiler.start)
    })

    it('does not stop a profiler already started by SSI heuristics on a repeated auto publish', () => {
      publishConfig('auto')
      ssiHeuristics.triggeredCallback()
      sinon.assert.calledOnce(profilingModule.profiler.start)
      assert.strictEqual(profiler.isStarted(), true)

      publishConfig('auto')

      sinon.assert.notCalled(profilingModule.profiler.stop)
      assert.strictEqual(profiler.isStarted(), true)
    })

    it('does not stop or restart a profiler unconditionally enabled before an auto publish', () => {
      publishConfig('true')
      sinon.assert.calledOnce(profilingModule.profiler.start)

      publishConfig('auto')

      sinon.assert.notCalled(profilingModule.profiler.stop)
      sinon.assert.calledOnce(profilingModule.profiler.start)
      assert.strictEqual(profiler.isStarted(), true)
    })

    it('re-enables the SSI heuristics after a prior instance has already triggered', () => {
      publishConfig('auto')
      ssiHeuristics.triggeredCallback()
      sinon.assert.calledOnce(FakeSSIHeuristics)

      publishConfig('false')
      publishConfig('auto')

      sinon.assert.calledTwice(FakeSSIHeuristics)
    })

    it('logs and treats the profiler as not started when starting throws', () => {
      profilingModule.profiler.start.throws(new Error('boom'))

      publishConfig('true')

      assert.strictEqual(profiler.isStarted(), false)
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

    it('stop delegates to a loaded profiling layer', () => {
      profiler.start({})

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
