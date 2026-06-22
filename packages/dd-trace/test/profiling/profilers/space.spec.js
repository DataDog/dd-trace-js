'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

describe('profilers/native/space', () => {
  let NativeSpaceProfiler
  let pprof
  let profile0

  beforeEach(() => {
    profile0 = {
      encodeAsync: sinon.stub().returns(Promise.resolve('encoded')),
    }
    pprof = {
      heap: {
        start: sinon.stub(),
        stop: sinon.stub(),
        profile: sinon.stub().returns(profile0),
      },
    }

    NativeSpaceProfiler = proxyquire('../../../src/profiling/profilers/space', {
      '@datadog/pprof': pprof,
    })
  })

  // Test adapter: bridges the legacy flat options shape these specs use to the
  // (config, derived) shape the space profiler now expects.
  function makeSpace ({ heapSamplingInterval = 512 * 1024, allocationProfilingEnabled = false, oomMonitoring } = {}) {
    return new NativeSpaceProfiler(
      { profiling: { heapSamplingInterval } },
      { allocationProfilingEnabled, oomMonitoring }
    )
  }

  it('should start the internal space profiler', () => {
    const profiler = makeSpace({ allocationProfilingEnabled: false })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
  })

  it('should use the provided configuration options', () => {
    const heapSamplingInterval = 1024
    const profiler = makeSpace({ heapSamplingInterval, allocationProfilingEnabled: false })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, heapSamplingInterval, 64, false)
  })

  it('should enable allocation profiling when configured', () => {
    const profiler = makeSpace({ allocationProfilingEnabled: true })

    profiler.start()

    sinon.assert.calledOnceWithExactly(pprof.heap.start, 512 * 1024, 64, true)
  })

  it('should stop the internal space profiler', () => {
    const profiler = makeSpace()

    assert.strictEqual(profiler.isStarted(), false)
    profiler.start()
    assert.strictEqual(profiler.isStarted(), true)
    profiler.stop()
    assert.strictEqual(profiler.isStarted(), false)

    sinon.assert.calledOnce(pprof.heap.stop)
  })

  it('should provide info', () => {
    const profiler = makeSpace()

    const info = profiler.getInfo()
    assert.strictEqual(Object.keys(info).length, 0)
  })

  it('should collect profiles from the pprof space profiler', () => {
    const profiler = makeSpace()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(true)
    assert.strictEqual(profiler.isStarted(), true)

    assert.strictEqual(profile, 'profile')
  })

  it('should collect profiles from the pprof space profiler and stop profiler if not restarted', () => {
    const profiler = makeSpace()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(false)
    assert.strictEqual(profiler.isStarted(), false)

    assert.strictEqual(profile, 'profile')
  })

  it('should encode profiles using their encodeAsync method', () => {
    const profiler = makeSpace()

    profiler.start()
    const profile = profiler.profile(true)
    profiler.encode(profile)

    sinon.assert.calledOnce(profile0.encodeAsync)
  })

  it('should use mapper if given', () => {
    const profiler = makeSpace()

    const mapper = {}

    profiler.start({ mapper })
    profiler.profile(true)

    sinon.assert.calledWith(pprof.heap.profile, undefined, mapper)
  })
})
