'use strict'

require('../../setup/core')

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('profilers/native/space', () => {
  let NativeSpaceProfiler
  let pprof

  beforeEach(() => {
    pprof = {
      encode: sinon.stub().returns(Promise.resolve()),
      heap: {
        start: sinon.stub(),
        stop: sinon.stub(),
        profile: sinon.stub()
      }
    }

    NativeSpaceProfiler = proxyquire('../../../src/profiling/profilers/space', {
      '@datadog/pprof': pprof
    })
  })

  it('should start the internal space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
  })

  it('should use the provided configuration options', () => {
    const samplingInterval = 1024
    const stackDepth = 10
    const profiler = new NativeSpaceProfiler({ samplingInterval, stackDepth })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, samplingInterval, stackDepth)
  })

  it('should stop the internal space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()
    profiler.stop()

    sinon.assert.calledOnce(pprof.heap.stop)
  })

  it('should collect profiles from the pprof space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile()

    expect(profile).to.equal('profile')
  })

  it('should encode profiles from the pprof space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()
    const profile = profiler.profile()
    profiler.encode(profile)

    sinon.assert.calledOnce(pprof.encode)
  })

  it('should use mapper if given', () => {
    const profiler = new NativeSpaceProfiler()

    const mapper = {}

    profiler.start({ mapper })
    profiler.profile()

    sinon.assert.calledWith(pprof.heap.profile, undefined, mapper)
  })
})
