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

  it('should start the internal space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
  })

  it('should use the provided configuration options', () => {
    const heapSamplingInterval = 1024
    const profiler = new NativeSpaceProfiler({ heapSamplingInterval })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, heapSamplingInterval, 64)
  })

  it('should stop the internal space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    assert.strictEqual(profiler.isStarted(), false)
    profiler.start()
    assert.strictEqual(profiler.isStarted(), true)
    profiler.stop()
    assert.strictEqual(profiler.isStarted(), false)

    sinon.assert.calledOnce(pprof.heap.stop)
  })

  it('should provide info', () => {
    const profiler = new NativeSpaceProfiler()

    const info = profiler.getInfo()
    assert.strictEqual(Object.keys(info).length, 0)
  })

  it('should collect profiles from the pprof space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(true)
    assert.strictEqual(profiler.isStarted(), true)

    assert.strictEqual(profile, 'profile')
  })

  it('should collect profiles from the pprof space profiler and stop profiler if not restarted', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(false)
    assert.strictEqual(profiler.isStarted(), false)

    assert.strictEqual(profile, 'profile')
  })

  it('should encode profiles using their encodeAsync method', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()
    const profile = profiler.profile(true)
    profiler.encode(profile)

    sinon.assert.calledOnce(profile0.encodeAsync)
  })

  it('should use mapper if given', () => {
    const profiler = new NativeSpaceProfiler()

    const mapper = {}

    profiler.start({ mapper })
    profiler.profile(true)

    sinon.assert.calledWith(pprof.heap.profile, undefined, mapper)
  })
})
