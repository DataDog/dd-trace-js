'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('profilers/native/heap', () => {
  let NativeHeapProfiler
  let profileData
  let pprof

  beforeEach(() => {
    profileData = {
      sample: [{
        value: [1, 512 * 1024 * 60 * 99]
      }]
    }

    pprof = {
      encode: sinon.stub().returns(Promise.resolve()),
      heap: {
        start: sinon.stub(),
        stop: sinon.stub(),
        profile: sinon.stub().returns(profileData)
      }
    }

    NativeHeapProfiler = proxyquire('../../../src/profiling/profilers/heap', {
      '@datadog/pprof': pprof
    })
  })

  it('should start the internal heap profiler', () => {
    const profiler = new NativeHeapProfiler()

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
  })

  it('should use the provided configuration options', () => {
    const samplingInterval = 1024
    const stackDepth = 10
    const profiler = new NativeHeapProfiler({ samplingInterval, stackDepth })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, samplingInterval, stackDepth)
  })

  it('should stop the internal heap profiler', () => {
    const profiler = new NativeHeapProfiler()

    profiler.start()
    profiler.stop()

    sinon.assert.calledOnce(pprof.heap.stop)
  })

  it('should collect profiles from the pprof heap profiler', () => {
    const profiler = new NativeHeapProfiler()

    profiler.start()

    const profile = profiler.profile()

    expect(profile).to.equal(profileData)
  })

  it('should adjust heap profiler sample rate dynamically', () => {
    let profileData
    let profile

    const profiler = new NativeHeapProfiler({
      samplingInterval: 1024,
      samplingThreshold: 0.5
    })

    profiler.start()

    // Check sample rate adjusts up
    pprof.heap.start.resetHistory()

    profileData = {
      sample: [{
        value: [1, 1024 * 2 * 60 * 99]
      }]
    }

    pprof.heap.profile.returns(profileData)
    profile = profiler.profile()
    expect(profile).to.equal(profileData)

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, 1024 * 2, 64)

    // Check sample rate adjusts down
    pprof.heap.start.resetHistory()

    profileData = {
      sample: [{
        value: [1, (1024 - 1) * 60 * 99]
      }]
    }

    pprof.heap.profile.returns(profileData)
    profile = profiler.profile()
    expect(profile).to.equal(profileData)

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, 1023, 64)

    // Check sample rate does not adjust below threshold
    pprof.heap.start.resetHistory()

    profileData = {
      sample: [{
        value: [1, 1024 * 60 * 99]
      }]
    }

    pprof.heap.profile.returns(profileData)
    profile = profiler.profile()
    expect(profile).to.equal(profileData)

    sinon.assert.notCalled(pprof.heap.start)
  })

  it('should encode profiles from the pprof heap profiler', () => {
    const profiler = new NativeHeapProfiler()

    profiler.start()
    const profile = profiler.profile()
    profiler.encode(profile)

    sinon.assert.calledOnce(pprof.encode)
  })
})
